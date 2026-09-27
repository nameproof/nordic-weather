import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Networking
import qs.Commons
import "Model.js" as Model

// The one data source behind the weather pill and panel. Omarchy mounts a
// service once, however many monitors (and so bar widgets and panels) there
// are, following Quickshell's guidance to keep processes and timers out of
// per-screen components: widgets and panels only present what is here.
// Model.js holds the pure logic.
//
// Panels report what they show (open, radar open, map size) with
// updateViewer(); the radar only downloads while some panel shows it.
Scope {
  id: root

  // Injected by the Omarchy shell: a scoped API (summon/hide/toggle for this
  // plugin) and our manifest.
  property var shell: null
  property var manifest: null

  readonly property string pluginId: Model.PLUGIN_ID

  Component.onCompleted: console.log("nordic-weather: service started")

  // ---------------------------------------------------------------- settings

  readonly property string lang: Model.langFor(Qt.locale().name)
  readonly property var t: Model.strings(lang)

  // From the bar entry in shell.json (BarWidget passes them on).
  property int hourStep: 3
  property int hourlyDays: 3
  property int longRangeDays: 10
  onHourStepChanged: rebuild()
  onHourlyDaysChanged: rebuild()
  onLongRangeDaysChanged: rebuild()

  function setDisplaySettings(settings) {
    var s = settings || {}
    var step = parseInt(s.hourStep, 10)
    var days = parseInt(s.hourlyDays, 10)
    var range = parseInt(s.longRangeDays, 10)
    hourStep = isNaN(step) ? 3 : Math.max(1, Math.min(6, step))
    hourlyDays = isNaN(days) ? 3 : Math.max(1, Math.min(3, days))
    longRangeDays = isNaN(range) ? 10 : Math.max(0, Math.min(10, range))
  }

  readonly property string cacheDir: (Quickshell.env("XDG_CACHE_HOME") || (Quickshell.env("HOME") + "/.cache"))
    + "/" + Model.PLUGIN_ID
  readonly property string tilesDir: cacheDir + "/tiles"

  // ---------------------------------------------------------------- viewers

  // What the panels show, by panel: { open, radarOpen, width, height }.
  property var viewers: ({})
  readonly property bool anyOpen: {
    for (var k in viewers) if (viewers[k].open) return true
    return false
  }
  // The panel showing the radar (at most one popout is open at a time).
  readonly property var radarViewer: {
    for (var k in viewers) if (viewers[k].open && viewers[k].radarOpen) return viewers[k]
    return null
  }

  function updateViewer(id, state) {
    var next = Object.assign({}, viewers)
    next[id] = state
    viewers = next
  }

  function removeViewer(id) {
    if (!(id in viewers)) return
    var next = Object.assign({}, viewers)
    delete next[id]
    viewers = next
  }

  onAnyOpenChanged: if (anyOpen) {
    locationFile.reload()
    rebuild()
    maybeFetch(false)
  }

  // ---------------------------------------------------------------- state

  // Shared with the built-in widget and omarchy-weather-location.
  property var location: ({ name: "", latitude: null, longitude: null })
  readonly property bool hasLocation: Model.hasCoordinates(location)

  // { forecast, nowcast, sun, moon, radar, radarFile, yrObs, yrNow: cache
  //   entries (see Model.isFresh), elevations: { "lat,lon": metres },
  //   prefs: { radarSource, mapStep } }
  property var cache: ({})
  property bool cacheLoaded: false

  property var view: Model.buildView({ lang: root.lang, nowMs: Date.now(), location: root.location })
  property bool stale: false
  property string lastError: ""

  // Spread refreshes out after each Expires (MET asks for no synchronised
  // traffic). Fixed per session so it doesn't drift per tick.
  readonly property int refreshJitterMs: Model.jitterMs()
  property double backoffUntil: 0
  property var failures: ({})

  // Parsed bodies, reused until the cached body changes.
  property var parsedMemo: ({})

  // Network state from NetworkManager (Quickshell.Networking; Omarchy's own
  // network widget uses it too). Offline, requests are skipped rather than
  // failed, so the back-off doesn't grow; when the connection comes back,
  // everything due is fetched at once instead of after the back-off.
  // Without NetworkManager this stays Unknown and nothing changes.
  readonly property int connectivity: Networking.connectivity
  readonly property bool offline: connectivity === NetworkConnectivity.None
    || connectivity === NetworkConnectivity.Limited || connectivity === NetworkConnectivity.Portal
  onConnectivityChanged: {
    console.log("nordic-weather: connectivity " + connectivity)
    if (connectivity === NetworkConnectivity.Full) {
      failures = ({})
      maybeFetch(false)
    }
  }

  onLocationChanged: {
    rebuild()
    maybeFetch(false)
  }

  function locationForRequests() {
    var key = Model.roundCoord(location.latitude) + "," + Model.roundCoord(location.longitude)
    var elevations = cache.elevations || {}
    return {
      name: location.name,
      latitude: location.latitude,
      longitude: location.longitude,
      elevation: typeof elevations[key] === "number" ? elevations[key] : null
    }
  }

  function requestUrls() {
    if (!hasLocation) return null
    var loc = locationForRequests()
    var now = Date.now()
    return {
      forecast: Model.forecastUrl(loc),
      nowcast: Model.nowcastUrl(loc),
      sun: Model.sunUrl(loc, now),
      moon: Model.moonUrl(loc, now)
    }
  }

  function parsedFor(kind, url) {
    var entry = cache[kind]
    if (!entry || entry.key !== url || !entry.body) return null
    var memo = parsedMemo[kind]
    if (memo && memo.key === url && memo.body === entry.body) return memo.value
    var value = kind === "sun" ? Model.parseSun(entry.body)
      : kind === "moon" ? Model.parseMoon(entry.body, entry.fetchedMs)
      : Model.parseTimeseries(entry.body)
    var next = Object.assign({}, parsedMemo)
    next[kind] = { key: url, body: entry.body, value: value }
    parsedMemo = next
    return value
  }

  function rebuild() {
    var urls = requestUrls()
    var now = Date.now()
    var forecast = urls ? parsedFor("forecast", urls.forecast) : null
    // While a new place's forecast loads, keep showing the previous view
    // (the search field stays open with a spinner) rather than flashing empty.
    if (urls && !forecast && forecastProc.running && view.ready) return

    view = Model.buildView({
      forecast: forecast,
      nowcast: urls ? parsedFor("nowcast", urls.nowcast) : null,
      sun: urls ? parsedFor("sun", urls.sun) : null,
      moon: urls ? parsedFor("moon", urls.moon) : null,
      location: location,
      lang: lang,
      nowMs: now,
      settings: { hourStep: hourStep, hourlyDays: hourlyDays, longRangeDays: longRangeDays }
    })
    var entry = cache.forecast
    stale = !!entry && !!urls && entry.key === urls.forecast && now > entry.expiresMs + 60 * 60000
  }

  // ---------------------------------------------------------------- fetching

  function isDue(kind, url, now) {
    var entry = cache[kind]
    var failure = failures[kind]
    if (failure && failure.key === url && now < failure.nextMs) return false
    if (!entry || entry.key !== url) return true
    // Sun and moon are keyed by date; one fetch per day is plenty.
    if (kind === "sun" || kind === "moon") return false
    // Nowcast keeps the bar's "now" fresh: every 15 min in the background,
    // as often as Expires allows (~5 min) while a panel is open. The
    // minimum gaps also guard against an Expires that is already in the
    // past on arrival (seen from MET's cache), which would otherwise mean a
    // request on every tick.
    if (kind === "nowcast")
      return now >= Math.max(entry.expiresMs, entry.fetchedMs + (anyOpen ? 2 * 60000 : Model.NOWCAST_BACKGROUND_MS))
    // Radar indexes: only polled while that radar is on screen.
    if (kind === "radar" || kind === "yrObs" || kind === "yrNow")
      return now >= Math.max(entry.expiresMs, entry.fetchedMs + 2 * 60000)
    return now >= Math.max(entry.expiresMs + refreshJitterMs, entry.fetchedMs + 5 * 60000)
  }

  // force: middle click / IPC refresh. Skips the Expires wait, but still
  // sends If-Modified-Since, so an unchanged forecast costs a 304.
  function maybeFetch(force) {
    if (!hasLocation || !cacheLoaded || offline) return
    var now = Date.now()
    if (now < backoffUntil) return
    var urls = requestUrls()
    startFetch(forecastProc, "forecast", urls.forecast, force || isDue("forecast", urls.forecast, now))
    startFetch(sunProc, "sun", urls.sun, isDue("sun", urls.sun, now))
    startFetch(moonProc, "moon", urls.moon, isDue("moon", urls.moon, now))
    // A cached 422 (outside radar coverage) has an empty body; forcing won't change that.
    var nowcastCovered = !cache.nowcast || cache.nowcast.key !== urls.nowcast || cache.nowcast.body !== ""
    startFetch(nowcastProc, "nowcast", urls.nowcast, (force && nowcastCovered) || isDue("nowcast", urls.nowcast, now))
    if (metRadarActive) {
      startFetch(radarIndexProc, "radar", Model.RADAR_INDEX_URL, force || isDue("radar", Model.RADAR_INDEX_URL, now))
      maybeDownloadRadar()
    }
    if (yrRadarActive) {
      startFetch(yrObsProc, "yrObs", Model.YR_RADAR_OBS_INDEX, force || isDue("yrObs", Model.YR_RADAR_OBS_INDEX, now))
      startFetch(yrNowProc, "yrNow", Model.YR_RADAR_NOWCAST_INDEX, force || isDue("yrNow", Model.YR_RADAR_NOWCAST_INDEX, now))
      maybeDownloadYrTiles()
    }
  }

  function startFetch(proc, kind, url, due) {
    if (!due || proc.running) return
    var entry = cache[kind]
    var lastModified = entry && entry.key === url ? entry.lastModified : ""
    proc.url = url
    proc.command = Model.curlCommand(url, lastModified, kind === "forecast" ? 15 : 10)
    proc.running = true
  }

  function refresh(force) {
    failures = ({})
    maybeFetch(force === true)
  }

  function recordFailure(kind, url, message) {
    var next = Object.assign({}, failures)
    var previous = next[kind] && next[kind].key === url ? next[kind].count : 0
    var count = previous + 1
    // 15 s, 30 s, 60 s … capped at 15 min; the tick picks it up again.
    next[kind] = { key: url, count: count, nextMs: Date.now() + Math.min(15 * 60000, 15000 * Math.pow(2, count - 1)) }
    failures = next
    if (kind === "forecast") lastError = message
  }

  function handleResponse(kind, url, raw) {
    var now = Date.now()
    var response = Model.parseHttpResponse(raw)
    var urls = requestUrls()
    var current = urls && urls[kind] === url

    console.log("nordic-weather: " + kind + " HTTP " + (response.status || "failed")
      + (response.headers.expires ? ", expires " + response.headers.expires : ""))
    if (response.status === 203)
      console.warn("nordic-weather: " + kind + " API version is deprecated: " + url)

    if (response.status === 200 || response.status === 203 || response.status === 304) {
      var unreadable = response.status !== 304 && (
        ((kind === "forecast" || kind === "nowcast") && !Model.parseTimeseries(response.body))
        || ((kind === "yrObs" || kind === "yrNow") && !Model.parseTileIndex(response.body).length))
      if (unreadable) {
        recordFailure(kind, url, "unreadable response")
      } else {
        var fallbackTtl = kind === "yrObs" || kind === "yrNow" ? 60000
          : kind === "nowcast" || kind === "radar" ? 5 * 60000 : kind === "forecast" ? 30 * 60000 : 24 * 3600000
        setCacheEntry(kind, Model.cacheEntryFromResponse(cache[kind], url, response, now, fallbackTtl))
        var cleared = Object.assign({}, failures)
        delete cleared[kind]
        failures = cleared
        if (kind === "forecast") lastError = ""
      }
    } else if (response.status === 422 && kind === "nowcast") {
      // Outside the Nordic radar area: remember that for a day.
      setCacheEntry(kind, { key: url, body: "", lastModified: "", expiresMs: now + 24 * 3600000, fetchedMs: now })
    } else if (response.status === 429) {
      console.warn("nordic-weather: throttled by api.met.no (429), pausing requests")
      backoffUntil = now + 10 * 60000
      recordFailure(kind, url, "HTTP 429")
    } else {
      if (response.status === 403) console.warn("nordic-weather: 403 Forbidden for " + url)
      recordFailure(kind, url, response.status ? "HTTP " + response.status : "network error")
    }

    if (kind === "forecast" && current) finishSavingLocation()
    rebuild()
  }

  function setCacheEntry(kind, entry) {
    var next = Object.assign({}, cache)
    next[kind] = entry
    cache = next
    writeCache()
  }

  function setPref(name, value) {
    var next = Object.assign({}, cache)
    var prefs = Object.assign({}, cache.prefs || {})
    prefs[name] = value
    next.prefs = prefs
    cache = next
    writeCache()
  }

  function writeCache() {
    if (!cacheLoaded) return
    cacheFile.setText(JSON.stringify(cache) + "\n")
  }

  // ---------------------------------------------------------------- location search

  property var locationSuggestions: []
  property bool geocodeSearched: false
  property bool savingLocation: false
  property string geocodePendingQuery: ""
  property string geocodeActiveQuery: ""

  // A picked place's forecast has arrived (or failed): panels close the search.
  signal locationSaved()

  // One request at a time; if the query moved on while a request was in
  // flight, the latest query is fetched right after. (Panels debounce typing.)
  function search(text) {
    var query = String(text || "").trim()
    if (query.length < 2) {
      clearSearch()
      return
    }
    geocodePendingQuery = query
    if (!geocodeProc.running) startGeocode()
  }

  function clearSearch() {
    geocodePendingQuery = ""
    locationSuggestions = []
    geocodeSearched = false
    savingLocation = false
  }

  function searchBusy() {
    return geocodeProc.running
  }

  function startGeocode() {
    geocodeActiveQuery = geocodePendingQuery
    geocodeProc.command = ["curl", "-fsS", "--max-time", "5", "-A", Model.USER_AGENT,
                           Model.geocodeUrl(geocodeActiveQuery, root.lang)]
    geocodeProc.running = true
  }

  function pickSuggestion(suggestion) {
    if (!suggestion) return
    savingLocation = true
    if (typeof suggestion.elevation === "number") {
      var next = Object.assign({}, cache)
      var elevations = Object.assign({}, next.elevations || {})
      elevations[Model.roundCoord(suggestion.latitude) + "," + Model.roundCoord(suggestion.longitude)] = suggestion.elevation
      next.elevations = elevations
      cache = next
      writeCache()
    }
    location = { name: suggestion.name, latitude: suggestion.latitude, longitude: suggestion.longitude }
    persistLocation(["--set", suggestion.name, suggestion.latitude + "," + suggestion.longitude])
    // Already-cached place: nothing to wait for.
    if (!forecastProc.running) finishSavingLocation()
  }

  function finishSavingLocation() {
    if (!savingLocation) return
    clearSearch()
    locationSaved()
  }

  function persistLocation(args) {
    locationSaveProc.command = ["omarchy-weather-location"].concat(args)
    locationSaveProc.running = true
  }

  // ---------------------------------------------------------------- notification

  function notify() {
    rebuild()
    var note = Model.notification(view)
    if (!note) {
      Util.execArgv(["omarchy-notification-send", hasLocation ? t.fetching : t.noLocation])
      return
    }
    var argv = ["omarchy-notification-send", "-g", note.glyph, note.headline]
    if (note.body) argv.push(note.body)
    Util.execArgv(argv)
  }

  // ---------------------------------------------------------------- radar: common

  // Which radar the side panel shows: MET's GIF or the yr.no-style map
  // (toggle at the bottom of the side panel, remembered in the cache file).
  readonly property string radarSource: cache.prefs && cache.prefs.radarSource === "yr" ? "yr" : "met"
  readonly property bool metRadarActive: radarViewer !== null && radarSource === "met"
  readonly property bool yrRadarActive: radarViewer !== null && radarSource === "yr" && hasLocation
  onRadarSourceChanged: maybeFetch(false)
  onMetRadarActiveChanged: if (metRadarActive) maybeFetch(false)
  onYrRadarActiveChanged: if (yrRadarActive) {
    yrPlayhead = { frame: 0, tick: yrPlayhead.tick }
    yrSub = 0
    yrPaused = false
    maybeFetch(false)
    Qt.callLater(maybeEstimateFlow)
  }

  function setRadarSource(source) {
    if (source === "met" || source === "yr") setPref("radarSource", source)
  }

  // ---------------------------------------------------------------- radar: MET GIF

  property bool radarDownloading: false
  readonly property var radarIndex: cache.radar ? Model.parseRadarIndex(cache.radar.body) : null
  // Newest frame time of the GIF on disk (cache.radarFile.timeMs).
  readonly property double radarFileTimeMs: cache.radarFile && typeof cache.radarFile.timeMs === "number" ? cache.radarFile.timeMs : 0
  onRadarIndexChanged: maybeDownloadRadar()

  function maybeDownloadRadar() {
    var index = radarIndex
    if (!index || radarDownloading || !metRadarActive) return
    if (index.timeMs === radarFileTimeMs) return
    radarDownloading = true
    radarDownloadProc.timeMs = index.timeMs
    radarDownloadProc.command = Model.radarDownloadCommand(cacheDir)
    radarDownloadProc.running = true
  }

  // ---------------------------------------------------------------- radar: yr.no map

  // Our own base map (map/, from OpenStreetMap) with yr.no's radar tiles on
  // top. The view never leaves the radar coverage (Model.mapView).
  readonly property int mapStep: Model.clampMapStep(cache.prefs ? cache.prefs.mapStep : undefined)

  function zoomMap(delta) {
    var step = Model.clampMapStep(mapStep + delta)
    if (step !== mapStep) setPref("mapStep", step)
  }

  function setMapStep(step) {
    zoomMap(step - mapStep)
  }

  // Place labels come from map/places.json (read once, static).
  property var mapPlaces: null
  FileView {
    path: decodeURIComponent(String(Qt.resolvedUrl("map/places.json")).replace(/^file:\/\//, ""))
    printErrors: false
    onLoaded: {
      try { root.mapPlaces = JSON.parse(text()) } catch (e) { root.mapPlaces = null }
    }
  }

  readonly property var yrRadar: Model.radarFrames(cache.yrObs ? cache.yrObs.body : "", cache.yrNow ? cache.yrNow.body : "")
  // The map's real pixel size, from the panel showing it.
  readonly property int yrMapWidth: radarViewer ? radarViewer.width : 0
  readonly property int yrMapHeight: radarViewer ? radarViewer.height : 0
  readonly property var mapViewState: hasLocation
    ? Model.mapView(mapStep, location.latitude, location.longitude, yrMapWidth, yrMapHeight) : null
  readonly property var yrBaseTiles: mapViewState ? Model.viewTiles(mapViewState, yrMapWidth, yrMapHeight) : []
  readonly property var yrRadarTiles: mapViewState
    ? Model.viewTiles(Model.radarView(mapViewState), yrMapWidth, yrMapHeight) : []
  // Bumped after each download batch so Images re-read files that just arrived.
  property int yrRadarRevision: 0
  // Frames download in playback order, yrBatchFrames at a time; this many
  // frames (a prefix) of the key yrRadarDoneKey are on disk.
  property string yrRadarDoneKey: ""
  property int yrRadarDoneCount: 0
  readonly property int yrBatchFrames: 6

  // Animation: 250 ms per 5-minute frame, looping straight from the last
  // forecast frame back to the first. Click the map to pause.
  // Playback position: the frame on screen, and how many steps playback
  // has made. One object, so what derives from both (the image slots
  // below) changes once per step: an image whose source flickered to
  // another frame and back would decode twice, or show nothing meanwhile.
  property var yrPlayhead: ({ frame: 0, tick: 0 })
  readonly property int yrFrame: yrPlayhead.frame
  property bool yrPaused: false

  function togglePause() {
    yrPaused = !yrPaused
    yrSub = 0
  }

  // Scrubbing (the ruler on the map, or , and .): show a frame and pause.
  // Only frames that are downloaded can be shown.
  function seekFrame(index) {
    var n = Math.min(yrDisplay.frames.length, yrPlayLimit)
    if (n <= 0) return
    yrPlayhead = { frame: Math.max(0, Math.min(n - 1, index)), tick: yrPlayhead.tick }
    yrSub = 0
    yrPaused = true
  }

  function stepFrame(delta) {
    seekFrame(Math.min(yrFrame, yrDisplay.frames.length - 1) + delta)
  }

  // Smoothing between frames (test: off, fade or flow). A frame still lasts
  // 250 ms; smoothed, it is drawn radarFps / 4 times, each drawing blended
  // (fade) or moved (flow) further towards the next frame.
  readonly property string radarSmoothing: cache.prefs && (cache.prefs.radarSmoothing === "fade" || cache.prefs.radarSmoothing === "flow")
    ? cache.prefs.radarSmoothing : "off"
  readonly property int radarFps: cache.prefs && [8, 12, 16].indexOf(cache.prefs.radarFps) >= 0 ? cache.prefs.radarFps : 8
  readonly property int yrSubsteps: radarSmoothing === "off" ? 1 : radarFps / 4

  function setRadarSmoothing(mode) {
    if (mode === "off" || mode === "fade" || mode === "flow") setPref("radarSmoothing", mode)
  }

  function setRadarFps(fps) {
    if ([8, 12, 16].indexOf(fps) >= 0) setPref("radarFps", fps)
  }

  // Drawings done within the current frame (0 … yrSubsteps − 1).
  property int yrSub: 0
  readonly property int yrCurrentIndex: yrDisplay.frames.length ? Math.min(yrFrame, yrDisplay.frames.length - 1) : -1
  readonly property int yrUpcomingIndex: yrDisplay.frames.length
    ? Model.radarNextFrame(yrFrame, yrDisplay.frames.length, Math.min(yrDisplay.frames.length, yrPlayLimit)) : -1
  // The two images panels draw from when smoothing: the frame on screen in
  // slot tick % 2, the upcoming one in the other. At each step the upcoming
  // frame, already decoded, becomes the current one where it is, and only
  // the other slot loads. Read straight from yrPlayhead, so it changes once
  // per step.
  readonly property var yrSlots: {
    var frames = yrShownValid ? yrShown.frames : []
    var n = frames.length
    if (!n) return { frames: [null, null], current: 0 }
    var cur = Math.min(yrPlayhead.frame, n - 1)
    var up = Model.radarNextFrame(yrPlayhead.frame, n, n)
    var k = yrPlayhead.tick % 2
    var slots = [null, null]
    slots[k] = frames[cur]
    slots[1 - k] = up !== cur ? frames[up] : null
    return { frames: slots, current: k }
  }
  // Only towards the next frame in time, never across the loop's seam.
  readonly property bool yrBlendable: yrShownValid && !yrPaused && yrUpcomingIndex === yrCurrentIndex + 1
  readonly property real yrBlend: yrBlendable ? yrSub / yrSubsteps : 0

  // Identifies the full tile set: the map view (which tiles) and every
  // frame (which run and time). The latest observed frame downloads first
  // (≈25 tiles) and is shown until the first batch of frames is in; playback
  // then starts and never runs ahead of the download (it holds on the last
  // frame that is there).
  readonly property string yrRadarKey: yrRadar.frames.length && yrViewKey !== "" && yrRadarTiles.length
    ? yrViewKey + "|" + Model.radarFramesKey(yrRadar.frames) : ""
  onYrRadarKeyChanged: {
    yrRetry.stop()
    yrRetryCount = 0
    maybeDownloadYrTiles()
  }
  // A batch counts as downloaded only once all its tiles are on disk; until
  // then it is retried with a growing delay.
  property int yrRetryCount: 0
  Timer {
    id: yrRetry
    interval: Math.min(60000, 5000 * Math.pow(2, Math.max(0, root.yrRetryCount - 1)))
    onTriggered: root.maybeDownloadYrTiles()
  }
  readonly property int yrRadarReadyCount: yrRadarKey !== "" && yrRadarDoneKey === yrRadarKey ? yrRadarDoneCount : 0
  readonly property bool yrRadarReady: yrRadarKey !== "" && yrRadarReadyCount >= yrRadar.frames.length
  readonly property bool yrPlayable: yrRadarKey !== "" && yrRadarReadyCount >= Math.min(yrBatchFrames, yrRadar.frames.length)
  property string yrRadarNowDoneKey: ""
  readonly property var yrNowFrame: yrRadar.frames.length ? yrRadar.frames[Math.max(0, yrRadar.nowIndex)] : null

  // What plays: the last fully assembled loop for this view ({ frames,
  // nowIndex, viewKey }), kept while a newer forecast run downloads so the
  // animation doesn't stop every 5 minutes. Without one (first open, new
  // zoom), the live tiles play once downloaded, holding "now" until then.
  property var yrShown: null
  readonly property bool yrShownValid: yrShown !== null && yrShown.viewKey === yrViewKey
  readonly property var yrDisplay: yrShownValid ? yrShown : yrRadar
  readonly property bool yrPlaying: yrShownValid || yrPlayable
  // How far playback may go: everything for an assembled loop, otherwise
  // the frames downloaded so far.
  readonly property int yrPlayLimit: yrShownValid ? yrShown.frames.length : yrRadarReadyCount
  readonly property var yrCurrentFrame: !yrDisplay.frames.length ? null
    : yrPlaying ? yrDisplay.frames[Math.min(yrFrame, yrDisplay.frames.length - 1, Math.max(0, yrPlayLimit - 1))] : yrNowFrame

  // Pre-assembled frames (Model.frameComposeCommand): once a view's tiles
  // are all downloaded, each frame becomes one map-sized image, so playback
  // decodes one image per frame instead of 20–25 tiles. Until then (and for
  // any new view) the tiles are shown directly.
  readonly property string yrViewKey: Model.mapViewKey(mapViewState, yrMapWidth, yrMapHeight)
  readonly property string yrFramesKey: yrRadarKey
  property string yrFramesDoneKey: ""
  property int yrFramesRevision: 0
  onYrFramesKeyChanged: Qt.callLater(maybeComposeYrFrames)

  function maybeComposeYrFrames() {
    if (!yrRadarActive || !yrRadarReady || yrViewKey === "" || yrFramesProc.running
        || yrFramesDoneKey === yrFramesKey) return
    var rv = Model.radarView(mapViewState)
    yrFramesProc.key = yrFramesKey
    yrFramesProc.loop = { frames: yrRadar.frames, nowIndex: yrRadar.nowIndex, viewKey: yrViewKey, key: yrFramesKey }
    yrFramesProc.command = Model.frameComposeCommand(tilesDir, yrMapWidth, yrMapHeight, rv.px,
      Model.frameComposeSpecs(yrRadarTiles, yrRadar.frames, yrViewKey))
    yrFramesProc.running = true
  }

  function maybeDownloadYrTiles() {
    if (!yrRadarActive || yrRadarKey === "" || yrRadarProc.running || yrRetry.running) return
    if (yrRadarNowDoneKey !== yrRadarKey) {
      yrRadarProc.key = yrRadarKey + "|now"
      yrRadarProc.command = Model.tileDownloadCommand(tilesDir, Model.radarDownloads(yrRadarTiles, [yrNowFrame]))
    } else if (yrRadarReadyCount < yrRadar.frames.length) {
      var from = yrRadarReadyCount
      var to = Math.min(yrRadar.frames.length, from + yrBatchFrames)
      yrRadarProc.key = yrRadarKey
      yrRadarProc.upTo = to
      yrRadarProc.command = Model.tileDownloadCommand(tilesDir, Model.radarDownloads(yrRadarTiles, yrRadar.frames.slice(from, to)))
    } else {
      maybeComposeYrFrames()
      return
    }
    yrRadarProc.running = true
  }

  // ---------------------------------------------------------------- IPC

  // Keeps the built-in widget's target, so `omarchy-shell omarchy.weather …`
  // keybinds keep working. Opening goes through the shell, which picks the
  // bar widget on the focused monitor; commands for the panel itself (radar,
  // edit) are handed to whichever panel opens (takePendingAction).
  property string pendingAction: ""
  signal panelCommand(string name)

  function takePendingAction() {
    var action = pendingAction
    pendingAction = ""
    return action
  }

  function openPanelWith(action) {
    if (shell && shell.isPluginOpen(pluginId)) {
      panelCommand(action)
      return
    }
    pendingAction = action
    if (shell) shell.summon(pluginId)
  }

  IpcHandler {
    target: "omarchy.weather"
    function open(): void { if (root.shell) root.shell.summon(root.pluginId) }
    function show(): void { if (root.shell) root.shell.summon(root.pluginId) }
    function close(): void { if (root.shell) root.shell.hide(root.pluginId) }
    function hide(): void { if (root.shell) root.shell.hide(root.pluginId) }
    function toggle(): void { if (root.shell) root.shell.toggle(root.pluginId) }
    function edit(): void { root.openPanelWith("edit") }
    function radar(): void { root.openPanelWith("radar") }
    function refresh(): void { root.refresh(true) }
    function mapZoom(step: int): void { root.setMapStep(step) }
    function setRadarSource(source: string): void { root.setRadarSource(source) }
    // Smoothing test: off, fade or flow; 8, 12 or 16 drawings per second.
    function setRadarSmoothing(mode: string): void { root.setRadarSmoothing(mode) }
    function setRadarFps(fps: int): void { root.setRadarFps(fps) }
    // For scripts: "Alingsås · Klart 12° · Vind 2 m/s S · …" and "12°".
    function summary(): string { return Model.summaryText(root.view) }
    function temperature(): string {
      return root.view.ready && root.view.current.temp !== null ? root.view.current.temp + "°" : ""
    }
  }

  // ---------------------------------------------------------------- files

  FileView {
    id: locationFile
    path: Quickshell.env("HOME") + "/.local/state/omarchy/settings/weather.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.setLocationIfChanged(Model.parseLocationFile(text()))
    onLoadFailed: root.setLocationIfChanged(Model.parseLocationFile(""))
  }

  function setLocationIfChanged(next) {
    if (next.name === location.name && next.latitude === location.latitude && next.longitude === location.longitude) return
    location = next
  }

  // The first read can race shell startup (seen with the built-in); one
  // delayed reload self-corrects and is a no-op otherwise.
  Timer {
    interval: 1500
    running: true
    onTriggered: locationFile.reload()
  }

  Process {
    id: mkdirProc
    command: ["mkdir", "-p", root.cacheDir]
    running: true
    onExited: cacheFile.path = root.cacheDir + "/cache.json"
  }

  // Only this service writes it, so there is nothing to watch.
  FileView {
    id: cacheFile
    atomicWrites: true
    printErrors: false
    onLoaded: {
      var parsed = null
      try { parsed = JSON.parse(text()) } catch (e) { parsed = null }
      root.cache = parsed && typeof parsed === "object" ? parsed : ({})
      root.cacheLoaded = true
      root.rebuild()
      root.maybeFetch(false)
    }
    onLoadFailed: {
      if (root.cacheLoaded) return
      root.cache = ({})
      root.cacheLoaded = true
      root.rebuild()
      root.maybeFetch(false)
    }
  }

  // ---------------------------------------------------------------- processes

  // Inline components can use this file's ids (Quickshell guide).
  component FetchProcess: Process {
    id: fetchProc
    property string kind: ""
    property string url: ""
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.handleResponse(fetchProc.kind, fetchProc.url, text)
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: if (text.trim() !== "") console.warn("nordic-weather/" + fetchProc.kind + ": " + text.trim())
    }
  }

  FetchProcess { id: forecastProc; kind: "forecast" }
  FetchProcess { id: nowcastProc; kind: "nowcast" }
  FetchProcess { id: sunProc; kind: "sun" }
  FetchProcess { id: moonProc; kind: "moon" }
  FetchProcess { id: radarIndexProc; kind: "radar" }
  FetchProcess { id: yrObsProc; kind: "yrObs" }
  FetchProcess { id: yrNowProc; kind: "yrNow" }

  // Both scripts print two numbers (see Model.tileDownloadCommand and
  // Model.frameComposeCommand). The next step starts once the process has
  // exited: its output can end while it still counts as running.
  component TileProcess: Process {
    id: tileProc
    property string key: ""
    signal finished(string key, bool ok, int first, int second)
    signal idle()
    onRunningChanged: if (!running) Qt.callLater(tileProc.idle)
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var n = text.trim().split(/\s+/)
        tileProc.finished(tileProc.key, n.length === 2, parseInt(n[0], 10) || 0, parseInt(n[1], 10) || 0)
      }
    }
  }

  TileProcess {
    id: yrRadarProc
    property int upTo: 0
    onFinished: (key, ok, fetched, missing) => {
      console.log("nordic-weather: yr radar tiles, " + fetched + " fetched" + (missing ? ", " + missing + " missing" : ""))
      root.yrRadarRevision++
      if (!ok || missing > 0) {
        root.yrRetryCount++
        yrRetry.restart()
      } else if (key.endsWith("|now")) {
        root.yrRetryCount = 0
        root.yrRadarNowDoneKey = key.slice(0, -4)
      } else {
        root.yrRetryCount = 0
        root.yrRadarDoneCount = key === root.yrRadarDoneKey ? Math.max(root.yrRadarDoneCount, upTo) : upTo
        root.yrRadarDoneKey = key
      }
    }
    onIdle: root.maybeDownloadYrTiles()
  }

  TileProcess {
    id: yrFramesProc
    property var loop: null
    onFinished: (key, ok, total, made) => {
      console.log("nordic-weather: yr radar frames assembled, " + made + "/" + total)
      root.yrFramesRevision++
      if (ok && made === total) {
        root.yrFramesDoneKey = key
        root.yrShown = loop
      } else if (key === root.yrRadarKey) {
        // A tile went missing after its batch was counted: check the
        // downloads again (only missing tiles are fetched) after a delay.
        root.yrRadarDoneKey = ""
        root.yrRetryCount++
        yrRetry.restart()
      }
    }
    // The view may have changed while this ran.
    onIdle: root.maybeComposeYrFrames()
  }

  // Flow (smoothing test): the motion between consecutive frames of the
  // loop on screen, estimated once per assembled loop off the GUI thread
  // (FlowWorker.mjs) from quarter-size rain-strength images (ImageMagick),
  // and written as a small PPM atlas for the radar shader. What holds the
  // frames' data (the process and its output, the worker and its engine)
  // exists only while a loop is estimated: V4 keeps a heap once grown, so
  // a long-lived worker would hold on to ≈45 MB.
  readonly property string yrShownKey: yrShown ? yrShown.key : ""
  property string yrFlowKey: ""
  property var yrFlowInfo: null
  property int yrFlowRevision: 0
  // The loop being estimated ("" when idle) and its input; yrFlowWorking
  // keeps the process and worker alive.
  property string yrFlowBusy: ""
  property var yrFlowJob: null
  property bool yrFlowWorking: false
  property double yrFlowStartMs: 0
  property double yrFlowInputMs: 0
  readonly property bool yrFlowReady: yrShownValid && yrFlowInfo !== null && yrFlowKey === yrShownKey
  onYrShownKeyChanged: Qt.callLater(maybeEstimateFlow)
  onRadarSmoothingChanged: Qt.callLater(maybeEstimateFlow)

  function maybeEstimateFlow() {
    if (radarSmoothing !== "flow" || !yrRadarActive || !yrShownValid || yrFlowBusy !== ""
        || yrFlowKey === yrShownKey || tilesDir === "") return
    var files = []
    for (var i = 0; i < yrShown.frames.length; i++) files.push(Model.radarFrameFile(yrShown.frames[i], yrShown.viewKey))
    var w = Math.max(1, Math.round(yrMapWidth / 4))
    var h = Math.max(1, Math.round(yrMapHeight / 4))
    yrFlowBusy = yrShownKey
    yrFlowStartMs = Date.now()
    yrFlowJob = { key: yrShownKey, command: Model.flowInputCommand(tilesDir, files, w, h), w: w, h: h,
                  count: files.length, mapWidth: yrMapWidth, mapHeight: yrMapHeight }
    yrFlowWorking = true
  }

  // Ends the process and worker (not from inside their own handlers).
  function stopFlowWork() {
    yrFlowJob = null
    Qt.callLater(function() { root.yrFlowWorking = false })
  }

  function flowFailed(reason) {
    if (reason) console.warn("nordic-weather: flow failed: " + reason)
    stopFlowWork()
    yrFlowBusy = ""
  }

  function flowResult(message) {
    stopFlowWork()
    if (!message.result || message.key !== yrShownKey) {
      flowFailed(message.error)
      Qt.callLater(maybeEstimateFlow)
      return
    }
    var r = message.result
    flowFile.pending = { key: message.key, workerMs: message.ms,
      info: { gx: r.gx, gy: r.gy, pairs: r.pairs, cellW: r.cellW, cellH: r.cellH, unit: r.unit, knownCells: r.knownCells } }
    flowFile.setText(r.ppm)
  }

  LazyLoader {
    active: root.yrFlowWorking

    Scope {
      Process {
        command: root.yrFlowJob ? root.yrFlowJob.command : []
        running: root.yrFlowJob !== null
        stdout: StdioCollector {
          waitForEnd: true
          onStreamFinished: {
            var job = root.yrFlowJob
            root.yrFlowInputMs = Date.now() - root.yrFlowStartMs
            if (!job || text === "" || job.key !== root.yrShownKey) {
              root.flowFailed(job && text === "" ? "no input from ImageMagick" : "")
              Qt.callLater(root.maybeEstimateFlow)
              return
            }
            flowWorker.sendMessage({ key: job.key, data: text, w: job.w, h: job.h, count: job.count,
                                     mapWidth: job.mapWidth, mapHeight: job.mapHeight })
          }
        }
      }

      WorkerScript {
        id: flowWorker
        source: Qt.resolvedUrl("FlowWorker.mjs")
        onMessage: function(message) { root.flowResult(message) }
      }
    }
  }

  FileView {
    id: flowFile
    property var pending: null
    path: root.tilesDir !== "" ? root.tilesDir + "/flow.ppm" : ""
    preload: false
    printErrors: false
    onSaved: {
      var p = pending
      pending = null
      if (p) {
        root.yrFlowInfo = p.info
        root.yrFlowKey = p.key
        root.yrFlowRevision++
        console.log("nordic-weather: flow estimated, " + p.info.pairs + " pairs, " + p.info.knownCells + " cells with rain; input "
          + root.yrFlowInputMs + " ms, worker " + p.workerMs + " ms, total " + (Date.now() - root.yrFlowStartMs) + " ms")
      }
      root.yrFlowBusy = ""
      Qt.callLater(root.maybeEstimateFlow)
    }
    onSaveFailed: {
      pending = null
      root.yrFlowBusy = ""
    }
  }

  Process {
    id: radarDownloadProc
    property double timeMs: 0
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var response = Model.parseHttpResponse(text)
        console.log("nordic-weather: radar image HTTP " + (response.status || "failed"))
        if (response.status === 200) root.setCacheEntry("radarFile", { timeMs: radarDownloadProc.timeMs })
        root.radarDownloading = false
      }
    }
  }

  Process {
    id: geocodeProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var searching = root.geocodePendingQuery !== ""
        root.locationSuggestions = searching ? Model.parseGeocodingResults(text) : []
        root.geocodeSearched = searching
        if (searching && root.geocodePendingQuery !== root.geocodeActiveQuery) Qt.callLater(root.startGeocode)
      }
    }
  }

  Process {
    id: locationSaveProc
    onExited: function(exitCode) {
      if (exitCode !== 0) console.warn("nordic-weather: omarchy-weather-location failed (" + exitCode + ")")
      locationFile.reload()
    }
  }

  // ---------------------------------------------------------------- timers

  // Every minute, on the minute (SystemClock updates within 50 ms of the
  // wall clock): rebuild so hour rows roll over exactly on the hour, and
  // fetch whatever is due (cheap: no request unless Expires has passed).
  SystemClock {
    precision: SystemClock.Minutes
    onDateChanged: {
      root.rebuild()
      root.maybeFetch(false)
    }
  }

  // The radar animation (one frame counter for every panel): a new frame
  // every 250 ms, drawn yrSubsteps times.
  Timer {
    interval: Math.round(250 / root.yrSubsteps)
    repeat: true
    running: root.yrRadarActive && root.yrPlaying && !root.yrPaused && root.yrDisplay.frames.length > 1
    onTriggered: {
      if (root.yrSub + 1 < root.yrSubsteps) {
        root.yrSub++
        return
      }
      root.yrSub = 0
      var next = root.yrUpcomingIndex
      if (next === root.yrFrame) return
      root.yrPlayhead = { frame: next, tick: root.yrPlayhead.tick + 1 }
    }
  }
}
