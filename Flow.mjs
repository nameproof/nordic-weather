// Motion between consecutive radar frames, for the "flow" smoothing: the
// frames drawn between two radar frames move the rain along it instead of
// crossfading. Runs in a WorkerScript (FlowWorker.mjs) once per assembled
// loop; plain JavaScript, also loaded by the tests.
//
// Input: the loop's frames as quarter-size grey images of rain strength
// (ImageMagick's HCL chroma, so both black "no rain" and white "no
// coverage" are 0), base64. Output: one motion vector per CELL×CELL
// cell (≈64 px on the map) and frame pair, packed into a PPM image that
// the radar shader samples with bilinear filtering.
//
// V4 only JIT-compiles functions that are called repeatedly, so the hot
// loops live in small functions called per chunk or per candidate. Sizes
// are forced to integers (| 0): typed-array indexes computed from a double
// take V4's slow path (≈15× slower here).

export const CELL = 16         // analysed px per grid cell
export const RADIUS = 3        // coarsest search, followed by two ±2 refinements
export const MAX_MOTION = 12   // analysed px (≈48 map px); boundary matches rejected
export const RAIN = 16         // strength that counts as rain
export const MIN_RAIN_PX = 4   // less rain than this in both frames: motion unknown
export const UNIT = 2          // default packing: ±63.5 map px, 0.5 px steps

// ---- Input: the frames as raw 8-bit grey, w×h each, one after another,
// base64-encoded (4 characters per 3 bytes): the densest form text takes,
// and text is what a StdioCollector gives and what survives a message to a
// WorkerScript (ArrayBuffers arrive empty).

const B64 = (function() {
  const table = new Int16Array(128).fill(-1)
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  for (let i = 0; i < chars.length; i++) table[chars.charCodeAt(i)] = i
  return table
})()

// `groups` groups of 4 characters from text[pos…] into out[at…].
function decodeGroups(text, pos, out, at, groups) {
  for (let g = 0; g < groups; g++) {
    const n = (B64[text.charCodeAt(pos)] << 18) | (B64[text.charCodeAt(pos + 1)] << 12)
      | ((B64[text.charCodeAt(pos + 2)] & 63) << 6) | (B64[text.charCodeAt(pos + 3)] & 63)
    out[at] = (n >> 16) & 255
    out[at + 1] = (n >> 8) & 255
    out[at + 2] = n & 255
    pos += 4
    at += 3
  }
}

export function decodeBase64(text) {
  const length = text.length - text.length % 4
  const pad = length && text.charAt(length - 1) === "=" ? (text.charAt(length - 2) === "=" ? 2 : 1) : 0
  const out = new Uint8Array(length / 4 * 3)
  const chunk = 1024
  for (let g = 0; g < length / 4; g += chunk)
    decodeGroups(text, g * 4, out, g * 3, Math.min(chunk, length / 4 - g))
  return out.subarray(0, out.length - pad)
}

// → [{ w, h, px: Uint8Array }], one per frame.
export function decodeFrames(text, w, h, count) {
  w = w | 0
  h = h | 0
  const bytes = decodeBase64(text.trim())
  if (bytes.length !== w * h * count) throw new Error("expected " + w * h * count + " bytes, got " + bytes.length)
  const frames = []
  for (let k = 0; k < count; k++) frames.push({ w: w, h: h, px: bytes.subarray(k * w * h, (k + 1) * w * h) })
  return frames
}

// ---- Block matching

function countRain(img, w, x0, y0, bw, bh) {
  w |= 0; x0 |= 0; y0 |= 0; bw |= 0; bh |= 0
  let n = 0
  for (let y = 0; y < bh; y++) {
    const row = ((y0 + y) * w + x0) | 0
    for (let x = 0; x < bw; x++) if (img[(row + x) | 0] >= RAIN) n++
  }
  return n
}

// Sum of absolute differences between a's block and b's block moved by (dx, dy).
function sad(a, b, w, x0, y0, bw, bh, dx, dy) {
  w |= 0; x0 |= 0; y0 |= 0; bw |= 0; bh |= 0; dx |= 0; dy |= 0
  let s = 0
  for (let y = 0; y < bh; y++) {
    const ia = ((y0 + y) * w + x0) | 0
    const ib = (ia + dy * w + dx) | 0
    for (let x = 0; x < bw; x++) {
      const d = a[(ia + x) | 0] - b[(ib + x) | 0]
      s += d < 0 ? -d : d
    }
  }
  return s
}

// Sub-pixel offset of a minimum from its two neighbours (parabola fit).
function subpixel(before, at, after) {
  const denom = before - 2 * at + after
  if (!(denom > 0)) return 0
  return Math.max(-0.5, Math.min(0.5, 0.5 * (before - after) / denom))
}

// Three-level, box-filtered pyramid. Built once per frame, not per pair.
function pyramid(px, w, h) {
  const levels = [{ px: px, w: w, h: h }]
  for (let level = 1; level < 3; level++) {
    const prev = levels[level - 1]
    const nw = Math.ceil(prev.w / 2), nh = Math.ceil(prev.h / 2)
    const out = new Uint8Array(nw * nh)
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const x0 = 2 * x, x1 = Math.min(x0 + 1, prev.w - 1)
        const y0 = 2 * y, y1 = Math.min(y0 + 1, prev.h - 1)
        out[y * nw + x] = (prev.px[y0 * prev.w + x0] + prev.px[y0 * prev.w + x1]
          + prev.px[y1 * prev.w + x0] + prev.px[y1 * prev.w + x1] + 2) >> 2
      }
    }
    levels.push({ px: out, w: nw, h: nh })
  }
  return levels
}

function textureDetail(a, w, x0, y0, bw, bh) {
  w |= 0; x0 |= 0; y0 |= 0; bw |= 0; bh |= 0
  let sum = 0, squares = 0
  for (let y = 0; y < bh; y++) {
    const row = ((y0 + y) * w + x0) | 0
    for (let x = 0; x < bw; x++) {
      const v = a[(row + x) | 0]
      sum += v
      squares += v * v
    }
  }
  const n = bw * bh
  return Math.sqrt(Math.max(0, squares / n - (sum / n) * (sum / n)))
}

// Bounded SAD search around a pyramid prediction. A candidate must have
// its complete block in bounds; comparing differently cropped blocks
// would favour motion out of the viewport.
function search(a, b, cx, cy, px, py, radius, limit, block, detailed = true) {
  const w = a.w | 0, h = a.h | 0
  const bw = Math.min(block, w) | 0, bh = Math.min(block, h) | 0
  const x0 = Math.max(0, Math.min(w - bw, Math.floor(cx - bw / 2))) | 0
  const y0 = Math.max(0, Math.min(h - bh, Math.floor(cy - bh / 2))) | 0
  px = Math.round(px) | 0
  py = Math.round(py) | 0
  const side = 2 * radius + 1
  const costs = new Float64Array(side * side).fill(Infinity)
  let best = -1, bestCost = Infinity
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      const dx = (px + x) | 0, dy = (py + y) | 0
      if (Math.abs(dx) > limit || Math.abs(dy) > limit || x0 + dx < 0 || y0 + dy < 0
          || x0 + bw + dx > w || y0 + bh + dy > h) continue
      const k = (y + radius) * side + x + radius
      const cost = sad(a.px, b.px, w, x0, y0, bw, bh, dx, dy) / (bw * bh)
      costs[k] = cost
      const ranked = cost + 0.015 * (dx * dx + dy * dy)
      if (ranked < bestCost) { bestCost = ranked; best = k }
    }
  }
  if (best < 0) return null
  const bx = best % side, by = Math.floor(best / side)
  const dx = px + bx - radius, dy = py + by - radius
  if (!detailed) return { dx: dx, dy: dy }
  let second = Infinity
  for (let k = 0; k < costs.length; k++) {
    if (Math.abs(k % side - bx) > 1 || Math.abs(Math.floor(k / side) - by) > 1)
      second = Math.min(second, costs[k])
  }
  let fx = dx, fy = dy
  if (bx > 0 && bx + 1 < side && isFinite(costs[best - 1]) && isFinite(costs[best + 1]))
    fx += subpixel(costs[best - 1], costs[best], costs[best + 1])
  if (by > 0 && by + 1 < side && isFinite(costs[best - side]) && isFinite(costs[best + side]))
    fy += subpixel(costs[best - side], costs[best], costs[best + side])
  return { dx: dx, dy: dy, fx: fx, fy: fy, cost: costs[best], second: second,
    zero: sad(a.px, b.px, w, x0, y0, bw, bh, 0, 0) / (bw * bh),
    detail: textureDetail(a.px, w, x0, y0, bw, bh),
    rainA: countRain(a.px, w, x0, y0, bw, bh),
    rainB: countRain(b.px, w, x0 + dx, y0 + dy, bw, bh) }
}

function verifyContext(a, b, cx, cy, dx, dy) {
  const w = a.w | 0, h = a.h | 0
  const block = Math.max(CELL, Math.min(CELL * 4, Math.min(w, h) - 2 * MAX_MOTION))
  const bw = Math.min(block, w) | 0, bh = Math.min(block, h) | 0
  const x0 = Math.max(0, Math.min(w - bw, Math.floor(cx - bw / 2))) | 0
  const y0 = Math.max(0, Math.min(h - bh, Math.floor(cy - bh / 2))) | 0
  if (x0 + dx < 0 || y0 + dy < 0 || x0 + bw + dx > w || y0 + bh + dy > h) return false
  const cost = sad(a.px, b.px, w, x0, y0, bw, bh, dx, dy) / (bw * bh)
  return cost <= Math.max(8, textureDetail(a.px, w, x0, y0, bw, bh) * 0.3)
}

function emptyField(w, h) {
  const gx = Math.ceil(w / CELL), gy = Math.ceil(h / CELL), n = gx * gy
  return { gx: gx, gy: gy, dx: new Float32Array(n), dy: new Float32Array(n),
    known: new Uint8Array(n), confidence: new Float32Array(n) }
}

function pyramidMotion(a, b) {
  const f = emptyField(a[0].w, a[0].h)
  const coarse = [], coarseWidth = Math.ceil(f.gx / 2)
  for (let j = 0; j < f.gy; j++) {
    for (let i = 0; i < f.gx; i++) {
      const cx = Math.min((i + 0.5) * CELL, a[0].w - 1)
      const cy = Math.min((j + 0.5) * CELL, a[0].h - 1)
      // Dry source blocks can't establish a motion correspondence.
      const x0 = Math.max(0, Math.min(a[0].w - CELL, i * CELL)) | 0
      const y0 = Math.max(0, Math.min(a[0].h - CELL, j * CELL)) | 0
      if (countRain(a[0].px, a[0].w, x0, y0, Math.min(CELL, a[0].w), Math.min(CELL, a[0].h)) < MIN_RAIN_PX) continue
      // Neighbouring cells share a broad coarse prediction; each still
      // gets its own two refinements and confidence checks. Re-searching
      // these heavily overlapping coarse patches costs most in wet scenes.
      const ci = Math.floor(i / 2), cj = Math.floor(j / 2), ck = cj * coarseWidth + ci
      if (coarse[ck] === undefined)
        coarse[ck] = search(a[2], b[2], (ci * 2 + 1) * CELL / 4, (cj * 2 + 1) * CELL / 4,
          0, 0, RADIUS, MAX_MOTION / 4, 16, false)
      let match = coarse[ck]
      if (!match) continue
      for (let level = 1; level >= 0; level--) {
        const scale = 1 << level
        match = search(a[level], b[level], cx / scale, cy / scale,
          match.dx * 2, match.dy * 2, 2, MAX_MOTION / scale, Math.max(8, CELL / scale), level === 0)
        if (!match) break
      }
      if (!match || match.rainA < MIN_RAIN_PX || match.rainB < MIN_RAIN_PX || match.detail < 5) continue
      if (Math.abs(match.dx) >= MAX_MOTION || Math.abs(match.dy) >= MAX_MOTION) continue
      // Residual error, an ambiguous minimum, or barely improving on no
      // movement means that advection is less credible than a fade.
      const quality = 1 - match.cost / Math.max(12, match.detail * 0.8)
      const distinct = isFinite(match.second) ? (match.second - match.cost) / Math.max(4, match.second) : 0
      if (quality < 0.25 || distinct < 0.08) continue
      if ((Math.abs(match.dx) > 1 || Math.abs(match.dy) > 1) && match.cost > match.zero * 0.85) continue
      // Repeated texture can fit a small block in the wrong place. Verify
      // the winning displacement on wider context before accepting it.
      if (!verifyContext(a[0], b[0], cx, cy, match.dx, match.dy)) continue
      const c = j * f.gx + i
      f.dx[c] = match.fx
      f.dy[c] = match.fy
      f.confidence[c] = Math.min(1, quality * 1.5) * Math.min(1, distinct * 3)
      f.known[c] = 1
    }
  }
  return f
}

// Motion in analysis pixels. Exposed separately for regression fixtures.
export function blockMotion(a, b, w, h) {
  return pyramidMotion(pyramid(a, w | 0, h | 0), pyramid(b, w | 0, h | 0))
}

// ---- Cleaning up the field

// Discard isolated vectors before they can spread into dry/ambiguous cells.
export function rejectOutliers(field) {
  const known = field.known.slice()
  for (let j = 0; j < field.gy; j++) {
    for (let i = 0; i < field.gx; i++) {
      const c = j * field.gx + i
      if (!known[c]) continue
      const xs = [], ys = []
      for (let v = -1; v <= 1; v++) {
        for (let u = -1; u <= 1; u++) {
          const x = i + u, y = j + v, k = y * field.gx + x
          if ((!u && !v) || x < 0 || y < 0 || x >= field.gx || y >= field.gy || !known[k]) continue
          xs.push(field.dx[k]); ys.push(field.dy[k])
        }
      }
      if (xs.length < 4) continue
      const mx = median9(xs, xs.length), my = median9(ys, ys.length)
      const deviations = xs.map(function(x, k) { return Math.hypot(x - mx, ys[k] - my) })
      const limit = Math.max(3, 3 * median9(deviations, deviations.length))
      if (Math.hypot(field.dx[c] - mx, field.dy[c] - my) > limit) {
        field.known[c] = 0
        field.confidence[c] = 0
      }
    }
  }
  return field
}

// Unknown cells (dry) take the mean of known neighbours, growing outwards,
// so rain near dry cells isn't pulled towards zero by the interpolation.
export function fillUnknown(field) {
  const gx = field.gx
  const gy = field.gy
  let known = field.known.slice()
  for (let pass = 0; pass < gx + gy; pass++) {
    const next = known.slice()
    let changed = false
    for (let j = 0; j < gy; j++) {
      for (let i = 0; i < gx; i++) {
        const c = j * gx + i
        if (known[c]) continue
        let sx = 0
        let sy = 0
        let n = 0
        let weight = 0
        for (let v = -1; v <= 1; v++) {
          for (let u = -1; u <= 1; u++) {
            const x = i + u
            const y = j + v
            if (x < 0 || y < 0 || x >= gx || y >= gy || !known[y * gx + x]) continue
            const k = y * gx + x
            const confidence = field.confidence[k]
            sx += field.dx[k] * confidence
            sy += field.dy[k] * confidence
            weight += confidence
            n++
          }
        }
        if (weight > 0) {
          field.dx[c] = sx / weight
          field.dy[c] = sy / weight
          field.confidence[c] = weight / n * 0.96
          next[c] = 1
          changed = true
        }
      }
    }
    known = next
    if (!changed) break
  }
  return field
}

function median9(values, n) {
  const s = Array.prototype.slice.call(values, 0, n).sort(function(p, q) { return p - q })
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
}

// 3×3 median per component: removes single wrong matches.
export function medianField(field) {
  const gx = field.gx
  const gy = field.gy
  const outX = new Float32Array(gx * gy)
  const outY = new Float32Array(gx * gy)
  const bx = new Float64Array(9)
  const by = new Float64Array(9)
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      let n = 0
      for (let v = -1; v <= 1; v++) {
        for (let u = -1; u <= 1; u++) {
          const x = i + u
          const y = j + v
          if (x < 0 || y < 0 || x >= gx || y >= gy) continue
          bx[n] = field.dx[y * gx + x]
          by[n] = field.dy[y * gx + x]
          n++
        }
      }
      outX[j * gx + i] = median9(bx, n)
      outY[j * gx + i] = median9(by, n)
    }
  }
  field.dx = outX
  field.dy = outY
  return field
}

// Rain moves steadily over a few frames: blend each pair's field with its
// neighbours (1-2-1), which also calms noisy single pairs.
export function smoothTime(fields, segments) {
  return fields.map(function(f, p) {
    const prev = fields[p - 1] && (!segments || segments[p - 1] === segments[p]) ? fields[p - 1] : f
    const next = fields[p + 1] && (!segments || segments[p + 1] === segments[p]) ? fields[p + 1] : f
    const dx = new Float32Array(f.dx.length)
    const dy = new Float32Array(f.dy.length)
    for (let c = 0; c < dx.length; c++) {
      if (!f.confidence[c]) continue
      const a = prev.confidence[c], b = 2 * f.confidence[c], d = next.confidence[c]
      dx[c] = (prev.dx[c] * a + f.dx[c] * b + next.dx[c] * d) / (a + b + d)
      dy[c] = (prev.dy[c] * a + f.dy[c] * b + next.dy[c] * d) / (a + b + d)
    }
    return { gx: f.gx, gy: f.gy, dx: dx, dy: dy, known: f.known, confidence: f.confidence }
  })
}

// ---- Output

function encode(v, unit) {
  return Math.max(0, Math.min(255, Math.round(128 + v * unit)))
}

// Fields (map px) stacked top to bottom, one gx×gy block per pair, as an
// ASCII PPM: red = x motion, green = y motion (128 = none, UNIT per px).
export function flowAtlas(fields, scaleX, scaleY, unit = UNIT) {
  const gx = fields[0].gx
  const gy = fields[0].gy
  const rows = ["P3", gx + " " + gy * fields.length, "255"]
  for (let p = 0; p < fields.length; p++) {
    for (let j = 0; j < gy; j++) {
      const row = []
      for (let i = 0; i < gx; i++) {
        const c = j * gx + i
        row.push(encode(fields[p].dx[c] * scaleX, unit) + " " + encode(fields[p].dy[c] * scaleY, unit)
          + " " + Math.round(255 * fields[p].confidence[c]))
      }
      rows.push(row.join(" "))
    }
  }
  return rows.join("\n") + "\n"
}

// The whole loop: count frames of w×h (base64) → atlas of count − 1
// fields, with the numbers the shader needs (grid size, cell size in map px).
export function loopFlow(data, w, h, count, mapWidth, mapHeight, options = {}) {
  if (count < 2) return null
  const images = decodeFrames(data, w, h, count)
  w = w | 0
  h = h | 0
  const scaleX = mapWidth / w
  const scaleY = mapHeight / h
  const unit = Math.min(UNIT, 120 / (MAX_MOTION * Math.max(scaleX, scaleY)))
  const raw = [], segments = [], levels = []
  let knownCells = 0
  let segment = 0
  for (let p = 0; p + 1 < images.length; p++) {
    const continuous = !options.times || options.times[p + 1] - options.times[p] === 300000
    const boundary = options.forecast && options.forecast[p] !== options.forecast[p + 1]
    if (!continuous || boundary) segment++
    segments.push(segment)
    if (!continuous || boundary) segment++
    let f
    if (!continuous) {
      f = emptyField(w, h)
    } else {
      if (!levels[p]) levels[p] = pyramid(images[p].px, w, h)
      if (!levels[p + 1]) levels[p + 1] = pyramid(images[p + 1].px, w, h)
      f = rejectOutliers(pyramidMotion(levels[p], levels[p + 1]))
    }
    for (let c = 0; c < f.known.length; c++) knownCells += f.known[c]
    raw.push(medianField(fillUnknown(f)))
    levels[p] = null
  }
  const fields = smoothTime(raw, segments)
  return {
    ppm: flowAtlas(fields, scaleX, scaleY, unit),
    gx: fields[0].gx,
    gy: fields[0].gy,
    pairs: fields.length,
    cellW: CELL * scaleX,
    cellH: CELL * scaleY,
    unit: unit,
    knownCells: knownCells
  }
}
