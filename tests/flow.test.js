const test = require("node:test")
const assert = require("node:assert/strict")
const path = require("node:path")

const load = () => import(path.join(__dirname, "..", "Flow.mjs"))

// Rain with texture inside a disc, sampled at (x − sx, y − sy): the same
// field moved by (sx, sy), sub-pixel shifts included.
function rainImage(w, h, cx, cy, r, sx, sy) {
  const px = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x - sx
      const v = y - sy
      if ((u - cx) ** 2 + (v - cy) ** 2 > r * r) continue
      px[y * w + x] = Math.round(120 + 90 * Math.sin(u / 2.3) * Math.cos(v / 3.1))
    }
  }
  return px
}

function pgm(w, h, px) {
  const rows = []
  for (let y = 0; y < h; y++) rows.push(Array.from(px.subarray(y * w, (y + 1) * w)).join(" "))
  return `P2\n${w} ${h}\n255\n${rows.join("\n")}\n`
}

test("flow: parses concatenated ASCII PGMs", async () => {
  const F = await load()
  const images = F.parsePgms(pgm(3, 2, Uint8Array.from([0, 1, 2, 3, 4, 255])) + pgm(1, 1, Uint8Array.from([7])))
  assert.equal(images.length, 2)
  assert.deepEqual([images[0].w, images[0].h], [3, 2])
  assert.deepEqual(Array.from(images[0].px), [0, 1, 2, 3, 4, 255])
  assert.deepEqual(Array.from(images[1].px), [7])
  assert.throws(() => F.parsePgms("P5\n1 1\n255\nx"))
})

test("flow: finds whole and sub-pixel motion where it rains", async () => {
  const F = await load()
  const w = 96, h = 96
  for (const [sx, sy] of [[3, 2], [-2, 1], [1.5, -0.5]]) {
    const a = rainImage(w, h, 48, 48, 30, 0, 0)
    const b = rainImage(w, h, 48, 48, 30, sx, sy)
    const f = F.blockMotion(a, b, w, h)
    const c = 2 * f.gx + 2  // a cell well inside the rain
    assert.equal(f.known[c], 1)
    assert.ok(Math.abs(f.dx[c] - sx) < 0.35, `dx ${f.dx[c]} for ${sx}`)
    assert.ok(Math.abs(f.dy[c] - sy) < 0.35, `dy ${f.dy[c]} for ${sy}`)
  }
})

test("flow: dry cells are unknown, then filled from their neighbours", async () => {
  const F = await load()
  const w = 96, h = 96
  const a = rainImage(w, h, 24, 24, 14, 0, 0)
  const b = rainImage(w, h, 24, 24, 14, 2, 1)
  const f = F.blockMotion(a, b, w, h)
  const far = (f.gy - 1) * f.gx + f.gx - 1
  assert.equal(f.known[far], 0)
  F.fillUnknown(f)
  assert.ok(f.dx[far] > 1 && f.dy[far] > 0.3, "far cells take the rain's motion")
  // No rain at all: nothing to follow, no motion.
  const dry = F.fillUnknown(F.blockMotion(new Uint8Array(w * h), new Uint8Array(w * h), w, h))
  assert.ok(Array.from(dry.dx).every((v) => v === 0) && Array.from(dry.dy).every((v) => v === 0))
})

test("flow: a loop becomes a PPM atlas the shader can decode", async () => {
  const F = await load()
  const w = 64, h = 48
  const frames = [0, 1, 2].map((k) => pgm(w, h, rainImage(w, h, 32, 24, 20, 2 * k, 0))).join("")
  // Analysed at a quarter of the map size.
  const out = F.loopFlow(frames, w * 4, h * 4)
  assert.equal(out.pairs, 2)
  assert.deepEqual([out.gx, out.gy], [4, 3])
  assert.equal(out.cellW, F.CELL * 4)
  const tokens = out.ppm.trim().split(/\s+/)
  assert.deepEqual(tokens.slice(0, 4), ["P3", "4", "6", "255"])
  assert.equal(tokens.length, 4 + 4 * 6 * 3)
  // The middle cell of pair 0: 2 analysed px right = 8 map px → 128 + 8 × UNIT.
  const at = (p, i, j) => 4 + ((p * out.gy + j) * out.gx + i) * 3
  const red = Number(tokens[at(0, 1, 1)])
  assert.ok(Math.abs(red - (128 + 8 * F.UNIT)) <= 3, `red ${red}`)
  assert.ok(Math.abs(Number(tokens[at(0, 1, 1) + 1]) - 128) <= 3)
  assert.equal(F.loopFlow(pgm(w, h, new Uint8Array(w * h)), w, h), null)
})
