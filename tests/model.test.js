// Run with: npm test  (pins TZ=Europe/Stockholm so local-time output is stable)
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const M = require("./load-model.js")

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8")
const alingsas = M.parseTimeseries(fixture("forecast-alingsas.json"))
const bergen = M.parseTimeseries(fixture("forecast-bergen.json"))
const singapore = M.parseTimeseries(fixture("forecast-singapore.json"))
const nowcastAlingsas = M.parseTimeseries(fixture("nowcast-alingsas.json"))
const moon = M.parseMoon(fixture("moon-alingsas.json"), Date.parse("2026-09-26T10:00:00Z"))
const sun = M.parseSun(fixture("sun-alingsas.json"))
// 14:44 local, just after the Alingsås fixtures were fetched.
const NOW = Date.parse("2026-09-26T12:44:00Z")

test("runs in the expected zone", () => {
  assert.equal(new Date(NOW).getHours(), 14)
})

test("language follows locale, English fallback", () => {
  assert.equal(M.langFor("sv_SE"), "sv")
  assert.equal(M.langFor("sv_FI.UTF-8"), "sv")
  assert.equal(M.langFor("en_US"), "en")
  assert.equal(M.langFor("nb_NO"), "en")
  assert.equal(M.langFor(""), "en")
})

test("numbers use a decimal comma in Swedish", () => {
  assert.equal(M.formatNumber(0.4, 1, "sv"), "0,4")
  assert.equal(M.formatNumber(0.4, 1, "en"), "0.4")
  assert.equal(M.formatNumber(1.0, 1, "sv"), "1")
  assert.equal(M.roundTemp(-0.3), 0)
  assert.ok(!Object.is(M.roundTemp(-0.3), -0))
})

test("time parsing", () => {
  assert.equal(M.parseIsoMs("2026-09-26T12:00:00Z"), Date.UTC(2026, 8, 26, 12))
  assert.equal(M.parseIsoMs("2026-09-26T07:02+02:00"), Date.UTC(2026, 8, 26, 5, 2))
  assert.equal(M.parseHttpDateMs("Sat, 26 Sep 2026 13:14:28 GMT"), Date.UTC(2026, 8, 26, 13, 14, 28))
  assert.ok(Number.isNaN(M.parseIsoMs("nope")))
})

test("sunrise offset follows DST for the date asked about", () => {
  assert.equal(M.utcOffsetString(Date.parse("2026-07-01T12:00:00Z")), "+02:00")
  assert.equal(M.utcOffsetString(Date.parse("2026-12-01T12:00:00Z")), "+01:00")
  // Day after the October switch (Oct 25 2026).
  assert.equal(M.utcOffsetString(Date.parse("2026-10-26T12:00:00Z")), "+01:00")
})

test("coordinates are truncated to 4 decimals in URLs", () => {
  const loc = { name: "Alingsås", latitude: 57.930331, longitude: 12.533452, elevation: 66.4 }
  assert.equal(M.forecastUrl(loc),
    "https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=57.9303&lon=12.5335&altitude=66")
  assert.match(M.sunUrl(loc, NOW), /date=2026-09-26&offset=%2B02%3A00$/)
  assert.ok(!M.forecastUrl({ latitude: 1, longitude: 2 }).includes("altitude"))
})

test("curl command identifies itself and sends If-Modified-Since", () => {
  const cmd = M.curlCommand("https://x", "Sat, 26 Sep 2026 12:44:00 GMT")
  assert.equal(cmd[cmd.indexOf("-A") + 1], M.USER_AGENT)
  assert.ok(cmd.includes("If-Modified-Since: Sat, 26 Sep 2026 12:44:00 GMT"))
  assert.ok(!M.curlCommand("https://x", "").includes("-H"))
})

test("HTTP response parsing and cache policy", () => {
  const raw = "HTTP/2 200 \r\nexpires: Sat, 26 Sep 2026 13:14:28 GMT\r\nLast-Modified: Sat, 26 Sep 2026 12:44:00 GMT\r\n\r\n{\"a\":1}"
  const r = M.parseHttpResponse(raw)
  assert.equal(r.status, 200)
  assert.equal(r.body, "{\"a\":1}")
  const entry = M.cacheEntryFromResponse(null, "k", r, NOW)
  assert.equal(entry.lastModified, "Sat, 26 Sep 2026 12:44:00 GMT")
  assert.ok(M.isFresh(entry, "k", NOW))
  assert.ok(!M.isFresh(entry, "other", NOW))
  assert.ok(!M.isFresh(entry, "k", Date.UTC(2026, 8, 26, 13, 15)))

  const notModified = M.parseHttpResponse("HTTP/2 304 \r\nexpires: Sat, 26 Sep 2026 13:45:00 GMT\r\n\r\n")
  const renewed = M.cacheEntryFromResponse(entry, "k", notModified, NOW)
  assert.equal(renewed.body, "{\"a\":1}")
  assert.equal(renewed.expiresMs, Date.UTC(2026, 8, 26, 13, 45))

  const unsupported = M.parseHttpResponse("HTTP/2 422 \r\n\r\n" + fixture("nowcast-singapore-422.txt"))
  assert.equal(unsupported.status, 422)
  assert.equal(M.parseTimeseries(unsupported.body), null)
})

test("symbol descriptions in both languages", () => {
  assert.equal(M.describeSymbol("clearsky_day", "sv"), "Klart")
  assert.equal(M.describeSymbol("partlycloudy_night", "en"), "Partly cloudy")
  assert.equal(M.describeSymbol("lightrain", "sv"), "Lätt regn")
  assert.equal(M.describeSymbol("heavyrainshowers_day", "sv"), "Kraftiga regnskurar")
  assert.equal(M.describeSymbol("sleetshowersandthunder_night", "sv"), "Byar av snöblandat regn och åska")
  assert.equal(M.describeSymbol("heavysnow", "en"), "Heavy snow")
  assert.equal(M.describeSymbol("rainshowersandthunder_day", "en"), "Rain showers and thunder")
})

test("MET's misspelled symbol codes map to the real ones", () => {
  assert.equal(M.describeSymbol("lightssleetshowersandthunder_day", "en"), "Light sleet showers and thunder")
  assert.equal(M.describeSymbol("lightssnowshowersandthunder_night", "sv"), "Lätta snöbyar och åska")
  assert.equal(M.iconForSymbol("lightssnowshowersandthunder_night"), M.iconForSymbol("lightsnowshowersandthunder_night"))
})

test("every MET base symbol has a description and a specific icon", () => {
  const bases = ["clearsky", "fair", "partlycloudy", "cloudy", "fog"]
  for (const i of ["light", "", "heavy"])
    for (const k of ["rain", "sleet", "snow"])
      for (const sh of ["", "showers"])
        for (const th of ["", "andthunder"]) bases.push(i + k + sh + th)
  assert.equal(bases.length, 41)
  for (const b of bases) {
    for (const v of ["", "_day", "_night"]) {
      const code = b + v
      for (const lang of ["sv", "en"]) {
        const text = M.describeSymbol(code, lang)
        assert.ok(text.length > 0 && text[0] === text[0].toUpperCase(), code + " " + lang)
        assert.ok(!/^[a-z]+$/.test(text), "untranslated: " + code)
      }
      const icon = M.iconForSymbol(code)
      assert.equal(icon.length, 1, code)
      assert.ok(icon.charCodeAt(0) >= 0xe300 && icon.charCodeAt(0) <= 0xe3ff, code)
    }
  }
})

test("night icons: clear/fair nights use the crescent, never a phase disc", () => {
  assert.equal(M.iconForSymbol("clearsky_night"), "\ue32b")
  assert.equal(M.iconForSymbol("fair_night"), "\ue32b")
  assert.equal(M.iconForSymbol("clearsky_day"), "\ue30d")
  assert.equal(M.iconForSymbol("partlycloudy_night"), "\ue37e")
  assert.equal(M.iconForSymbol("clearsky_polartwilight"), "\ue30d")
})

test("moon phase glyphs (footer only)", () => {
  assert.equal(M.moonGlyph(0), "\ue38d")    // new
  assert.equal(M.moonGlyph(180), "\ue39b")  // full
  assert.equal(M.moonGlyph(90), "\ue394")   // first quarter
  assert.equal(M.moonGlyph(355), "\ue38d")  // wraps to new
})

test("moon illumination", () => {
  const at = (deg) => M.buildView({ moon: { phaseDeg: deg, refMs: NOW, riseMs: NaN, setMs: NaN },
                                    lang: "sv", nowMs: NOW }).moon.illumination
  assert.equal(at(0), 0)
  assert.equal(at(90), 50)
  assert.equal(at(180), 100)
  assert.equal(at(270), 50)
})

test("moon phase advances between days", () => {
  const today = M.moonPhaseAt(moon, moon.refMs)
  const tomorrow = M.moonPhaseAt(moon, moon.refMs + 86400000)
  assert.ok(Math.abs(today - 170.8) < 0.1)
  assert.ok(Math.abs(tomorrow - today - 12.19) < 0.05)
})

test("wind compass and arrow", () => {
  assert.equal(M.windCompass(259, "sv"), "V")
  assert.equal(M.windCompass(259, "en"), "W")
  assert.equal(M.windCompass(45, "sv"), "NO")
  assert.equal(M.windArrow(259), "→")  // from the west, blowing east
  assert.equal(M.windArrow(0), "↓")
})

test("precipitation formatting", () => {
  assert.equal(M.formatPrecip(0, 0, 0, "sv"), "")
  assert.equal(M.formatPrecip(0.04, 0.04, 0.04, "sv"), "<0,1 mm")
  assert.equal(M.formatPrecip(0.4, 0.4, 0.4, "sv"), "0,4 mm")
  assert.equal(M.formatPrecip(0.6, 0.2, 1.4, "sv"), "0,2–1,4 mm")
  assert.equal(M.formatPrecip(0, 0, 0.3, "en"), "0–0.3 mm")
})

test("forecast parsing keeps periods", () => {
  assert.equal(alingsas.steps.length, 86)
  assert.equal(alingsas.steps[0].period1.symbol, "clearsky_day")
  assert.equal(alingsas.steps[0].period6.details.air_temperature_max, 15.2)
  const lastHourly = alingsas.steps.filter((s) => s.period1).pop()
  assert.ok(lastHourly.ms > NOW + 48 * 3600000)
})

test("current conditions use the step nearest now", () => {
  const c = M.buildCurrent(alingsas, null, NOW, "sv")
  const nearest = alingsas.steps.find((s) => s.ms === Date.parse("2026-09-26T13:00:00Z"))
  assert.equal(c.temp, Math.round(nearest.instant.air_temperature))
  assert.equal(c.description, M.describeSymbol(nearest.period1.symbol, "sv"))
  assert.equal(c.wind.dirLabel, M.windCompass(nearest.instant.wind_from_direction, "sv"))
})

test("current conditions prefer a fresh nowcast", () => {
  const nc = M.parseTimeseries(fixture("nowcast-alingsas.json"))
  const at = nc.steps[0].ms
  const c = M.buildCurrent(alingsas, nc, at, "en")
  assert.equal(c.temp, Math.round(nc.steps[0].instant.air_temperature))
  // Only the first step carries temperature; it stays in use for 30 min
  // (the bar refetches every 15), then the model takes over again.
  const modelTempAt = (ms) => Math.round(alingsas.steps.reduce((a, b) => Math.abs(b.ms - ms) < Math.abs(a.ms - ms) ? b : a).instant.air_temperature)
  const ncTemp = 23.4  // distinct from the model so the source is unambiguous
  const tweaked = JSON.parse(JSON.stringify(nc))
  tweaked.steps[0].instant.air_temperature = ncTemp
  assert.equal(M.buildCurrent(alingsas, tweaked, at + 14 * 60000, "en").temp, 23)
  assert.equal(M.buildCurrent(alingsas, tweaked, at + 29 * 60000, "en").temp, 23)
  assert.equal(M.buildCurrent(alingsas, tweaked, at + 31 * 60000, "en").temp, modelTempAt(at + 31 * 60000))
  // A stale nowcast (hours later) is ignored.
  const later = M.buildCurrent(alingsas, nc, at + 5 * 3600000, "en")
  const step = alingsas.steps.reduce((a, b) => Math.abs(b.ms - (at + 5 * 3600000)) < Math.abs(a.ms - (at + 5 * 3600000)) ? b : a)
  assert.equal(later.temp, Math.round(step.instant.air_temperature))
})

test("hourly days: 3 h steps, then 6 h steps past the hourly range", () => {
  const days = M.buildHourlyDays(alingsas, NOW, 3, 3, "sv")
  assert.deepEqual(days.map((d) => d.title), ["Idag 26 sep", "Imorgon 27 sep", "Måndag 28 sep"])
  assert.deepEqual(days[0].rows.map((r) => r.hour), ["15", "18", "21"])
  assert.deepEqual(days[1].rows.map((r) => r.hour), ["00", "03", "06", "09", "12", "15", "18", "21"])
  for (const day of days) for (const r of day.rows) assert.ok(r.ms >= Date.parse("2026-09-26T12:00:00Z"))
  // The day after tomorrow is always 6-hour rows, even when a later
  // forecast run covers it hourly (simulated: every step gets a 1 h period).
  const allHourly = { steps: alingsas.steps.map((st) => Object.assign({}, st, { period1: st.period1 || st.period6 })) }
  const later = M.buildHourlyDays(allHourly, NOW, 3, 3, "sv")
  assert.equal(later[1].sixHour, false)
  assert.equal(later[2].sixHour, true)
  assert.deepEqual(later[2].rows.map((r) => r.hour), ["02", "08", "14", "20"])
  // Hourly data runs out on Monday evening, so all of Monday is 6-hour rows.
  assert.equal(days[1].sixHour, false)
  assert.equal(days[2].sixHour, true)
  assert.deepEqual(days[2].rows.map((r) => r.hour), ["02", "08", "14", "20"])
  assert.ok(days[2].rows.every((r) => r.periodHours === 6))
  // The 6-hour row uses the 6-hour period even where hourly data exists.
  const mon02 = alingsas.steps.find((s) => s.ms === Date.parse("2026-09-28T00:00:00Z"))
  assert.equal(days[2].rows[0].description, M.describeSymbol(mon02.period6.symbol, "sv"))
  assert.equal(M.buildHourlyDays(alingsas, NOW, 3, 3, "en")[2].title, "Monday Sep 28")
})

test("hourly rows carry precipitation, spread and wind", () => {
  const days = M.buildHourlyDays(bergen, Date.parse(bergen.steps[0].ms ? new Date(bergen.steps[0].ms).toISOString() : 0), 1, 3, "sv")
  const rows = days.flatMap((d) => d.rows)
  const wet = rows.find((r) => r.precip.text !== "")
  assert.ok(wet, "Bergen fixture should have precipitation")
  assert.match(wet.precip.text, /mm$/)
  assert.ok(rows.every((r) => r.wind.arrow.length === 1))
  assert.ok(rows.every((r) => r.tempSpread >= 0))
})

test("long range: one row per day, today first, sane values", () => {
  const days = M.buildLongRange(alingsas, NOW, 10, "sv")
  assert.equal(days[0].day, "Idag")
  assert.equal(days[1].day, "Sön")
  assert.ok(days.length >= 10)
  for (const d of days) {
    assert.ok(d.min <= d.max, JSON.stringify(d))
    assert.equal(d.icon.length, 1)
  }
  // Evening: only night periods remain today, but the overview still shows a day icon.
  const evening = M.buildLongRange(alingsas, Date.parse("2026-09-26T19:00:00Z"), 1, "sv")[0]
  assert.equal(evening.day, "Idag")
  assert.ok(!["\ue32b", "\ue37e"].includes(evening.icon), "night icon in overview")
  const wet = M.buildLongRange(singapore, singapore.steps[0].ms, 10, "en")
  assert.ok(wet.some((d) => d.precip !== ""), "Singapore fixture should have precipitation")
})

test("long range precipitation does not double count overlapping periods", () => {
  const days = M.buildLongRange(bergen, bergen.steps[0].ms, 10, "en")
  const total = days.reduce((sum, d) => sum + (d.precip ? parseFloat(d.precip) : 0), 0)
  let expected = 0
  let covered = -Infinity
  for (const s of bergen.steps) {
    const p = s.period1 || s.period6
    if (p && s.ms >= covered) { expected += p.details.precipitation_amount || 0; covered = s.ms + p.hours * 3600000 }
  }
  assert.ok(Math.abs(total - expected) < 0.5, total + " vs " + expected)
})

test("nowcast summary", () => {
  const dry = M.buildNowcast(nowcastAlingsas, nowcastAlingsas.steps[0].ms, "sv")
  assert.match(dry.summary, /^Uppehåll närmaste \d+ min$/)
  assert.equal(dry.wet, false)

  const wetLater = JSON.parse(JSON.stringify(nowcastAlingsas))
  wetLater.steps[4].instant.precipitation_rate = 0.5
  wetLater.steps[4].period1 = { hours: 1, symbol: "lightrain", details: {} }
  assert.equal(M.buildNowcast(wetLater, wetLater.steps[0].ms, "sv").summary, "Regn om ca 20 min")

  const stopping = JSON.parse(JSON.stringify(nowcastAlingsas))
  for (let i = 0; i < 3; i++) stopping.steps[i].instant.precipitation_rate = 1.2
  assert.equal(M.buildNowcast(stopping, stopping.steps[0].ms, "en").summary, "Precipitation now, stopping in ~15 min")

  const noCoverage = JSON.parse(JSON.stringify(nowcastAlingsas))
  noCoverage.meta.radar_coverage = "temporarily unavailable"
  assert.equal(M.buildNowcast(noCoverage, noCoverage.steps[0].ms, "sv"), null)
})

test("sun and moon", () => {
  const view = M.buildView({ forecast: alingsas, sun, moon, location: { name: "Alingsås", latitude: 57.93, longitude: 12.53 },
                             lang: "sv", nowMs: NOW, settings: {} })
  assert.deepEqual(view.sun, { rise: "07:03", set: "18:58", dayLength: "11 h 55 min" })
  assert.equal(view.moon.name, "Fullmåne")  // 171°, within ±22.5° of full
  assert.equal(view.moon.rise, "18:31")
  assert.equal(view.moon.illumination, 99)  // 171°
})

test("full view model", () => {
  const view = M.buildView({ forecast: alingsas, nowcast: nowcastAlingsas, sun, moon,
                             location: { name: "Alingsås", latitude: 57.93, longitude: 12.53 },
                             lang: "sv", nowMs: NOW, settings: { hourStep: 3, hourlyDays: 3, longRangeDays: 10 } })
  assert.equal(view.ready, true)
  assert.equal(view.location.set, true)
  assert.equal(view.bar.text, view.current.icon + " " + view.current.temp + "°")
  assert.equal(view.days.length, 3)
  // The overview continues where the hourly sections stop (Tue 29 Sep).
  assert.equal(view.longRange[0].day, "Tis")
  const hourlyStarts = view.days.map((d) => d.start)
  assert.ok(view.longRange.every((d) => !hourlyStarts.includes(d.start)))
  assert.ok(view.longRange.length >= 7 && view.longRange.length <= 10)
  const twoHourly = M.buildView({ forecast: alingsas, location: { name: "A", latitude: 57.93, longitude: 12.53 },
                                  lang: "sv", nowMs: NOW, settings: { hourlyDays: 2 } })
  assert.equal(twoHourly.longRange[0].day, "Mån")
  assert.ok(view.longRangeScale.min <= view.longRangeScale.max)
  assert.equal(view.updatedAt, "14:30")
  const note = M.notification(view)
  assert.match(note.headline, /^Alingsås {2}· {2}Klart \d+°$/)
  assert.match(note.body, /^Vind \d+ m\/s \S+ {2}· {2}Uppehåll/)
  assert.equal(note.glyph, view.current.icon)
})

test("summary line for scripts", () => {
  const view = M.buildView({ forecast: alingsas, nowcast: nowcastAlingsas, sun, moon,
                             location: { name: "Alingsås", latitude: 57.93, longitude: 12.53 },
                             lang: "sv", nowMs: NOW, settings: {} })
  assert.match(M.summaryText(view), /^Alingsås · Klart \d+° · Vind \d+ m\/s \S+ · Uppehåll/)
  assert.equal(M.summaryText(M.buildView({ lang: "en", nowMs: NOW, location: { name: "", latitude: null, longitude: null } })),
    "Choose a place to see the weather")
  assert.equal(M.summaryText(M.buildView({ lang: "sv", nowMs: NOW, location: { name: "A", latitude: 57.9, longitude: 12.5 } })),
    "Hämtar prognos…")
})

test("view without forecast or location", () => {
  const view = M.buildView({ lang: "en", nowMs: NOW, location: { name: "", latitude: null, longitude: null } })
  assert.equal(view.ready, false)
  assert.equal(view.location.set, false)
  assert.equal(view.bar.text, "")
  assert.equal(M.notification(view), null)
})

test("location file and geocoding", () => {
  assert.deepEqual(M.parseLocationFile('{"name":"Alingsås","latitude":57.93033,"longitude":12.53345}'),
    { name: "Alingsås", latitude: 57.93033, longitude: 12.53345 })
  assert.deepEqual(M.parseLocationFile("garbage"), { name: "", latitude: null, longitude: null })
  assert.deepEqual(M.parseLocationFile('{"name":"Malibu"}'), { name: "Malibu", latitude: null, longitude: null })

  const results = M.parseGeocodingResults(fixture("geocode-alings.json"))
  assert.equal(results[0].name, "Alingsås")
  assert.equal(results[0].description, "Västra Götalands län, Sverige")
  assert.equal(typeof results[0].elevation, "number")
  assert.deepEqual(M.parseGeocodingResults(fixture("geocode-empty.json")), [])
  assert.equal(M.geocodeUrl("Göte borg", "sv"),
    "https://geocoding-api.open-meteo.com/v1/search?name=G%C3%B6te%20borg&count=6&format=json&language=sv")

  assert.equal(M.locationCommit("alings", results, 0), results[0])
  assert.equal(M.locationCommit("alings", results, 99), results[results.length - 1])
  assert.equal(M.locationCommit("", results, 0), null)
  assert.equal(M.locationCommit("x", [], 0), null)
})

test("tile maths matches the Web Mercator scheme", () => {
  const t = M.worldTile(57.9303, 12.5335, 6)
  assert.ok(Math.abs(t.x - 34.228) < 0.001 && Math.abs(t.y - 19.2995) < 0.001)
  // Zoom 7 is exactly twice zoom 6.
  const t7 = M.worldTile(57.9303, 12.5335, 7)
  assert.ok(Math.abs(t7.x - 2 * t.x) < 1e-9 && Math.abs(t7.y - 2 * t.y) < 1e-9)
})

const W = 659, H = 761
const ALINGSAS = [57.9303, 12.5335]

// The view's pixel box, in tile units at its zoom.
const viewBox = (v) => ({ x0: v.left / v.px, y0: v.top / v.px, x1: (v.left + W) / v.px, y1: (v.top + H) / v.px })

test("views never leave the radar coverage", () => {
  M.MAP_ZOOM_STEPS.forEach((step, i) => {
    for (const [lat, lon] of [ALINGSAS, [55.4, 13.0] /* Skåne */, [69.65, 18.96] /* Tromsø */, [60.17, 24.94] /* Helsinki */]) {
      const v = M.mapView(i, lat, lon, W, H)
      const b = M.coverageTiles(v.z)
      const box = viewBox(v)
      const eps = 1 / v.px
      if (b.x1 - b.x0 >= W / v.px) assert.ok(box.x0 >= b.x0 - eps && box.x1 <= b.x1 + eps, `step ${i} ${lat},${lon} x`)
      if (b.y1 - b.y0 >= H / v.px) assert.ok(box.y0 >= b.y0 - eps && box.y1 <= b.y1 + eps, `step ${i} ${lat},${lon} y`)
      assert.ok(Number.isInteger(v.left) && Number.isInteger(v.top))
    }
  })
})

test("overview frames the whole coverage; closer steps centre on the place when they can", () => {
  const o = M.mapView(0, ...ALINGSAS, W, H)
  const b = M.coverageTiles(o.z)
  const box = viewBox(o)
  assert.ok(box.x0 <= b.x0 && box.x1 >= b.x1 && box.y0 <= b.y0 && box.y1 >= b.y1, "coverage fits")
  assert.ok(o.px <= 256)
  // Same overview wherever you are.
  assert.deepEqual([o.left, o.top], [M.mapView(0, 69.65, 18.96, W, H).left, M.mapView(0, 69.65, 18.96, W, H).top])
  // Zoomed in on Alingsås: centred.
  const v = M.mapView(3, ...ALINGSAS, W, H)
  assert.ok(Math.abs(v.markerX - W / 2) <= 1 && Math.abs(v.markerY - H / 2) <= 1)
  // Zoomed in on Skåne: pushed north to stay in coverage, so the marker sits low.
  const sk = M.mapView(2, 55.4, 13.0, W, H)
  assert.ok(sk.markerY > H / 2 + 50, `marker at ${sk.markerY}`)
  assert.ok(sk.markerX >= 0 && sk.markerX <= W && sk.markerY >= 0 && sk.markerY <= H)
})

test("view tiles cover the view without gaps, and radar lines up", () => {
  M.MAP_ZOOM_STEPS.forEach((step, i) => {
    const v = M.mapView(i, ...ALINGSAS, W, H)
    const base = M.viewTiles(v, W, H)
    for (const [px, py] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1], [W / 2, H / 2]]) {
      const hits = base.filter((t) => px >= t.left && px < t.left + t.size && py >= t.top && py < t.top + t.size)
      assert.equal(hits.length, 1, `step ${i} pixel ${px},${py}`)
    }
    const r = M.radarView(v)
    const f = Math.pow(2, v.z - r.z)
    for (const rt of M.viewTiles(r, W, H)) {
      const b = base.find((t) => t.x === rt.x * f && t.y === rt.y * f)
      if (b) assert.deepEqual([b.left, b.top], [rt.left, rt.top], `step ${i}`)
    }
  })
})

test("map maths never loops or divides by zero on odd box sizes", () => {
  // A tile size of 0 would make viewTiles loop forever and hang the shell.
  // Each case runs in a child process, so such a loop can't hang the tests.
  const { execFileSync } = require("node:child_process")
  const script = `
    const M = require(${JSON.stringify(path.join(__dirname, "load-model.js"))})
    for (const [w, h] of [[0, 0], [1, 1], [3, 3], [63, 700], [NaN, 500], [-5, 10], [659, 761]])
      for (let step = 0; step < M.MAP_ZOOM_STEPS.length; step++) {
        const v = M.mapView(step, 57.93, 12.53, w, h)
        const tiles = M.viewTiles(v, w, h)
        M.viewTiles(M.radarView(v), w, h)
        M.mapLabels({ places: [["A", "A", "A", 57.9, 12.5, 1e6, 3]] }, v, w, h, "sv", 7, "X")
        if (w < 64 || !(w >= 64)) { if (v !== null || tiles.length) throw new Error("view for tiny box " + w) }
        else if (!tiles.length) throw new Error("no tiles for " + w + "x" + h)
      }
    // Hostile views are refused rather than looped over.
    for (const v of [{ z: 5, px: 0, left: -1, top: -1 }, { z: 5, px: NaN, left: 0, top: 0 },
                     { z: 5, px: 1, left: 0, top: 0 }, null])
      M.viewTiles(v, 659, 761)
    console.log("ok")`
  const out = execFileSync(process.execPath, ["-e", script], { timeout: 5000 }).toString().trim()
  assert.equal(out, "ok")
})

test("map zoom steps", () => {
  assert.equal(M.clampMapStep("9"), M.MAP_ZOOM_STEPS.length - 1)
  assert.equal(M.clampMapStep(-2), 0)
  assert.equal(M.clampMapStep(undefined), M.MAP_DEFAULT_STEP)
  assert.deepEqual(M.radarView({ z: 7, px: 256, left: 1, top: 2 }), { z: 6, px: 512, left: 1, top: 2 })
  assert.deepEqual(M.radarView({ z: 6, px: 181, left: 1, top: 2 }), { z: 6, px: 181, left: 1, top: 2 })
  assert.equal(M.mapTilePath({ z: 6, x: 34, y: 19 }), "map/tiles/6/34/19.png")
  // The build script uses the same coverage box and zoom steps.
  const script = fs.readFileSync(path.join(__dirname, "..", "scripts", "build-basemap.py"), "utf8")
  const c = M.RADAR_COVERAGE
  assert.ok(script.includes(`COVERAGE = (${c.west}, ${c.south}, ${c.east}, ${c.north})`), "COVERAGE out of sync")
  const zooms = [...new Set(M.MAP_ZOOM_STEPS.map((s) => s.z))].join(", ")
  assert.ok(script.includes(`ZOOMS = (${zooms})`), "ZOOMS out of sync")
})

test("radar frames: observations then nowcast, with the now marker", () => {
  const { frames, nowIndex } = M.radarFrames(fixture("yr-radar-observations.json"), fixture("yr-radar-nowcast.json"))
  assert.equal(nowIndex, 17)
  assert.equal(frames[nowIndex].forecast, false)
  assert.equal(frames[nowIndex + 1].forecast, true)
  assert.ok(frames.every((f, i) => i === 0 || f.timeMs > frames[i - 1].timeMs))
  assert.equal(frames.length, 18 + 24)
  assert.match(frames[0].template, /\{z\}\/\{x\}\/\{y\}\.png$/)
  // Nowcast frames at or before the last observation are dropped.
  const overlap = M.radarFrames(fixture("yr-radar-observations.json"), fixture("yr-radar-observations.json"))
  assert.equal(overlap.frames.length, 18)
  assert.deepEqual(M.radarFrames("", ""), { frames: [], nowIndex: -1 })
  // Every frame knows its run; runs differ between observations and nowcast
  // (and between successive nowcasts), so caches keyed by run never mix them.
  assert.match(frames[0].runId, /^[0-9a-f]{32}$/)
  assert.notEqual(frames[nowIndex].runId, frames[nowIndex + 1].runId)
  assert.ok(frames.slice(nowIndex + 1).every((f) => f.runId === frames[nowIndex + 1].runId))
  const a = M.radarTileFile({ z: 6, x: 1, y: 1 }, { timeMs: 5, runId: "run1" })
  const b = M.radarTileFile({ z: 6, x: 1, y: 1 }, { timeMs: 5, runId: "run2" })
  assert.notEqual(a, b, "same time, different forecast runs → different cache files")
  assert.equal(M.tileRunId("https://tiles.yr.no/api/precipitation-nowcast/01a0df3c-6d8e-71b9-8dd0-69864ef18745/202609261935/tiles/{z}/{x}/{y}.png"),
    "01a0df3c6d8e71b98dd069864ef18745")
  assert.equal(M.tileRunId("https://x/{z}/{x}/{y}.png"), "")
  // 16:45 UTC observed = 18:45 local; the first nowcast frame is labelled as forecast.
  assert.equal(M.mapFrameLabel(frames[nowIndex], "sv"), "18:45")
  assert.equal(M.mapFrameLabel(frames[nowIndex + 1], "sv"), "Prognos 19:05")
  assert.equal(M.mapFrameLabel(frames[nowIndex + 1], "en"), "Forecast 19:05")
  assert.equal(M.mapFrameLabel(null, "sv"), "")
})

test("radar tile urls and cache names", () => {
  assert.equal(M.tileUrl("https://x/{z}/{x}/{y}.png", 6, 34, 19), "https://x/6/34/19.png")
  assert.equal(M.radarTileFile({ z: 6, x: 34, y: 19 }, { timeMs: 123, runId: "abc" }), "r_abc_123_6_34_19.png")
  assert.equal(M.radarTileFile({ z: 6, x: 34, y: 19 }, { timeMs: 123, runId: "" }), "r_123_6_34_19.png")
  const dl = M.radarDownloads([{ z: 6, x: 3, y: 4 }, { z: 6, x: 5, y: 4 }],
    [{ timeMs: 1, template: "u/{z}/{x}/{y}" }, { timeMs: 2, template: "v/{z}/{x}/{y}" }])
  assert.equal(dl.length, 2 * 2)
  assert.deepEqual(dl[0], { url: "u/6/3/4", file: "r_1_6_3_4.png" })  // no run id in these templates
})

test("tile download fetches only missing tiles and never keeps failures", () => {
  const { execFileSync } = require("node:child_process")
  const os = require("node:os")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "met-tiles-"))
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "met-fakecurl-"))
  const log = path.join(bin, "calls")
  // Fake curl: logs its URLs; writes each -o target unless the URL contains "missing".
  fs.writeFileSync(path.join(bin, "curl"), `#!/bin/bash
out=""
for a in "$@"; do
  if [[ $prev == -o ]]; then out=$a
  elif [[ $a == http* ]]; then echo "$a" >> "${log}"; [[ $a == *missing* ]] || printf 'PNG' > "$out"
  fi
  prev=$a
done
`, { mode: 0o755 })
  const run = (downloads) => {
    const cmd = M.tileDownloadCommand(dir, downloads)
    return execFileSync(cmd[0], cmd.slice(1), { env: { ...process.env, PATH: bin + ":" + process.env.PATH } }).toString().trim()
  }
  fs.writeFileSync(path.join(dir, "r_0_6_9_9.png"), "cached")
  const out = run([
    { url: "http://t/cached", file: "r_0_6_9_9.png" },
    { url: "http://t/r1", file: "r_1_6_1_1.png" },
    { url: "http://t/missing", file: "r_2_6_1_1.png" },
  ])
  assert.equal(out, "2 1")  // two were not cached; one of them failed and is still missing
  assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["http://t/r1", "http://t/missing"])
  assert.equal(fs.readFileSync(path.join(dir, "r_0_6_9_9.png"), "utf8"), "cached")
  assert.equal(fs.readFileSync(path.join(dir, "r_1_6_1_1.png"), "utf8"), "PNG")
  assert.ok(!fs.existsSync(path.join(dir, "r_2_6_1_1.png")))
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".part")), [])
})

test("radar frames are assembled with each tile in its place", { skip: !fs.existsSync("/usr/bin/magick") && "ImageMagick not installed" }, () => {
  const { execFileSync } = require("node:child_process")
  const os = require("node:os")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "met-frames-"))
  // Two 256 px tiles: red and blue. The view puts them at (-100, 10) and
  // (156, 10) scaled to 128 px, on a 200×150 map.
  execFileSync("magick", ["-size", "256x256", "xc:#ff0000", path.join(dir, "r_1_6_1_1.png")])
  execFileSync("magick", ["-size", "256x256", "xc:#0000ff", path.join(dir, "r_1_6_2_1.png")])
  const tiles = [{ z: 6, x: 1, y: 1, left: -100, top: 10, size: 128 }, { z: 6, x: 2, y: 1, left: 28, top: 10, size: 128 }]
  const specs = M.frameComposeSpecs(tiles, [{ timeMs: 1 }, { timeMs: 2 }], "v")
  assert.deepEqual(specs[0].split("|"), ["f_1_v.png", "r_1_6_1_1.png:-100:10", "r_1_6_2_1.png:28:10"])
  const cmd = M.frameComposeCommand(dir, 200, 150, 128, specs)
  assert.equal(execFileSync(cmd[0], cmd.slice(1)).toString().trim(), "2 1")  // two frames, one made
  const pixel = (x, y) => execFileSync("magick", [path.join(dir, "f_1_v.png"), "-format", `%[pixel:p{${x},${y}}]`, "info:"]).toString()
  assert.match(pixel(10, 50), /\(255,0,0\)|red/)       // red tile, shifted left
  assert.match(pixel(100, 50), /\(0,0,255\)|blue/)     // blue tile from x = 28
  assert.match(pixel(100, 5), /\(0,0,0\)|black/)       // above the tiles: background
  assert.match(pixel(190, 145), /\(0,0,0\)|black/)     // past the blue tile (28 + 128 = 156)
  // Frame 2 has no tiles on disk: left out, never an empty frame.
  assert.ok(!fs.existsSync(path.join(dir, "f_2_v.png")))
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".part")), [])
  assert.equal(M.mapViewKey({ z: 6, px: 181, left: 5, top: -3 }, 633, 738), "6_181_5_-3_633_738")
  assert.equal(M.mapViewKey(null, 1, 1), "")
})

test("Model.js is a shared, stateless QML library", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "Model.js"), "utf8")
  assert.equal(source.split("\n")[0], ".pragma library")
  // A .pragma library can't reach QML objects or the Qt global.
  assert.doesNotMatch(source.replace(/\/\/.*$/gm, ""), /\bQt\.|\bQuickshell\b|\broot\./)
})

test("radar frame-list keys differ whenever any frame's run or time does", () => {
  const f = (runId, timeMs) => ({ runId, timeMs })
  const a = [f("obs1", 1), f("obs1", 2), f("now1", 3)]
  assert.equal(M.radarFramesKey(a), M.radarFramesKey(a.map((x) => ({ ...x }))))
  // Same first and last frame, different run in the middle.
  assert.notEqual(M.radarFramesKey(a), M.radarFramesKey([f("obs1", 1), f("obs2", 2), f("now1", 3)]))
  assert.notEqual(M.radarFramesKey(a), M.radarFramesKey([f("obs1", 1), f("now1", 3)]))
  assert.equal(M.radarFramesKey([]), "")
})

test("time ruler: tallest at now, falling off to both ends, hours marked", () => {
  const t0 = Date.parse("2026-09-27T07:50:00Z")  // 09:50 local
  const frames = Array.from({ length: 7 }, (_, i) => ({ timeMs: t0 + i * 300000, forecast: i > 2 }))
  const ticks = M.rulerTicks(frames, 2)
  assert.deepEqual(ticks.map((t) => t.level), [0.5, 0.75, 1, 0.75, 0.5, 0.25, 0])
  assert.deepEqual(ticks.map((t) => t.hour), [false, false, true, false, false, false, false])  // 10:00
  assert.deepEqual(ticks.map((t) => t.forecast), [false, false, false, true, true, true, true])
  assert.equal(new Set(ticks.map((t) => t.key)).size, ticks.length)
  // A new "now" changes the levels, so the keys change too (ScriptModel).
  assert.notEqual(M.rulerTicks(frames, 3)[0].key, ticks[0].key)
  // No observations: the ruler peaks at the first frame.
  assert.equal(M.rulerTicks(frames, -1)[0].level, 1)
  assert.deepEqual(M.rulerTicks([], 0), [])
  assert.deepEqual(M.rulerTicks([frames[0]], 0).map((t) => t.level), [1])
})

test("radar: rotating slots retain decoded endpoints across advancement and wrap", () => {
  const frames = Array.from({ length: 5 }, (_, i) => ({ timeMs: i * 300000 }))
  let prev = M.radarImageSlots(frames, 0, 0)
  for (let tick = 1; tick <= 12; tick++) {
    const next = M.radarImageSlots(frames, tick % frames.length, tick)
    assert.equal(next.current, prev.upcoming)
    assert.equal(next.frames[next.current], prev.frames[prev.upcoming])
    assert.equal(next.frames.filter((f, i) => f !== prev.frames[i]).length, 1)
    prev = next
  }
  for (const n of [1, 2]) {
    const a = M.radarImageSlots(frames.slice(0, n), 0, 0)
    const b = M.radarImageSlots(frames.slice(0, n), 1 % n, 1)
    assert.deepEqual(a.frames, b.frames)
  }
  assert.deepEqual(M.radarImageSlots([], 0, 0).frames, [null, null, null])
})

test("radar: one frame per tick, wrapping, and waiting on the newest frame while loading", () => {
  const frames = Array.from({ length: 10 }, (_, i) => ({ timeMs: i * 300000 }))
  // Six of ten assembled: slots stay within them, wrapping inside the prefix.
  const slots = M.radarImageSlots(frames, 5, 5, 6)
  assert.ok(slots.frames.every((f) => f === null || f.timeMs < 6 * 300000))
  assert.equal(slots.frames[slots.current], frames[5])
  assert.deepEqual(M.radarStep(3, 3, 10, 6), { frame: 4, tick: 4 })
  assert.deepEqual(M.radarStep(5, 5, 10, 6), { frame: 5, tick: 5 })     // newest assembled: wait
  assert.deepEqual(M.radarStep(5, 5, 10, 8), { frame: 6, tick: 6 })     // more arrived: on
  assert.deepEqual(M.radarStep(9, 9, 10, 10), { frame: 0, tick: 10 })   // complete: wrap
  assert.deepEqual(M.radarStep(9, 9, 10), { frame: 0, tick: 10 })
  assert.deepEqual(M.radarStep(7, 7, 5, 5), { frame: 0, tick: 8 })      // from a longer loop
  assert.deepEqual(M.radarStep(0, 2, 1), { frame: 0, tick: 2 })         // a single frame
})

test("radar: a replacement loop carries on at the same time", () => {
  const frames = [300000, 600000, 900000].map((timeMs) => ({ timeMs }))
  assert.equal(M.radarFrameAt(frames, 600000), 1)
  assert.equal(M.radarFrameAt(frames, 450000), 1)   // between frames: the next one
  assert.equal(M.radarFrameAt(frames, 0), 0)        // dropped off the start
  assert.equal(M.radarFrameAt(frames, 1200000), 0)  // past the end: from the start
  assert.equal(M.radarFrameAt([], 0), 0)
})

test("list keys: unique, stable for unchanged content, new for changed content", () => {
  const build = (nowMs) => M.buildView({ forecast: alingsas, nowcast: nowcastAlingsas, sun, moon,
    location: { name: "Alingsås", latitude: 57.93, longitude: 12.53 }, lang: "sv", nowMs, settings: {} })
  const a = build(NOW), b = build(NOW + 60000)
  const rowKeys = (v) => v.days.flatMap((d) => d.rows.map((r) => r.key))
  for (const keys of [rowKeys(a), a.days.map((d) => d.key), a.longRange.map((d) => d.key)])
    assert.equal(new Set(keys).size, keys.length, "keys must be unique (ScriptModel requirement)")
  // A minute later nothing in the rows changed: same keys, so no rebuilds.
  assert.deepEqual(rowKeys(b), rowKeys(a))
  assert.deepEqual(b.longRange.map((d) => d.key), a.longRange.map((d) => d.key))
  // Changed content → changed key.
  const changed = JSON.parse(JSON.stringify(a.days[0].rows[0])); changed.temp += 1
  assert.notEqual(M.contentKey ? M.contentKey(changed) : null, a.days[0].rows[0].key)
  // Tiles, labels, suggestions and nowcast points carry keys too.
  const v = M.mapView(1, 57.93, 12.53, 659, 761)
  const tiles = M.viewTiles(v, 659, 761)
  assert.equal(new Set(tiles.map((t) => t.key)).size, tiles.length)
  assert.ok(M.parseGeocodingResults(fixture("geocode-alings.json")).every((r) => typeof r.key === "string"))
  assert.ok(a.nowcast.points.every((p) => typeof p.key === "string"))
})
