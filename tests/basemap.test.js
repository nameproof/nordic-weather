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
