// Motion between consecutive radar frames, for the "flow" smoothing: the
// frames drawn between two radar frames move the rain along it instead of
// crossfading. Runs in a WorkerScript (FlowWorker.mjs) once per assembled
// loop; plain JavaScript, also loaded by the tests.
//
// Input: the loop's frames as quarter-size grey images of rain strength
// (ImageMagick's HCL chroma, so both black "no rain" and white "no
// coverage" are 0), as ASCII PGM. Output: one motion vector per CELL×CELL
// cell (≈64 px on the map) and frame pair, packed into a PPM image that
// the radar shader samples with bilinear filtering.
//
// V4 only JIT-compiles functions that are called repeatedly, so the hot
// loops live in small functions called per row or per candidate. Sizes are
// forced to integers (| 0): parseInt gives doubles, and typed-array indexes
// computed from a double take V4's slow path (≈15× slower here).

export const CELL = 16         // analysed px per grid cell
export const RADIUS = 4        // search ±4 analysed px (≈±16 px on the map)
export const RAIN = 16         // strength that counts as rain
export const MIN_RAIN_PX = 4   // less rain than this in both frames: motion unknown
export const UNIT = 4          // PPM encoding: 128 + 4 per map px (±31.75 px, 0.25 px steps)

// ---- PGM (P2) input

function skipSpace(text, pos) {
  let c = text.charCodeAt(pos)
  while (c === 32 || c === 10 || c === 13 || c === 9) c = text.charCodeAt(++pos)
  return pos
}

// One row of numbers into out[offset…]; returns the position after it.
function readRow(text, pos, out, offset, count) {
  for (let i = 0; i < count; i++) {
    pos = skipSpace(text, pos)
    let v = 0
    let c = text.charCodeAt(pos)
    while (c >= 48 && c <= 57) {
      v = v * 10 + c - 48
      c = text.charCodeAt(++pos)
    }
    out[offset + i] = v
  }
  return pos
}

function readToken(text, pos) {
  pos = skipSpace(text, pos)
  const start = pos
  let c = text.charCodeAt(pos)
  while (pos < text.length && c !== 32 && c !== 10 && c !== 13 && c !== 9) c = text.charCodeAt(++pos)
  return { value: text.slice(start, pos), pos: pos }
}

// Concatenated ASCII PGMs → [{ w, h, px: Uint8Array }].
export function parsePgms(text) {
  const images = []
  let pos = 0
  while (true) {
    pos = skipSpace(text, pos)
    if (pos >= text.length) break
    const magic = readToken(text, pos)
    if (magic.value !== "P2") throw new Error("not an ASCII PGM")
    const w = readToken(text, magic.pos)
    const h = readToken(text, w.pos)
    const max = readToken(text, h.pos)
    const width = parseInt(w.value, 10) | 0
    const height = parseInt(h.value, 10) | 0
    if (!(width > 0 && height > 0) || max.value !== "255") throw new Error("unsupported PGM")
    const px = new Uint8Array(width * height)
    pos = max.pos
    for (let y = 0; y < height; y++) pos = readRow(text, pos, px, y * width, width)
    images.push({ w: width, h: height, px: px })
  }
  return images
}

// ---- Block matching

function countRain(img, w, x0, y0, bw, bh) {
  let n = 0
  for (let y = 0; y < bh; y++) {
    const row = (y0 + y) * w + x0
    for (let x = 0; x < bw; x++) if (img[row + x] >= RAIN) n++
  }
  return n
}

// Sum of absolute differences between a's block and b's block moved by (dx, dy).
function sad(a, b, w, x0, y0, bw, bh, dx, dy) {
  let s = 0
  for (let y = 0; y < bh; y++) {
    const ia = (y0 + y) * w + x0
    const ib = ia + dy * w + dx
    for (let x = 0; x < bw; x++) {
      const d = a[ia + x] - b[ib + x]
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

// Motion of each cell from image a to image b, in analysed px.
// → { dx, dy: Float32Array, known: Uint8Array } over a gx×gy grid.
export function blockMotion(a, b, w, h) {
  w = w | 0
  h = h | 0
  const gx = Math.ceil(w / CELL)
  const gy = Math.ceil(h / CELL)
  const side = 2 * RADIUS + 1
  const dxs = new Float32Array(gx * gy)
  const dys = new Float32Array(gx * gy)
  const known = new Uint8Array(gx * gy)
  const cost = new Float64Array(side * side)
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      // The block stays far enough from the edges for the whole search.
      const x0 = Math.max(i * CELL, RADIUS)
      const y0 = Math.max(j * CELL, RADIUS)
      const bw = Math.min((i + 1) * CELL, w - RADIUS) - x0
      const bh = Math.min((j + 1) * CELL, h - RADIUS) - y0
      if (bw < 4 || bh < 4) continue
      if (countRain(a, w, x0, y0, bw, bh) < MIN_RAIN_PX && countRain(b, w, x0, y0, bw, bh) < MIN_RAIN_PX) continue
      // A small penalty on distance settles ties (flat rain) on less motion.
      const penalty = bw * bh * 0.05
      let best = -1
      let bestCost = Infinity
      for (let dy = -RADIUS; dy <= RADIUS; dy++) {
        for (let dx = -RADIUS; dx <= RADIUS; dx++) {
          const k = (dy + RADIUS) * side + dx + RADIUS
          cost[k] = sad(a, b, w, x0, y0, bw, bh, dx, dy)
          const c = cost[k] + penalty * (dx * dx + dy * dy)
          if (c < bestCost) { bestCost = c; best = k }
        }
      }
      const bx = best % side - RADIUS
      const by = Math.floor(best / side) - RADIUS
      let fx = bx
      let fy = by
      if (bx > -RADIUS && bx < RADIUS) fx += subpixel(cost[best - 1], cost[best], cost[best + 1])
      if (by > -RADIUS && by < RADIUS) fy += subpixel(cost[best - side], cost[best], cost[best + side])
      const c = j * gx + i
      dxs[c] = fx
      dys[c] = fy
      known[c] = 1
    }
  }
  return { gx: gx, gy: gy, dx: dxs, dy: dys, known: known }
}

// ---- Cleaning up the field

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
        for (let v = -1; v <= 1; v++) {
          for (let u = -1; u <= 1; u++) {
            const x = i + u
            const y = j + v
            if (x < 0 || y < 0 || x >= gx || y >= gy || !known[y * gx + x]) continue
            sx += field.dx[y * gx + x]
            sy += field.dy[y * gx + x]
            n++
          }
        }
        if (n) {
          field.dx[c] = sx / n
          field.dy[c] = sy / n
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
export function smoothTime(fields) {
  return fields.map(function(f, p) {
    const prev = fields[p - 1] || f
    const next = fields[p + 1] || f
    const dx = new Float32Array(f.dx.length)
    const dy = new Float32Array(f.dy.length)
    for (let c = 0; c < dx.length; c++) {
      dx[c] = (prev.dx[c] + 2 * f.dx[c] + next.dx[c]) / 4
      dy[c] = (prev.dy[c] + 2 * f.dy[c] + next.dy[c]) / 4
    }
    return { gx: f.gx, gy: f.gy, dx: dx, dy: dy, known: f.known }
  })
}

// ---- Output

function encode(v) {
  return Math.max(0, Math.min(255, Math.round(128 + v * UNIT)))
}

// Fields (map px) stacked top to bottom, one gx×gy block per pair, as an
// ASCII PPM: red = x motion, green = y motion (128 = none, UNIT per px).
export function flowAtlas(fields, scaleX, scaleY) {
  const gx = fields[0].gx
  const gy = fields[0].gy
  const rows = ["P3", gx + " " + gy * fields.length, "255"]
  for (let p = 0; p < fields.length; p++) {
    for (let j = 0; j < gy; j++) {
      const row = []
      for (let i = 0; i < gx; i++) {
        const c = j * gx + i
        row.push(encode(fields[p].dx[c] * scaleX) + " " + encode(fields[p].dy[c] * scaleY) + " 128")
      }
      rows.push(row.join(" "))
    }
  }
  return rows.join("\n") + "\n"
}

// The whole loop: PGM text of n frames → atlas of n − 1 fields, with the
// numbers the shader needs (grid size, cell size in map px).
export function loopFlow(pgmText, mapWidth, mapHeight) {
  const images = parsePgms(pgmText)
  if (images.length < 2) return null
  const w = images[0].w
  const h = images[0].h
  const scaleX = mapWidth / w
  const scaleY = mapHeight / h
  let raw = []
  let knownCells = 0
  for (let p = 0; p + 1 < images.length; p++) {
    const f = blockMotion(images[p].px, images[p + 1].px, w, h)
    for (let c = 0; c < f.known.length; c++) knownCells += f.known[c]
    raw.push(medianField(fillUnknown(f)))
  }
  const fields = smoothTime(raw)
  return {
    ppm: flowAtlas(fields, scaleX, scaleY),
    gx: fields[0].gx,
    gy: fields[0].gy,
    pairs: fields.length,
    cellW: CELL * scaleX,
    cellH: CELL * scaleY,
    unit: UNIT,
    knownCells: knownCells
  }
}
