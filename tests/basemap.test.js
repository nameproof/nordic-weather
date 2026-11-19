const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const M = require("./load-model.js")

const ROOT = path.join(__dirname, "..")
const TILES = path.join(ROOT, "map", "tiles")

function tileFiles() {
  return fs.readdirSync(TILES, { recursive: true })
    .filter((f) => fs.statSync(path.join(TILES, f)).isFile())
    .map((f) => f.split(path.sep).join("/"))
}

// Every tile any map view can show, from Model.js itself: each zoom step at
// centres every half degree across the radar coverage (views clamp to it).
function neededTiles() {
  const c = M.RADAR_COVERAGE
  const need = new Set()
  for (let step = 0; step < M.MAP_ZOOM_STEPS.length; step++) {
    for (let lat = c.south; lat <= c.north; lat += 0.5) {
      for (let lon = c.west; lon <= c.east; lon += 0.5) {
        const v = M.mapView(step, lat, lon, 659, 761)
        for (const t of M.viewTiles(v, 659, 761)) need.add(`${t.z}/${t.x}/${t.y}.webp`)
      }
    }
  }
  return need
}

// The shipped tiles are what scripts/build-basemap.py writes: lossless WebP
// (VP8L) at MAP_TILE_FILE_PX for their zoom, and at least 40 bytes, below
// which Qt's WebP plugin refuses a file.
test("base map tiles: lossless WebP at the file size of their zoom", () => {
  const files = tileFiles()
  assert.ok(files.length > 0)
  for (const f of files) {
    const m = f.match(/^(\d+)\/(\d+)\/(\d+)\.webp$/)
    assert.ok(m, `unexpected file ${f}`)
    const z = Number(m[1])
    const data = fs.readFileSync(path.join(TILES, f))
    assert.ok(data.length >= 40, `${f}: ${data.length} bytes`)
    assert.equal(data.toString("latin1", 0, 4), "RIFF", f)
    assert.equal(data.toString("latin1", 8, 16), "WEBPVP8L", f)
    assert.equal(data.readUInt32LE(4) + 8, data.length, `${f}: RIFF size`)
    assert.equal(data[20], 0x2f, `${f}: VP8L signature`)
    const bits = data.readUInt32LE(21)
    const px = M.MAP_TILE_FILE_PX[z]
    assert.equal((bits & 0x3fff) + 1, px, `${f}: width`)
    assert.equal(((bits >> 14) & 0x3fff) + 1, px, `${f}: height`)
  }
})

test("base map tiles: every tile a view can show is shipped, and nothing else", () => {
  const files = new Set(tileFiles())
  const need = neededTiles()
  const missing = [...need].filter((t) => !files.has(t))
  assert.deepEqual(missing, [], `missing tiles: ${missing.slice(0, 5).join(", ")}`)
  const unused = [...files].filter((t) => !need.has(t))
  assert.deepEqual(unused, [], `tiles no view shows: ${unused.slice(0, 5).join(", ")}`)
})

// The tiles store water in green and roads in red; the build writes that
// order and the shader reads it back.
test("base map channel order: build script and shader agree", () => {
  const script = fs.readFileSync(path.join(ROOT, "scripts", "build-basemap.py"), "utf8")
  const shader = fs.readFileSync(path.join(ROOT, "shaders", "mapdata.frag"), "utf8")
  assert.match(script, /Image\.merge\("RGB", \[road_img, water_img, border_img\]\)/)
  assert.match(shader, /c\.grb \/ c\.a/)
})

// The build's extract cache is plain data: what it reads back is exactly
// what was written, and anything else (short, longer, another version or
// class, a link, a missing region) is refused rather than run or rendered.
const python = require("node:child_process").spawnSync("which", ["python3"], { encoding: "utf8" }).stdout.trim()
test("base map extract cache round-trips and refuses malformed files", { skip: !python && "python3 required" }, () => {
  const program = String.raw`
import importlib.util, os, struct, sys, tempfile
spec = importlib.util.spec_from_file_location("bb", sys.argv[1])
bb = importlib.util.module_from_spec(spec); spec.loader.exec_module(bb)
d = tempfile.mkdtemp()
path = os.path.join(d, "region.features")
water, roads, borders = [b"\x01" * 9, b""], [("motorway", b"\x02" * 5), ("secondary", b"\x03")], [b"\x04" * 3]
bb.write_extract(path, water, roads, borders)
assert bb.read_extract(path) == (water, roads, borders)
assert [f for f in os.listdir(d)] == ["region.features"], os.listdir(d)
good = open(path, "rb").read()

def refused(data, why):
    with open(path, "wb") as f:
        f.write(data)
    try:
        bb.read_extract(path)
    except bb.ExtractError:
        return
    raise AssertionError("accepted: " + why)

for cut in range(len(good)):
    refused(good[:cut], "truncated at %d" % cut)
refused(good + b"\x00", "trailing byte")
refused(b"XXXX" + good[4:], "magic")
refused(good[:4] + struct.pack("<I", 2) + good[8:], "version")
refused(good[:8] + struct.pack("<I", 0xFFFFFFFF), "huge count")
refused(good.replace(b"motorway", b"motorwax"), "road class")
huge = good[:8] + struct.pack("<I", 1) + struct.pack("<I", bb.MAX_WKB_BYTES + 1)
refused(huge, "huge record")

# Checked without keeping records;
# a file larger than any extract is refused before it is read.
with open(path, "wb") as f:
    f.write(good)
assert bb.read_extract(path, keep=False) is None
with open(path, "wb") as f:
    f.write(good[:-1])
try:
    bb.read_extract(path, keep=False)
    raise AssertionError("checked a truncated file as whole")
except bb.ExtractError:
    pass
with open(path, "wb") as f:
    f.write(good)
bb.MAX_EXTRACT_BYTES = len(good) - 1
refused(good, "larger than the limit")
bb.MAX_EXTRACT_BYTES = 4 * 1024 ** 3

os.unlink(path)
os.symlink(os.path.join(d, "elsewhere"), path)
open(os.path.join(d, "elsewhere"), "wb").write(good)
try:
    bb.read_extract(path)
    raise AssertionError("followed a symlink")
except bb.ExtractError:
    pass

# Rendering needs every region's extract, newer than its OSM data.
bb.EXTRACTED, bb.OSM = d, d
bb.region_names = lambda: ["present", "absent"]
bb.write_extract(os.path.join(d, "present.features"), [], [], [])
try:
    bb.load_extracted()
    raise AssertionError("rendered without a region")
except SystemExit as e:
    assert "no extract for absent" in str(e), e
open(os.path.join(d, "absent-latest.osm.pbf"), "wb").close()
bb.write_extract(os.path.join(d, "absent.features"), [], [], [])
os.utime(os.path.join(d, "absent.features"), (1, 1))
try:
    bb.load_extracted()
    raise AssertionError("rendered from a stale extract")
except SystemExit as e:
    assert "older than its OSM data" in str(e), e
print("EXTRACT_OK")
`
  const r = require("node:child_process").spawnSync(python, ["-I", "-c", program, path.join(ROOT, "scripts", "build-basemap.py")],
    { encoding: "utf8", timeout: 30000 })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /EXTRACT_OK/)
})
