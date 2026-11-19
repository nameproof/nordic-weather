#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["osmium", "shapely", "pyshp", "pillow", "numpy"]
# ///
"""Build the radar map's base map from OpenStreetMap data.

Maintainer tool, not needed to run the plugin. Reads OSM extracts and the
simplified land polygons from build/osm/ (regions in
scripts/basemap-regions.txt), and writes:

  map/tiles/{z}/{x}/{y}.webp Web Mercator tiles holding *masks*, not colours,
                             as lossless WebP: G = water, R = roads (brighter =
                             bigger road), B = country borders.
                             shaders/mapdata.frag turns them into theme colours
                             at display time. 512 px (392 at zoom 5): twice the
                             largest size a tile is drawn at, for monitor scale 2.
  map/places.json            Cities and towns for labels drawn by the panel.

Run with uv, which provides the dependencies listed above:
  uv run scripts/build-basemap.py [--download] [--extract] [--render] [--places]
(no flags = all four; downloads ≈6 GB into build/osm/ and skips files it has).
--places alone rewrites map/places.json from the downloaded extracts (a
few minutes), e.g. after adding a label language.

Map data © OpenStreetMap contributors, ODbL.
"""

import argparse
import json
import math
import os
import shutil
import stat
import struct
import sys
import tempfile
import zipfile
from concurrent.futures import ProcessPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
OSM = os.path.join(BUILD, "osm")
EXTRACTED = os.path.join(BUILD, "extracted")
OUT = os.path.join(ROOT, "map")

# Where yr.no's radar has data (west, south, east, north), as RADAR_COVERAGE
# in Model.js: map views never leave it, so tiles are rendered for it plus
# the zoom-5 overview frame around it (whole tiles).
COVERAGE = (0.5, 54.2, 35.5, 72.8)
ZOOMS = (5, 6, 7)
# Logical tile size: the panel draws tiles at up to 256 px.
TILE = 256
# Pixels per tile file, per zoom: twice the largest drawn size (zoom 5 is drawn
# at most 196 px, in the overview). As MAP_TILE_FILE_PX in Model.js.
TILE_FILE_PX = {5: 392, 6: 512, 7: 512}
# The map box in the panel, for the overview frame (as Model.mapView).
MAP_BOX = (659, 761)
SUPERSAMPLE = 4

R = 6378137.0
HALF = math.pi * R

# Smallest lake kept, in true square metres (≈ one pixel of a zoom-7 tile at 60° N).
MIN_WATER_M2 = 100_000
# Road classes: (mask value, first zoom shown, width in px of a tile drawn at 256).
ROADS = {
    "motorway": (255, 5, 1.6),
    "trunk": (215, 5, 1.3),
    "primary": (165, 6, 1.0),
    "secondary": (115, 7, 0.7),
}
BORDER_WIDTH = 1.2
PLACE_KINDS = {"city", "town"}
# Label languages (Model.js STRINGS) and the OSM name tags for each, in
# order of preference; places.json gets a name_<lang> column per language.
LABEL_NAMES = {
    "sv": ["name:sv"],
    "nb": ["name:nb", "name:no"],
    "da": ["name:da"],
    "fi": ["name:fi"],
    "en": ["name:en"],
}


def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    r = math.radians(lat)
    return (lon + 180) / 360 * n, (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n


def tile_to_lonlat(x, y, z):
    n = 2 ** z
    return x / n * 360 - 180, math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))


def extent_tiles(z):
    """Tile coordinate bounds (x0, y0, x1, y1) of the render area at zoom z."""
    x0, y0 = lonlat_to_tile(COVERAGE[0], COVERAGE[3], z)
    x1, y1 = lonlat_to_tile(COVERAGE[2], COVERAGE[1], z)
    if z == 5:
        # The overview frame is centred on the coverage and may be wider.
        w, h = MAP_BOX
        px = min(TILE, math.floor(min(w / (x1 - x0), h / (y1 - y0))))
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        x0, x1 = min(x0, cx - w / px / 2), max(x1, cx + w / px / 2)
        y0, y1 = min(y0, cy - h / px / 2), max(y1, cy + h / px / 2)
    return x0, max(0, y0), x1, y1


def extent_lonlat():
    """Widest render area (zoom 5) in lon/lat: places are kept within it."""
    x0, y0, x1, y1 = extent_tiles(5)
    lon0, lat1 = tile_to_lonlat(x0, y0, 5)
    lon1, lat0 = tile_to_lonlat(x1, y1, 5)
    return lon0, lat0, lon1, lat1


def merc(lon, lat):
    lat = max(-85.0511, min(85.0511, lat))
    return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def inv_lat(my):
    return math.degrees(2 * math.atan(math.exp(my / R)) - math.pi / 2)


# ---------------------------------------------------------------- extraction

def extract_region(pbf):
    """One OSM extract → water polygons, roads and borders (Mercator)."""
    import osmium
    import shapely
    from shapely import wkb as shp_wkb

    name = os.path.basename(pbf).replace("-latest.osm.pbf", "")
    out_path = os.path.join(EXTRACTED, name + EXTRACT_SUFFIX)
    if os.path.exists(out_path) and os.path.getmtime(out_path) > os.path.getmtime(pbf) and extract_usable(out_path):
        return name, "cached"

    factory = osmium.geom.WKBFactory()

    # Pass 1: ways that are members of national (admin_level=2) boundaries.
    border_ways = set()
    for rel in osmium.FileProcessor(pbf, osmium.osm.RELATION).with_filter(osmium.filter.KeyFilter("boundary")):
        if rel.tags.get("boundary") == "administrative" and rel.tags.get("admin_level") == "2":
            for m in rel.members:
                if m.type == "w":
                    border_ways.add(m.ref)

    water, roads, borders = [], [], []

    # Pass 2: areas (lakes) and ways (roads, border ways).
    fp = (osmium.FileProcessor(pbf)
          .with_locations()
          .with_areas(osmium.filter.KeyFilter("natural", "waterway", "landuse", "water")))
    for obj in fp:
        try:
            if obj.is_area():
                t = obj.tags
                if not (t.get("natural") == "water" or t.get("waterway") == "riverbank"
                        or t.get("landuse") in ("reservoir", "basin")):
                    continue
                geom = to_merc(shp_wkb.loads(factory.create_multipolygon(obj), hex=True))
                cy = inv_lat(geom.centroid.y)
                true_area = geom.area * math.cos(math.radians(cy)) ** 2
                if true_area >= MIN_WATER_M2:
                    water.append(geom.wkb)
            elif obj.is_way():
                hw = obj.tags.get("highway")
                in_border = obj.id in border_ways
                if hw not in ROADS and not in_border:
                    continue
                geom = to_merc(shp_wkb.loads(factory.create_linestring(obj), hex=True))
                if hw in ROADS:
                    roads.append((hw, geom.wkb))
                if in_border and obj.tags.get("maritime") != "yes":
                    borders.append(geom.wkb)
        except (RuntimeError, ValueError):
            # Broken geometry (unclosed ring, missing nodes at extract edges).
            continue

    os.makedirs(EXTRACTED, exist_ok=True)
    write_extract(out_path, water, roads, borders)
    return name, f"{len(water)} water, {len(roads)} roads, {len(borders)} border ways"


# The extract cache, build/extracted/<region>.features: plain data, never
# code. The magic and a version, then three sections in order (water,
# roads, borders), each a record count and its records: a length and that
# many WKB bytes, a road record first naming its class (one of ROADS).
# Little-endian. Reading rejects anything short, longer, of another version
# or naming another class, and only reads regular files. --extract redoes a
# cached file that does not read back whole with usable geometry.
EXTRACT_MAGIC = b"NWBF"
EXTRACT_VERSION = 1
EXTRACT_SUFFIX = ".features"
MAX_WKB_BYTES = 256 * 1024 * 1024
MAX_EXTRACT_BYTES = 4 * 1024 * 1024 * 1024
EXTRACT_TYPES = {"water": {"Polygon", "MultiPolygon"}, "roads": {"LineString"}, "borders": {"LineString"}}


class ExtractError(ValueError):
    pass


def write_extract(path, water, roads, borders):
    # A new temporary file next to the target (created exclusively, so it
    # cannot be a planted link), moved into place once complete.
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".extract-", suffix=".part")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(EXTRACT_MAGIC + struct.pack("<I", EXTRACT_VERSION))
            for section, records in (("water", water), ("roads", roads), ("borders", borders)):
                f.write(struct.pack("<I", len(records)))
                for record in records:
                    if section == "roads":
                        cls, record = record
                        name = cls.encode("ascii")
                        f.write(struct.pack("<B", len(name)) + name)
                    f.write(struct.pack("<I", len(record)))
                    f.write(record)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def read_extract(path, keep=True):
    """An extract cache file → (water, roads, borders) as WKB bytes, roads as
    (class, WKB). With keep=False only checks the file (records are skipped,
    not read) and returns None."""
    if not stat.S_ISREG(os.lstat(path).st_mode):
        raise ExtractError("not a regular file")
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as f:
        size = os.fstat(f.fileno()).st_size
        if size > MAX_EXTRACT_BYTES:
            raise ExtractError("larger than any extract")

        def take(n):
            if n > size - f.tell():
                raise ExtractError("truncated")
            chunk = f.read(n)
            if len(chunk) != n:
                raise ExtractError("truncated")
            return chunk

        def u32():
            return struct.unpack("<I", take(4))[0]

        def records(with_class):
            count = u32()
            # Every record takes at least its length field (and a class byte).
            if count > (size - f.tell()) // (5 if with_class else 4):
                raise ExtractError("record count exceeds the file")
            out = []
            for _ in range(count):
                cls = None
                if with_class:
                    cls = take(take(1)[0]).decode("ascii", errors="replace")
                    if cls not in ROADS:
                        raise ExtractError(f"unknown road class {cls!r}")
                n = u32()
                if n > MAX_WKB_BYTES or n > size - f.tell():
                    raise ExtractError("truncated" if n <= MAX_WKB_BYTES else "record too large")
                if keep:
                    blob = take(n)
                    out.append((cls, blob) if with_class else blob)
                else:
                    f.seek(n, os.SEEK_CUR)
            return out

        if take(4) != EXTRACT_MAGIC:
            raise ExtractError("not an extract file")
        if u32() != EXTRACT_VERSION:
            raise ExtractError("other version")
        water, roads, borders = records(False), records(True), records(False)
        if f.tell() != size:
            raise ExtractError("trailing data")
    return (water, roads, borders) if keep else None


def extract_usable(path):
    """Whether an extract cache file reads back whole, every record a
    non-empty geometry of its section's type (needs shapely)."""
    from shapely import wkb as shp_wkb
    try:
        water, roads, borders = read_extract(path)
        for section, blobs in (("water", water), ("roads", [g for _, g in roads]), ("borders", borders)):
            for blob in blobs:
                g = shp_wkb.loads(blob)
                if g.is_empty or g.geom_type not in EXTRACT_TYPES[section]:
                    return False
    except Exception:
        return False
    return True


def extract_places(pbf):
    """One OSM extract → its cities and towns inside the map, with every
    name tag the label languages use."""
    import osmium

    min_lon, min_lat, max_lon, max_lat = extent_lonlat()
    tags = {tag for names in LABEL_NAMES.values() for tag in names}
    places = []
    for node in osmium.FileProcessor(pbf, osmium.osm.NODE).with_filter(osmium.filter.KeyFilter("place")):
        t = node.tags
        if t.get("place") not in PLACE_KINDS or "name" not in t:
            continue
        lon, lat = node.location.lon, node.location.lat
        if not (min_lon <= lon <= max_lon and min_lat <= lat <= max_lat):
            continue
        try:
            pop = int(str(t.get("population", "0")).replace(" ", "").replace(",", "").split(".")[0] or 0)
        except ValueError:
            pop = 0
        places.append({
            "name": t.get("name"), "names": {k: t.get(k) for k in tags if t.get(k)},
            "lat": round(lat, 4), "lon": round(lon, 4), "pop": pop,
            "kind": t.get("place"), "capital": t.get("capital") in ("yes", "2"),
        })
    return os.path.basename(pbf).replace("-latest.osm.pbf", ""), places


def places_all(jobs):
    pbfs = sorted(os.path.join(OSM, f) for f in os.listdir(OSM) if f.endswith("-latest.osm.pbf"))
    places = []
    with ProcessPoolExecutor(max_workers=jobs) as pool:
        for name, found in pool.map(extract_places, pbfs):
            places += found
    print(f"  {len(places)} places", flush=True)
    write_places(places)


def to_merc(geom):
    """lon/lat geometry → Web Mercator metres (vectorised)."""
    import numpy as np
    import shapely

    def project(c):
        lon = np.radians(c[:, 0])
        lat = np.radians(np.clip(c[:, 1], -85.0511, 85.0511))
        return np.column_stack((R * lon, R * np.log(np.tan(np.pi / 4 + lat / 2))))
    return shapely.transform(geom, project)


def region_names():
    """The base map's regions (scripts/basemap-regions.txt), as file names."""
    with open(REGIONS) as f:
        return [os.path.basename(line.strip()) for line in f if line.strip() and not line.startswith("#")]


def extract_all(jobs):
    pbfs = [os.path.join(OSM, name + "-latest.osm.pbf") for name in region_names()]
    missing = [p for p in pbfs if not os.path.exists(p)]
    if missing:
        sys.exit(f"missing {', '.join(os.path.basename(p) for p in missing)}; run --download")
    # Largest first so the long ones start early.
    pbfs.sort(key=lambda p: -os.path.getsize(p))
    with ProcessPoolExecutor(max_workers=jobs) as pool:
        for name, info in pool.map(extract_region, pbfs):
            print(f"  {name}: {info}", flush=True)


# ---------------------------------------------------------------- rendering

def load_land():
    import shapefile
    from shapely.geometry import shape, box
    lon0, lat0, lon1, lat1 = extent_lonlat()
    minx, miny = merc(lon0, lat0)
    maxx, maxy = merc(lon1, lat1)
    area = box(minx, miny, maxx, maxy).buffer(200_000)
    with zipfile.ZipFile(os.path.join(OSM, "land.zip")) as z:
        base = [n for n in z.namelist() if n.endswith(".shp")][0][:-4]
        reader = shapefile.Reader(shp=z.open(base + ".shp"), shx=z.open(base + ".shx"), dbf=z.open(base + ".dbf"))
        land = []
        for rec in reader.iterShapes():
            if rec.bbox[2] < area.bounds[0] or rec.bbox[0] > area.bounds[2] \
                    or rec.bbox[3] < area.bounds[1] or rec.bbox[1] > area.bounds[3]:
                continue
            g = shape(rec.__geo_interface__)
            if not g.is_valid:
                g = g.buffer(0)
            clipped = g.intersection(area)
            if not clipped.is_empty:
                land.append(clipped)
    return land


def load_extracted():
    """Every region's extract, each present and newer than its OSM data: a
    missing one would render tiles without its lakes, roads and borders.
    Regions in name order: where features overlap, the order they are drawn
    in shows in the tiles."""
    paths = []
    for name in sorted(region_names()):
        path = os.path.join(EXTRACTED, name + EXTRACT_SUFFIX)
        pbf = os.path.join(OSM, name + "-latest.osm.pbf")
        if not os.path.lexists(path):
            sys.exit(f"no extract for {name}; run --extract")
        if os.path.exists(pbf) and os.path.getmtime(path) <= os.path.getmtime(pbf):
            sys.exit(f"the extract for {name} is older than its OSM data; run --extract")
        paths.append(path)

    from shapely import wkb as shp_wkb
    water, roads, borders = [], [], []

    def geometry(blob, section, path):
        try:
            g = shp_wkb.loads(blob)
        except Exception as e:
            sys.exit(f"{path}: unreadable geometry ({e}); run --extract")
        if g.is_empty or g.geom_type not in EXTRACT_TYPES[section]:
            sys.exit(f"{path}: {'an empty' if g.is_empty else 'unexpected'} {g.geom_type} among {section}; run --extract")
        return g

    for path in paths:
        try:
            w, r, b = read_extract(path)
        except (OSError, ExtractError) as e:
            sys.exit(f"{path}: {e}; run --extract")
        water += [geometry(g, "water", path) for g in w]
        roads += [(c, geometry(g, "roads", path)) for c, g in r]
        borders += [geometry(g, "borders", path) for g in b]
    return water, roads, borders


def tile_range(z):
    x0, y0, x1, y1 = extent_tiles(z)
    n = 2 ** z
    return range(int(x0), min(n - 1, int(x1)) + 1), range(int(y0), min(n - 1, int(y1)) + 1)


def render_all(jobs):
    import numpy as np
    from shapely import STRtree

    print("loading land polygons…", flush=True)
    land = load_land()
    print("loading extracted features…", flush=True)
    water, roads, borders = load_extracted()
    print(f"  {len(land)} land, {len(water)} water, {len(roads)} roads, {len(borders)} border ways", flush=True)

    # Load once here; forked workers share it (Python 3.14 defaults to
    # forkserver, which would make every worker load its own copy).
    import multiprocessing
    _R["land"] = land
    _R["land_tree"] = STRtree(land)
    _R["water"] = water
    _R["water_tree"] = STRtree(water)
    _R["roads"] = roads
    _R["roads_tree"] = STRtree([g for _, g in roads])
    _R["borders"] = borders
    _R["borders_tree"] = STRtree(borders)

    tiles = [(z, x, y) for z in ZOOMS for x in tile_range(z)[0] for y in tile_range(z)[1]]
    # Rendered into a fresh staging folder in build/; map/tiles is replaced only once
    # every tile is there, so a failed run leaves the shipped tiles as they were.
    dest = os.path.join(OUT, "tiles")
    staging = os.path.join(BUILD, "tiles.new")
    os.makedirs(BUILD, exist_ok=True)
    for p in (dest, staging):
        if os.path.islink(p):
            sys.exit(f"{p} is a symlink; not writing through it")
    if os.path.exists(staging):
        shutil.rmtree(staging)
    _R["tiles_dir"] = staging
    print(f"rendering {len(tiles)} tiles (every lossless WebP setting per tile: minutes)…", flush=True)
    with ProcessPoolExecutor(max_workers=jobs, mp_context=multiprocessing.get_context("fork")) as pool:
        done = 0
        for _ in pool.map(render_tile, tiles, chunksize=4):
            done += 1
            if done % 50 == 0:
                print(f"  {done}/{len(tiles)}", flush=True)
    written = sorted(os.path.relpath(os.path.join(d, f), staging) for d, _, fs in os.walk(staging) for f in fs)
    expected = sorted(os.path.join(str(z), str(x), f"{y}.webp") for z, x, y in tiles)
    if written != expected:
        sys.exit(f"staging has {len(written)} files, expected {len(expected)}; map/tiles left unchanged")
    old = os.path.join(BUILD, "tiles.old")
    if os.path.exists(old):
        shutil.rmtree(old)
    try:
        if os.path.exists(dest):
            os.rename(dest, old)
        os.rename(staging, dest)
    except BaseException:
        # Put the previous tiles back if the new ones did not make it in.
        if os.path.exists(old) and not os.path.exists(dest):
            os.rename(old, dest)
        raise
    if os.path.exists(old):
        shutil.rmtree(old)


# Geometry and spatial indexes for the render workers (filled before forking).
_R = {}


def render_tile(zxy):
    from PIL import Image, ImageDraw
    from shapely.geometry import box

    z, x, y = zxy
    out = TILE_FILE_PX[z]
    k = out / TILE  # line widths are given for a tile drawn at 256 px
    size = out * SUPERSAMPLE
    span = 2 * HALF / 2 ** z
    minx = -HALF + x * span
    maxy = HALF - y * span
    bounds = box(minx, maxy - span, minx + span, maxy)
    pad = bounds.buffer(span * 0.02)
    tol = span / out * 0.3
    scale = size / span

    def px(coords):
        return [((cx - minx) * scale, (maxy - cy) * scale) for cx, cy in coords]

    def polys(geom):
        if geom.is_empty:
            return []
        return list(geom.geoms) if hasattr(geom, "geoms") else [geom]

    def fill(draw, geom, outer, inner):
        for p in polys(geom):
            if p.geom_type != "Polygon" or p.is_empty:
                continue
            draw.polygon(px(p.exterior.coords), fill=outer)
            for hole in p.interiors:
                draw.polygon(px(hole.coords), fill=inner)

    def lines(geom):
        if geom.is_empty:
            return []
        if geom.geom_type == "LineString":
            return [geom]
        return [g for g in getattr(geom, "geoms", []) if g.geom_type == "LineString"]

    # Water: start as sea, cut out land, then add lakes (with their islands).
    water_img = Image.new("L", (size, size), 255)
    wd = ImageDraw.Draw(water_img)
    land_here = []
    for i in _R["land_tree"].query(pad):
        g = _R["land"][i].intersection(pad).simplify(tol)
        land_here.append(g)
        fill(wd, g, 0, 255)
    for i in _R["water_tree"].query(pad):
        fill(wd, _R["water"][i].intersection(pad).simplify(tol), 255, 0)

    # Roads, biggest last so they win where they overlap.
    road_img = Image.new("L", (size, size), 0)
    rd = ImageDraw.Draw(road_img)
    order = sorted(_R["roads_tree"].query(pad), key=lambda i: ROADS[_R["roads"][i][0]][0])
    for i in order:
        cls, g = _R["roads"][i]
        value, min_zoom, width = ROADS[cls]
        if z < min_zoom:
            continue
        w = max(1, round(width * k * SUPERSAMPLE * (0.8 if z == 5 else 1.0)))
        for line in lines(g.intersection(pad).simplify(tol)):
            rd.line(px(line.coords), fill=value, width=w, joint="curve")

    # National borders, on land only.
    border_img = Image.new("L", (size, size), 0)
    bd = ImageDraw.Draw(border_img)
    if land_here:
        from shapely.ops import unary_union
        land_union = unary_union(land_here)
        for i in _R["borders_tree"].query(pad):
            g = _R["borders"][i].intersection(pad).intersection(land_union).simplify(tol)
            for line in lines(g) + [l for p in polys(g) for l in lines(p)]:
                bd.line(px(line.coords), fill=255, width=max(1, round(BORDER_WIDTH * k * SUPERSAMPLE)), joint="curve")

    # Stored G = water, R = roads, B = borders: of the six channel orders this
    # one compresses smallest.
    img = Image.merge("RGB", [road_img, water_img, border_img]).resize((out, out), Image.BOX)
    path = os.path.join(_R["tiles_dir"], str(z), str(x), f"{y}.webp")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(encode_tile(img))
    return zxy


# Qt's WebP plugin refuses files shorter than sizeof(WebPBitstreamFeatures),
# 40 bytes, before it reads them: the shortest encodes of a one-colour tile
# (36 bytes) would not load.
QT_MIN_WEBP = 40


def encode_tile(img):
    """The smallest lossless WebP of a tile, over every method and quality
    (libwebp's settings that change a lossless file), verified to decode to
    the same pixels."""
    import io
    import numpy as np
    from PIL import Image

    best = None
    for method in range(7):
        for quality in range(101):
            buf = io.BytesIO()
            img.save(buf, "WEBP", lossless=True, method=method, quality=quality, exact=True)
            data = buf.getvalue()
            if len(data) >= QT_MIN_WEBP and (best is None or len(data) < len(best)):
                best = data
    decoded = Image.open(io.BytesIO(best)).convert("RGB")
    if not np.array_equal(np.asarray(decoded), np.asarray(img)):
        raise RuntimeError("WebP tile does not decode to the rendered pixels")
    return best


def write_places(places):
    """Cities and towns, deduplicated, most important first."""
    seen = {}
    for p in places:
        key = (p["name"], round(p["lat"], 1), round(p["lon"], 1))
        if key not in seen or p["pop"] > seen[key]["pop"]:
            seen[key] = p
    rows = sorted(seen.values(), key=lambda p: (-(p["capital"]), -p["pop"], p["kind"] != "city"))

    def latin(s):
        return s is not None and all(ord(c) < 0x250 for c in s)

    # A name in Latin script is kept as it is (Göteborg, not Gothenburg);
    # others (Москва) use the language's own name, then English.
    def label(p, lang):
        if latin(p["name"]):
            return p["name"]
        for tag in LABEL_NAMES[lang] + ["name:en"]:
            if p["names"].get(tag):
                return p["names"][tag]
        return p["name"]

    out = []
    for p in rows:
        if p["kind"] == "town" and p["pop"] < 2000:
            continue
        out.append([p["name"]] + [label(p, lang) for lang in LABEL_NAMES]
                   + [p["lat"], p["lon"], p["pop"], (1 if p["capital"] else 0) | (2 if p["kind"] == "city" else 0)])
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "places.json"), "w") as f:
        json.dump({"attribution": "© OpenStreetMap contributors (ODbL)",
                   "fields": ["name"] + ["name_" + lang for lang in LABEL_NAMES] + ["lat", "lon", "population", "flags"],
                   "places": out}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {len(out)} places", flush=True)


REGIONS = os.path.join(ROOT, "scripts", "basemap-regions.txt")
LAND_URL = "https://osmdata.openstreetmap.de/download/simplified-land-polygons-complete-3857.zip"


def download_all():
    import subprocess
    os.makedirs(OSM, exist_ok=True)
    jobs = [(LAND_URL, os.path.join(OSM, "land.zip"))]
    with open(REGIONS) as f:
        for line in f:
            region = line.strip()
            if region and not region.startswith("#"):
                jobs.append((f"https://download.geofabrik.de/{region}-latest.osm.pbf",
                             os.path.join(OSM, os.path.basename(region) + "-latest.osm.pbf")))
    for url, path in jobs:
        if os.path.exists(path) and os.path.getsize(path) > 0:
            continue
        print(f"  {os.path.basename(path)}", flush=True)
        subprocess.run(["curl", "-sSL", "--fail", "--retry", "3", "-o", path + ".part", url], check=True)
        os.replace(path + ".part", path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--download", action="store_true")
    ap.add_argument("--extract", action="store_true")
    ap.add_argument("--render", action="store_true")
    ap.add_argument("--places", action="store_true")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 4) // 2))
    args = ap.parse_args()
    if not (args.download or args.extract or args.render or args.places):
        args.download = args.extract = args.render = args.places = True
    if args.download:
        print("downloading…", flush=True)
        download_all()
    if args.extract:
        print("extracting…", flush=True)
        extract_all(min(args.jobs, 6))
    if args.render:
        render_all(args.jobs)
    if args.places:
        print("places…", flush=True)
        places_all(args.jobs)


if __name__ == "__main__":
    sys.exit(main())
