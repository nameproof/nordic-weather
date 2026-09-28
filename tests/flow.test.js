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

const b64 = (...frames) => Buffer.concat(frames.map((f) => Buffer.from(f))).toString("base64")

test("flow: decodes base64 frames, padding included", async () => {
  const F = await load()
  for (const n of [1, 2, 3, 4, 3000]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255)
    assert.deepEqual(Array.from(F.decodeBase64(Buffer.from(bytes).toString("base64"))), Array.from(bytes), `${n} bytes`)
  }
  const frames = F.decodeFrames(b64([0, 1, 2, 3, 4, 255], [6, 7, 8, 9, 10, 11]) + "\n", 3, 2, 2)
  assert.equal(frames.length, 2)
  assert.deepEqual([frames[0].w, frames[0].h], [3, 2])
  assert.deepEqual(Array.from(frames[0].px), [0, 1, 2, 3, 4, 255])
  assert.deepEqual(Array.from(frames[1].px), [6, 7, 8, 9, 10, 11])
  assert.throws(() => F.decodeFrames(b64([1, 2, 3]), 3, 2, 2), /expected 12 bytes/)
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
  const frames = b64(...[0, 1, 2].map((k) => rainImage(w, h, 32, 24, 20, 2 * k, 0)))
  // Analysed at a quarter of the map size.
  const out = F.loopFlow(frames, w, h, 3, w * 4, h * 4)
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
  assert.equal(F.loopFlow(b64(new Uint8Array(w * h)), w, h, 1, w, h), null)
})

test("flow: pyramid follows motion beyond the former four-pixel search", async () => {
  const F = await load()
  const w = 128, h = 128, c = 3 * 8 + 3
  for (const [sx, sy] of [[6, 0], [8, 0], [-8, 4], [10, -3]]) {
    const f = F.blockMotion(rainImage(w, h, 64, 64, 40, 0, 0), rainImage(w, h, 64, 64, 40, sx, sy), w, h)
    assert.equal(f.known[c], 1, `motion ${sx},${sy} should be supported`)
    assert.ok(Math.abs(f.dx[c] - sx) < 0.4 && Math.abs(f.dy[c] - sy) < 0.4)
  }
})

test("flow: births, deaths, flat fields and search-limit hits are not confident motion", async () => {
  const F = await load()
  const w = 128, h = 128, dry = new Uint8Array(w * h)
  const rain = rainImage(w, h, 64, 64, 40, 0, 0)
  for (const [a, b] of [[dry, rain], [rain, dry], [new Uint8Array(w * h).fill(160), new Uint8Array(w * h).fill(160)]]) {
    const f = F.fillUnknown(F.blockMotion(a, b, w, h))
    assert.ok(Array.from(f.confidence).every(v => v === 0))
  }
  const limit = F.blockMotion(rain, rainImage(w, h, 64, 64, 40, F.MAX_MOTION, 0), w, h)
  assert.equal(limit.known[3 * limit.gx + 3], 0)
  const outside = F.blockMotion(rain, rainImage(w, h, 64, 64, 40, 16, 0), w, h)
  assert.equal(outside.known[3 * outside.gx + 3], 0, "a periodic alias must not be trusted")
})

test("flow: timestamp gaps fade and atlas carries confidence without clipping large motion", async () => {
  const F = await load()
  const w = 128, h = 128
  const bytes = b64(rainImage(w, h, 64, 64, 40, 0, 0), rainImage(w, h, 64, 64, 40, 8, 0))
  const gap = F.loopFlow(bytes, w, h, 2, w * 4, h * 4, { times: [0, 1200000] })
  assert.equal(gap.knownCells, 0)
  const full = F.loopFlow(bytes, w, h, 2, w * 8, h * 8, { times: [0, 300000] })
  const tokens = full.ppm.trim().split(/\s+/).slice(4).map(Number)
  assert.ok(tokens.every(v => Number.isInteger(v) && v >= 0 && v <= 255))
  assert.ok(tokens.filter((_, i) => i % 3 === 2).some(v => v > 200))
  const c = (3 * 8 + 3) * 3
  assert.ok(Math.abs((tokens[c] - 128) / full.unit - 64) < 2)
})
