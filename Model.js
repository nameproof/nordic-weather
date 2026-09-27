.pragma library
// Pure logic for the MET Norway weather widget: request URLs, HTTP/cache
// policy, parsing, and the view model the QML binds to. No QML dependencies,
// so `node --test tests/` exercises it directly (see module.exports below;
// tests/load-model.js strips the pragma line, which node can't parse).
//
// `.pragma library`: the engine loads this once and shares it between all
// importers (one Panel per monitor). That is only allowed because it keeps
// no state and never touches QML objects or `Qt` — keep it that way.
//
// Times: API timestamps are absolute (UTC); everything shown to the user is
// local wall-clock time, which comes from the JS engine's zone (the system
// zone inside the shell, TZ=... under node).

var PLUGIN_ID = "io.github.nameproof.nordic-weather"
var VERSION = "0.1.0"
var USER_AGENT = PLUGIN_ID + "/" + VERSION + " github.com/nameproof"
var MET_BASE = "https://api.met.no/weatherapi"
var HOUR_MS = 3600 * 1000
var DAY_MS = 24 * HOUR_MS
var SYNODIC_DEG_PER_DAY = 360 / 29.530589
var NOWCAST_MAX_AGE_MS = 30 * 60000
// Background nowcast cadence while the panel is closed (it follows the
// ~5 min Expires while open).
var NOWCAST_BACKGROUND_MS = 15 * 60000

// ---------------------------------------------------------------- strings

var STRINGS = {
  sv: {
    today: "Idag",
    tomorrow: "Imorgon",
    months: ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"],
    weekdays: ["Söndag", "Måndag", "Tisdag", "Onsdag", "Torsdag", "Fredag", "Lördag"],
    weekdaysShort: ["Sön", "Mån", "Tis", "Ons", "Tor", "Fre", "Lör"],
    compass: ["N", "NO", "O", "SO", "S", "SV", "V", "NV"],
    moonPhases: ["Nymåne", "Växande månskära", "Första kvarter", "Växande måne",
                 "Fullmåne", "Avtagande måne", "Sista kvarter", "Avtagande månskära"],
    feels: "Känns som",
    wind: "Vind",
    humidity: "Fukt",
    gust: "byar",
    comingDays: "Kommande dagar",
    updated: "Uppdaterad",
    stale: "Inaktuell",
    fetching: "Hämtar prognos…",
    searchPlaceholder: "Sök plats",
    noResults: "Inga platser hittades",
    noLocation: "Välj en plats för att se vädret",
    chooseLocation: "Välj plats",
    windLabel: "Vind",
    precipitation: "Nederbörd",
    rain: "Regn",
    sleet: "Snöblandat regn",
    snow: "Snö",
    nowcastDry: "Uppehåll närmaste {n} min",
    nowcastWetAll: "{kind} närmaste {n} min",
    nowcastStopping: "{kind} nu, upphör om ca {n} min",
    nowcastStarting: "{kind} om ca {n} min",
    dayLength: "{h} h {m} min",
    radar: "Radar",
    radarLoading: "Hämtar radar…",
    forecastWord: "Prognos",
    symbols: {
      clearsky: "Klart",
      fair: "Vackert",
      partlycloudy: "Växlande",
      cloudy: "Mulet",
      fog: "Dimma"
    }
  },
  en: {
    today: "Today",
    tomorrow: "Tomorrow",
    months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    weekdays: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    weekdaysShort: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    compass: ["N", "NE", "E", "SE", "S", "SW", "W", "NW"],
    moonPhases: ["New moon", "Waxing crescent", "First quarter", "Waxing gibbous",
                 "Full moon", "Waning gibbous", "Last quarter", "Waning crescent"],
    feels: "Feels like",
    wind: "Wind",
    humidity: "Humidity",
    gust: "gusts",
    comingDays: "Coming days",
    updated: "Updated",
    stale: "Stale",
    fetching: "Fetching forecast…",
    searchPlaceholder: "Search place",
    noResults: "No places found",
    noLocation: "Choose a place to see the weather",
    chooseLocation: "Choose place",
    windLabel: "Wind",
    precipitation: "Precipitation",
    rain: "Rain",
    sleet: "Sleet",
    snow: "Snow",
    nowcastDry: "No precipitation next {n} min",
    nowcastWetAll: "{kind} for the next {n} min",
    nowcastStopping: "{kind} now, stopping in ~{n} min",
    nowcastStarting: "{kind} in ~{n} min",
    dayLength: "{h} h {m} min",
    radar: "Radar",
    radarLoading: "Loading radar…",
    forecastWord: "Forecast",
    symbols: {
      clearsky: "Clear sky",
      fair: "Fair",
      partlycloudy: "Partly cloudy",
      cloudy: "Cloudy",
      fog: "Fog"
    }
  }
}

// Swedish for sv* locales, English for everything else.
function langFor(localeName) {
  return /^sv($|[_.-])/i.test(String(localeName || "")) ? "sv" : "en"
}

function strings(lang) {
  return STRINGS[lang] || STRINGS.en
}

function fill(template, values) {
  return String(template).replace(/\{(\w+)\}/g, function(_, key) {
    return values[key] === undefined ? "" : String(values[key])
  })
}

// ---------------------------------------------------------------- numbers / time

function isNum(value) {
  return typeof value === "number" && isFinite(value)
}

function formatNumber(value, decimals, lang) {
  if (!isNum(value)) return ""
  var s = String(parseFloat(value.toFixed(decimals)))
  return lang === "sv" ? s.replace(".", ",") : s
}

function roundTemp(value) {
  if (!isNum(value)) return null
  var r = Math.round(value)
  return r === 0 ? 0 : r  // no "-0°"
}

function pad2(n) {
  return (n < 10 ? "0" : "") + n
}

// ISO 8601 as the APIs send it: "2026-09-26T12:00:00Z", "2026-09-26T07:02+02:00".
function parseIsoMs(value) {
  var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(String(value || ""))
  if (!m) return NaN
  var ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))
  if (m[7] !== "Z") {
    var sign = m[7][0] === "-" ? -1 : 1
    ms -= sign * (parseInt(m[7].slice(1, 3), 10) * 60 + parseInt(m[7].slice(4, 6), 10)) * 60000
  }
  return ms
}

// RFC 1123 dates from HTTP headers: "Sat, 26 Sep 2026 13:14:28 GMT".
function parseHttpDateMs(value) {
  var m = /(\d{1,2}) (\w{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2})/.exec(String(value || ""))
  if (!m) return NaN
  var month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(m[2])
  if (month < 0) return NaN
  return Date.UTC(+m[3], month, +m[1], +m[4], +m[5], +m[6])
}

function localDateKey(ms) {
  var d = new Date(ms)
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate())
}

function localHour(ms) {
  return new Date(ms).getHours()
}

function localClock(ms) {
  var d = new Date(ms)
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes())
}

// Local midnight `offset` days after the day containing `ms`.
function localDayStart(ms, offset) {
  var d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + (offset || 0)).getTime()
}

// "+02:00" for the local zone on the given day (the sunrise API wants the
// offset of the date asked about, not of today).
function utcOffsetString(ms) {
  var d = new Date(ms)
  var minutes = -new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTimezoneOffset()
  var sign = minutes < 0 ? "-" : "+"
  minutes = Math.abs(minutes)
  return sign + pad2(Math.floor(minutes / 60)) + ":" + pad2(minutes % 60)
}

function dayTitle(dayStartMs, todayStartMs, lang) {
  var s = strings(lang)
  var d = new Date(dayStartMs)
  var diff = Math.round((dayStartMs - todayStartMs) / DAY_MS)
  var name = diff === 0 ? s.today : diff === 1 ? s.tomorrow : s.weekdays[d.getDay()]
  var date = lang === "sv"
    ? d.getDate() + " " + s.months[d.getMonth()]
    : s.months[d.getMonth()] + " " + d.getDate()
  return name + " " + date
}

function dayShortName(dayStartMs, todayStartMs, lang) {
  var s = strings(lang)
  if (Math.round((dayStartMs - todayStartMs) / DAY_MS) === 0) return s.today
  return s.weekdaysShort[new Date(dayStartMs).getDay()]
}

// ---------------------------------------------------------------- requests

function roundCoord(value) {
  return Math.round(Number(value) * 10000) / 10000
}

function hasCoordinates(location) {
  return !!location && isNum(Number(location.latitude)) && isNum(Number(location.longitude))
    && location.latitude !== null && location.longitude !== null
    && location.latitude !== "" && location.longitude !== ""
}

function coordQuery(location) {
  return "lat=" + roundCoord(location.latitude) + "&lon=" + roundCoord(location.longitude)
}

function forecastUrl(location) {
  var url = MET_BASE + "/locationforecast/2.0/complete?" + coordQuery(location)
  if (isNum(location.elevation)) url += "&altitude=" + Math.round(location.elevation)
  return url
}

function nowcastUrl(location) {
  return MET_BASE + "/nowcast/2.0/complete?" + coordQuery(location)
}

function sunUrl(location, ms) {
  return MET_BASE + "/sunrise/3.0/sun?" + coordQuery(location) + "&date=" + localDateKey(ms)
    + "&offset=" + encodeURIComponent(utcOffsetString(ms))
}

function moonUrl(location, ms) {
  return MET_BASE + "/sunrise/3.0/moon?" + coordQuery(location) + "&date=" + localDateKey(ms)
    + "&offset=" + encodeURIComponent(utcOffsetString(ms))
}

function geocodeUrl(query, lang) {
  return "https://geocoding-api.open-meteo.com/v1/search?name=" + encodeURIComponent(query)
    + "&count=6&format=json&language=" + (lang === "sv" ? "sv" : "en")
}

// argv for one request. `-D -` puts the response headers ahead of the body
// on stdout so Expires / Last-Modified reach parseHttpResponse.
function curlCommand(url, lastModified, maxTime) {
  var cmd = ["curl", "-sS", "--compressed", "--max-time", String(maxTime || 10),
             "-A", USER_AGENT, "-D", "-"]
  if (lastModified) cmd.push("-H", "If-Modified-Since: " + lastModified)
  cmd.push(url)
  return cmd
}

function parseHttpResponse(raw) {
  var rest = String(raw || "")
  var result = { status: 0, headers: {}, body: "" }
  // Skip interim/redirect header blocks; the last block belongs to the body.
  while (/^HTTP\/[\d.]+ \d{3}/.test(rest)) {
    var sep = rest.indexOf("\r\n\r\n")
    var sepLen = 4
    if (sep < 0) { sep = rest.indexOf("\n\n"); sepLen = 2 }
    var block = sep < 0 ? rest : rest.slice(0, sep)
    rest = sep < 0 ? "" : rest.slice(sep + sepLen)
    var lines = block.split(/\r?\n/)
    result.status = parseInt(/^HTTP\/[\d.]+ (\d{3})/.exec(lines[0])[1], 10)
    result.headers = {}
    for (var i = 1; i < lines.length; i++) {
      var colon = lines[i].indexOf(":")
      if (colon > 0) result.headers[lines[i].slice(0, colon).trim().toLowerCase()] = lines[i].slice(colon + 1).trim()
    }
  }
  result.body = rest
  return result
}

// Cache entry for one endpoint: what the next request needs plus the body.
//   { key, body, lastModified, expiresMs, fetchedMs }
// `key` identifies the request (coordinates, date) so a location change
// never reuses another place's data.
function isFresh(entry, key, nowMs) {
  return !!entry && entry.key === key && isNum(entry.expiresMs) && nowMs < entry.expiresMs
}

function cacheEntryFromResponse(previous, key, response, nowMs, fallbackTtlMs) {
  var expires = parseHttpDateMs(response.headers.expires)
  if (!isNum(expires)) expires = nowMs + (fallbackTtlMs || 30 * 60000)
  if (response.status === 304 && previous && previous.key === key) {
    return { key: key, body: previous.body, lastModified: previous.lastModified,
             expiresMs: expires, fetchedMs: nowMs }
  }
  return { key: key, body: response.body, lastModified: response.headers["last-modified"] || "",
           expiresMs: expires, fetchedMs: nowMs }
}

// MET asks clients not to fire in sync; spread refreshes out a little.
function jitterMs(random) {
  return Math.floor((random === undefined ? Math.random() : random) * 120000)
}

// ---------------------------------------------------------------- symbols

// MET symbol codes are "<base>[_day|_night|_polartwilight]". Two bases are
// misspelled in the API itself ("lightssleet…", "lightssnow…").
function splitSymbol(code) {
  var s = String(code || "")
  var m = /^(.*?)(?:_(day|night|polartwilight))?$/.exec(s)
  var base = m[1].replace(/^lights(?=s)/, "light")
  return { base: base, variant: m[2] || "" }
}

function parsePrecipBase(base) {
  var m = /^(light|heavy)?(rain|sleet|snow)(showers)?(andthunder)?$/.exec(base)
  if (!m) return null
  return { intensity: m[1] || "", kind: m[2], showers: !!m[3], thunder: !!m[4] }
}

function describeSymbol(code, lang) {
  var s = strings(lang)
  var base = splitSymbol(code).base
  if (s.symbols[base]) return s.symbols[base]
  var p = parsePrecipBase(base)
  if (!p) return base ? base.charAt(0).toUpperCase() + base.slice(1) : ""

  var text
  if (lang === "sv") {
    var nouns = {
      rain: ["regn", "regnskurar"],
      sleet: ["snöblandat regn", "byar av snöblandat regn"],
      snow: ["snöfall", "snöbyar"]
    }
    var noun = nouns[p.kind][p.showers ? 1 : 0]
    var adjective = p.intensity === "light" ? (p.showers ? "lätta " : "lätt ")
      : p.intensity === "heavy" ? (p.showers ? "kraftiga " : "kraftigt ") : ""
    text = adjective + noun + (p.thunder ? " och åska" : "")
  } else {
    text = (p.intensity ? p.intensity + " " : "") + p.kind + (p.showers ? " showers" : "")
      + (p.thunder ? " and thunder" : "")
  }
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// Precipitation family of a symbol ("rain", "sleet", "snow") or "".
function precipKind(code) {
  var p = parsePrecipBase(splitSymbol(code).base)
  return p ? p.kind : ""
}

function isNightSymbol(code) {
  return splitSymbol(code).variant === "night"
}

// Nerd Font "weather" glyphs (Weather Icons). The 28 moon phases are
// contiguous from U+E38D (new) through U+E3A8 (waning crescent 6).
function moonGlyph(phaseDeg) {
  if (!isNum(phaseDeg)) return ""  // night_clear
  var index = Math.round((((phaseDeg % 360) + 360) % 360) / 360 * 28) % 28
  return String.fromCharCode(0xe38d + index)
}

function moonPhaseIndex(phaseDeg) {
  return Math.round((((phaseDeg % 360) + 360) % 360) / 45) % 8
}

// Clear and fair nights use the crescent, not the moon-phase glyphs: near
// full or new moon those are a plain disc or ring, which reads as a glitch in
// the bar. The phase glyph is shown in the footer, next to its name.
function iconForSymbol(code) {
  var sym = splitSymbol(code)
  var night = sym.variant === "night"
  switch (sym.base) {
  case "clearsky":
  case "fair":
    if (night) return "\ue32b"  // night_clear
    return sym.base === "clearsky" ? "" : ""  // day_sunny / day_sunny_overcast
  case "partlycloudy":
    return night ? "" : ""  // night_alt_cloudy / day_cloudy
  case "cloudy":
    return ""
  case "fog":
    return ""
  }

  var p = parsePrecipBase(sym.base)
  if (!p) return ""
  if (p.showers) {
    if (p.kind === "rain") return p.thunder ? (night ? "" : "") : (night ? "" : "")
    if (p.kind === "sleet") return p.thunder ? (night ? "" : "") : (night ? "" : "")
    return p.thunder ? (night ? "" : "") : (night ? "" : "")
  }
  if (p.thunder) return ""  // thunderstorm
  if (p.kind === "rain") return p.intensity === "light" ? "" : ""  // sprinkle / rain
  if (p.kind === "sleet") return ""
  return ""  // snow
}

// ---------------------------------------------------------------- wind

function compassIndex(deg) {
  return Math.round((((deg % 360) + 360) % 360) / 45) % 8
}

function windCompass(deg, lang) {
  return isNum(deg) ? strings(lang).compass[compassIndex(deg)] : ""
}

// MET gives the direction the wind blows *from*; the arrow shows where it goes.
function windArrow(deg) {
  return isNum(deg) ? ["↓", "↙", "←", "↖", "↑", "↗", "→", "↘"][compassIndex(deg)] : ""
}

// ---------------------------------------------------------------- precipitation

function formatPrecip(amount, min, max, lang) {
  if (!isNum(amount) || amount <= 0) {
    if (isNum(max) && max > 0) amount = 0
    else return ""
  }
  if (isNum(min) && isNum(max) && max - min >= 0.1 && max > 0) {
    var lo = min < 0.1 ? "0" : formatNumber(min, 1, lang)
    return lo + "–" + formatNumber(max, 1, lang) + " mm"
  }
  if (amount < 0.1) return "<" + formatNumber(0.1, 1, lang) + " mm"
  return formatNumber(amount, 1, lang) + " mm"
}

// ---------------------------------------------------------------- parsing

function parseJson(text) {
  try {
    var parsed = JSON.parse(String(text || ""))
    return parsed && typeof parsed === "object" ? parsed : null
  } catch (e) {
    return null
  }
}

// Forecast/nowcast body → { updatedMs, steps: [{ ms, instant, period1, period6, period12 }], meta }
function parseTimeseries(text) {
  var data = parseJson(text)
  var series = data && data.properties && data.properties.timeseries
  if (!Array.isArray(series)) return null
  var steps = []
  for (var i = 0; i < series.length; i++) {
    var ts = series[i]
    var ms = parseIsoMs(ts.time)
    if (!isNum(ms) || !ts.data) continue
    steps.push({
      ms: ms,
      instant: (ts.data.instant && ts.data.instant.details) || {},
      period1: periodOf(ts.data.next_1_hours, 1),
      period6: periodOf(ts.data.next_6_hours, 6),
      period12: periodOf(ts.data.next_12_hours, 12)
    })
  }
  var meta = data.properties.meta || {}
  return { updatedMs: parseIsoMs(meta.updated_at), steps: steps, meta: meta }
}

function periodOf(block, hours) {
  if (!block) return null
  return {
    hours: hours,
    symbol: (block.summary && block.summary.symbol_code) || "",
    details: block.details || {}
  }
}

// The shortest period a step carries (1 h in the hourly range, else 6 h).
function stepPeriod(step) {
  return step.period1 || step.period6 || step.period12 || null
}

function nearestStep(steps, nowMs) {
  var best = null
  var bestDiff = Infinity
  for (var i = 0; i < steps.length; i++) {
    var diff = Math.abs(steps[i].ms - nowMs)
    if (diff < bestDiff) { best = steps[i]; bestDiff = diff }
  }
  return best
}

// The moon API answers for one date; the phase advances ~12.2°/day, which is
// accurate enough to pick glyphs for the next few nights.
function moonPhaseAt(moon, ms) {
  if (!moon || !isNum(moon.phaseDeg)) return NaN
  var days = (ms - moon.refMs) / DAY_MS
  return (((moon.phaseDeg + days * SYNODIC_DEG_PER_DAY) % 360) + 360) % 360
}

function parseMoon(text, dateMs) {
  var data = parseJson(text)
  var p = data && data.properties
  if (!p || !isNum(p.moonphase)) return null
  return {
    phaseDeg: p.moonphase,
    refMs: localDayStart(dateMs, 0) + 12 * HOUR_MS,
    riseMs: p.moonrise ? parseIsoMs(p.moonrise.time) : NaN,
    setMs: p.moonset ? parseIsoMs(p.moonset.time) : NaN
  }
}

function parseSun(text) {
  var data = parseJson(text)
  var p = data && data.properties
  if (!p) return null
  return {
    riseMs: p.sunrise ? parseIsoMs(p.sunrise.time) : NaN,
    setMs: p.sunset ? parseIsoMs(p.sunset.time) : NaN
  }
}

// ---------------------------------------------------------------- location

// weather.json holds {"name", "latitude", "longitude"} (owned by
// omarchy-weather-location, shared with the built-in widget).
function parseLocationFile(raw) {
  var unset = { name: "", latitude: null, longitude: null }
  var data = parseJson(raw)
  if (!data) return unset
  var latitude = parseFloat(data.latitude)
  var longitude = parseFloat(data.longitude)
  var ok = isNum(latitude) && isNum(longitude)
  return {
    name: typeof data.name === "string" ? data.name.trim() : "",
    latitude: ok ? latitude : null,
    longitude: ok ? longitude : null
  }
}

function parseGeocodingResults(raw) {
  var data = parseJson(raw)
  var results = data && data.results
  if (!Array.isArray(results)) return []
  var out = []
  for (var i = 0; i < results.length; i++) {
    var r = results[i]
    if (!r || !r.name || !isNum(r.latitude) || !isNum(r.longitude)) continue
    out.push({
      name: String(r.name),
      description: [r.admin1, r.country].filter(function(part) { return !!part }).join(", "),
      latitude: r.latitude,
      longitude: r.longitude,
      elevation: isNum(r.elevation) ? r.elevation : null,
      key: r.name + "@" + r.latitude + "," + r.longitude
    })
  }
  return out
}

function locationCommit(text, suggestions, selectedIndex) {
  var name = String(text || "").trim()
  if (name === "") return null
  var choices = suggestions || []
  if (!choices.length) return null
  var index = Math.max(0, Math.min(parseInt(selectedIndex, 10) || 0, choices.length - 1))
  return choices[index]
}

// ---------------------------------------------------------------- view model

function buildCurrent(forecast, nowcast, nowMs, lang) {
  var step = nearestStep(forecast.steps, nowMs)
  if (!step) return null
  var d = step.instant
  var period = stepPeriod(step)
  var symbol = period ? period.symbol : ""

  var values = {
    temp: d.air_temperature,
    feelsLike: d.apparent_air_temperature,
    windSpeed: d.wind_speed,
    windGust: d.wind_speed_of_gust,
    windDir: d.wind_from_direction,
    humidity: d.relative_humidity
  }

  // Nowcast's first step is an analysis at fetch time and the only one with
  // temperature, wind and humidity (later steps carry precipitation only).
  // It beats the hourly model while recent; older than NOWCAST_MAX_AGE_MS
  // (e.g. fetching has been failing) falls back to the model.
  var observed = nowcast && nowcast.steps.length ? nowcast.steps[0] : null
  if (observed && isNum(observed.instant.air_temperature)
      && nowMs - observed.ms <= NOWCAST_MAX_AGE_MS && observed.ms - nowMs <= 10 * 60000) {
    var n = observed.instant
    if (isNum(n.air_temperature)) values.temp = n.air_temperature
    if (isNum(n.apparent_air_temperature)) values.feelsLike = n.apparent_air_temperature
    if (isNum(n.wind_speed)) values.windSpeed = n.wind_speed
    if (isNum(n.wind_speed_of_gust)) values.windGust = n.wind_speed_of_gust
    if (isNum(n.wind_from_direction)) values.windDir = n.wind_from_direction
    if (isNum(n.relative_humidity)) values.humidity = n.relative_humidity
  }

  var pd = period ? period.details : {}
  return {
    symbol: symbol,
    icon: iconForSymbol(symbol),
    description: describeSymbol(symbol, lang),
    temp: roundTemp(values.temp),
    feelsLike: roundTemp(values.feelsLike),
    wind: {
      speed: isNum(values.windSpeed) ? Math.round(values.windSpeed) : null,
      gust: isNum(values.windGust) ? Math.round(values.windGust) : null,
      dirDeg: isNum(values.windDir) ? values.windDir : null,
      dirLabel: windCompass(values.windDir, lang),
      arrow: windArrow(values.windDir)
    },
    humidity: isNum(values.humidity) ? Math.round(values.humidity) : null,
    cloud: isNum(d.cloud_area_fraction) ? Math.round(d.cloud_area_fraction) : null,
    uv: isNum(d.ultraviolet_index_clear_sky) ? formatNumber(d.ultraviolet_index_clear_sky, 1, lang) : "",
    precip: {
      hours: period ? period.hours : 1,
      text: formatPrecip(pd.precipitation_amount, pd.precipitation_amount_min, pd.precipitation_amount_max, lang),
      probability: isNum(pd.probability_of_precipitation) ? Math.round(pd.probability_of_precipitation) : null
    }
  }
}

function buildRow(step, lang, sixHour) {
  var d = step.instant
  var period = sixHour ? step.period6 : stepPeriod(step)
  var pd = period ? period.details : {}
  var spread = isNum(d.air_temperature_percentile_90) && isNum(d.air_temperature_percentile_10)
    ? d.air_temperature_percentile_90 - d.air_temperature_percentile_10 : 0
  return {
    ms: step.ms,
    hour: pad2(localHour(step.ms)),
    periodHours: period ? period.hours : 1,
    icon: iconForSymbol(period ? period.symbol : ""),
    description: describeSymbol(period ? period.symbol : "", lang),
    temp: roundTemp(d.air_temperature),
    tempSpread: spread >= 2 ? Math.round(spread / 2) : 0,
    precip: {
      probability: isNum(pd.probability_of_precipitation) ? Math.round(pd.probability_of_precipitation) : null,
      text: formatPrecip(pd.precipitation_amount, pd.precipitation_amount_min, pd.precipitation_amount_max, lang),
      thunder: isNum(pd.probability_of_thunder) ? Math.round(pd.probability_of_thunder) : 0
    },
    wind: {
      speed: isNum(d.wind_speed) ? Math.round(d.wind_speed) : null,
      gust: isNum(d.wind_speed_of_gust) ? Math.round(d.wind_speed_of_gust) : null,
      dirDeg: isNum(d.wind_from_direction) ? d.wind_from_direction : null,
      arrow: windArrow(d.wind_from_direction)
    }
  }
}

// Sections for today and the following days. Today and tomorrow get rows
// every `hourStep` hours. The day after tomorrow, and any day where the
// hourly data (≈54–60 h, varies per run) runs out part-way, is shown
// entirely as 6-hour rows on MET's 6-hour steps (00/06/12/18 UTC, e.g.
// 02/08/14/20 in CEST), so a day never mixes the two and doesn't flip
// between layouts from one forecast run to the next.
function buildHourlyDays(forecast, nowMs, hourStep, dayCount, lang) {
  var step = Math.max(1, hourStep || 3)
  var todayStart = localDayStart(nowMs, 0)
  var fromMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS
  var lastHourlyMs = -Infinity
  for (var h = 0; h < forecast.steps.length; h++)
    if (forecast.steps[h].period1) lastHourlyMs = Math.max(lastHourlyMs, forecast.steps[h].ms)

  var days = []
  for (var offset = 0; offset < dayCount; offset++) {
    var start = localDayStart(nowMs, offset)
    var end = localDayStart(nowMs, offset + 1)
    var sixHour = offset >= 2 || lastHourlyMs < end - HOUR_MS
    var rows = []
    for (var i = 0; i < forecast.steps.length; i++) {
      var s = forecast.steps[i]
      if (s.ms < start || s.ms >= end || s.ms < fromMs) continue
      if (sixHour) {
        if (!s.period6 || new Date(s.ms).getUTCHours() % 6 !== 0) continue
      } else {
        if (!s.period1 || localHour(s.ms) % step !== 0) continue
      }
      rows.push(buildRow(s, lang, sixHour))
    }
    if (rows.length) days.push({ start: start, title: dayTitle(start, todayStart, lang), sixHour: sixHour, rows: rows })
  }
  return days
}

// One row per local day. Precipitation sums non-overlapping periods (1 h
// where available, then 6 h). Temperatures span instants plus 6-hour
// min/max. The icon is the 6-hour symbol closest to local noon.
// `skipStarts`: local day starts already shown as hourly sections.
function buildLongRange(forecast, nowMs, dayCount, lang, skipStarts) {
  var todayStart = localDayStart(nowMs, 0)
  var byDay = {}
  var order = []
  var coveredUntil = -Infinity

  function dayFor(ms) {
    var key = localDateKey(ms)
    if (!byDay[key]) {
      byDay[key] = { start: localDayStart(ms, 0), min: Infinity, max: -Infinity,
                     precip: 0, hasPeriod: false, pop: null, noon: null, noonDist: Infinity }
      order.push(key)
    }
    return byDay[key]
  }

  for (var i = 0; i < forecast.steps.length; i++) {
    var s = forecast.steps[i]
    if (s.ms < todayStart) continue
    var day = dayFor(s.ms)
    var t = s.instant.air_temperature
    if (isNum(t)) { day.min = Math.min(day.min, t); day.max = Math.max(day.max, t) }

    if (s.period6) {
      var d6 = s.period6.details
      if (isNum(d6.air_temperature_min)) day.min = Math.min(day.min, d6.air_temperature_min)
      if (isNum(d6.air_temperature_max)) day.max = Math.max(day.max, d6.air_temperature_max)
      if (isNum(d6.probability_of_precipitation))
        day.pop = Math.max(day.pop === null ? 0 : day.pop, d6.probability_of_precipitation)
      var dist = Math.abs(localHour(s.ms) + 3 - 12)  // centre of the 6 h window vs noon
      if (dist < day.noonDist) { day.noonDist = dist; day.noon = s.period6.symbol }
    }

    var period = s.period1 || s.period6
    if (period && s.ms >= coveredUntil) {
      var amount = period.details.precipitation_amount
      if (isNum(amount)) day.precip += amount
      day.hasPeriod = true
      coveredUntil = s.ms + period.hours * HOUR_MS
    }
  }

  var out = []
  for (var k = 0; k < order.length && out.length < dayCount; k++) {
    var entry = byDay[order[k]]
    if (!entry.hasPeriod || !isFinite(entry.min)) continue
    if (skipStarts && skipStarts.indexOf(entry.start) !== -1) continue
    out.push({
      start: entry.start,
      day: dayShortName(entry.start, todayStart, lang),
      // A day overview reads as daytime even when only night periods are left.
      icon: iconForSymbol(splitSymbol(entry.noon || "").base + "_day"),
      description: describeSymbol(entry.noon || "", lang),
      min: roundTemp(entry.min),
      max: roundTemp(entry.max),
      precip: entry.precip >= 0.05 ? formatNumber(entry.precip, 1, lang) + " mm" : "",
      precipProbability: entry.pop === null ? null : Math.round(entry.pop)
    })
  }
  return out
}

function longRangeScale(days) {
  var lo = Infinity
  var hi = -Infinity
  for (var i = 0; i < days.length; i++) {
    if (isNum(days[i].min)) lo = Math.min(lo, days[i].min)
    if (isNum(days[i].max)) hi = Math.max(hi, days[i].max)
  }
  return isFinite(lo) ? { min: lo, max: Math.max(hi, lo + 1) } : { min: 0, max: 1 }
}

function kindWord(kind, lang) {
  var s = strings(lang)
  return kind === "rain" ? s.rain : kind === "sleet" ? s.sleet : kind === "snow" ? s.snow : s.precipitation
}

// Radar nowcast → one sentence plus points for a sparkline. Null when the
// place has no radar coverage or the data is too old to say anything.
function buildNowcast(nowcast, nowMs, lang) {
  if (!nowcast || !nowcast.meta || nowcast.meta.radar_coverage !== "ok") return null
  var points = []
  for (var i = 0; i < nowcast.steps.length; i++) {
    var s = nowcast.steps[i]
    if (s.ms < nowMs - 5 * 60000) continue
    var rate = s.instant.precipitation_rate
    points.push({
      minutes: Math.max(0, Math.round((s.ms - nowMs) / 60000)),
      rate: isNum(rate) ? rate : 0,
      kind: s.period1 ? precipKind(s.period1.symbol) : "",
      key: s.ms + ":" + (isNum(rate) ? rate : 0)
    })
  }
  if (points.length < 2) return null

  var s2 = strings(lang)
  var horizon = Math.round(points[points.length - 1].minutes / 5) * 5
  var firstWet = -1
  for (var w = 0; w < points.length; w++) if (points[w].rate > 0) { firstWet = w; break }

  var summary
  if (firstWet < 0) {
    summary = fill(s2.nowcastDry, { n: horizon })
  } else {
    var kind = kindWord(points[firstWet].kind, lang)
    if (firstWet === 0) {
      var firstDry = -1
      for (var d = 1; d < points.length; d++) if (points[d].rate <= 0) { firstDry = d; break }
      summary = firstDry < 0
        ? fill(s2.nowcastWetAll, { kind: kind, n: horizon })
        : fill(s2.nowcastStopping, { kind: kind, n: Math.max(5, points[firstDry].minutes) })
    } else {
      summary = fill(s2.nowcastStarting, { kind: kind, n: Math.max(5, points[firstWet].minutes) })
    }
  }

  var maxRate = 0
  for (var r = 0; r < points.length; r++) maxRate = Math.max(maxRate, points[r].rate)
  return { summary: summary, wet: firstWet >= 0, points: points, maxRate: maxRate }
}

function buildSun(sun, lang) {
  if (!sun) return null
  var out = { rise: isNum(sun.riseMs) ? localClock(sun.riseMs) : "—",
              set: isNum(sun.setMs) ? localClock(sun.setMs) : "—",
              dayLength: "" }
  if (isNum(sun.riseMs) && isNum(sun.setMs) && sun.setMs > sun.riseMs) {
    var minutes = Math.round((sun.setMs - sun.riseMs) / 60000)
    out.dayLength = fill(strings(lang).dayLength, { h: Math.floor(minutes / 60), m: minutes % 60 })
  }
  return out
}

function buildMoon(moon, nowMs, lang) {
  if (!moon) return null
  var phase = moonPhaseAt(moon, nowMs)
  return {
    phaseDeg: Math.round(phase),
    icon: moonGlyph(phase),
    name: strings(lang).moonPhases[moonPhaseIndex(phase)],
    // Share of the disc that is lit: 0 % at new moon, 100 % at full.
    // Rounded down so "100 %" means actually full, not a day early.
    illumination: Math.floor((1 - Math.cos(phase * Math.PI / 180)) / 2 * 100 + 1e-9),
    rise: isNum(moon.riseMs) ? localClock(moon.riseMs) : "",
    set: isNum(moon.setMs) ? localClock(moon.setMs) : ""
  }
}

// Keys for the panel's lists (Quickshell ScriptModel, objectProp "key"),
// which keep a delegate only while its key is unchanged. A ScriptModel does
// not update a kept delegate's data, so the key must cover the content: a
// changed row gets a new key and is rebuilt, unchanged rows are left alone
// (a plain array rebuilds every row on every update).
function contentKey(item) {
  return JSON.stringify(item, function(name, value) { return name === "key" ? undefined : value })
}

function addListKeys(view) {
  for (var d = 0; d < view.days.length; d++) {
    var day = view.days[d]
    for (var r = 0; r < day.rows.length; r++) day.rows[r].key = contentKey(day.rows[r])
    day.key = contentKey(day)
  }
  for (var l = 0; l < view.longRange.length; l++) view.longRange[l].key = contentKey(view.longRange[l])
}

// Everything the QML shows, from parsed inputs:
//   { forecast, nowcast, sun, moon }  parsed with parseTimeseries/parseSun/parseMoon
//   location                          { name, latitude, longitude }
//   lang, nowMs, settings             { hourStep, hourlyDays, longRangeDays }
function buildView(input) {
  var lang = input.lang || "en"
  var settings = input.settings || {}
  var nowMs = input.nowMs
  var view = {
    lang: lang,
    ready: false,
    location: { name: input.location ? input.location.name || "" : "",
                set: hasCoordinates(input.location) },
    updatedAt: "",
    current: null,
    bar: { icon: "", text: "" },
    nowcast: null,
    days: [],
    longRange: [],
    longRangeScale: { min: 0, max: 1 },
    sun: buildSun(input.sun, lang),
    moon: buildMoon(input.moon, nowMs, lang),
    attribution: "\uf004 MET Norway"  // nf-fa-heart
  }
  var forecast = input.forecast
  if (!forecast || !forecast.steps.length) return view

  view.current = buildCurrent(forecast, input.nowcast, nowMs, lang)
  if (!view.current) return view
  view.ready = true
  view.updatedAt = isNum(forecast.updatedMs) ? localClock(forecast.updatedMs) : ""
  view.bar = {
    icon: view.current.icon,
    text: view.current.temp === null ? view.current.icon : view.current.icon + " " + view.current.temp + "°"
  }
  view.nowcast = buildNowcast(input.nowcast, nowMs, lang)
  view.days = buildHourlyDays(forecast, nowMs, settings.hourStep || 3, settings.hourlyDays || 3, lang)
  view.longRange = buildLongRange(forecast, nowMs, settings.longRangeDays === undefined ? 10 : settings.longRangeDays, lang,
                                  view.days.map(function(day) { return day.start }))
  view.longRangeScale = longRangeScale(view.longRange)
  addListKeys(view)
  return view
}

// ---------------------------------------------------------------- radar map

// MET's Nordic radar animation: a 659×761 GIF, one frame per 10 minutes for
// the last 3 hours. The small index names the newest frame time, and the GIF
// is downloaded again only when that time changes. The index lists a
// time-specific animation URI, but the API rejects `time` for animations
// (HTTP 400), so the "latest" URL is fetched right after reading the index;
// if MET publishes in between, the next index poll catches it.
var RADAR_FRAME_MS = 10 * 60000
var RADAR_INDEX_URL = MET_BASE + "/radar/2.0/available.json?area=nordic&type=reflectivity&content=animation"
var RADAR_ANIMATION_URL = MET_BASE + "/radar/2.0/?area=nordic&type=reflectivity&content=animation"

// Index body → { timeMs } of the newest animation, or null.
function parseRadarIndex(text) {
  var data = parseJson(text)
  if (!Array.isArray(data)) return null
  var best = null
  for (var i = 0; i < data.length; i++) {
    var entry = data[i]
    var ms = entry && entry.params ? parseIsoMs(entry.params.time) : NaN
    if (!isNum(ms)) continue
    if (!best || ms > best.timeMs) best = { timeMs: ms }
  }
  return best
}

// Local wall-clock time of frame `index` (0 = oldest) in an animation whose
// newest frame is at newestMs.
function radarFrameLabel(newestMs, frameCount, index) {
  if (!isNum(newestMs) || !(frameCount > 0)) return ""
  var i = Math.max(0, Math.min(frameCount - 1, index || 0))
  return localClock(newestMs - (frameCount - 1 - i) * RADAR_FRAME_MS)
}

// Download into a temp file and rename into place only on HTTP 200, so the
// GIF being shown is never truncated (the open file keeps its old inode).
// Prints the response headers for parseHttpResponse, like curlCommand.
function radarDownloadCommand(dir, uri) {
  var script = 'part="$2/radar.gif.part"\n'
    + 'hdr=$(curl -sS --max-time 30 -A "$3" -D - -o "$part" "$1") || { rm -f "$part"; exit 1; }\n'
    + 'case "$(printf "%s" "$hdr" | head -n1)" in\n'
    + '  *" 200"*) mv -f "$part" "$2/radar.gif" ;;\n'
    + '  *) rm -f "$part" ;;\n'
    + 'esac\n'
    + 'printf "%s" "$hdr"\n'
  return ["bash", "-c", script, "bash", uri || RADAR_ANIMATION_URL, dir, USER_AGENT]
}

// ---------------------------------------------------------------- yr.no radar map

// A radar map like yr.no's: our own base map (tiles rendered from
// OpenStreetMap data by scripts/build-basemap.py, shipped in map/) with
// yr.no's radar tiles on top, in 5-minute steps: past observations followed
// by a 2-hour nowcast. The radar tiles come from yr.no's undocumented tile
// server. Everything uses the standard Web Mercator XYZ tile scheme.
var YR_TILES = "https://tiles.yr.no"
var YR_RADAR_OBS_INDEX = YR_TILES + "/api/precipitation-observations/available.json"
var YR_RADAR_NOWCAST_INDEX = YR_TILES + "/api/precipitation-nowcast/available.json"
// The radar tiles stop at zoom 6; at 7 they are drawn scaled up.
var YR_RADAR_ZOOM = 6
var MAP_TILE_PX = 256
// Appended to the panel footer's credits while the radar map is shown.
var MAP_ATTRIBUTION = " · OpenStreetMap · yr.no"
// Zoom steps: which tiles, drawn at how many px per tile. Step 1 draws the
// zoom-6 tiles at 181 px (≈ zoom 5.5: shrinking keeps them sharp). Across
// the 659 px map: ≈1700 km, 1200 km, 850 km, 425 km. Keep in sync with
// DISPLAY_STEPS in scripts/build-basemap.py.
var MAP_ZOOM_STEPS = [
  { z: 5, px: 0, overview: true, minPop: 150000 },  // px: fitted to the coverage
  { z: 6, px: 181, minPop: 70000 },
  { z: 6, px: 256, minPop: 40000 },
  { z: 7, px: 256, minPop: 10000 }
]
var MAP_DEFAULT_STEP = 1

// Where yr.no's radar has data (the Nordic radar network), measured from
// its tiles, which are white outside coverage. Views never leave this box,
// so the map never shows land where rain could not appear. Keep in sync
// with COVERAGE in scripts/build-basemap.py.
var RADAR_COVERAGE = { west: 0.5, south: 54.2, east: 35.5, north: 72.8 }

// The coverage box in tile units at zoom z.
function coverageTiles(z) {
  var nw = worldTile(RADAR_COVERAGE.north, RADAR_COVERAGE.west, z)
  var se = worldTile(RADAR_COVERAGE.south, RADAR_COVERAGE.east, z)
  return { x0: nw.x, y0: nw.y, x1: se.x, y1: se.y }
}

// Centre on c but keep a view of ±half inside [lo, hi]; centre the box if
// the view is bigger than it.
function clampCenter(c, lo, hi, half) {
  if (hi - lo <= 2 * half) return (lo + hi) / 2
  return Math.max(lo + half, Math.min(hi - half, c))
}

// What a width×height map shows at a zoom step:
//   { z, px, left, top, markerX, markerY, minPop }
// left/top: integer world-pixel offset of the view (world pixels = tile
// units × px). The overview frames the whole coverage; closer steps centre
// on the location, shifted as needed to stay inside the coverage, so the
// marker is not always in the middle.
// Boxes smaller than this (a panel mid-layout) get no view at all.
var MAP_MIN_BOX_PX = 64

function mapView(step, lat, lon, width, height) {
  if (!(width >= MAP_MIN_BOX_PX && height >= MAP_MIN_BOX_PX) || !isNum(lat) || !isNum(lon)) return null
  var s = MAP_ZOOM_STEPS[clampMapStep(step)]
  var b = coverageTiles(s.z)
  var px = s.overview
    ? Math.max(1, Math.min(MAP_TILE_PX, Math.floor(Math.min(width / (b.x1 - b.x0), height / (b.y1 - b.y0)))))
    : s.px
  var loc = worldTile(lat, lon, s.z)
  var cx = s.overview ? (b.x0 + b.x1) / 2 : clampCenter(loc.x, b.x0, b.x1, width / px / 2)
  var cy = s.overview ? (b.y0 + b.y1) / 2 : clampCenter(loc.y, b.y0, b.y1, height / px / 2)
  var left = Math.round(cx * px - width / 2)
  var top = Math.round(cy * px - height / 2)
  return { z: s.z, px: px, left: left, top: top,
           markerX: loc.x * px - left, markerY: loc.y * px - top, minPop: s.minPop }
}

function clampMapStep(step) {
  var n = parseInt(step, 10)
  if (isNaN(n)) return MAP_DEFAULT_STEP
  return Math.max(0, Math.min(MAP_ZOOM_STEPS.length - 1, n))
}

// Radar tiles for a view: their zoom (≤ 6) and px per radar tile. They share
// the view's world-pixel space, so left/top stay the same.
function radarView(view) {
  if (!view) return null
  var z = Math.min(view.z, YR_RADAR_ZOOM)
  return { z: z, px: view.px * Math.pow(2, view.z - z), left: view.left, top: view.top }
}

// Base map tile, relative to the plugin folder.
function mapTilePath(tile) {
  return "map/tiles/" + tile.z + "/" + tile.x + "/" + tile.y + ".png"
}

// Position in tile units at zoom z.
function worldTile(lat, lon, z) {
  var n = Math.pow(2, z)
  var latRad = lat * Math.PI / 180
  return {
    x: (lon + 180) / 360 * n,
    y: (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n
  }
}

// Tiles covering a width×height view ({ z, px, left, top }, as from mapView
// or radarView). left/top are integers, so neighbouring tiles meet without
// seams, and zoom levels drawn at matching scales (e.g. base z7 @256 px,
// radar z6 @512 px) line up exactly.
// Guarded against looping forever: a tile size of 0 makes both loop bounds
// -Infinity (and -Infinity + 1 is still -Infinity), which would hang the shell.
var MAP_MAX_TILES = 400

function viewTiles(view, width, height) {
  if (!view || !(view.px >= 1) || !isNum(view.left) || !isNum(view.top)
      || !(width >= 1) || !(height >= 1)) return []
  var z = view.z
  var tilePx = view.px
  var n = Math.pow(2, z)
  var left = view.left
  var top = view.top
  var x0 = Math.floor(left / tilePx), x1 = Math.floor((left + width - 1) / tilePx)
  var y0 = Math.floor(top / tilePx), y1 = Math.floor((top + height - 1) / tilePx)
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAP_MAX_TILES) return []
  var tiles = []
  for (var tx = x0; tx <= x1; tx++) {
    for (var ty = y0; ty <= y1; ty++) {
      if (ty < 0 || ty >= n) continue
      var tile = { z: z, x: ((tx % n) + n) % n, y: ty, left: tx * tilePx - left, top: ty * tilePx - top, size: tilePx }
      tile.key = [tile.z, tile.x, tile.y, tile.left, tile.top, tile.size].join("/")
      tiles.push(tile)
    }
  }
  return tiles
}

function tileUrl(template, z, x, y) {
  return String(template).replace("{z}", z).replace("{x}", x).replace("{y}", y)
}

// Cache file name of a radar tile of a frame ({ timeMs, runId }).
function radarTileFile(tile, frame) {
  return "r_" + (frame.runId ? frame.runId + "_" : "") + frame.timeMs + "_" + tile.z + "_" + tile.x + "_" + tile.y + ".png"
}

// Each forecast (and observation) run has its own id in the tile URL
// (…/precipitation-nowcast/<run id>/<time>/tiles/…). The same valid time
// differs between runs, so caches must be keyed by run as well as time,
// or a loop stitches different forecasts together (visible as rain jumping
// back and forth at the end of the animation).
function tileRunId(template) {
  var m = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i.exec(String(template || ""))
  return m ? m[1].replace(/-/g, "").toLowerCase() : ""
}

// Tile index body → [{ timeMs, template, runId }], oldest first.
function parseTileIndex(text) {
  var data = parseJson(text)
  var times = data && Array.isArray(data.times) ? data.times : []
  var out = []
  for (var i = 0; i < times.length; i++) {
    var ms = parseIsoMs(times[i].time)
    var template = times[i].tiles && times[i].tiles.png
    if (isNum(ms) && typeof template === "string")
      out.push({ timeMs: ms, template: template, runId: tileRunId(template) })
  }
  out.sort(function(a, b) { return a.timeMs - b.timeMs })
  return out
}

// Observations, then nowcast frames after the last observation.
// nowIndex is the last observed frame (-1 without observations).
function radarFrames(obsText, nowcastText) {
  var obs = parseTileIndex(obsText)
  var lastObs = obs.length ? obs[obs.length - 1].timeMs : -Infinity
  var frames = []
  for (var i = 0; i < obs.length; i++)
    frames.push({ timeMs: obs[i].timeMs, template: obs[i].template, runId: obs[i].runId, forecast: false })
  var nowcast = parseTileIndex(nowcastText)
  for (var j = 0; j < nowcast.length; j++) {
    if (nowcast[j].timeMs > lastObs)
      frames.push({ timeMs: nowcast[j].timeMs, template: nowcast[j].template, runId: nowcast[j].runId, forecast: true })
  }
  return { frames: frames, nowIndex: obs.length - 1 }
}

// "18:45" for an observed frame, "Prognos 19:15" for a nowcast frame.
function mapFrameLabel(frame, lang) {
  if (!frame) return ""
  return (frame.forecast ? strings(lang).forecastWord + " " : "") + localClock(frame.timeMs)
}

// Identifies a frame list: every frame's run and time, so two lists never
// share a key (runs are republished with new ids and times shift).
function radarFramesKey(frames) {
  var parts = []
  for (var i = 0; i < (frames || []).length; i++) parts.push(frames[i].runId + "@" + frames[i].timeMs)
  return parts.join(",")
}

// Every radar tile a map view needs, for every frame. → [{ url, file }]
function radarDownloads(radarTiles, frames) {
  var out = []
  for (var f = 0; f < frames.length; f++) {
    for (var r = 0; r < radarTiles.length; r++) {
      var t = radarTiles[r]
      out.push({ url: tileUrl(frames[f].template, t.z, t.x, t.y), file: radarTileFile(t, frames[f]) })
    }
  }
  return out
}

// ---- Pre-assembled radar frames. Decoding 20–25 tiles per frame, 4 times
// a second, is costly; one image the size of the map decodes ≈3× faster.
// ImageMagick (in Omarchy's base packages) assembles each frame once, in the
// background, after its tiles are downloaded.

// Identifies a map view's geometry, so frames are rebuilt for a new view.
function mapViewKey(view, width, height) {
  return view ? [view.z, view.px, view.left, view.top, width, height].join("_") : ""
}

function radarFrameFile(frame, viewKey) {
  return "f_" + (frame.runId ? frame.runId + "_" : "") + frame.timeMs + "_" + viewKey + ".png"
}

// One argument per frame: "frameFile|tileFile:left:top|…" (the radar view's
// tiles for that frame).
function frameComposeSpecs(radarTiles, frames, viewKey) {
  var specs = []
  for (var f = 0; f < frames.length; f++) {
    var parts = [radarFrameFile(frames[f], viewKey)]
    for (var i = 0; i < radarTiles.length; i++) {
      var t = radarTiles[i]
      parts.push(radarTileFile(t, frames[f]) + ":" + t.left + ":" + t.top)
    }
    specs.push(parts.join("|"))
  }
  return specs
}

// Assemble missing frames (4 at a time) on a black background, like the
// tiles themselves, scaling tiles to the view's tile size. A frame with a
// tile missing is left out rather than drawn with a hole. Each frame goes
// via a temp file. Prints "<frames> <frames on disk>".
function frameComposeCommand(dir, width, height, tilePx, specs) {
  var script = 'dir=$1; w=$2; h=$3; px=$4; shift 4\n'
    + 'compose() {\n'
    + '  local IFS="|"; local parts=($1); local out="$dir/${parts[0]}"\n'
    + '  [[ -s $out ]] && return 0\n'
    + '  local args=(-size "${w}x${h}" xc:black) p f l t\n'
    + '  for p in "${parts[@]:1}"; do\n'
    + '    IFS=: read -r f l t <<< "$p"\n'
    + '    [[ -s $dir/$f ]] || return 0\n'
    + '    args+=("(" "$dir/$f" -resize "${px}x${px}!" ")" -geometry "$(printf "%+d%+d" "$l" "$t")" -composite)\n'
    + '  done\n'
    + '  magick "${args[@]}" -define png:compression-level=1 "PNG24:$out.part" 2>/dev/null && mv -f "$out.part" "$out" || rm -f "$out.part"\n'
    + '}\n'
    + 'n=0\n'
    + 'for spec in "$@"; do compose "$spec" & n=$((n + 1)); (( n % 4 == 0 )) && wait; done\n'
    + 'wait\n'
    + 'find "$dir" -name "f_*.png" -mmin +120 -delete 2>/dev/null\n'
    + 'made=0\n'
    + 'for spec in "$@"; do [[ -s $dir/${spec%%|*} ]] && made=$((made + 1)); done\n'
    + 'echo "$# $made"\n'
  return ["bash", "-c", script, "bash", dir, String(width), String(height), String(tilePx)].concat(specs)
}

// Place labels for a map view. places.json rows are
// [name, name_sv, name_en, lat, lon, population, flags] (flags: 1 capital,
// 2 city), most important first. Picks what the zoom level warrants and
// skips labels that would overlap each other or the marker's own label.
// charPx: average character width of the label font.
function mapLabels(places, view, width, height, lang, charPx, markerName) {
  if (!view || !(view.px >= 1) || !(charPx > 0)) return []
  var rows = places && Array.isArray(places.places) ? places.places : []
  var z = view.z
  var left = view.left
  var top = view.top
  var minPop = view.minPop
  var lineH = Math.round(charPx * 2.2)
  var taken = [{ x: view.markerX - 10, y: view.markerY - lineH / 2,
                 w: 24 + String(markerName || "").length * charPx, h: lineH }]
  var out = []
  for (var i = 0; i < rows.length && out.length < 40; i++) {
    var r = rows[i]
    if (!(r[6] & 1) && r[5] < minPop) continue
    var t = worldTile(r[3], r[4], z)
    var x = t.x * view.px - left
    var y = t.y * view.px - top
    var name = lang === "sv" ? r[1] : r[2]
    var w = 10 + name.length * charPx
    if (x < 4 || y < lineH || x + w > width - 4 || y > height - lineH) continue
    var box = { x: x - 4, y: y - lineH / 2, w: w + 4, h: lineH }
    var clash = false
    for (var k = 0; k < taken.length && !clash; k++) {
      var o = taken[k]
      clash = box.x < o.x + o.w && o.x < box.x + box.w && box.y < o.y + o.h && o.y < box.y + box.h
    }
    if (clash) continue
    taken.push(box)
    out.push({ text: name, x: Math.round(x), y: Math.round(y), capital: (r[6] & 1) === 1,
               key: name + "@" + Math.round(x) + "," + Math.round(y) })
  }
  return out
}

// Fetch the tiles that aren't cached yet (12 at a time: HTTP/2 multiplexes
// them over one connection, ≈110 tiles/s, 3× faster than 4), each via a temp
// file so a failed transfer never leaves a broken tile, and prune radar
// tiles older than 2 h.
// Prints "<fetched> <missing>": missing counts the tiles still not on disk
// afterwards (failed, or listed in the index before yr.no published them).
function tileDownloadCommand(dir, downloads) {
  var script = 'dir=$1; ua=$2; shift 2\n'
    + 'mkdir -p "$dir"\n'
    + 'args=(); parts=(); files=()\n'
    + 'while (( $# >= 2 )); do\n'
    + '  files+=("$2")\n'
    + '  if [[ ! -s "$dir/$2" ]]; then args+=(-o "$dir/$2.part" "$1"); parts+=("$2"); fi\n'
    + '  shift 2\n'
    + 'done\n'
    + 'if (( ${#parts[@]} )); then\n'
    + '  curl -sS --fail --parallel --parallel-max 12 --max-time 60 -A "$ua" "${args[@]}" 2>/dev/null\n'
    + '  for f in "${parts[@]}"; do\n'
    + '    if [[ -s "$dir/$f.part" ]]; then mv -f "$dir/$f.part" "$dir/$f"; else rm -f "$dir/$f.part"; fi\n'
    + '  done\n'
    + 'fi\n'
    + 'missing=0\n'
    + 'for f in "${files[@]}"; do [[ -s $dir/$f ]] || missing=$((missing + 1)); done\n'
    + 'find "$dir" -name "r_*.png" -mmin +120 -delete 2>/dev/null\n'
    + 'echo "${#parts[@]} $missing"\n'
  var cmd = ["bash", "-c", script, "bash", dir, USER_AGENT]
  for (var i = 0; i < downloads.length; i++) cmd.push(downloads[i].url, downloads[i].file)
  return cmd
}

// One line for scripts (`omarchy-shell omarchy.weather summary`):
// "Alingsås · Klart 12° · Vind 2 m/s S · Uppehåll närmaste 110 min".
// Before there is data: the "fetching" / "choose a place" text.
function summaryText(view) {
  var note = notification(view)
  if (!note) {
    var s = strings(view ? view.lang : "en")
    return view && view.location && view.location.set ? s.fetching : s.noLocation
  }
  return note.headline.replace(/ {2}· {2}/g, " · ") + (note.body ? " · " + note.body.replace(/ {2}· {2}/g, " · ") : "")
}

// Right-click notification: headline "Alingsås · Klart 15°", body with wind
// and the radar outlook when known. Null until there is data.
function notification(view) {
  if (!view || !view.ready) return null
  var s = strings(view.lang)
  var c = view.current
  var headline = (view.location.name ? view.location.name + "  ·  " : "") + c.description + " " + c.temp + "°"
  var body = []
  if (c.wind.speed !== null) body.push(s.windLabel + " " + c.wind.speed + " m/s " + c.wind.dirLabel)
  if (view.nowcast) body.push(view.nowcast.summary)
  return { glyph: c.icon, headline: headline, body: body.join("  ·  ") }
}

if (typeof module !== "undefined") {
  module.exports = {
    PLUGIN_ID: PLUGIN_ID,
    RADAR_INDEX_URL: RADAR_INDEX_URL,
    YR_RADAR_OBS_INDEX: YR_RADAR_OBS_INDEX,
    YR_RADAR_NOWCAST_INDEX: YR_RADAR_NOWCAST_INDEX,
    YR_RADAR_ZOOM: YR_RADAR_ZOOM,
    MAP_TILE_PX: MAP_TILE_PX,
    MAP_ATTRIBUTION: MAP_ATTRIBUTION,
    MAP_ZOOM_STEPS: MAP_ZOOM_STEPS,
    MAP_DEFAULT_STEP: MAP_DEFAULT_STEP,
    clampMapStep: clampMapStep,
    RADAR_COVERAGE: RADAR_COVERAGE,
    coverageTiles: coverageTiles,
    mapView: mapView,
    radarView: radarView,
    mapTilePath: mapTilePath,
    mapLabels: mapLabels,
    worldTile: worldTile,
    viewTiles: viewTiles,
    tileUrl: tileUrl,
    radarTileFile: radarTileFile,
    parseTileIndex: parseTileIndex,
    radarFrames: radarFrames,
    tileRunId: tileRunId,
    mapFrameLabel: mapFrameLabel,
    radarDownloads: radarDownloads,
    radarFramesKey: radarFramesKey,
    mapViewKey: mapViewKey,
    radarFrameFile: radarFrameFile,
    frameComposeSpecs: frameComposeSpecs,
    frameComposeCommand: frameComposeCommand,
    tileDownloadCommand: tileDownloadCommand,
    RADAR_ANIMATION_URL: RADAR_ANIMATION_URL,
    parseRadarIndex: parseRadarIndex,
    radarFrameLabel: radarFrameLabel,
    radarDownloadCommand: radarDownloadCommand,
    NOWCAST_BACKGROUND_MS: NOWCAST_BACKGROUND_MS,
    USER_AGENT: USER_AGENT,
    STRINGS: STRINGS,
    langFor: langFor,
    strings: strings,
    formatNumber: formatNumber,
    roundTemp: roundTemp,
    parseIsoMs: parseIsoMs,
    parseHttpDateMs: parseHttpDateMs,
    localDateKey: localDateKey,
    localDayStart: localDayStart,
    utcOffsetString: utcOffsetString,
    dayTitle: dayTitle,
    roundCoord: roundCoord,
    hasCoordinates: hasCoordinates,
    forecastUrl: forecastUrl,
    nowcastUrl: nowcastUrl,
    sunUrl: sunUrl,
    moonUrl: moonUrl,
    geocodeUrl: geocodeUrl,
    curlCommand: curlCommand,
    parseHttpResponse: parseHttpResponse,
    isFresh: isFresh,
    cacheEntryFromResponse: cacheEntryFromResponse,
    jitterMs: jitterMs,
    splitSymbol: splitSymbol,
    describeSymbol: describeSymbol,
    precipKind: precipKind,
    isNightSymbol: isNightSymbol,
    moonGlyph: moonGlyph,
    iconForSymbol: iconForSymbol,
    windCompass: windCompass,
    windArrow: windArrow,
    formatPrecip: formatPrecip,
    parseTimeseries: parseTimeseries,
    parseSun: parseSun,
    parseMoon: parseMoon,
    moonPhaseAt: moonPhaseAt,
    parseLocationFile: parseLocationFile,
    parseGeocodingResults: parseGeocodingResults,
    locationCommit: locationCommit,
    buildCurrent: buildCurrent,
    buildHourlyDays: buildHourlyDays,
    buildLongRange: buildLongRange,
    buildNowcast: buildNowcast,
    buildView: buildView,
    notification: notification,
    summaryText: summaryText,
    contentKey: contentKey
  }
}
