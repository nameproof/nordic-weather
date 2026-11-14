#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["shapely>=2.1"]
# ///
"""Build map/countries.json: outlines of the countries with a warning provider.

Maintainer tool, not needed to run the plugin. The plugin uses the outlines
only to pick which provider to ask for weather warnings (Model.warningCountries):
SMHI for Sweden, MET Norway for Norway, FMI for Finland (Åland included, which
Natural Earth keeps as its own unit). Denmark has no provider; its outline is
there so places in it aren't handed to Sweden as the nearest country.

Reads Natural Earth's 1:10m admin-0 countries (public domain) from build/ne/,
simplifies the three together so shared borders stay shared, drops islets too
small to hold a place, and writes rings as flat [lon, lat, lon, lat, …] lists.
`errorKm` is how far a simplified land border strays from the original at
most: the plugin asks both providers for points that close to a shared border.
Coasts stray further, which only matters for points off the coast, and those
go to the nearest country.

  uv run scripts/build-countries.py [--download]
"""

import argparse
import json
import math
import os
import urllib.request

import shapely
import shapely.affinity
from shapely.geometry import MultiPolygon, Polygon, shape
from shapely.ops import unary_union

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, "build", "ne")
SRC = os.path.join(SRC_DIR, "ne_10m_admin_0_countries.geojson")
SRC_URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
           "v5.1.2/geojson/ne_10m_admin_0_countries.geojson")
OUT = os.path.join(ROOT, "map", "countries.json")

# Country -> Natural Earth ADM0_A3 units in it.
UNITS = {"SE": ["SWE"], "NO": ["NOR"], "FI": ["FIN", "ALD"], "DK": ["DNK"]}
TOLERANCE_DEG = 0.01        # simplification, ≈1 km north-south
MIN_ISLAND_KM2 = 0.5        # smaller islets are dropped
DECIMALS = 3                # ≈100 m


def km2(poly):
    lat = math.radians(poly.centroid.y)
    return poly.area * 111.32 ** 2 * math.cos(lat)


def parts(geom):
    return list(geom.geoms) if isinstance(geom, MultiPolygon) else [geom]


def flat(ring):
    out = []
    for x, y in ring.coords[:-1]:
        out += [round(x, DECIMALS), round(y, DECIMALS)]
    return out


def border_error_km(orig_a, orig_b, simp_a):
    # Farthest any point of the original shared border lies from the simplified
    # outline, in km (longitude scaled at the border's latitude).
    shared = orig_a.boundary.intersection(orig_b.boundary)
    if shared.is_empty:
        return 0.0
    lat = math.radians(shared.centroid.y)
    scale = lambda g: shapely.affinity.scale(g, xfact=math.cos(lat), yfact=1, origin=(0, 0))
    points = shapely.points(shapely.get_coordinates(shapely.segmentize(scale(shared), 0.005)))
    return float(shapely.distance(points, scale(simp_a.boundary)).max()) * 111.32


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--download", action="store_true")
    args = ap.parse_args()
    if args.download or not os.path.exists(SRC):
        os.makedirs(SRC_DIR, exist_ok=True)
        urllib.request.urlretrieve(SRC_URL, SRC)

    with open(SRC, encoding="utf-8") as f:
        features = json.load(f)["features"]
    by_unit = {f["properties"]["ADM0_A3"]: shape(f["geometry"]) for f in features}
    codes = list(UNITS)
    originals = [unary_union([by_unit[u] for u in UNITS[c]]) for c in codes]
    simplified = shapely.coverage_simplify(originals, TOLERANCE_DEG, simplify_boundary=True)
    errors = []

    for i, a in enumerate(codes):
        for j, b in enumerate(codes):
            if i != j:
                err = border_error_km(originals[i], originals[j], simplified[i])
                print(f"{a}/{b} border: error {err:.1f} km")
                errors.append(err)

    out = {"source": "Natural Earth 1:10m admin-0 countries (public domain), simplified",
           "errorKm": round(max(errors) + 0.05, 1), "countries": {}}
    for code, orig, simp in zip(codes, originals, simplified):
        polys = []
        for p in parts(shapely.make_valid(simp)):
            if not isinstance(p, Polygon) or km2(p) < MIN_ISLAND_KM2:
                continue
            polys.append([flat(p.exterior)] + [flat(r) for r in p.interiors if km2(Polygon(r)) >= MIN_ISLAND_KM2])
        out["countries"][code] = polys
        print(f"{code}: {len(polys)} polygons, {sum(len(r) // 2 for p in polys for r in p)} vertices")

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
        f.write("\n")
    print(f"wrote {OUT}: {os.path.getsize(OUT) // 1024} KB, errorKm {out['errorKm']}")


if __name__ == "__main__":
    main()
