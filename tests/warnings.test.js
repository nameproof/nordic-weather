// Weather warnings: provider routing, parsing, the band's rows. Run with npm test.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const { spawnSync } = require("node:child_process")
const M = require("./load-model.js")

const outlines = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "map", "countries.json"), "utf8"))
const NOW = Date.parse("2026-11-14T10:00:00Z")  // Saturday 11:00 local
const hours = (h) => NOW + h * 3600000
const iso = (ms) => new Date(ms).toISOString()
// A square around Alingsås, as GeoJSON and as a flat ring.
const square = [[12.3, 57.8], [12.8, 57.8], [12.8, 58.1], [12.3, 58.1], [12.3, 57.8]]

test("warnings: the provider follows the country, both near a shared border", () => {
  const at = (lat, lon) => M.warningCountries(outlines, lat, lon).join(",")
  assert.equal(at(57.93, 12.53), "SE")      // Alingsås
  assert.equal(at(59.91, 10.75), "NO")      // Oslo
  assert.equal(at(60.17, 24.94), "FI")      // Helsinki
  assert.equal(at(60.097, 19.934), "FI")    // Mariehamn: Åland is Finland's
  assert.equal(at(65.836, 24.136), "SE,FI") // Haparanda, on the border
  assert.equal(at(58.936, 11.171), "SE")    // Strömstad, near Norway
  assert.equal(at(57.64, 18.29), "SE")      // Visby
  assert.equal(at(69.047, 20.79), "FI")     // Kilpisjärvi
  assert.equal(at(59.31, 4.88), "NO")       // Utsira, an island the outlines lack
  assert.equal(at(55.68, 12.57), "")        // Copenhagen: Denmark has no provider
  assert.equal(at(52.52, 13.4), "")         // Berlin
  assert.equal(at(57.0, 3.0), "")           // the North Sea
  assert.deepEqual(M.warningCountries(null, 57.9, 12.5), [])
})

test("warnings: SMHI, yellow and up on land, never Meddelande or sea", () => {
  const area = (id, level, extra) => Object.assign({
    id, warningLevel: { code: level }, approximateStart: iso(hours(-1)), approximateEnd: iso(hours(5)),
    areaName: { sv: "Västra Götalands län", en: "Västra Götaland County" },
    eventDescription: { sv: "Mycket kraftiga vindbyar", en: "Very strong gusts" },
    descriptions: [{ title: { code: "AFFECT" }, text: { sv: "Undvik skogen.", en: "Avoid forests." } }],
    area: { type: "Feature", geometry: { type: "Polygon", coordinates: [square] } }
  }, extra)
  const body = JSON.stringify([
    { id: 1, event: { code: "WIND" }, warningAreas: [area(11, "ORANGE"), area(12, "MESSAGE")] },
    { id: 2, event: { code: "WIND_SEA" }, warningAreas: [area(21, "YELLOW")] },
    { id: 3, event: { code: "WATER_SHORTAGE" }, warningAreas: [area(31, "MESSAGE")] },
    { id: 4, event: { code: "SNOW" }, warningAreas: [area(41, "YELLOW", { approximateEnd: undefined,
      area: { type: "MultiPolygon", coordinates: [[square]] } })] }
  ])
  const parsed = M.parseSmhiWarnings(body)
  assert.deepEqual(parsed.warnings.map((w) => [w.id, w.level]), [["smhi:1:11", 2], ["smhi:4:41", 1]])
  const w = parsed.warnings[0]
  assert.equal(w.title.sv, "Mycket kraftiga vindbyar")
  assert.equal(w.advice.en, "Avoid forests.")
  assert.equal(w.areas[0].polygons[0][0].length, 10)
  assert.equal(parsed.warnings[1].endMs, null)
  assert.equal(M.parseSmhiWarnings("<html>"), null)
  // Areas of one warning that overlap (a later yellow phase over an active
  // orange core) are separate rows; neither hides the other.
  const phases = M.parseSmhiWarnings(JSON.stringify([{ id: 5, event: { code: "WIND" }, warningAreas: [
    area(51, "YELLOW", { approximateStart: iso(hours(6)), approximateEnd: iso(hours(12)) }),
    area(52, "ORANGE")] }]))
  const rows = M.buildWarnings({ sources: { smhi: phases }, providers: ["smhi"], latitude: 57.93, longitude: 12.53 }, NOW, "sv")
  assert.deepEqual(rows.map((r) => [r.id, r.level]), [["smhi:5:52", 2], ["smhi:5:51", 1]])
  assert.deepEqual(M.parseSmhiWarnings("[]").warnings, [])
})

test("warnings: MET, land only, level from the risk matrix colour", () => {
  const feature = (id, color, domain) => ({
    when: { interval: [iso(hours(-2)), iso(hours(10))] },
    properties: { id, riskMatrixColor: color, geographicDomain: domain, eventAwarenessName: "Ising",
      description: "Glatte veier.", consequences: "Fare for skader.", instruction: "Bruk brodder.",
      area: "Oslo", eventEndingTime: iso(hours(8)) }
  })
  const body = JSON.stringify({ features: [feature("a", "Red", "land"), feature("b", "Yellow", "marine"), feature("c", "Green", "land")] })
  const parsed = M.parseMetAlerts(body, "nb")
  assert.equal(parsed.warnings.length, 1)
  const w = parsed.warnings[0]
  assert.equal(w.level, 3)
  assert.equal(w.title.nb, "Ising: Glatte veier.")
  assert.equal(w.advice.nb, "Fare for skader. Bruk brodder.")
  assert.equal(w.endMs, hours(8))
  assert.equal(M.parseMetAlerts("{}", "en"), null)
  assert.match(M.metAlertsUrl({ latitude: 59.91, longitude: 10.75 }, "nb"), /lang=no&geographicDomain=land$/)
  assert.match(M.metAlertsUrl({ latitude: 59.91, longitude: 10.75 }, "sv"), /lang=en&/)
})

const rssItem = (title, guid) => `<item><title>${title}</title><guid isPermaLink="false">${guid}</guid></item>`
const rss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>FMI</title>${items.join("")}</channel></rss>`

test("warnings: FMI's RSS decides whether the Atom feed is needed", () => {
  const sea = rssItem("Yellow wind warning for sea area: Gulf of Finland, Sat 5.06 - 18.00", "urn:1")
  const land = rssItem("Yellow traffic weather warning: Southern Lapland, Sat 5.06 - Sun 0.00", "urn:2")
  assert.deepEqual(M.parseFmiRss(rss([sea])), { ids: ["urn:1"], needsAtom: false })
  assert.deepEqual(M.parseFmiRss(rss([sea, land])), { ids: ["urn:1", "urn:2"], needsAtom: true })
  assert.deepEqual(M.parseFmiRss(rss([])), { ids: [], needsAtom: false })
  // Any wording it doesn't know fetches the Atom feed.
  assert.equal(M.parseFmiRss(rss([rssItem("Gale warning for sea areas", "urn:3")])).needsAtom, true)
  assert.equal(M.parseFmiRss("<html></html>"), null)
})

const capInfo = (lang, color, areas) => `<info><language>${lang}</language><event>Liikennesää</event>
  <description>${lang === "sv-FI" ? "Trafikvädret: Dåligt väglag &amp; snö." : "Traffic weather: bad roads."}</description>
  <onset>${iso(hours(1))}</onset><expires>${iso(hours(13))}</expires>
  <parameter><valueName>color</valueName><value>${color}</value></parameter>
  <parameter><valueName>typicalImpacts</valueName><value>Ökad olycksrisk.</value></parameter>
  ${areas}</info>`
const landArea = (name) => `<area><areaDesc>${name}</areaDesc><polygon>57.8,12.3 57.8,12.8 58.1,12.8 58.1,12.3 57.8,12.3</polygon>
  <geocode><valueName>FI-kuntanumero</valueName><value>698</value></geocode></area>`
const seaArea = `<area><areaDesc>Pohjois-Itämeri</areaDesc><polygon>57.8,12.3 57.8,12.8 58.1,12.8 57.8,12.3</polygon>
  <geocode><valueName>METAREA</valueName><value>B7E</value></geocode></area>`
const entry = (id, msgType, infos) => `<entry><content type="text/xml"><alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>${id}</identifier><status>Actual</status><msgType>${msgType}</msgType>${infos}</alert></content></entry>`
const atom = (entries) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries.join("")}</feed>`

test("warnings: FMI's Atom feed, land areas in every language", () => {
  const parsed = M.parseFmiAtom(atom([
    entry("urn:land", "Update", capInfo("fi-FI", "orange", landArea("Rovaniemi")) + capInfo("sv-FI", "orange", landArea("Rovaniemi"))),
    entry("urn:sea", "Alert", capInfo("en-GB", "yellow", seaArea)),
    entry("urn:gone", "Cancel", capInfo("en-GB", "red", landArea("Oulu"))),
    entry("urn:green", "Alert", capInfo("en-GB", "green", landArea("Oulu")))
  ]))
  assert.deepEqual(parsed.ids, ["urn:land", "urn:sea", "urn:gone", "urn:green"])
  assert.equal(parsed.warnings.length, 1)
  const w = parsed.warnings[0]
  assert.equal(w.id, "fmi:urn:land")
  assert.equal(w.level, 2)
  assert.equal(w.title.sv, "Trafikvädret: Dåligt väglag & snö.")
  assert.equal(w.advice.sv, "Ökad olycksrisk.")
  assert.equal(w.areas[0].name.fi, "Rovaniemi")
  // CAP polygons are "lat,lon"; stored as lon, lat.
  assert.deepEqual(w.areas[0].polygons[0][0].slice(0, 2), [12.3, 57.8])
  assert.equal(M.parseFmiAtom("<rss/>"), null)
})

test("warnings: inherited names, object-shaped values and oversized FMI feeds", () => {
  const smhiArea = (code, id) => ({ id, warningLevel: { code }, approximateStart: iso(hours(-1)), approximateEnd: iso(hours(5)),
    eventDescription: { en: "Gusts" }, area: { type: "Polygon", coordinates: [square] } })
  const smhi = M.parseSmhiWarnings(JSON.stringify([{ id: { toString: 1 }, event: { code: "WIND" }, warningAreas: [
    smhiArea("constructor", 1), smhiArea("__proto__", 2), smhiArea({ toString: 1 }, 3), smhiArea("YELLOW", { toString: 1 }),
    smhiArea("RED", 5)] }]))
  assert.deepEqual(smhi.warnings.map((w) => [w.id, w.level]), [["smhi::", 1], ["smhi::5", 3]])

  const met = M.parseMetAlerts(JSON.stringify({ features: [
    { properties: { id: "a", riskMatrixColor: "constructor", geographicDomain: "land" } },
    { properties: { id: "b", riskMatrixColor: { toString: 1 }, awareness_level: "2; yellow; Moderate", geographicDomain: "land",
      eventAwarenessName: { toString: 1 }, description: "Glatt.", eventEndingTime: { toString: 1 } } }] }), "en")
  assert.deepEqual(met.warnings.map((w) => [w.id, w.level, w.title.en, w.endMs]), [["met:b", 1, "Glatt.", null]])

  const fmi = M.parseFmiAtom(atom([
    entry("urn:a", "Alert", capInfo("constructor", "orange", landArea("Oulu"))),
    entry("urn:b", "Alert", capInfo("en-GB", "constructor", landArea("Oulu"))),
    entry("urn:c", "Alert", capInfo("en-GB", "toString", landArea("Oulu")) + capInfo("sv-FI", "red", landArea("Oulu")))
  ]))
  assert.deepEqual(fmi.warnings.map((w) => [w.id, w.level, Object.keys(w.title)]), [["fmi:urn:c", 3, ["en", "sv"]]])

  // A feed far past what FMI publishes, cut off, or with an overlong id is
  // unreadable rather than slow or empty.
  const many = Array.from({ length: M.MAX_FMI_ENTRIES + 1 }, (_, i) => rssItem("x", "urn:" + i))
  assert.equal(M.parseFmiRss(rss(many)), null)
  assert.equal(M.parseFmiAtom(atom(Array.from({ length: M.MAX_FMI_ENTRIES + 1 }, (_, i) => entry("urn:" + i, "Alert", "")))), null)
  const whole = rss([rssItem("Yellow wind warning for sea area: Gulf of Finland", "urn:1")])
  assert.equal(M.parseFmiRss(whole.slice(0, -"</rss>".length)), null)
  assert.equal(M.parseFmiRss(whole.slice(0, whole.indexOf("</item>"))), null)
  const feed = atom([entry("urn:land", "Alert", capInfo("en-GB", "orange", landArea("Oulu")))])
  assert.equal(M.parseFmiAtom(feed.slice(0, -10)), null)
  assert.equal(M.parseFmiRss(rss([rssItem("x", "u".repeat(257))])), null)
  assert.equal(M.parseFmiAtom(atom([entry("u".repeat(257), "Alert", "")])), null)
  // A feed with an item or entry left open, or a provider list holding
  // something other than warnings, is malformed rather than empty.
  assert.equal(M.parseFmiRss(rss(["<item><guid>u</guid>"])), null)
  assert.equal(M.parseFmiAtom(atom([entry("urn:a", "Alert", "<info><language>en-GB</language>")])), null)
  assert.equal(M.parseSmhiWarnings("[null]"), null)
  assert.equal(M.parseMetAlerts('{"features":[null]}', "en"), null)
  // A self-closing element is empty, not paired with a later closing tag.
  const selfClosing = atom([entry("urn:s", "Alert", capInfo("en-GB", "orange",
    '<area><areaDesc>Oulu</areaDesc><polygon /></area>' + landArea("Kemi")))])
  assert.deepEqual(M.parseFmiAtom(selfClosing).warnings[0].areas.map((a) => a.name.en), ["Kemi"])
  // CDATA is unwrapped in one pass; an unclosed section stays as text.
  assert.deepEqual(M.parseFmiRss(rss([rssItem("<![CDATA[Gale & rain]]>", "<![CDATA[urn:9]]>")])).ids, ["urn:9"])
  assert.deepEqual(M.parseFmiRss(rss([rssItem("x", "a<![CDATA[b")])).ids, ["a<![CDATA[b"])
  // Hostile shapes at the response size limit parse in one pass.
  const started = Date.now()
  for (const body of [rss(["<item><title>x</title>".repeat(360000)]), rss(["<item <".repeat(1000000)]),
    atom(["<entry><alert>".repeat(500000)]), rss(["<item ".repeat(1300000)]),
    rss([rssItem("<![CDATA[".repeat(900000), "u")])])
    assert.ok(M.parseFmiRss(body) !== undefined && M.parseFmiAtom(body) !== undefined)
  assert.ok(Date.now() - started < 2000, "took " + (Date.now() - started) + " ms")
  // The two feeds agree only on the same ids, each as often.
  assert.ok(M.sameFmiIds(["a", "b"], ["b", "a"]))
  assert.ok(!M.sameFmiIds(["a", "a"], ["a", "b"]))
  assert.ok(!M.sameFmiIds(["a", "b"], ["a", "a"]))
  assert.ok(!M.sameFmiIds(["a"], ["a", "b"]))
  assert.ok(!M.sameFmiIds(["constructor"], ["x"]))
  assert.ok(!M.sameFmiIds([{ toString: 1 }], [{ toString: 1 }]))
})

test("warnings: the band's rows, worst first, ended ones gone", () => {
  const warning = (id, level, start, end) => ({ id, level, title: { sv: "Titel " + id, en: "Title " + id },
    advice: { sv: "Råd" }, startMs: start, endMs: end, areas: [{ name: { sv: "Område" }, polygons: [[square.flat()]] }] })
  const smhi = { key: M.SMHI_WARNINGS_URL, warnings: [
    warning("y", 1, hours(-1), hours(3)), warning("o", 2, hours(14), hours(38)),
    warning("old", 3, hours(-9), hours(-1)), warning("open", 1, hours(-1), null)] }
  const input = { sources: { smhi }, providers: ["smhi"], latitude: 57.93, longitude: 12.53 }
  const rows = M.buildWarnings(input, NOW, "sv")
  assert.deepEqual(rows.map((r) => [r.id, r.label, r.when]), [
    ["o", "Orange varning", "sön 01 – mån 01"],
    ["y", "Gul varning", "till 14"],
    ["open", "Gul varning", ""]])
  assert.equal(rows[0].advice, "Råd")
  assert.equal(rows[0].area, "Område")
  assert.equal(rows[0].provider, "SMHI")
  assert.ok(rows.every((r) => typeof r.key === "string" && r.key !== r.id))
  assert.equal(M.buildWarnings(input, NOW, "en")[1].when, "until 14")
  assert.equal(M.buildWarnings(input, NOW, "en")[0].when, "Sun 01 – Mon 01")
  // Somewhere else: nothing.
  assert.deepEqual(M.buildWarnings(Object.assign({}, input, { latitude: 59.3, longitude: 18.1 }), NOW, "sv"), [])
  assert.deepEqual(M.buildWarnings(null, NOW, "sv"), [])
  // The view has them even before the forecast is in.
  assert.equal(M.buildView({ lang: "sv", nowMs: NOW, location: { latitude: 57.93, longitude: 12.53 }, warnings: input }).warnings.length, 3)
})

test("warnings: the stored sources survive a round trip; other versions are ignored", () => {
  const sources = { smhi: { key: M.SMHI_WARNINGS_URL, etag: "W/\"1\"", lastModified: "", warnings: [] } }
  assert.deepEqual(M.parseWarningStore(M.warningStoreText(sources)), sources)
  assert.deepEqual(M.parseWarningStore(JSON.stringify({ version: 0, sources })), {})
  assert.deepEqual(M.parseWarningStore(JSON.stringify({ version: 1, sources: { smhi: { key: 1 }, x: {} } })), {})
  assert.deepEqual(M.parseWarningStore("nope"), {})
  // A source holding a warning of any other shape, or malformed fields, is
  // left out whole, validators included, so it is fetched again in full.
  const ring = [12.3, 57.8, 12.8, 57.8, 12.8, 58.1, 12.3, 57.8]
  const ok = { id: "smhi:1:2", level: 2, title: { sv: "Vind" }, advice: {}, startMs: null, endMs: hours(5),
    areas: [{ name: { sv: "Län" }, polygons: [[ring]] }] }
  const stored = (warnings, extra) => M.warningStoreText({ smhi: Object.assign({ key: "k", etag: "", lastModified: "", warnings }, extra) })
  assert.deepEqual(M.parseWarningStore(stored([ok, { ...ok, title: { sv: { toString: 1 }, __proto__: "x" } }])).smhi.warnings,
    [ok, { ...ok, title: {} }])
  for (const bad of [null, 7, { ...ok, level: "2" }, { ...ok, level: 4 }, { ...ok, id: { toString: 1 } }, { ...ok, startMs: "now" },
    { ...ok, areas: [{ name: {}, polygons: [[[1, 2, "3", 4, 5, 6, 7, 8]]] }] }, { ...ok, areas: [{ name: {}, polygons: [[[1, 2]]] }] },
    { ...ok, areas: null }, { ...ok, endMs: 1e20 }, { ...ok, startMs: -5 }])
    assert.deepEqual(M.parseWarningStore(stored([ok, bad])), {}, JSON.stringify(bad))
  // Each provider has its own vertex budget, as when its feed was parsed:
  // two large stored sources both come back.
  const big = (n) => { const r = []; for (let i = 0; i < n; i++) r.push(12 + i / n, 57 + i / n); return r }
  const large = { ...ok, areas: [{ name: {}, polygons: [[big(300000)]] }] }
  const both = M.parseWarningStore(M.warningStoreText({ smhi: { key: "s", etag: "", lastModified: "", warnings: [large] },
    fmi: { key: "f", etag: "", lastModified: "", ids: [], warnings: [{ ...large, id: "fmi:x" }] } }))
  assert.deepEqual(Object.keys(both).sort(), ["fmi", "smhi"])
  assert.deepEqual(M.parseWarningStore(stored([ok], { etag: 5 })), {})
  assert.deepEqual(M.parseWarningStore(stored([ok], { ids: [{ toString: 1 }] })), {})
  const rows = M.buildWarnings({ sources: M.parseWarningStore(stored([ok])), providers: ["smhi"], latitude: 57.93, longitude: 12.53 }, NOW, "sv")
  assert.deepEqual(rows.map((r) => r.id), ["smhi:1:2"])
})

test("warnings: conditional requests and their services", () => {
  const cmd = M.curlCommand("https://x", "", 10, "agent/1", "W/\"25e3f\"")
  assert.ok(cmd.includes("If-None-Match: W/\"25e3f\""))
  assert.ok(!cmd.includes("If-Modified-Since: "))
  assert.equal(M.requestService("warnSmhi"), "smhi")
  assert.equal(M.requestService("warnMet"), "met")
  assert.equal(M.requestService("warnFmiRss"), "fmi")
  assert.equal(M.requestService("warnFmiAtom"), "fmi")
})

test("Quickshell: warning checks only while open, from the right provider, without needless work", {
  skip: !fs.existsSync("/usr/bin/qs") || !fs.existsSync("/usr/share/omarchy/shell/Commons")
    ? "Quickshell and Omarchy required" : false
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nordic-warnings-service-"))
  try {
    for (const file of ["Service.qml", "RadarImages.qml", "Model.js"])
      fs.copyFileSync(path.join(__dirname, "..", file), path.join(dir, file))
    fs.mkdirSync(path.join(dir, "map"))
    fs.copyFileSync(path.join(__dirname, "..", "map", "countries.json"), path.join(dir, "map", "countries.json"))
    fs.copyFileSync(path.join(__dirname, "qml", "warnings.qml"), path.join(dir, "shell.qml"))
    fs.symlinkSync("/usr/share/omarchy/shell/Commons", path.join(dir, "Commons"))
    const runtime = path.join(dir, "runtime")
    fs.mkdirSync(runtime, { mode: 0o700 })
    const result = spawnSync("qs", ["-p", path.join(dir, "shell.qml"), "--no-color"], {
      encoding: "utf8", timeout: 20000,
      env: { ...process.env, QT_QPA_PLATFORM: "offscreen", QT_QUICK_BACKEND: "software",
        HOME: path.join(dir, "home"), XDG_RUNTIME_DIR: runtime, XDG_CACHE_HOME: path.join(dir, "cache"),
        QML_DISABLE_DISK_CACHE: "1" }
    })
    const output = (result.stdout || "") + (result.stderr || "")
    assert.equal(result.status, 0, (result.error || "") + output)
    assert.match(output, /WARNINGS_SERVICE_PASS/, output)
    assert.doesNotMatch(output, /WARNINGS_SERVICE_FAIL|ReferenceError|TypeError|Binding loop/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
