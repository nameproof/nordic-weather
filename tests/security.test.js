const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const net = require("node:net")
const { spawnSync, execFileSync } = require("node:child_process")
const M = require("./load-model.js")
const { withHttpsServer, runCommand } = require("./network.js")

const NOW = Date.parse("2026-10-01T12:00:00Z")
const template = "https://tiles.yr.no/test/{z}/{x}/{y}.png"
const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8")
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nordic-security-"))
const execute = (cmd, env) => spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", env, timeout: 15000 })
const index = (times, url = template) => JSON.stringify({ times: times.map((ms) => ({
  time: new Date(ms).toISOString(), tiles: { png: url }
})) })

test("radar indexes admit only the exact HTTPS tile origin", () => {
  for (const url of [
    "file:///tmp/tile.png", "dict://127.0.0.1:6379/SET:key:value", "http://tiles.yr.no/x",
    "https://elsewhere.test/x", "https://tiles.yr.no.evil.test/x", "https://tiles.yr.no@evil.test/x",
    "https://tiles.yr.no:444/x", "https://tiles.yr.no\\@evil.test/x", "https://tiles.yr.no/x\n",
    "--upload-file=/tmp/marker", "--proto=all"
  ]) {
    assert.deepEqual(M.parseTileIndex(index([NOW], url), NOW), [], url)
    assert.equal(M.tileUrl(url, 6, 1, 2), "", url)
  }
  assert.equal(M.parseTileIndex(index([NOW]), NOW).length, 1)
  assert.equal(M.tileUrl(template, 6, 1, 2), "https://tiles.yr.no/test/6/1/2.png")
})

test("real curl downloads HTTPS tiles without protocol, option or glob injection", async () => {
  const dir = temp()
  const sockets = net.createServer((socket) => { connections++; socket.end() })
  let connections = 0
  await new Promise((resolve) => sockets.listen(0, "127.0.0.1", resolve))
  try {
    const marker = path.join(dir, "private.txt")
    fs.writeFileSync(marker, "private marker")
    const seen = []
    await withHttpsServer((req, res) => {
      seen.push({ url: req.url, method: req.method })
      res.end("tile")
    }, async (base, env) => {
      const port = sockets.address().port
      const downloads = [
        { url: "file://" + marker, file: "r_file.png" },
        { url: "dict://127.0.0.1:" + port + "/SET:key:value", file: "r_dict.png" },
        { url: "http://127.0.0.1:" + port + "/tile", file: "r_http.png" },
        { url: "--upload-file=" + marker, file: "r_option.png" },
        { url: base + "/literal[1-3].png", file: "r_good.png" }
      ]
      const r = await runCommand(M.tileDownloadCommand(path.join(dir, "cache", "tiles"), downloads, "test"), env)
      assert.equal(r.code, 0, r.stderr)
      assert.equal(r.stdout.trim(), "1 4")
      assert.deepEqual(seen, [{ url: "/literal[1-3].png", method: "GET" }])
      assert.equal(connections, 0)
      assert.deepEqual(fs.readdirSync(path.join(dir, "cache", "tiles")), ["r_good.png"])

      // The generic API helper also restricts protocols and consumes the
      // URL as a value. These never become local reads or curl options.
      for (const url of ["file://" + marker, "http://127.0.0.1:" + port + "/", "--upload-file=" + marker]) {
        const blocked = await runCommand(M.curlCommand(url, "", 2, "test"), env)
        assert.equal(blocked.bytes, 0, url)
        assert.ok(blocked.stderr.length > 0, url)
      }
      assert.equal(connections, 0)
      assert.equal(fs.readFileSync(marker, "utf8"), "private marker")
    })
  } finally {
    sockets.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("downloads replace final symlinks and never write through planted partial files", async () => {
  const dir = temp()
  try {
    const tiles = path.join(dir, "cache", "tiles")
    fs.mkdirSync(tiles, { recursive: true })
    const marker = path.join(dir, "outside.txt")
    fs.writeFileSync(marker, "untouched")
    fs.symlinkSync(marker, path.join(tiles, "r_test.png"))
    fs.symlinkSync(marker, path.join(tiles, "r_test.png.part"))
    await withHttpsServer((req, res) => res.end("new tile"), async (base, env) => {
      const r = await runCommand(M.tileDownloadCommand(tiles, [{ url: base + "/tile", file: "r_test.png" }], "test"), env)
      assert.equal(r.code, 0, r.stderr)
      assert.equal(r.stdout.trim(), "1 0")
    })
    assert.equal(fs.readFileSync(marker, "utf8"), "untouched")
    assert.equal(fs.lstatSync(path.join(tiles, "r_test.png")).isSymbolicLink(), false)
    assert.equal(fs.readFileSync(path.join(tiles, "r_test.png"), "utf8"), "new tile")
    assert.ok(fs.lstatSync(path.join(tiles, "r_test.png.part")).isSymbolicLink())
    assert.ok(!fs.readdirSync(tiles).some((name) => name.startsWith(".nw-")))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("cache setup, downloads and composition refuse linked roots or tiles folders", () => {
  const dir = temp()
  try {
    const outside = path.join(dir, "outside")
    fs.mkdirSync(path.join(outside, "tiles"), { recursive: true })
    for (const base of [outside, path.join(outside, "tiles")]) {
      for (const name of ["r_old.png", "f_old.png"]) {
        const file = path.join(base, name)
        fs.writeFileSync(file, "keep")
        const old = new Date(Date.now() - 3 * 3600000)
        fs.utimesSync(file, old, old)
      }
    }
    const linkedRoot = path.join(dir, "linked-root")
    fs.symlinkSync(outside, linkedRoot)
    const linkedTiles = path.join(dir, "linked-tiles")
    fs.mkdirSync(linkedTiles)
    fs.symlinkSync(outside, path.join(linkedTiles, "tiles"))
    const invalidRoot = path.join(dir, "file-root")
    fs.writeFileSync(invalidRoot, "not a directory")
    for (const cache of [linkedRoot, linkedTiles, invalidRoot]) {
      for (const cmd of [
        M.cacheSetupCommand(cache, path.join(dir, "settings")),
        M.tileDownloadCommand(path.join(cache, "tiles"), [], "test"),
        M.frameComposeCommand(path.join(cache, "tiles"), 256, 192, 256, [])
      ]) {
        const r = execute(cmd)
        assert.notEqual(r.status, 0)
        assert.match(r.stderr, /refusing a linked or invalid cache directory/)
      }
    }
    for (const base of [outside, path.join(outside, "tiles")])
      for (const name of ["r_old.png", "f_old.png"])
        assert.equal(fs.readFileSync(path.join(base, name), "utf8"), "keep")

    // Redirecting XDG_CACHE_HOME above the plugin directory is supported.
    const parent = path.join(dir, "parent")
    fs.symlinkSync(outside, parent)
    const safeRoot = path.join(parent, "plugin")
    assert.equal(execute(M.cacheSetupCommand(safeRoot, path.join(dir, "settings"))).status, 0)
    assert.ok(fs.statSync(path.join(safeRoot, "tiles")).isDirectory())
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("ImageMagick rejects disguised formats and oversized PNG tiles", {
  skip: !fs.existsSync("/usr/bin/magick") && "ImageMagick required"
}, () => {
  const dir = temp()
  try {
    const tiles = path.join(dir, "cache", "tiles")
    fs.mkdirSync(tiles, { recursive: true })
    fs.writeFileSync(path.join(tiles, "r_ps.png"),
      "%!PS-Adobe-3.0\n%%BoundingBox: 0 0 256 256\n1 0 0 setrgbcolor 0 0 256 256 rectfill showpage\n")
    fs.writeFileSync(path.join(tiles, "r_svg.png"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="red"/></svg>')
    execFileSync("magick", ["-size", "257x256", "xc:red", path.join(tiles, "r_wide.png")])
    execFileSync("magick", ["-size", "256x257", "xc:red", path.join(tiles, "r_tall.png")])
    for (const kind of ["ps", "svg", "wide", "tall"]) {
      const r = execute(M.frameComposeCommand(tiles, 659, 761, 512, ["f_" + kind + ".png|r_" + kind + ".png:0:0"]))
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout.trim(), "1 0", kind)
      assert.ok(!fs.existsSync(path.join(tiles, "f_" + kind + ".png")), kind)
    }
    assert.ok(!fs.readdirSync(tiles).some((name) => name.startsWith(".nw-")))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("bounded PNG composition preserves larger canvases, scaled tiles and final symlink targets", {
  skip: !fs.existsSync("/usr/bin/magick") && "ImageMagick required"
}, () => {
  const dir = temp()
  try {
    const tiles = path.join(dir, "cache", "tiles")
    fs.mkdirSync(tiles, { recursive: true })
    execFileSync("magick", ["-size", "256x256", "xc:blue", path.join(tiles, "r_blue.png")])
    const marker = path.join(dir, "outside.txt")
    fs.writeFileSync(marker, "untouched")
    fs.symlinkSync(marker, path.join(tiles, "f_test.png"))
    fs.symlinkSync(marker, path.join(tiles, "f_test.png.part"))
    // Many sequential composites must work with the small image-list cap.
    const spec = "f_test.png" + Array.from({ length: 25 }, (_, i) => "|r_blue.png:" + (i % 5 * 100) + ":" + (Math.floor(i / 5) * 100)).join("")
    const r = execute(M.frameComposeCommand(tiles, 659, 761, 512, [spec]))
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), "1 1")
    assert.equal(fs.readFileSync(marker, "utf8"), "untouched")
    assert.ok(!fs.lstatSync(path.join(tiles, "f_test.png")).isSymbolicLink())
    const info = execFileSync("magick", [path.join(tiles, "f_test.png"), "-format", "%wx%h %[pixel:p{600,700}]", "info:"], { encoding: "utf8" })
    assert.match(info, /^659x761 .*blue|^659x761 .*\(0,0,255\)/)
    assert.ok(!fs.readdirSync(tiles).some((name) => name.startsWith(".nw-")))
    assert.equal(execute(M.frameComposeCommand(tiles, 2000, 761, 512, [spec])).status, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("radar work is bounded across both indexes and ignores distant or duplicate frames", () => {
  const observations = Array.from({ length: 200 }, (_, i) => NOW - i * 60000)
  const forecasts = Array.from({ length: 200 }, (_, i) => NOW + (i + 1) * 60000)
  const radar = M.radarFrames(index(observations.concat(observations)), index(forecasts), NOW)
  assert.equal(radar.frames.length, 60)
  assert.equal(radar.nowIndex, 35)
  assert.equal(radar.frames[radar.nowIndex].timeMs, NOW)
  assert.ok(radar.frames.every((frame, i) => i === 0 || frame.timeMs > radar.frames[i - 1].timeMs))
  assert.equal(radar.frames[0].timeMs, NOW - 35 * 60000)
  assert.equal(radar.frames.at(-1).timeMs, NOW + 24 * 60000)
  assert.deepEqual(M.parseTileIndex(index([NOW - 13 * 3600000, NOW + 13 * 3600000]), NOW), [])
  // A radar hours late still shows, with its delay note.
  const late = M.radarFrames(index([NOW - 5 * 3600000 - 300000, NOW - 5 * 3600000]), "", NOW)
  assert.equal(late.nowIndex, 1)
  assert.ok(M.radarUsable(late, NOW, false, NOW))
  assert.equal(M.radarDelayNote(late.frames[1].timeMs, NOW, "sv"), "Radar från 09:00")
  assert.deepEqual(M.parseTileIndex(index(Array.from({ length: 12000 }, (_, i) => NOW + i)), NOW), [])
  assert.deepEqual(M.parseTileIndex('{"times":[null,{},{"time":3,"tiles":{}}]}', NOW), [])
})

test("lightning bounds geometry and keeps the newest regional strikes, however many arrive", () => {
  const events = Array.from({ length: 12000 }, (_, i) => [NOW / 1000 - i / 2, 12, 58])
  events.push([NOW / 1000 - 8000, 12, 58], [NOW / 1000 + 600, 12, 58],
    [NOW / 1000, 100, 58], [NOW / 1000, 12, 20], events[0], null, ["bad", 12, 58])
  const body = (items) => JSON.stringify({ historicalData: JSON.stringify(items) })
  const strikes = M.parseLightning(body(events), NOW)
  assert.equal(strikes.length, M.MAX_LIGHTNING_STRIKES)
  assert.equal(strikes.at(-1).ms, NOW)
  assert.equal(strikes[0].ms, NOW - (M.MAX_LIGHTNING_STRIKES - 1) * 500)
  assert.ok(strikes.every((s) => s.shape && s.lon === 12 && s.lat === 58))
  // A storm-sized list keeps its newest strikes; those older than two hours
  // (the feed holds more) are left out.
  const storm = Array.from({ length: 100000 }, (_, i) => [NOW / 1000 - i * 0.07, 12, 58])
  const older = Array.from({ length: 1000 }, (_, i) => [NOW / 1000 - 3 * 3600 - i, 12, 58])
  const kept = M.parseLightning(body(older.concat(storm)), NOW)
  assert.equal(kept.length, M.MAX_LIGHTNING_STRIKES)
  assert.equal(kept.at(-1).ms, NOW)
  assert.ok(kept.every((s, i) => i === 0 || kept[i - 1].ms <= s.ms))
  assert.deepEqual(M.parseLightning(body(older), NOW), [])
  const boundary = M.parseLightning(body([[NOW / 1000 - 7200, M.RADAR_COVERAGE.west, M.RADAR_COVERAGE.north]]), NOW)
  assert.equal(boundary.length, 1, "full supported map and the two-hour boundary are retained")
})

test("place search caps unique rows and text before building keys or saving", () => {
  const results = Array.from({ length: 12000 }, (_, i) => ({
    name: i < 6 ? "x".repeat(10000) + i : "Place " + i, latitude: 58, longitude: 12 + i / 100000,
    admin1: i < 6 ? "a".repeat(10000) : "Region", country: i < 6 ? "c".repeat(10000) : "Country"
  }))
  results.unshift(null, { name: "invalid", latitude: 91, longitude: 12 }, results[0])
  const rows = M.parseGeocodingResults(JSON.stringify({ results }))
  assert.equal(rows.length, 6)
  assert.equal(new Set(rows.map((r) => r.key)).size, 6)
  for (const row of rows) {
    assert.equal(row.name.length, 256)
    assert.ok(row.description.length <= 514)
    assert.ok(row.key.length < 320)
    const selected = M.locationCommit(row.name, rows, rows.indexOf(row))
    assert.ok(JSON.stringify({ name: selected.name, latitude: selected.latitude, longitude: selected.longitude }).length < 400)
  }
  const loc = M.parseLocationFile(JSON.stringify({ name: "x".repeat(10000), latitude: 58, longitude: 12 }))
  assert.equal(loc.name.length, 256)
})

test("search text is trimmed, capped and well-formed before it becomes a curl argument", () => {
  const max = M.MAX_SEARCH_LENGTH
  const pair = "\u{1F327}"  // two UTF-16 units
  const cases = [
    ["  Bergen \n", "Bergen"],
    ["", ""],
    [null, ""],
    ["x".repeat(max), "x".repeat(max)],
    ["x".repeat(max + 1), "x".repeat(max)],
    ["x".repeat(1024 * 1024), "x".repeat(max)],
    [" ".repeat(1024 * 1024) + "Oslo", "Oslo"],
    ["x".repeat(max - 2) + pair, "x".repeat(max - 2) + pair],
    ["x".repeat(max - 1) + pair, "x".repeat(max - 1)],  // pair straddles the limit: the half is dropped
    ["x".repeat(max - 2) + " " + pair, "x".repeat(max - 2)],
    ["a\uD800b", "ab"],
    ["a\uDC00b", "ab"],
    ["\uDC00\uD800", ""],
    ["Göte\u{1F327}borg", "Göte\u{1F327}borg"]
  ]
  for (const [input, expected] of cases) {
    const query = M.searchQuery(input)
    assert.equal(query, expected, JSON.stringify(input).slice(0, 40))
    assert.equal(M.searchQuery(query), query)
    assert.ok(query.length <= max)
  }

  // Worst case: every unit the start of a 4-byte UTF-8 character.
  for (const input of [pair.repeat(1024 * 1024), "\uD800".repeat(1024 * 1024), "x".repeat(1024 * 1024)]) {
    const command = M.geocodeCommand(input, "sv", "agent/1")
    for (const arg of command) assert.ok(Buffer.byteLength(arg) < 4096, `argument of ${Buffer.byteLength(arg)} bytes`)
  }
})

test("forecast expansion bounds steps, symbols and nested measurements", () => {
  const step = { data: { instant: { details: { air_temperature: 12 } },
    next_1_hours: { summary: { symbol_code: "clearsky_day" }, details: { precipitation_amount: 0 } } } }
  const series = Array.from({ length: 12000 }, (_, i) => ({ ...step, time: new Date(NOW + i * 3600000).toISOString() }))
  series[0].data = { instant: { details: { air_temperature: 12, nested: { a: "x".repeat(10000) } } },
    next_1_hours: { summary: { symbol_code: "x".repeat(10000) }, details: { precipitation_amount: 1 } } }
  const parsed = M.parseTimeseries(JSON.stringify({ properties: { timeseries: series, meta: { updated_at: new Date(NOW).toISOString() } } }))
  assert.equal(parsed.steps.length, M.MAX_TIMESERIES_STEPS)
  assert.deepEqual(parsed.steps[0].instant, { air_temperature: 12 })
  assert.equal(parsed.steps[0].period1.symbol.length, 64)
  const view = M.buildView({ forecast: parsed, location: { name: "Test", latitude: 58, longitude: 12 }, nowMs: NOW, lang: "en" })
  assert.ok(view.ready)
  assert.ok(view.days.reduce((count, day) => count + day.rows.length, 0) <= 256)
})

test("malformed provider symbols and measurements never break the view", () => {
  const raw = JSON.parse(fixture("forecast-alingsas.json"))
  const nowMs = Date.parse(raw.properties.timeseries[0].time) + 60000
  const viewFor = (edit) => {
    const d = JSON.parse(JSON.stringify(raw))
    d.properties.timeseries.forEach(edit)
    const forecast = M.parseTimeseries(JSON.stringify(d))
    return M.buildView({ forecast, location: { name: "Test", latitude: 58, longitude: 12 }, nowMs, lang: "en" })
  }
  for (const code of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf",
    "clearsky\u2028_day", "cloudy\u2029", "\u2028", "_night", "lightsconstructor"]) {
    const view = viewFor((t) => {
      for (const k of ["next_1_hours", "next_6_hours", "next_12_hours"])
        if (t.data[k] && t.data[k].summary) t.data[k].summary.symbol_code = code
    })
    const rows = view.days.flatMap((day) => day.rows)
    for (const text of [view.current.description, view.current.icon, ...rows.map((r) => r.description), ...rows.map((r) => r.icon),
      M.summaryText(view)])
      assert.equal(typeof text, "string", JSON.stringify(code))
    assert.ok(!/function|\[object/.test(M.summaryText(view)), M.summaryText(view))
  }
  assert.deepEqual(M.splitSymbol("rain\u2028_night"), { base: "rain\u2028", variant: "night" })
  assert.deepEqual(M.splitSymbol({ toString: 1 }), { base: "", variant: "" })

  // Measurements past any real value are dropped, not interpolated into
  // Infinity or NaN.
  const extreme = viewFor((t, i) => { t.data.instant.details.air_pressure_at_sea_level = i % 2 ? 1e308 : -1e308 })
  assert.equal(extreme.current.pressure, null)
  const hot = viewFor((t, i) => {
    if (i % 3) return
    t.data.instant.details.air_temperature = 1e308
    for (const k of ["next_6_hours", "next_12_hours"]) if (t.data[k]) t.data[k].details.air_temperature_max = 1e308
  })
  assert.ok(hot.longRange.length > 0)
  assert.ok(hot.longRange.every((day) => Math.abs(day.max) < 100 && Math.abs(day.min) < 100))
  assert.ok(Number.isFinite(hot.longRangeScale.max - hot.longRangeScale.min))
})

test("only usable forecasts and nowcasts are cached or kept from disk", () => {
  const forecastBody = fixture("forecast-alingsas.json")
  const nowcastBody = fixture("nowcast-alingsas.json")
  const forecast = M.parseTimeseries(forecastBody)
  const nowcast = M.parseTimeseries(nowcastBody)
  const at = (parsed) => parsed.steps[0].ms
  const hour = 3600000
  assert.ok(M.usableTimeseries("forecast", forecast, at(forecast)))
  assert.ok(M.usableTimeseries("nowcast", nowcast, at(nowcast)))
  // Radar down for the place: no rates, still shown as such.
  const down = M.parseTimeseries(fixture("nowcast-alingsas-unavailable.json"))
  assert.ok(M.usableTimeseries("nowcast", down, at(down)))
  // A forecast only from long ago, or with no temperature near now.
  assert.ok(!M.usableTimeseries("forecast", forecast, at(forecast) + 365 * 24 * hour))
  assert.ok(!M.usableTimeseries("forecast", M.parseTimeseries('{"properties":{"timeseries":[]}}'), NOW))
  const time = new Date(NOW).toISOString()
  assert.ok(!M.usableTimeseries("forecast", M.parseTimeseries(JSON.stringify({ properties: { timeseries: [{ time, data: {} }] } })), NOW))
  const yearOld = { time: new Date(NOW - 365 * 24 * hour).toISOString(), data: { instant: { details: { air_temperature: 3 } } } }
  assert.ok(!M.usableTimeseries("forecast", M.parseTimeseries(JSON.stringify({ properties: { timeseries: [{ time, data: {} }, yearOld] } })), NOW))
  // Nowcasts: a rate on every step from now on, MET's coverage states only,
  // and steps still ahead.
  const rateless = JSON.parse(nowcastBody)
  delete rateless.properties.timeseries[3].data.instant.details.precipitation_rate
  assert.ok(!M.usableTimeseries("nowcast", M.parseTimeseries(JSON.stringify(rateless)), at(nowcast)))
  const coverage = (value) => {
    const n = JSON.parse(nowcastBody)
    n.properties.meta.radar_coverage = value
    n.properties.timeseries = []
    return M.parseTimeseries(JSON.stringify(n))
  }
  assert.ok(M.usableTimeseries("nowcast", coverage("no coverage"), NOW))
  assert.ok(!M.usableTimeseries("nowcast", coverage("weird"), NOW))
  assert.ok(!M.usableTimeseries("nowcast", coverage(""), NOW))
  assert.ok(!M.usableTimeseries("nowcast", nowcast, at(nowcast) + 6 * hour))
  assert.ok(!M.usableTimeseries("sun", forecast, at(forecast)))
  assert.ok(!M.usableTimeseries("forecast", forecast))

  // A 304 renews only a stored entry for the same request, and no Expires
  // holds off refreshing for more than a day.
  const notModified = { status: 304, headers: {}, body: "" }
  assert.equal(M.cacheEntryFromResponse(null, "k", notModified, NOW), null)
  assert.equal(M.cacheEntryFromResponse({ key: "other", body: "x" }, "k", notModified, NOW), null)
  assert.equal(M.cacheEntryFromResponse({ key: "k", body: "x", lastModified: "" }, "k", notModified, NOW).body, "x")
  const farFuture = { status: 200, headers: { expires: "Thu, 01 Jan 2099 00:00:00 GMT" }, body: "x" }
  assert.equal(M.cacheEntryFromResponse(null, "k", farFuture, NOW).expiresMs, NOW + M.MAX_CACHE_TTL_MS)

  // cache.json as loaded: complete, usable entries and known keys only, and
  // nothing can reach the object's prototype.
  const nowMs = at(forecast)
  const entry = (key, body) => ({ key, body, lastModified: "", expiresMs: nowMs + hour, fetchedMs: nowMs })
  const good = entry("f", forecastBody)
  const sun = entry("s", fixture("sun-alingsas.json"))
  assert.deepEqual(M.usableCache({ forecast: good, sun, prefs: { mapStep: 1 }, elevations: { "57.93,12.53": 55 } }, nowMs),
                   { forecast: good, sun, prefs: { mapStep: 1 }, elevations: { "57.93,12.53": 55 } })
  assert.deepEqual(M.usableCache({ forecast: entry("f", '{"properties":{"timeseries":[]}}'), sun: entry("s", "{}") }, nowMs), {})
  assert.deepEqual(M.usableCache({ nowcast: entry("n", "") }, nowMs), { nowcast: entry("n", "") })
  assert.deepEqual(M.usableCache({ nowcast: { key: "n", body: "" } }, nowMs), {})
  assert.deepEqual(M.usableCache({ moon: Object.assign(entry("m", fixture("moon-alingsas.json")), { fetchedMs: "x" }) }, nowMs), {})
  assert.deepEqual(M.usableCache({ forecast: Object.assign({}, good, { lastModified: 7 }), extra: { a: 1 } }, nowMs), {})
  assert.deepEqual(M.usableCache({ elevations: { a: 1e300, b: "12", c: 40 }, prefs: { mapStep: "x" } }, nowMs), { elevations: { c: 40 } })
  for (const bad of [null, [], "text", 7]) assert.deepEqual(M.usableCache(bad, nowMs), {})
  const polluted = M.usableCache(JSON.parse('{"__proto__": {"polluted": true}, "elevations": {"__proto__": 5}}'), nowMs)
  assert.equal(Object.getPrototypeOf(polluted), Object.prototype)
  assert.equal(polluted.polluted, undefined)
  assert.equal(Object.getPrototypeOf(polluted.elevations), Object.prototype)
})

test("dates, coordinates and elevations from providers stay in range", () => {
  assert.equal(M.parseIsoMs("2026-03-01T06:00:00Z"), Date.parse("2026-03-01T06:00:00Z"))
  assert.equal(M.parseIsoMs("2026-02-28T06:00+01:00"), Date.parse("2026-02-28T05:00:00Z"))
  for (const bad of ["2026-02-31T06:00:00Z", "2026-13-01T06:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T12:60:00Z",
    "2026-01-01T12:00:61Z", "2026-01-01T12:00+25:00", "2026-01-01T12:00+01:60"])
    assert.ok(Number.isNaN(M.parseIsoMs(bad)), bad)
  assert.ok(Number.isNaN(M.parseIsoMs({ toString: 1 })))
  const unset = { name: "", latitude: null, longitude: null }
  assert.deepEqual(M.parseLocationFile(JSON.stringify({ name: "X", latitude: { toString: 1 }, longitude: 12 })),
                   { name: "X", latitude: null, longitude: null })
  assert.deepEqual(M.parseLocationFile(JSON.stringify({ latitude: 91, longitude: 12 })), unset)
  assert.equal(M.parseLocationFile(JSON.stringify({ latitude: "57.9", longitude: "12.5" })).latitude, 57.9)
  const place = { latitude: 57.93, longitude: 12.53 }
  assert.match(M.forecastUrl(Object.assign({ elevation: 55.4 }, place)), /&altitude=55$/)
  for (const elevation of [1e300, -1e4, NaN, "55"])
    assert.doesNotMatch(M.forecastUrl(Object.assign({ elevation }, place)), /altitude/, String(elevation))
  const found = M.parseGeocodingResults(JSON.stringify({ results: [{ name: "Top", latitude: 58, longitude: 12, elevation: 1e300 }] }))
  assert.equal(found[0].elevation, null)
})

test("responses are read as curl received them, and only for their own day or place", () => {
  // Only interim answers come before the response (curl leaves out a
  // proxy's CONNECT reply); a body that looks like headers stays body.
  const plain = M.parseHttpResponse("HTTP/2 200\r\ncontent-type: application/json\r\n\r\nHTTP/2 422\r\nx: y\r\n\r\nbody")
  assert.equal(plain.status, 200)
  assert.equal(plain.body, "HTTP/2 422\r\nx: y\r\n\r\nbody")
  assert.equal(M.parseHttpResponse("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 304 Not Modified\r\n\r\n").status, 304)
  assert.ok(M.curlCommand("https://x", "", 10, "agent/1").includes("--suppress-connect-headers"))

  // Times outside this century, sunrises far from the day asked about and
  // coordinates that only start with a number.
  assert.ok(Number.isNaN(M.parseIsoMs("1999-12-31T23:00:00Z")))
  assert.ok(Number.isNaN(M.parseIsoMs("2100-01-01T00:00:00Z")))
  assert.ok(Number.isNaN(M.parseHttpDateMs("Fri, 31 Dec 9999 23:59:59 GMT")))
  const sunBody = fixture("sun-alingsas.json")
  const sun = M.parseSun(sunBody)
  assert.ok(M.parseSun(sunBody, sun.riseMs + 6 * 3600000))
  assert.equal(M.parseSun(sunBody, sun.riseMs + 5 * 24 * 3600000), null)
  assert.equal(M.parseGeoLocation(JSON.stringify({ latitude: "58north", longitude: "12,53" })), null)
  assert.deepEqual(M.parseGeoLocation(JSON.stringify({ latitude: " 57.93 ", longitude: "12.53" })),
                   { name: "", latitude: 57.93, longitude: 12.53 })
  const forecast = M.parseTimeseries(fixture("forecast-alingsas.json"))
  const nowMs = forecast.steps[0].ms
  const entry = { key: "m", body: fixture("moon-alingsas.json"), lastModified: "", expiresMs: nowMs + 3600000, fetchedMs: 1e20 }
  assert.deepEqual(M.usableCache({ moon: entry }, nowMs), {})

  // The forecast step the hero shows needs a temperature; a nowcast starts
  // about now and stays within the next hours.
  const gap = JSON.parse(fixture("forecast-alingsas.json"))
  delete gap.properties.timeseries[0].data.instant.details.air_temperature
  assert.ok(!M.usableTimeseries("forecast", M.parseTimeseries(JSON.stringify(gap)), nowMs))
  const nowcast = JSON.parse(fixture("nowcast-alingsas.json"))
  const later = (days) => nowcast.properties.timeseries.map((t) => ({ ...t, time: new Date(Date.parse(t.time) + days * 86400000).toISOString() }))
  const first = Date.parse(nowcast.properties.timeseries[0].time)
  assert.ok(!M.usableTimeseries("nowcast", M.parseTimeseries(JSON.stringify({ ...nowcast, properties: { ...nowcast.properties, timeseries: later(100) } })), first))
})

test("the location field is never a Qt TextInput", () => {
  // Through Qt 6.12.0 a TextInput (and every TextField) reads the whole
  // clipboard on the GUI thread when it changes; TextEdit only checks formats.
  for (const file of ["Panel.qml", "BarWidget.qml", "Service.qml", "RadarImages.qml"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8").replace(/\/\/.*$/gm, "")
    assert.doesNotMatch(source, /\b(TextField|TextInput)\s*\{/, file)
  }
})

test("celestial validation rejects malformed data and keeps polar events", () => {
  for (const body of ["<html>", "{}", '{"properties":{}}', '{"properties":{"sunrise":{},"sunset":null}}',
    '{"properties":{"sunrise":{"time":"soon"},"sunset":{"time":null}}}']) {
    assert.equal(M.parseSun(body), null)
    assert.equal(M.parseMoon(body, NOW), null)
  }
  assert.ok(M.parseSun(fixture("sun-alingsas.json")))
  assert.ok(M.parseMoon(fixture("moon-alingsas.json"), NOW))
  // Polar night in Tromsø as MET sends it: no sunrise or sunset that day.
  const polar = M.parseSun(fixture("sun-tromso-polar-night.json"))
  assert.ok(polar)
  assert.ok(Number.isNaN(polar.riseMs) && Number.isNaN(polar.setMs))
  const view = M.buildView({ forecast: M.parseTimeseries(fixture("forecast-alingsas.json")), sun: polar,
    location: { name: "Tromsø", latitude: 69.65, longitude: 18.96 }, nowMs: Date.parse("2026-09-26T12:44:00Z"), lang: "en" })
  assert.deepEqual(view.sun, { rise: "—", set: "—" })
  assert.ok(M.parseSun('{"properties":{"sunrise":null,"sunset":null}}'))
  assert.ok(M.parseMoon('{"properties":{"moonphase":123}}', NOW))
  assert.equal(M.parseMoon('{"properties":{"moonphase":361}}', NOW), null)
})

test("notification place names cannot become Omarchy notification options", () => {
  const parsed = M.parseTimeseries(fixture("forecast-alingsas.json"))
  for (const name of ["--app-name=other", "--image=/tmp/image", "---", "--replace-id=42"]) {
    const note = M.notification(M.buildView({ forecast: parsed,
      location: { name, latitude: 58, longitude: 12 }, nowMs: Date.parse("2026-09-26T12:44:00Z"), lang: "en" }))
    assert.ok(!note.headline.startsWith("-"))
    assert.ok(note.headline.includes("12°") || /\d+°/.test(note.headline))
  }
})

const notificationSender = spawnSync("which", ["omarchy-notification-send"], { encoding: "utf8" }).stdout.trim()
test("the installed notification helper receives option-shaped names as headline text", {
  skip: !notificationSender && "Omarchy notification helper required"
}, () => {
  const dir = temp()
  try {
    const log = path.join(dir, "args")
    fs.writeFileSync(path.join(dir, "busctl"),
      '#!/bin/bash\nprintf "%s\\0" "$@" > "$SECURITY_NOTIFICATION_ARGS"\n', { mode: 0o755 })
    for (const name of ["--app-name=other", "--image=/tmp/image", "--replace-id=42"]) {
      const note = M.notification(M.buildView({ forecast: M.parseTimeseries(fixture("forecast-alingsas.json")),
        location: { name, latitude: 58, longitude: 12 }, nowMs: Date.parse("2026-09-26T12:44:00Z"), lang: "en" }))
      const r = execute([notificationSender, "-g", note.glyph, note.headline, note.body], {
        ...process.env, PATH: dir + ":" + process.env.PATH, SECURITY_NOTIFICATION_ARGS: log
      })
      assert.equal(r.status, 0, r.stderr)
      const args = fs.readFileSync(log, "utf8").split("\0")
      const start = args.indexOf("susssasa{sv}i") + 1
      assert.equal(args[start], "omarchy-action")
      assert.equal(args[start + 1], "0")
      assert.equal(args[start + 3], note.headline)
      assert.equal(args[start + 4], note.body)
      assert.ok(!args.includes("image-path"))
      assert.ok(!args.includes("omarchy-exec-argv"))
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
