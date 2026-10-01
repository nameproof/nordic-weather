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
// Identifies us to MET and yr.no (MET's terms ask for it): id and version
// from the manifest the shell hands the service, plus where to reach us.
function userAgent(manifest) {
  var version = manifest && manifest.version ? manifest.version : "dev"
  return PLUGIN_ID + "/" + version + " github.com/nameproof/nordic-weather"
}
var MET_BASE = "https://api.met.no/weatherapi"
var HOUR_MS = 3600 * 1000
var DAY_MS = 24 * HOUR_MS
var SYNODIC_DEG_PER_DAY = 360 / 29.530589
var NOWCAST_MAX_AGE_MS = 30 * 60000
// Background nowcast cadence while the panel is closed (it follows the
// ~5 min Expires while open).
var NOWCAST_BACKGROUND_MS = 15 * 60000

// ---------------------------------------------------------------- strings

// One entry per language: its text, plus what differs beyond text.
//   locales:  locale-name prefixes that pick it (the first entry matching
//             Qt.locale().name wins; English is the fallback)
//   decimal:  decimal separator
//   dayDate:  a day's date in titles ({day}; {month} from months, or
//             {monthNumber} 1–12)
//   hour:     the hour unit in short texts ("−1 h", "/6h")
//   geocode:  language code for place search (Open-Meteo)
//   precip:   precipitation descriptions (describeSymbol): nouns per kind as
//             [plain, showers], the light/heavy words to put before them
//             (also [plain, showers], for agreement), and the thunder suffix
// A new language is one more entry; tests check it has every key.
var STRINGS = {
  sv: {
    locales: ["sv"],
    decimal: ",",
    dayDate: "{day} {month}",
    hour: "h",
    geocode: "sv",
    precip: {
      rain: ["regn", "regnskurar"],
      sleet: ["snöblandat regn", "byar av snöblandat regn"],
      snow: ["snöfall", "snöbyar"],
      light: ["lätt", "lätta"],
      heavy: ["kraftigt", "kraftiga"],
      thunder: " och åska"
    },
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
    pressure: "Tryck",
    pressureNext: "på 3 h",
    moonHigh: "högst",
    gust: "byar",
    forecastFrom: "prognos från",
    stale: "Inaktuell",
    fetching: "Hämtar prognos…",
    searchPlaceholder: "Sök plats",
    noResults: "Inga platser hittades",
    noLocation: "Välj en plats för att se vädret",
    chooseLocation: "Välj plats",
    precipitation: "Nederbörd",
    rain: "Regn",
    sleet: "Snöblandat regn",
    snow: "Snö",
    nowcastDry: "Uppehåll närmaste {n} min",
    nowcastWetAll: "{kind} närmaste {n} min",
    nowcastStopping: "{kind} nu, upphör om ca {n} min",
    nowcastStarting: "{kind} om ca {n} min",
    radar: "Radar",
    radarLoading: "Hämtar radar…",
    radarNow: "Nu",
    radarFrom: "Radar från {time}",
    radarGaps: "Luckor i yr.no:s radar – tiden kan hoppa mellan bilder",
    forecastWord: "Prognos",
    symbols: {
      clearsky: "Klart",
      fair: "Vackert",
      partlycloudy: "Växlande",
      cloudy: "Mulet",
      fog: "Dimma"
    }
  },
  // Bokmål, also for Nynorsk and plain "no" locales.
  nb: {
    locales: ["nb", "nn", "no"],
    decimal: ",",
    dayDate: "{day}. {month}",
    hour: "t",
    geocode: "no",
    precip: {
      rain: ["regn", "regnbyger"],
      sleet: ["sludd", "sluddbyger"],
      snow: ["snø", "snøbyger"],
      light: ["lett", "lette"],
      heavy: ["kraftig", "kraftige"],
      thunder: " og torden"
    },
    today: "I dag",
    tomorrow: "I morgen",
    months: ["jan", "feb", "mar", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "des"],
    weekdays: ["Søndag", "Mandag", "Tirsdag", "Onsdag", "Torsdag", "Fredag", "Lørdag"],
    weekdaysShort: ["Søn", "Man", "Tir", "Ons", "Tor", "Fre", "Lør"],
    compass: ["N", "NØ", "Ø", "SØ", "S", "SV", "V", "NV"],
    moonPhases: ["Nymåne", "Voksende månesigd", "Første kvarter", "Voksende måne",
                 "Fullmåne", "Minkende måne", "Siste kvarter", "Minkende månesigd"],
    feels: "Føles som",
    wind: "Vind",
    humidity: "Fukt",
    pressure: "Trykk",
    pressureNext: "på 3 t",
    moonHigh: "høyest",
    gust: "kast",
    forecastFrom: "prognose fra",
    stale: "Utdatert",
    fetching: "Henter prognose…",
    searchPlaceholder: "Søk etter sted",
    noResults: "Fant ingen steder",
    noLocation: "Velg et sted for å se været",
    chooseLocation: "Velg sted",
    precipitation: "Nedbør",
    rain: "Regn",
    sleet: "Sludd",
    snow: "Snø",
    nowcastDry: "Opphold neste {n} min",
    nowcastWetAll: "{kind} neste {n} min",
    nowcastStopping: "{kind} nå, gir seg om ca. {n} min",
    nowcastStarting: "{kind} om ca. {n} min",
    radar: "Radar",
    radarLoading: "Henter radar…",
    radarNow: "Nå",
    radarFrom: "Radar fra {time}",
    radarGaps: "Hull i yr.no-radaren – tiden kan hoppe mellom bildene",
    forecastWord: "Prognose",
    symbols: {
      clearsky: "Klarvær",
      fair: "Lettskyet",
      partlycloudy: "Delvis skyet",
      cloudy: "Skyet",
      fog: "Tåke"
    }
  },
  da: {
    locales: ["da"],
    decimal: ",",
    dayDate: "{day}. {month}",
    hour: "t",
    geocode: "da",
    precip: {
      rain: ["regn", "regnbyger"],
      sleet: ["slud", "sludbyger"],
      snow: ["sne", "snebyger"],
      light: ["let", "lette"],
      heavy: ["kraftig", "kraftige"],
      thunder: " og torden"
    },
    today: "I dag",
    tomorrow: "I morgen",
    months: ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"],
    weekdays: ["Søndag", "Mandag", "Tirsdag", "Onsdag", "Torsdag", "Fredag", "Lørdag"],
    weekdaysShort: ["Søn", "Man", "Tir", "Ons", "Tor", "Fre", "Lør"],
    compass: ["N", "NØ", "Ø", "SØ", "S", "SV", "V", "NV"],
    moonPhases: ["Nymåne", "Tiltagende månesegl", "Første kvarter", "Tiltagende måne",
                 "Fuldmåne", "Aftagende måne", "Sidste kvarter", "Aftagende månesegl"],
    feels: "Føles som",
    wind: "Vind",
    humidity: "Fugt",
    pressure: "Tryk",
    pressureNext: "på 3 t",
    moonHigh: "højest",
    gust: "stød",
    forecastFrom: "prognose fra",
    stale: "Forældet",
    fetching: "Henter prognose…",
    searchPlaceholder: "Søg sted",
    noResults: "Ingen steder fundet",
    noLocation: "Vælg et sted for at se vejret",
    chooseLocation: "Vælg sted",
    precipitation: "Nedbør",
    rain: "Regn",
    sleet: "Slud",
    snow: "Sne",
    nowcastDry: "Tørvejr de næste {n} min",
    nowcastWetAll: "{kind} de næste {n} min",
    nowcastStopping: "{kind} nu, stopper om ca. {n} min",
    nowcastStarting: "{kind} om ca. {n} min",
    radar: "Radar",
    radarLoading: "Henter radar…",
    radarNow: "Nu",
    radarFrom: "Radar fra {time}",
    radarGaps: "Huller i yr.no's radar – tiden kan springe mellem billederne",
    forecastWord: "Prognose",
    symbols: {
      clearsky: "Klart",
      fair: "Let skyet",
      partlycloudy: "Delvis skyet",
      cloudy: "Skyet",
      fog: "Tåge"
    }
  },
  // Finnish. The precipitation words are partitive ("Heikkoa vesisadetta",
  // "Voimakkaita lumikuuroja"), the nowcast kinds nominative ("Vesisade
  // alkaa…").
  fi: {
    locales: ["fi"],
    decimal: ",",
    dayDate: "{day}.{monthNumber}.",
    hour: "h",
    geocode: "fi",
    precip: {
      rain: ["vesisadetta", "sadekuuroja"],
      sleet: ["räntäsadetta", "räntäkuuroja"],
      snow: ["lumisadetta", "lumikuuroja"],
      light: ["heikkoa", "heikkoja"],
      heavy: ["voimakasta", "voimakkaita"],
      thunder: " ja ukkosta"
    },
    today: "Tänään",
    tomorrow: "Huomenna",
    months: ["tammi", "helmi", "maalis", "huhti", "touko", "kesä", "heinä", "elo", "syys", "loka", "marras", "joulu"],
    weekdays: ["Sunnuntai", "Maanantai", "Tiistai", "Keskiviikko", "Torstai", "Perjantai", "Lauantai"],
    weekdaysShort: ["Su", "Ma", "Ti", "Ke", "To", "Pe", "La"],
    compass: ["P", "KO", "I", "KA", "E", "LO", "L", "LU"],
    moonPhases: ["Uusikuu", "Kasvava kuunsirppi", "Ensimmäinen neljännes", "Kasvava kuu",
                 "Täysikuu", "Vähenevä kuu", "Viimeinen neljännes", "Vähenevä kuunsirppi"],
    feels: "Tuntuu kuin",
    wind: "Tuuli",
    humidity: "Kosteus",
    pressure: "Paine",
    pressureNext: "/ 3 h",
    moonHigh: "ylimmillään",
    gust: "puuskat",
    forecastFrom: "ennuste klo",
    stale: "Vanhentunut",
    fetching: "Haetaan ennustetta…",
    searchPlaceholder: "Hae paikkaa",
    noResults: "Paikkoja ei löytynyt",
    noLocation: "Valitse paikka nähdäksesi sään",
    chooseLocation: "Valitse paikka",
    precipitation: "Sade",
    rain: "Vesisade",
    sleet: "Räntäsade",
    snow: "Lumisade",
    nowcastDry: "Poutaa seuraavat {n} min",
    nowcastWetAll: "{kind} jatkuu seuraavat {n} min",
    nowcastStopping: "{kind} nyt, loppuu noin {n} min kuluttua",
    nowcastStarting: "{kind} alkaa noin {n} min kuluttua",
    radar: "Tutka",
    radarLoading: "Ladataan tutkaa…",
    radarNow: "Nyt",
    radarFrom: "Tutka klo {time}",
    radarGaps: "Aukkoja yr.no:n tutkassa – aika voi hypätä kuvien välillä",
    forecastWord: "Ennuste",
    symbols: {
      clearsky: "Selkeää",
      fair: "Melko selkeää",
      partlycloudy: "Puolipilvistä",
      cloudy: "Pilvistä",
      fog: "Sumua"
    }
  },
  en: {
    locales: ["en"],
    decimal: ".",
    dayDate: "{month} {day}",
    hour: "h",
    geocode: "en",
    precip: {
      rain: ["rain", "rain showers"],
      sleet: ["sleet", "sleet showers"],
      snow: ["snow", "snow showers"],
      light: ["light", "light"],
      heavy: ["heavy", "heavy"],
      thunder: " and thunder"
    },
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
    pressure: "Pressure",
    pressureNext: "in 3 h",
    moonHigh: "highest",
    gust: "gusts",
    forecastFrom: "forecast from",
    stale: "Stale",
    fetching: "Fetching forecast…",
    searchPlaceholder: "Search place",
    noResults: "No places found",
    noLocation: "Choose a place to see the weather",
    chooseLocation: "Choose place",
    precipitation: "Precipitation",
    rain: "Rain",
    sleet: "Sleet",
    snow: "Snow",
    nowcastDry: "No precipitation next {n} min",
    nowcastWetAll: "{kind} for the next {n} min",
    nowcastStopping: "{kind} now, stopping in ~{n} min",
    nowcastStarting: "{kind} in ~{n} min",
    radar: "Radar",
    radarLoading: "Loading radar…",
    radarNow: "Now",
    radarFrom: "Radar from {time}",
    radarGaps: "Gaps in yr.no's radar: expect time jumps between frames",
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

// The language whose locales match a locale name ("sv_SE.UTF-8" → "sv"),
// English otherwise.
function langFor(localeName) {
  var name = String(localeName || "").toLowerCase()
  for (var lang in STRINGS) {
    var prefixes = STRINGS[lang].locales
    for (var i = 0; i < prefixes.length; i++) {
      var p = prefixes[i]
      if (name.indexOf(p) === 0 && (name.length === p.length || /[_.@-]/.test(name.charAt(p.length)))) return lang
    }
  }
  return "en"
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
  return s.replace(".", strings(lang).decimal)
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
  return name + " " + fill(s.dayDate, { day: d.getDate(), month: s.months[d.getMonth()], monthNumber: d.getMonth() + 1 })
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
    + "&count=6&format=json&language=" + strings(lang).geocode
}

// Size limits. API responses are collected in the shell's memory, so no
// response may hand over more than MAX_RESPONSE_BYTES, whatever the server
// sends: a small compressed response can expand to gigabytes, and a stream
// may never end. Real responses stay far below: the forecast is ~90 KB, the
// rest a few KB, and lightning grows with the strikes of the last two
// hours. Radar tiles (~3 KB) go to disk and have their own limit. Both are
// enforced outside curl, so they hold with any curl version (its own
// --max-filesize covers decompressed data only since curl 8.20).
var MAX_RESPONSE_BYTES = 8 * 1024 * 1024
var MAX_TILE_BYTES = 1024 * 1024

// argv running curl with `args` that passes on at most MAX_RESPONSE_BYTES
// of its output: head stops reading at the limit, then one more byte tells
// whether anything was cut off; once the pipe closes, curl ends on its next
// write. A cut-off body fails to parse like any other broken response.
function cappedCurl(args) {
  var script = 'max=$1; shift\n'
    + 'curl -q --proto =https --globoff "$@" | {\n'
    + '  head -c "$max"\n'
    + '  if (( $(head -c 1 | wc -c) )); then echo "response over $max bytes, cut off" >&2; fi\n'
    + '}\n'
  return ["bash", "-c", script, "bash", String(MAX_RESPONSE_BYTES)].concat(args)
}

// Which service a request kind goes to: yr.no's radar and lightning, or
// MET's API (forecast, nowcast, sun, moon). Throttling is per service.
function requestService(kind) {
  return kind === "yrObs" || kind === "yrNow" || kind === "lightning" ? "yr" : "met"
}

// argv for one request. `-D -` puts the response headers ahead of the body
// on stdout so Expires / Last-Modified reach parseHttpResponse.
function curlCommand(url, lastModified, maxTime, agent) {
  var args = ["-sS", "--compressed", "--max-time", String(maxTime || 10), "-A", agent, "-D", "-"]
  if (lastModified) args.push("-H", "If-Modified-Since: " + lastModified)
  args.push("--url", url)
  return cappedCurl(args)
}

// argv for a place search: the body only, nothing on HTTP errors.
function geocodeCommand(query, lang, agent) {
  return cappedCurl(["-fsS", "--max-time", "5", "-A", agent, "--url", geocodeUrl(query, lang)])
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

  var g = s.precip
  var form = p.showers ? 1 : 0
  var text = (p.intensity ? g[p.intensity][form] + " " : "") + g[p.kind][form] + (p.thunder ? g.thunder : "")
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// Precipitation family of a symbol ("rain", "sleet", "snow") or "".
function precipKind(code) {
  var p = parsePrecipBase(splitSymbol(code).base)
  return p ? p.kind : ""
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

// The byte ceiling also needs bounds on the objects and labels built from
// a response. MET's ten-day forecast and two-hour nowcast fit in 256 steps.
var MAX_TIMESERIES_STEPS = 256
var MAX_PLACE_NAME_CHARS = 256
var MAX_GEOCODE_RESULTS = 6

function boundedText(value, max) {
  return typeof value === "string" ? value.slice(0, max).replace(/[\x00-\x1f\x7f]/g, " ").trim() : ""
}

// Keep scalar weather measurements, never arbitrary nested API objects.
function numericDetails(details) {
  var out = {}, count = 0
  if (!details || typeof details !== "object" || Array.isArray(details)) return out
  for (var key in details) {
    if (key.length > 64 || !isNum(details[key])) continue
    out[key] = details[key]
    if (++count >= 32) break
  }
  return out
}

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
  var steps = [], seen = {}
  for (var i = 0; i < series.length && steps.length < MAX_TIMESERIES_STEPS; i++) {
    var ts = series[i]
    if (!ts || typeof ts.time !== "string" || ts.time.length > 64) continue
    var ms = parseIsoMs(ts.time)
    if (!isNum(ms) || !ts.data || seen[ms]) continue
    seen[ms] = true
    steps.push({
      ms: ms,
      instant: numericDetails(ts.data.instant && ts.data.instant.details),
      period1: periodOf(ts.data.next_1_hours, 1),
      period6: periodOf(ts.data.next_6_hours, 6),
      period12: periodOf(ts.data.next_12_hours, 12)
    })
  }
  steps.sort(function(a, b) { return a.ms - b.ms })
  var meta = data.properties.meta || {}
  return { updatedMs: parseIsoMs(boundedText(meta.updated_at, 64)), steps: steps,
           meta: { radar_coverage: boundedText(meta.radar_coverage, 64) } }
}

function periodOf(block, hours) {
  if (!block) return null
  return {
    hours: hours,
    symbol: boundedText(block.summary && block.summary.symbol_code, 64),
    details: numericDetails(block.details)
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
  if (!p || !isNum(p.moonphase) || p.moonphase < 0 || p.moonphase > 360
      || (p.high_moon !== undefined && !validCelestialEvent(p.high_moon))) return null
  return {
    phaseDeg: p.moonphase,
    refMs: localDayStart(dateMs, 0) + 12 * HOUR_MS,
    // Highest point in the day asked for.
    highMs: p.high_moon ? parseIsoMs(p.high_moon.time) : NaN
  }
}

// An event that doesn't happen that day (polar night, midnight sun) comes
// as { time: null }; null is taken the same way. Missing fields, malformed
// dates and other values are not valid events.
function validCelestialEvent(event) {
  if (event === null) return true
  if (!event || typeof event !== "object") return false
  return event.time === null
    || (typeof event.time === "string" && event.time.length <= 64 && isNum(parseIsoMs(event.time)))
}

function parseSun(text) {
  var data = parseJson(text)
  var p = data && data.properties
  if (!p || !validCelestialEvent(p.sunrise) || !validCelestialEvent(p.sunset)) return null
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
    name: boundedText(data.name, MAX_PLACE_NAME_CHARS),
    latitude: ok ? latitude : null,
    longitude: ok ? longitude : null
  }
}

function parseGeocodingResults(raw) {
  var data = parseJson(raw)
  var results = data && data.results
  if (!Array.isArray(results)) return []
  // Unique keys: the panel lists these in a ScriptModel, which needs them.
  var out = [], seen = {}
  for (var i = 0; i < results.length && out.length < MAX_GEOCODE_RESULTS; i++) {
    var r = results[i]
    if (!r || !isNum(r.latitude) || !isNum(r.longitude)
        || Math.abs(r.latitude) > 90 || Math.abs(r.longitude) > 180) continue
    var name = boundedText(r.name, MAX_PLACE_NAME_CHARS)
    if (!name) continue
    var key = name + "@" + r.latitude + "," + r.longitude
    if (seen[key]) continue
    seen[key] = true
    out.push({
      name: name,
      description: [boundedText(r.admin1, MAX_PLACE_NAME_CHARS), boundedText(r.country, MAX_PLACE_NAME_CHARS)]
        .filter(function(part) { return !!part }).join(", "),
      latitude: r.latitude,
      longitude: r.longitude,
      elevation: isNum(r.elevation) ? r.elevation : null,
      key: key
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

// ---------------------------------------------------------------- favourites

// Favourite places, in the order added: { name, description, latitude,
// longitude, elevation }, the same shape as a search result. Stored in a
// file of this plugin's own (the current place lives in the shared
// weather.json). A place is identified by its rounded coordinates.
var FAVORITES_MAX = 8

function placeKey(place) {
  return place && hasCoordinates(place) ? roundCoord(place.latitude) + "," + roundCoord(place.longitude) : ""
}

function parseFavorites(text) {
  var data = parseJson(text)
  var list = Array.isArray(data) ? data : []
  var out = [], seen = {}
  for (var i = 0; i < list.length && out.length < FAVORITES_MAX; i++) {
    var f = list[i]
    if (!f || typeof f.name !== "string" || f.name.trim() === "") continue
    var place = {
      name: boundedText(f.name, MAX_PLACE_NAME_CHARS),
      description: boundedText(f.description, 2 * MAX_PLACE_NAME_CHARS + 2),
      latitude: Number(f.latitude),
      longitude: Number(f.longitude),
      elevation: isNum(f.elevation) ? f.elevation : null
    }
    var key = placeKey(place)
    if (key === "" || seen[key]) continue
    seen[key] = true
    out.push(place)
  }
  return out
}

function isFavorite(favorites, place) {
  var key = placeKey(place)
  if (key === "") return false
  for (var i = 0; i < favorites.length; i++) if (placeKey(favorites[i]) === key) return true
  return false
}

function removeFavorite(favorites, key) {
  return favorites.filter(function(f) { return placeKey(f) !== key })
}

// Adds the place, or removes it if it is a favourite. A new place with a
// full list leaves the list unchanged.
function toggleFavorite(favorites, place) {
  if (isFavorite(favorites, place)) return removeFavorite(favorites, placeKey(place))
  if (!hasCoordinates(place) || favorites.length >= FAVORITES_MAX) return favorites
  return favorites.concat([{
    name: place.name,
    description: place.description || "",
    latitude: Number(place.latitude),
    longitude: Number(place.longitude),
    elevation: isNum(place.elevation) ? place.elevation : null
  }])
}

// Rows for the search dropdown while the field is empty: every favourite,
// the current place marked (shown dimmed).
function favoriteRows(favorites, location) {
  var current = placeKey(location)
  return favorites.map(function(f) {
    var key = placeKey(f)
    return Object.assign({}, f, { key: "fav@" + key, placeKey: key, current: key === current })
  })
}

// The favourite after (step 1) or before (step −1) the current place,
// wrapping; the first one when the current place isn't a favourite. Null
// when there is nowhere else to go.
function stepFavorite(favorites, location, step) {
  if (!favorites.length) return null
  var key = placeKey(location), at = -1
  for (var i = 0; i < favorites.length; i++) if (placeKey(favorites[i]) === key) at = i
  if (at < 0) return favorites[0]
  if (favorites.length === 1) return null
  var n = favorites.length
  return favorites[((at + (step < 0 ? -1 : 1)) % n + n) % n]
}

// ---------------------------------------------------------------- view model

// Sea-level pressure at `ms`, linear between the forecast steps around it;
// null outside them.
function pressureAt(steps, ms) {
  for (var i = 0; i + 1 < steps.length; i++) {
    var a = steps[i], b = steps[i + 1]
    if (ms < a.ms || ms > b.ms) continue
    var pa = a.instant.air_pressure_at_sea_level, pb = b.instant.air_pressure_at_sea_level
    if (!isNum(pa) || !isNum(pb)) return null
    return pa + (pb - pa) * (ms - a.ms) / (b.ms - a.ms)
  }
  return null
}

// Pressure now and its forecast change over the next 3 hours. The arrow is
// flat under 1 hPa, and steep from 3 hPa.
function buildPressure(forecast, nowMs, lang) {
  var now = pressureAt(forecast.steps, nowMs)
  if (now === null) return null
  var later = pressureAt(forecast.steps, nowMs + 3 * HOUR_MS)
  var change = later === null ? null : Math.round((later - now) * 10) / 10
  var arrow = change === null ? "" : Math.abs(change) < 1 ? "\u2192"
    : change > 0 ? (change >= 3 ? "\u2191" : "\u2197") : (change <= -3 ? "\u2193" : "\u2198")
  var signed = change === null ? "" : change === 0 ? "\u00b10"
    : (change > 0 ? "+" : "\u2212") + formatNumber(Math.abs(change), 1, lang)
  return {
    value: Math.round(now),
    change: change,
    arrow: arrow,
    changeText: change === null ? "" : signed + " " + strings(lang).pressureNext
  }
}

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

  return {
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
    pressure: buildPressure(forecast, nowMs, lang)
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
      kind: precipKind(period ? period.symbol : "")
    },
    wind: {
      speed: isNum(d.wind_speed) ? Math.round(d.wind_speed) : null,
      gust: isNum(d.wind_speed_of_gust) ? Math.round(d.wind_speed_of_gust) : null,
      dirDeg: isNum(d.wind_from_direction) ? d.wind_from_direction : null,
      arrow: windArrow(d.wind_from_direction)
    }
  }
}

var PRECIP_GLYPHS = {
  rain: "\ue371",   // raindrop
  sleet: "\ue371\ue36f",  // raindrop and snowflake
  snow: "\ue36f"    // snowflake_cold
}

// Glyph for a day's precipitation column: the kind (rain, sleet, snow) of
// its most likely precipitation. With none in any symbol, snow when every
// row is at or below 0°, otherwise rain.
function precipGlyph(rows) {
  var best = null
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i]
    if (r.precip.kind && (best === null || (r.precip.probability || 0) > (best.precip.probability || 0))) best = r
  }
  var frozen = rows.length > 0 && rows.every(function(row) { return row.temp !== null && row.temp <= 0 })
  return PRECIP_GLYPHS[best ? best.precip.kind : frozen ? "snow" : "rain"]
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
      // Upcoming times only: a row goes once its time is reached (the
      // hero shows the present).
      if (s.ms < start || s.ms >= end || s.ms <= nowMs) continue
      if (sixHour) {
        if (!s.period6 || new Date(s.ms).getUTCHours() % 6 !== 0) continue
      } else {
        if (!s.period1 || localHour(s.ms) % step !== 0) continue
      }
      rows.push(buildRow(s, lang, sixHour))
    }
    if (rows.length) days.push({ start: start, title: dayTitle(start, todayStart, lang), sixHour: sixHour,
                                 precipGlyph: precipGlyph(rows), rows: rows })
  }
  return days
}

// One row per local day. Precipitation sums non-overlapping periods (1 h
// where available, then 6 h). Temperatures span instants plus 6-hour
// min/max. The icon is the 6-hour symbol closest to local noon.
// Days from the local day start `fromStart` on (today when left out).
function buildLongRange(forecast, nowMs, dayCount, lang, fromStart) {
  var todayStart = localDayStart(nowMs, 0)
  var byDay = {}
  var order = []
  var coveredUntil = -Infinity

  function dayFor(ms) {
    var key = localDateKey(ms)
    if (!byDay[key]) {
      byDay[key] = { start: localDayStart(ms, 0), min: Infinity, max: -Infinity,
                     precip: 0, hasPeriod: false, noon: null, noonDist: Infinity }
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
    if (isNum(fromStart) && entry.start < fromStart) continue
    out.push({
      start: entry.start,
      day: dayShortName(entry.start, todayStart, lang),
      // A day overview reads as daytime even when only night periods are left.
      icon: iconForSymbol(splitSymbol(entry.noon || "").base + "_day"),
      min: roundTemp(entry.min),
      max: roundTemp(entry.max),
      precip: entry.precip >= 0.05 ? formatNumber(entry.precip, 1, lang) + " mm" : ""
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

  return { summary: summary, wet: firstWet >= 0, points: points }
}

function buildSun(sun) {
  if (!sun) return null
  return { rise: isNum(sun.riseMs) ? localClock(sun.riseMs) : "—",
           set: isNum(sun.setMs) ? localClock(sun.setMs) : "—" }
}

function buildMoon(moon, nowMs, lang) {
  if (!moon) return null
  var phase = moonPhaseAt(moon, nowMs)
  return {
    icon: moonGlyph(phase),
    name: strings(lang).moonPhases[moonPhaseIndex(phase)],
    // Share of the disc that is lit: 0 % at new moon, 100 % at full.
    // Rounded down so "100 %" means actually full, not a day early.
    illumination: Math.floor((1 - Math.cos(phase * Math.PI / 180)) / 2 * 100 + 1e-9),
    // "högst 01:08"; "" without high-moon data.
    high: isNum(moon.highMs) ? strings(lang).moonHigh + " " + localClock(moon.highMs) : ""
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
    sun: buildSun(input.sun),
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
  // The first hourlyDays calendar days (from today) are hourly sections,
  // the days after them the overview: one split in time, so a day is in
  // one or the other whatever its rows (today has none left late in the
  // evening, and is then in neither).
  var hourlyDays = settings.hourlyDays || 3
  view.days = buildHourlyDays(forecast, nowMs, settings.hourStep || 3, hourlyDays, lang)
  view.longRange = buildLongRange(forecast, nowMs, settings.longRangeDays === undefined ? 10 : settings.longRangeDays, lang,
                                  localDayStart(nowMs, hourlyDays))
  view.longRangeScale = longRangeScale(view.longRange)
  addListKeys(view)
  return view
}

// ---------------------------------------------------------------- radar map

// ---------------------------------------------------------------- lightning

// Lightning strikes in the Nordics from yr.no's lightning map (undocumented,
// like its radar tiles): the last 2 hours, which covers the radar loop's past
// plus the time a strike stays on the map.
var YR_LIGHTNING_URL = "https://www.yr.no/api/v0/lightning-events?fromHours=2"
// A strike's bolt shows in the frame it falls in, and dimmer in the next;
// a small dot marks it for this long.
var LIGHTNING_FRAME_MS = 5 * 60000
var LIGHTNING_TRAIL_MS = 10 * 60000
// Each kept strike gets a bolt shape; a big storm keeps its newest strikes.
var MAX_LIGHTNING_STRIKES = 8192

// yr.no's body: { historicalData: "[[time (s), lon, lat, …], …]" } (a JSON
// string inside JSON). → [{ ms, lat, lon, shape }] oldest first, or null
// when unreadable. Keeps the strikes the map can show: from the last two
// hours (the body may hold older ones), inside the coverage (any zoom
// step), at most MAX_LIGHTNING_STRIKES of the newest.
function parseLightning(text, nowMs) {
  if (!isNum(nowMs)) nowMs = Date.now()
  var data = parseJson(text)
  if (!data || typeof data.historicalData !== "string") return null
  var events = parseJson(data.historicalData)
  if (!Array.isArray(events)) return null
  var shown = []
  for (var i = 0; i < events.length; i++) {
    var e = events[i]
    if (Array.isArray(e) && isNum(e[0]) && isNum(e[1]) && isNum(e[2])
        && e[0] * 1000 >= nowMs - 2 * HOUR_MS && e[0] * 1000 <= nowMs + LIGHTNING_FRAME_MS
        && e[1] >= RADAR_COVERAGE.west - 1 && e[1] <= RADAR_COVERAGE.east + 1
        && e[2] >= RADAR_COVERAGE.south - 1 && e[2] <= RADAR_COVERAGE.north + 1) shown.push(i)
  }
  // Oldest first, strikes of the same second in yr.no's order.
  shown.sort(function(a, b) { return events[a][0] - events[b][0] || a - b })
  var out = [], seen = {}
  for (var j = shown.length - 1; j >= 0 && out.length < MAX_LIGHTNING_STRIKES; j--) {
    var s = events[shown[j]]
    var key = s[0] + "," + s[1] + "," + s[2]
    if (seen[key]) continue
    seen[key] = true
    out.push({ ms: s[0] * 1000, lon: s[1], lat: s[2], shape: lightningShape(lightningSeed(s[0], s[1], s[2])) })
  }
  return out.reverse()
}

// Which moment the map shows strikes for at a radar frame, or null for a
// forecast frame (strikes can't be forecast). Past frames: the frame's
// time. The newest observation ("now"): the latest strike data, which runs
// ahead of the radar.
function lightningMoment(frameMs, nowFrameMs, dataMs) {
  if (frameMs > nowFrameMs) return null
  return frameMs < nowFrameMs ? frameMs : Math.max(nowFrameMs, isNum(dataMs) ? dataMs : 0)
}

// Which strikes get a bolt at a moment (ms), from lightningPoints:
// { fresh, after }. Fresh: the moment's own 5 minutes; after: the 5
// minutes before (drawn dimmer). Newest first, a bolt within 10 px of one
// already chosen is left out, so a dense cell reads as separate bolts.
function lightningBolts(points, moment) {
  var fresh = [], after = [], chosen = []
  for (var i = points.length - 1; i >= 0; i--) {
    var p = points[i]
    var age = moment - p.ms
    if (age < 0) continue
    if (age >= 2 * LIGHTNING_FRAME_MS) break
    var near = false
    for (var d = 0; d < chosen.length && !near; d++)
      near = Math.abs(chosen[d].x - p.x) < 10 && Math.abs(chosen[d].y - p.y) < 10
    if (near) continue
    chosen.push(p)
    if (age < LIGHTNING_FRAME_MS) fresh.push(p)
    else after.push(p)
  }
  return { fresh: fresh, after: after }
}

// A bolt's shape in px, ending at the strike (0, 0): a jagged main channel
// from above, sometimes forking once or twice partway down. The same seed
// always gives the same bolt.
function lightningRandom(seed) {
  var a = seed >>> 0
  return function() {
    a = (a + 0x6D2B79F5) >>> 0
    var t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Midpoint displacement: each pass kinks every segment sideways by up to
// `spread` of its length, so the zigzags come in several sizes.
function lightningJagged(rand, x0, y0, x1, y1, passes, spread) {
  var pts = [[x0, y0], [x1, y1]]
  for (var d = 0; d < passes; d++) {
    var next = [pts[0]]
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i]
      var dx = b[0] - a[0], dy = b[1] - a[1]
      var len = Math.sqrt(dx * dx + dy * dy) || 1
      var off = (rand() - 0.5) * spread * len
      next.push([(a[0] + b[0]) / 2 - dy / len * off, (a[1] + b[1]) / 2 + dx / len * off])
      next.push(b)
    }
    pts = next
  }
  return pts
}

function lightningShape(seed) {
  var rand = lightningRandom(seed)
  var h = 13 + rand() * 9
  var main = lightningJagged(rand, (rand() - 0.5) * 8, -h, 0, 0, 3, 0.75)
  var branches = []
  var count = rand() < 0.5 ? (rand() < 0.3 ? 2 : 1) : 0
  for (var k = 0; k < count; k++) {
    var from = main[1 + Math.floor(rand() * Math.floor(main.length * 0.55))]
    var side = rand() < 0.5 ? -1 : 1
    var len = h * (0.3 + rand() * 0.35)
    var angle = (25 + rand() * 35) * Math.PI / 180
    branches.push(lightningJagged(rand, from[0], from[1],
      from[0] + side * Math.sin(angle) * len, from[1] + Math.cos(angle) * len, 2, 0.8))
  }
  return { main: main, branches: branches }
}

// A seed from a strike's time (s) and place, stable across views.
function lightningSeed(timeS, lon, lat) {
  return (Math.imul(timeS | 0, 2654435761) ^ Math.imul(Math.round(lon * 1e4), 40503) ^ Math.round(lat * 1e4)) >>> 0
}

// Strikes in a view's pixels, oldest first, dropping those more than
// `margin` px outside the width×height map.
function lightningPoints(strikes, view, width, height, margin) {
  var out = []
  if (!view) return out
  for (var i = 0; i < strikes.length; i++) {
    var w = worldTile(strikes[i].lat, strikes[i].lon, view.z)
    var x = w.x * view.px - view.left, y = w.y * view.px - view.top
    if (x < -margin || y < -margin || x > width + margin || y > height + margin) continue
    out.push({ x: x, y: y, ms: strikes[i].ms, shape: strikes[i].shape })
  }
  out.sort(function(a, b) { return a.ms - b.ms })
  return out
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
// Credited after MET Norway, under the radar map.
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

// An index may only refer back to yr.no's HTTPS tile origin. Check again
// when building a download command, including for older cached indexes.
function isTileUrl(url) {
  return typeof url === "string" && url.length <= 1024 && url.indexOf(YR_TILES + "/") === 0
    && !/[\x00-\x20\x7f\\]/.test(url)
}

function tileUrl(template, z, x, y) {
  return isTileUrl(template) ? template.replace("{z}", z).replace("{x}", x).replace("{y}", y) : ""
}

// Cache file name of a radar tile of a frame ({ timeMs, runId, forecast }).
function radarTileFile(tile, frame) {
  return "r_" + radarFrameId(frame) + "_" + tile.z + "_" + tile.x + "_" + tile.y + ".png"
}

// What makes a frame's images unique. Every index update has its own run id
// in the tile URL (…/<run id>/<time>/tiles/…). A forecast for the same time
// differs between runs, so forecast frames are keyed by run and time (or a
// loop would stitch different forecasts together, visible as rain jumping
// back and forth). An observation is the same image in every run, so it is
// keyed by time alone and stays cached across updates: only the newest
// observation and the new forecast need fetching.
function radarFrameId(frame) {
  return (frame.forecast && frame.runId ? frame.runId + "_" : "") + frame.timeMs
}

// Each run's id, from a tile URL template.
function tileRunId(template) {
  var m = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i.exec(String(template || ""))
  return m ? m[1].replace(/-/g, "").toLowerCase() : ""
}

var MAX_RADAR_INDEX_ENTRIES = 512
var MAX_RADAR_OBSERVATIONS = 36
var MAX_RADAR_FORECASTS = 24
// The counts above bound the work. Times further than this from now are no
// loop to show; a late radar within it still shows, with its delay note
// (radarDelayNote gives only the time of day, so this stays under a day).
var RADAR_WINDOW_MS = 12 * HOUR_MS

// Tile index body → [{ timeMs, template, runId }], oldest first. A valid
// loop covers recent observations and a two-hour forecast, not arbitrary
// history or thousands of nearly simultaneous frames.
function parseTileIndex(text, nowMs) {
  if (!isNum(nowMs)) nowMs = Date.now()
  var data = parseJson(text)
  var times = data && Array.isArray(data.times) ? data.times : []
  if (times.length > MAX_RADAR_INDEX_ENTRIES) return []
  var out = [], seen = {}
  for (var i = 0; i < times.length; i++) {
    if (!times[i] || typeof times[i].time !== "string" || times[i].time.length > 64) continue
    var ms = parseIsoMs(times[i].time)
    var template = times[i].tiles && times[i].tiles.png
    if (!isNum(ms) || Math.abs(ms - nowMs) > RADAR_WINDOW_MS || seen[ms] || !isTileUrl(template)) continue
    seen[ms] = true
    out.push({ timeMs: ms, template: template, runId: tileRunId(template) })
  }
  // Keep the nearest times before constructing a loop. The combined loop
  // below is separately bounded to 36 observations + 24 forecasts.
  out.sort(function(a, b) { return Math.abs(a.timeMs - nowMs) - Math.abs(b.timeMs - nowMs) })
  out = out.slice(0, MAX_RADAR_OBSERVATIONS + MAX_RADAR_FORECASTS)
  out.sort(function(a, b) { return a.timeMs - b.timeMs })
  return out
}

// How long ago our copy of the radar index may have been fetched for its
// loop to be shown. An older copy (the computer slept, the network is
// down) is worse than an empty map: it looks current but isn't. What
// counts is our fetch, not the newest observation: when yr.no itself runs
// late, the index just fetched is still the freshest radar there is.
var RADAR_MAX_AGE_MS = 30 * 60000
// yr.no's newest observation older than this is shown as late
// (radarDelayNote).
var RADAR_LATE_MS = 15 * 60000

// Whether a frame list (radarFrames) may be shown at nowMs: its index was
// fetched (fetchedMs) no more than RADAR_MAX_AGE_MS ago, it has an
// observation, and no refresh is still awaited (awaiting: the radar opened
// with a refresh under way).
function radarUsable(radar, nowMs, awaiting, fetchedMs) {
  if (awaiting || !radar || radar.nowIndex < 0 || !radar.frames.length) return false
  return isNum(fetchedMs) && nowMs - fetchedMs <= RADAR_MAX_AGE_MS
}

// A note when frames are missing from yr.no's loop (neighbours more than
// 1.5 steps apart, e.g. an outage), so the jumps in time aren't taken for a
// bug; "" otherwise.
function radarGapNote(frames, lang) {
  for (var i = 1; i < (frames || []).length; i++)
    if (frames[i].timeMs - frames[i - 1].timeMs > 1.5 * 5 * 60000) return strings(lang).radarGaps
  return ""
}

// "Radar från 13:15" when yr.no's newest observation (newestMs) is more than
// RADAR_LATE_MS old, so the ruler's "now" isn't taken for the present;
// "" otherwise.
function radarDelayNote(newestMs, nowMs, lang) {
  if (!isNum(newestMs) || !(newestMs > 0) || nowMs - newestMs <= RADAR_LATE_MS) return ""
  return fill(strings(lang).radarFrom, { time: localClock(newestMs) })
}

// Observations, then nowcast frames after the last observation.
// nowIndex is the last observed frame (-1 without observations).
function radarFrames(obsText, nowcastText, nowMs) {
  if (!isNum(nowMs)) nowMs = Date.now()
  var obs = parseTileIndex(obsText, nowMs).filter(function(f) { return f.timeMs <= nowMs + LIGHTNING_FRAME_MS })
    .slice(-MAX_RADAR_OBSERVATIONS)
  var lastObs = obs.length ? obs[obs.length - 1].timeMs : -Infinity
  var frames = []
  for (var i = 0; i < obs.length; i++)
    frames.push({ timeMs: obs[i].timeMs, template: obs[i].template, runId: obs[i].runId, forecast: false })
  var nowcast = parseTileIndex(nowcastText, nowMs)
  var forecastCount = 0
  for (var j = 0; j < nowcast.length && forecastCount < MAX_RADAR_FORECASTS; j++) {
    if (nowcast[j].timeMs > lastObs) {
      frames.push({ timeMs: nowcast[j].timeMs, template: nowcast[j].template, runId: nowcast[j].runId, forecast: true })
      forecastCount++
    }
  }
  return { frames: frames, nowIndex: obs.length - 1 }
}

// The frame whose no-coverage areas the whole loop uses: its latest
// observation, or while the loop is still being assembled and that frame
// isn't yet, the newest one that is.
function radarCoverageIndex(loop) {
  var ready = loop.ready === undefined ? loop.frames.length : loop.ready
  return Math.max(0, Math.min(loop.nowIndex, ready - 1))
}

// Three rotating image slots give the next frame a whole source-frame
// interval to load before it is sampled. Two-frame loops use two slots.
// `ready`: of a loop still loading, the frames assembled so far (a prefix);
// slots never point past them.
function radarImageSlots(frames, frame, tick, ready) {
  var slots = [null, null, null]
  var n = Math.min(frames.length, ready === undefined ? frames.length : ready)
  var count = Math.min(3, n)
  if (!count) return { frames: slots, current: 0, upcoming: 0 }
  var current = tick % count
  frame = Math.min(frame, n - 1)
  for (var i = 0; i < count; i++) slots[(current + i) % count] = frames[(frame + i) % n]
  return { frames: slots, current: current, upcoming: (current + 1) % count }
}

// The radar loop's next position, one frame per timer tick: the next frame,
// or the first after the last. A loop still loading (`ready` of its frames
// assembled) waits on its newest frame instead, until more arrive; a frame
// left over from another, longer loop restarts at the first.
function radarStep(frame, tick, count, ready) {
  var n = ready === undefined ? count : Math.min(ready, count)
  if (count < 2 || n < 1) return { frame: 0, tick: tick }
  if (frame >= n) return { frame: 0, tick: tick + 1 }
  if (frame + 1 < n) return { frame: frame + 1, tick: tick + 1 }
  return n < count ? { frame: frame, tick: tick } : { frame: 0, tick: tick + 1 }
}

// Where a replacement loop carries on: the first of its frames at or after
// timeMs (loops shift by a frame or so per update), else the start.
function radarFrameAt(frames, timeMs) {
  for (var i = 0; i < frames.length; i++) if (frames[i].timeMs >= timeMs) return i
  return 0
}

// The time ruler on the yr.no map: one tick per frame. level is 1 at "now"
// (the last observed frame) and falls off linearly towards both ends. Ticks
// a whole number of hours from now get a stamp under the map ("−1 h", "Nu",
// "+1 h") and are drawn a little stronger. The key covers everything a tick
// draws, since a ScriptModel keeps a delegate with an unchanged key as it is.
function rulerTicks(frames, nowIndex, lang) {
  var n = (frames || []).length
  var now = Math.max(0, Math.min(n - 1, nowIndex))
  var reach = Math.max(now, n - 1 - now, 1)
  var out = []
  for (var i = 0; i < n; i++) {
    var level = Math.round((1 - Math.abs(i - now) / reach) * 1000) / 1000
    var offset = frames[i].timeMs - frames[now].timeMs
    var stamp = offset % HOUR_MS !== 0 ? ""
      : offset === 0 ? strings(lang).radarNow
      : (offset < 0 ? "\u2212" : "+") + Math.abs(offset) / HOUR_MS + " " + strings(lang).hour
    var forecast = !!frames[i].forecast
    out.push({ index: i, level: level, stamp: stamp, forecast: forecast,
               key: frames[i].timeMs + "|" + level + "|" + stamp + "|" + forecast })
  }
  return out
}

// "18:45" for an observed frame, "Prognos 19:15" for a nowcast frame.
function mapFrameLabel(frame, lang) {
  if (!frame) return ""
  return (frame.forecast ? strings(lang).forecastWord + " " : "") + localClock(frame.timeMs)
}

// Identifies a frame list by its frames' ids (radarFrameId), so two lists
// share a key only when they show the same images.
function radarFramesKey(frames) {
  var parts = []
  for (var i = 0; i < (frames || []).length; i++) parts.push(radarFrameId(frames[i]))
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
  return "f_" + radarFrameId(frame) + "_" + viewKey + ".png"
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
// tile missing is left out rather than drawn with a hole. Only decode PNG
// tiles of at most 256x256, with a bounded canvas and pixel cache. Temporary
// output lives in a fresh private directory, never a planted .part link.
// Prints "<frames> <frames on disk>".
function frameComposeCommand(dir, width, height, tilePx, specs) {
  if (!(width >= 1 && width <= 1024 && height >= 1 && height <= 1024 && tilePx >= 1 && tilePx <= 512))
    return ["false"]
  var script = 'set -euo pipefail\n'
    + 'dir=$1; w=$2; h=$3; px=$4; cache=${dir%/*}; shift 4\n'
    + cacheGuardScript()
    + [
      'mkdir -p -- "$dir"',
      'work=$(mktemp -d "$dir/.nw-frames.XXXXXXXX")',
      'trap \'rm -rf -- "$work"\' EXIT',
      'compose() {',
      '  local IFS="|"; local parts; read -ra parts <<< "$1"',
      '  [[ ${parts[0]} =~ ^f_[[:alnum:]_-]+[.]png$ ]] || return 1',
      '  local out="$dir/${parts[0]}" tmp="$work/${parts[0]}"',
      '  [[ -f $out && -s $out && ! -L $out ]] && return 0',
      '  local args=(-size "${w}x${h}" xc:black) p f l t',
      '  for p in "${parts[@]:1}"; do',
      '    IFS=: read -r f l t <<< "$p"',
      '    [[ $f =~ ^r_[[:alnum:]_-]+[.]png$ ]] || return 1',
      '    [[ -f $dir/$f && -s $dir/$f && ! -L $dir/$f ]] || return 0',
      '    args+=("(" -limit width 256 -limit height 256 "png:$dir/$f"',
      '      -limit width 1024 -limit height 1024 -resize "${px}x${px}!" ")"',
      '      -geometry "$(printf "%+d%+d" "$l" "$t")" -composite)',
      '  done',
      '  magick -limit thread 1 -limit time 10 -limit width 1024 -limit height 1024 \\',
      '    -limit memory 128MiB -limit map 0 -limit disk 0 -limit list-length 2 \\',
      '    "${args[@]}" -define png:compression-level=1 "PNG24:$tmp" 2>/dev/null \\',
      '    && mv -fT -- "$tmp" "$out" || rm -f -- "$tmp"',
      '}',
      'n=0',
      'for spec in "$@"; do compose "$spec" & n=$((n + 1)); if (( n % 4 == 0 )); then wait; fi; done',
      'wait',
      'find "$dir" -maxdepth 1 -name "f_*.png" -mmin +120 -delete 2>/dev/null || true',
      'find "$dir" -maxdepth 1 -type d -name ".nw-frames.*" -mmin +120 -exec rm -rf -- {} + 2>/dev/null || true',
      'made=0',
      'for spec in "$@"; do [[ -f $dir/${spec%%|*} && -s $dir/${spec%%|*} && ! -L $dir/${spec%%|*} ]] && made=$((made + 1)); done',
      'echo "$# $made"'
    ].join("\n") + "\n"
  return ["bash", "-c", script, "bash", dir, String(width), String(height), String(tilePx)].concat(specs)
}

// Place labels for a map view. places.json names its columns in `fields`:
// the local name, one name_<lang> per label language, lat, lon, population
// and flags (1 capital, 2 city); rows most important first. A language
// without its own column gets the English names. Picks what the zoom level
// warrants and skips labels that would overlap each other or the marker's
// own label.
// charPx: average character width of the label font.
function mapLabels(places, view, width, height, lang, charPx, markerName) {
  if (!view || !(view.px >= 1) || !(charPx > 0)) return []
  var rows = places && Array.isArray(places.places) ? places.places : []
  var fields = places && Array.isArray(places.fields) ? places.fields : []
  var col = function(name) { return fields.indexOf(name) }
  var nameCol = [col("name_" + lang), col("name_en"), col("name")].filter(function(i) { return i >= 0 })[0]
  var latCol = col("lat"), lonCol = col("lon"), popCol = col("population"), flagsCol = col("flags")
  if (nameCol === undefined || latCol < 0 || lonCol < 0 || popCol < 0 || flagsCol < 0) return []
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
    var flags = r[flagsCol]
    if (!(flags & 1) && r[popCol] < minPop) continue
    var t = worldTile(r[latCol], r[lonCol], z)
    var x = t.x * view.px - left
    var y = t.y * view.px - top
    var name = r[nameCol]
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
    out.push({ text: name, x: Math.round(x), y: Math.round(y), capital: (flags & 1) === 1,
               key: name + "@" + Math.round(x) + "," + Math.round(y) })
  }
  return out
}

// Both the plugin cache root and its tiles child must be real directories.
// Parents above the plugin root may still be redirected by a dotfiles setup.
function cacheGuardScript() {
  return 'if [[ -L $cache || -L $dir || ( -e $cache && ! -d $cache ) || ( -e $dir && ! -d $dir ) ]]; then\n'
    + '  echo "nordic-weather: refusing a linked or invalid cache directory" >&2; exit 1\n'
    + 'fi\n'
}

function cacheSetupCommand(cacheDir, settingsDir) {
  var script = 'set -euo pipefail\ncache=$1; dir="$cache/tiles"\n'
    + cacheGuardScript() + 'mkdir -p -- "$dir" "$2"\n'
  return ["bash", "-c", script, "bash", cacheDir, settingsDir]
}

// Fetch the tiles that aren't cached yet (24 at a time over HTTP/2: the
// tiles are ~3 KB, so request latency limits, not bandwidth; 24 gives
// ≈180–250 tiles/s, 12 ≈130–180, and 48 is slower again) into a fresh
// private folder, then move each finished tile into place: a failed
// transfer never leaves a broken tile, and a planted link is replaced, not
// written through. A URL that isn't a yr.no tile (isTileUrl) is skipped.
// A file-size limit (ulimit -f) holds each tile to MAX_TILE_BYTES: a write
// past it fails that transfer (SIGXFSZ is ignored, so it doesn't kill
// curl), and --remove-on-error drops the partial file. Tiles, .part files
// and work folders older than 2 h are pruned.
// Prints "<fetched> <missing>": missing counts the tiles still not on disk
// afterwards (failed, or listed in the index before yr.no published them).
function tileDownloadCommand(dir, downloads, agent) {
  var script = 'set -euo pipefail\n'
    + 'dir=$1; ua=$2; max=$3; cache=${dir%/*}; shift 3\n'
    + cacheGuardScript()
    + [
      'mkdir -p -- "$dir"',
      'work=$(mktemp -d "$dir/.nw-tiles.XXXXXXXX")',
      'trap \'rm -rf -- "$work"\' EXIT',
      'args=(); parts=(); files=()',
      'while (( $# >= 2 )); do',
      '  [[ $2 =~ ^r_[[:alnum:]_-]+[.]png$ ]] || exit 1',
      '  files+=("$2")',
      '  if [[ -n $1 && ! ( -f $dir/$2 && -s $dir/$2 && ! -L $dir/$2 ) ]]; then',
      '    args+=(-o "$work/$2" --url "$1"); parts+=("$2")',
      '  fi',
      '  shift 2',
      'done',
      'if (( ${#parts[@]} )); then',
      '  (trap "" XFSZ; ulimit -f $((max / 1024)) || exit 1',
      '   exec curl -q --proto =https --globoff -sS --fail --parallel --parallel-max 24 --max-time 60 --remove-on-error \\',
      '     -A "$ua" "${args[@]}") 2>/dev/null || true',
      '  for f in "${parts[@]}"; do',
      '    if [[ -s $work/$f ]]; then mv -fT -- "$work/$f" "$dir/$f"; fi',
      '  done',
      'fi',
      'missing=0',
      'for f in "${files[@]}"; do [[ -f $dir/$f && -s $dir/$f && ! -L $dir/$f ]] || missing=$((missing + 1)); done',
      'find "$dir" -maxdepth 1 \\( -name "r_*.png" -o -name "r_*.png.part" \\) -mmin +120 -delete 2>/dev/null || true',
      'find "$dir" -maxdepth 1 -type d -name ".nw-tiles.*" -mmin +120 -exec rm -rf -- {} + 2>/dev/null || true',
      'echo "${#parts[@]} $missing"'
    ].join("\n") + "\n"
  var cmd = ["bash", "-c", script, "bash", dir, agent, String(MAX_TILE_BYTES)]
  for (var i = 0; i < downloads.length; i++)
    cmd.push(isTileUrl(downloads[i].url) ? downloads[i].url : "", downloads[i].file)
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
  // omarchy-notification-send parses options before its headline. This
  // boundary also covers a dash-leading fallback weather symbol.
  headline = headline.replace(/^-+/, "")
  var body = []
  if (c.wind.speed !== null) body.push(s.wind + " " + c.wind.speed + " m/s " + c.wind.dirLabel)
  if (view.nowcast) body.push(view.nowcast.summary)
  return { glyph: c.icon, headline: headline, body: body.join("  ·  ") }
}

if (typeof module !== "undefined") {
  module.exports = {
    PLUGIN_ID: PLUGIN_ID,
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
    isTileUrl: isTileUrl,
    radarTileFile: radarTileFile,
    radarFrameId: radarFrameId,
    RADAR_MAX_AGE_MS: RADAR_MAX_AGE_MS,
    radarUsable: radarUsable,
    radarDelayNote: radarDelayNote,
    radarGapNote: radarGapNote,
    parseTileIndex: parseTileIndex,
    radarFrames: radarFrames,
    tileRunId: tileRunId,
    mapFrameLabel: mapFrameLabel,
    radarDownloads: radarDownloads,
    radarFramesKey: radarFramesKey,
    rulerTicks: rulerTicks,
    radarImageSlots: radarImageSlots,
    radarCoverageIndex: radarCoverageIndex,
    radarStep: radarStep,
    radarFrameAt: radarFrameAt,
    mapViewKey: mapViewKey,
    radarFrameFile: radarFrameFile,
    frameComposeSpecs: frameComposeSpecs,
    frameComposeCommand: frameComposeCommand,
    cacheSetupCommand: cacheSetupCommand,
    tileDownloadCommand: tileDownloadCommand,
    NOWCAST_BACKGROUND_MS: NOWCAST_BACKGROUND_MS,
    userAgent: userAgent,
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
    geocodeCommand: geocodeCommand,
    MAX_RESPONSE_BYTES: MAX_RESPONSE_BYTES,
    MAX_TILE_BYTES: MAX_TILE_BYTES,
    MAX_TIMESERIES_STEPS: MAX_TIMESERIES_STEPS,
    MAX_PLACE_NAME_CHARS: MAX_PLACE_NAME_CHARS,
    MAX_GEOCODE_RESULTS: MAX_GEOCODE_RESULTS,
    MAX_RADAR_OBSERVATIONS: MAX_RADAR_OBSERVATIONS,
    MAX_RADAR_FORECASTS: MAX_RADAR_FORECASTS,
    cappedCurl: cappedCurl,
    curlCommand: curlCommand,
    requestService: requestService,
    parseHttpResponse: parseHttpResponse,
    isFresh: isFresh,
    cacheEntryFromResponse: cacheEntryFromResponse,
    jitterMs: jitterMs,
    splitSymbol: splitSymbol,
    describeSymbol: describeSymbol,
    precipKind: precipKind,
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
    pressureAt: pressureAt,
    FAVORITES_MAX: FAVORITES_MAX,
    placeKey: placeKey,
    parseFavorites: parseFavorites,
    isFavorite: isFavorite,
    removeFavorite: removeFavorite,
    toggleFavorite: toggleFavorite,
    favoriteRows: favoriteRows,
    stepFavorite: stepFavorite,
    YR_LIGHTNING_URL: YR_LIGHTNING_URL,
    LIGHTNING_FRAME_MS: LIGHTNING_FRAME_MS,
    LIGHTNING_TRAIL_MS: LIGHTNING_TRAIL_MS,
    MAX_LIGHTNING_STRIKES: MAX_LIGHTNING_STRIKES,
    parseLightning: parseLightning,
    lightningMoment: lightningMoment,
    lightningBolts: lightningBolts,
    lightningPoints: lightningPoints,
    lightningShape: lightningShape,
    lightningSeed: lightningSeed,
    buildPressure: buildPressure,
    precipGlyph: precipGlyph,
    buildLongRange: buildLongRange,
    buildNowcast: buildNowcast,
    buildView: buildView,
    notification: notification,
    summaryText: summaryText,
    contentKey: contentKey
  }
}
