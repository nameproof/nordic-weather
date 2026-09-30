pragma ComponentBehavior: Bound
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
  readonly property string userAgent: Model.userAgent(manifest)

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
    Qt.callLater(maybeFetch, false)
  }

  // ---------------------------------------------------------------- state

  // Shared with the built-in widget and omarchy-weather-location.
  property var location: ({ name: "", latitude: null, longitude: null })
  readonly property bool hasLocation: Model.hasCoordinates(location)

  // { forecast, nowcast, sun, moon, yrObs, yrNow: cache entries (see
  //   Model.isFresh), elevations: { "lat,lon": metres }, prefs: { mapStep } }
  property var cache: ({})
  property bool cacheLoaded: false

  property var view: Model.buildView({ lang: root.lang, nowMs: Date.now(), location: root.location })
  property bool stale: false
  property string lastError: ""

  // Spread refreshes out after each Expires (MET asks for no synchronised
  // traffic). Fixed per session so it doesn't drift per tick.
  readonly property int refreshJitterMs: Model.jitterMs()
  // After a 429, requests to that service ("met" or "yr", Model.requestService)
  // pause until this time.
  property var backoffUntil: ({ met: 0, yr: 0 })
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
      // Later: `offline` (derived from connectivity) may not have caught up
      // yet in this handler, and would skip the fetch (e.g. after a wake).
      Qt.callLater(maybeFetch, false)
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

  // Both read `location` itself rather than hasLocation: they run from
  // onLocationChanged, where that derived value may not have caught up.
  function requestUrls() {
    if (!Model.hasCoordinates(location)) return null
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

  // Cached responses; lightning lives in memory (see lightningEntry).
  function entryFor(kind) {
    return kind === "lightning" ? lightningEntry : cache[kind]
  }

  function isDue(kind, url, now) {
    var entry = entryFor(kind)
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
    // Radar indexes and lightning: only polled while the radar is on screen.
    if (kind === "yrObs" || kind === "yrNow")
      return now >= Math.max(entry.expiresMs, entry.fetchedMs + 2 * 60000)
    if (kind === "lightning")
      return now >= Math.max(entry.expiresMs, entry.fetchedMs + 60000)
    return now >= Math.max(entry.expiresMs + refreshJitterMs, entry.fetchedMs + 5 * 60000)
  }

  // force: middle click / IPC refresh. Skips the Expires wait, but still
  // sends If-Modified-Since, so an unchanged forecast costs a 304.
  function maybeFetch(force) {
    if (!Model.hasCoordinates(location) || !cacheLoaded || offline) return
    var now = Date.now()
    var urls = requestUrls()
    if (now >= backoffUntil.met) {
      startFetch(forecastProc, "forecast", urls.forecast, force || isDue("forecast", urls.forecast, now))
      startFetch(sunProc, "sun", urls.sun, isDue("sun", urls.sun, now))
      startFetch(moonProc, "moon", urls.moon, isDue("moon", urls.moon, now))
      // A cached 422 (outside radar coverage) has an empty body; forcing won't change that.
      var nowcastCovered = !cache.nowcast || cache.nowcast.key !== urls.nowcast || cache.nowcast.body !== ""
      startFetch(nowcastProc, "nowcast", urls.nowcast, (force && nowcastCovered) || isDue("nowcast", urls.nowcast, now))
    }
    if (yrRadarActive && now >= backoffUntil.yr) {
      startFetch(yrObsProc, "yrObs", Model.YR_RADAR_OBS_INDEX, force || isDue("yrObs", Model.YR_RADAR_OBS_INDEX, now))
      startFetch(yrNowProc, "yrNow", Model.YR_RADAR_NOWCAST_INDEX, force || isDue("yrNow", Model.YR_RADAR_NOWCAST_INDEX, now))
      startFetch(lightningProc, "lightning", Model.YR_LIGHTNING_URL, force || isDue("lightning", Model.YR_LIGHTNING_URL, now))
      maybeDownloadYrTiles()
    }
  }

  function startFetch(proc, kind, url, due) {
    if (!due || proc.running) return
    var entry = entryFor(kind)
    var lastModified = entry && entry.key === url ? entry.lastModified : ""
    proc.url = url
    proc.command = Model.curlCommand(url, lastModified, kind === "forecast" ? 15 : 10, userAgent)
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
        || ((kind === "yrObs" || kind === "yrNow") && !Model.parseTileIndex(response.body).length)
        || (kind === "lightning" && !Model.parseLightning(response.body)))
      if (unreadable) {
        recordFailure(kind, url, "unreadable response")
      } else {
        var fallbackTtl = kind === "yrObs" || kind === "yrNow" || kind === "lightning" ? 60000
          : kind === "nowcast" ? 5 * 60000 : kind === "forecast" ? 30 * 60000 : 24 * 3600000
        var entry = Model.cacheEntryFromResponse(entryFor(kind), url, response, now, fallbackTtl)
        if (kind === "lightning") lightningEntry = entry
        else setCacheEntry(kind, entry)
        var cleared = Object.assign({}, failures)
        delete cleared[kind]
        failures = cleared
        if (kind === "forecast") lastError = ""
      }
    } else if (response.status === 422 && kind === "nowcast") {
      // Outside the Nordic radar area: remember that for a day.
      setCacheEntry(kind, { key: url, body: "", lastModified: "", expiresMs: now + 24 * 3600000, fetchedMs: now })
    } else if (response.status === 429) {
      var service = Model.requestService(kind)
      console.warn("nordic-weather: throttled by " + service + " (429), pausing its requests for 10 min")
      var next = Object.assign({}, backoffUntil)
      next[service] = now + 10 * 60000
      backoffUntil = next
      recordFailure(kind, url, "HTTP 429")
    } else {
      if (response.status === 403) console.warn("nordic-weather: 403 Forbidden for " + url)
      recordFailure(kind, url, response.status ? "HTTP " + response.status : "network error")
    }

    if (kind === "forecast" && current) finishSavingLocation()
    // An awaited radar index is answered only once it is stored: ended
    // earlier, the radar would briefly count as usable with the old index
    // and start loading from it.
    if ((kind === "yrObs" || kind === "yrNow") && yrAwaiting[kind]) {
      var awaiting = Object.assign({}, yrAwaiting)
      awaiting[kind] = false
      yrClockMs = now
      yrAwaiting = awaiting
    }
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
    geocodeProc.command = Model.geocodeCommand(geocodeActiveQuery, root.lang, root.userAgent)
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

  // ---------------------------------------------------------------- favourites

  // Model.parseFavorites; this plugin's own file, next to the shared
  // weather.json.
  readonly property string favoritesPath: Quickshell.env("HOME") + "/.local/state/omarchy/settings/nordic-weather-favorites.json"
  property var favorites: []

  function setFavorites(list) {
    favorites = list
    favoritesFile.setText(JSON.stringify(list, null, 2) + "\n")
  }

  // Star or unstar a search result (it keeps its description and elevation).
  function toggleFavorite(place) {
    setFavorites(Model.toggleFavorite(favorites, place))
  }

  function removeFavorite(key) {
    setFavorites(Model.removeFavorite(favorites, key))
  }

  // Next or previous favourite (IPC, for a keybind).
  function stepFavorite(step) {
    var next = Model.stepFavorite(favorites, location, step)
    if (next) pickSuggestion(next)
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

  // ---------------------------------------------------------------- radar

  // The radar side panel: yr.no's radar frames on our own base map. Only
  // downloaded and animated while some panel shows it.
  readonly property bool yrRadarActive: radarViewer !== null && hasLocation
  onYrRadarActiveChanged: if (yrRadarActive) {
    yrPlayhead = { frame: 0, tick: yrPlayhead.tick }
    yrPaused = false
    var now = Date.now()
    yrClockMs = now
    // Index refreshes due now are waited for before anything shows, so a
    // loop from before (minutes or a night ago) never plays first. Decided
    // before any request starts, so nothing loads from the old index.
    var canFetch = !offline && cacheLoaded && now >= backoffUntil.yr
    yrAwaiting = { yrObs: canFetch && yrIndexDue("yrObs", now), yrNow: canFetch && yrIndexDue("yrNow", now) }
    if (yrAwaiting.yrObs || yrAwaiting.yrNow) yrAwaitTimeout.restart()
    if (!yrRadarUsable) dropYrLoops()
    // Later: the map view derived from this panel may not have caught up.
    Qt.callLater(maybeFetch, false)
    Qt.callLater(maybeComposeYrFrames)
  }

  function yrIndexDue(kind, now) {
    return isDue(kind, kind === "yrObs" ? Model.YR_RADAR_OBS_INDEX : Model.YR_RADAR_NOWCAST_INDEX, now)
  }

  // Radar index refreshes awaited since the radar opened (see above). A
  // response of any kind ends the wait; so does the timeout, so a hung
  // request can't keep the radar empty.
  property var yrAwaiting: ({ yrObs: false, yrNow: false })
  Timer {
    id: yrAwaitTimeout
    interval: 8000
    onTriggered: root.yrAwaiting = { yrObs: false, yrNow: false }
  }
  // Wall-clock time for the radar's age check (Model.radarUsable), set on
  // opening, when an awaited index arrives and every minute.
  property double yrClockMs: Date.now()
  readonly property bool yrRadarUsable: Model.radarUsable(yrIndex, yrClockMs, yrAwaiting.yrObs || yrAwaiting.yrNow,
                                                            cache.yrObs ? cache.yrObs.fetchedMs : NaN)
  onYrRadarUsableChanged: if (!yrRadarUsable) dropYrLoops()

  // Also forgets what was assembled, so the loops are built again from
  // disk (instant where the frames are there) once the radar is usable:
  // the refreshed index is often the very same frames.
  function dropYrLoops() {
    yrShown = null
    yrPending = null
    yrComposedKey = ""
    yrComposedCount = 0
  }

  // Frames of a loop went missing on disk (e.g. cleaned up): drop the loops
  // built on them and check tiles and frames again, rather than hold on a
  // frame that can't load.
  function radarImagesFailed() {
    console.warn("nordic-weather: radar frame images missing, reloading them")
    dropYrLoops()
    yrRadarDoneKey = ""
    maybeDownloadYrTiles()
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

  // Lightning strikes (yr.no, polled while the radar is open). Kept in
  // memory only: it is short-lived, and the cache file is rewritten on
  // every change.
  property var lightningEntry: null
  readonly property var lightningStrikes: lightningEntry ? (Model.parseLightning(lightningEntry.body) || []) : []
  readonly property double lightningDataMs: lightningEntry ? lightningEntry.fetchedMs : 0
  // The newest radar observation's time: "now" on the map.
  readonly property double yrNowMs: yrDisplay.frames.length && yrDisplay.nowIndex >= 0
    ? yrDisplay.frames[yrDisplay.nowIndex].timeMs : 0

  // The radar indexes as cached, and what may be shown of them: nothing
  // while too old or while their refresh is awaited (yrRadarUsable).
  readonly property var yrIndex: Model.radarFrames(cache.yrObs ? cache.yrObs.body : "", cache.yrNow ? cache.yrNow.body : "")
  readonly property var yrRadar: yrRadarUsable ? yrIndex : ({ frames: [], nowIndex: -1 })
  // The map's real pixel size, from the panel showing it.
  readonly property int yrMapWidth: radarViewer ? radarViewer.width : 0
  readonly property int yrMapHeight: radarViewer ? radarViewer.height : 0
  readonly property var mapViewState: hasLocation
    ? Model.mapView(mapStep, location.latitude, location.longitude, yrMapWidth, yrMapHeight) : null
  readonly property var yrBaseTiles: mapViewState ? Model.viewTiles(mapViewState, yrMapWidth, yrMapHeight) : []
  readonly property var yrRadarTiles: mapViewState
    ? Model.viewTiles(Model.radarView(mapViewState), yrMapWidth, yrMapHeight) : []
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
  }

  // Scrubbing (the ruler on the map, or , and .): show a frame and pause.
  // Only frames that are downloaded can be shown.
  function seekFrame(index) {
    var n = Math.min(yrDisplay.frames.length, yrPlayLimit)
    if (n <= 0) return
    yrPlayhead = { frame: Math.max(0, Math.min(n - 1, index)), tick: yrPlayhead.tick }
    yrPaused = true
  }

  function stepFrame(delta) {
    seekFrame(Math.min(yrFrame, yrDisplay.frames.length - 1) + delta)
  }

  // The panel reports when the images for this exact loop and frame are
  // decoded; until then playback holds rather than skipping a frame. A loop
  // that only grew (more of the same frames assembled) keeps its token.
  readonly property string yrPresentationToken: (yrShownValid ? loopBase(yrShown) : "") + "|" + yrPlayhead.frame + "|" + yrPlayhead.tick
  property string yrReadyToken: ""
  property bool yrReadyImages: false
  readonly property bool yrImagesReady: yrReadyToken === yrPresentationToken && yrReadyImages

  function radarImagesPrepared(token, ready) {
    if (token !== yrPresentationToken) return
    yrReadyToken = token
    yrReadyImages = ready
  }

  // Identifies the full tile set: the map view (which tiles) and every
  // frame (Model.radarFrameId). Nothing shows until the first batch of
  // frames is assembled; it then plays from the loop's start (a still of
  // the newest frame first would jump back 1½ h once playback began).
  readonly property string yrRadarKey: yrRadar.frames.length && yrViewKey !== "" && yrRadarTiles.length
    ? yrViewKey + "|" + Model.radarFramesKey(yrRadar.frames) : ""
  // Later, not at once: the key changes while other values derived from
  // the same index (yrRadar, …) may still hold the old ones.
  onYrRadarKeyChanged: {
    yrRetry.stop()
    yrRetryCount = 0
    Qt.callLater(maybeDownloadYrTiles)
    Qt.callLater(maybeComposeYrFrames)
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

  // Published loops are immutable. A complete loop replacing a working one
  // is published at a frame boundary. On a first open or new zoom nothing
  // works yet, so frames are assembled batch by batch as their tiles
  // arrive and play as they come: a partial loop, of which the first
  // `ready` frames are assembled; playback waits on the newest until the
  // next batch extends it.
  property var yrShown: null
  property var yrPending: null
  readonly property bool yrShownValid: yrShown !== null && yrShown.viewKey === yrViewKey
  readonly property var yrDisplay: yrShownValid ? yrShown : yrRadar
  readonly property var yrImageLoop: yrShownValid ? yrShown : null
  readonly property int yrPlayLimit: yrShownValid ? loopReady(yrShown) : 0
  readonly property bool yrPlaying: yrShownValid && yrPlayLimit > 1
  readonly property var yrCurrentFrame: yrShownValid ? yrShown.frames[Math.min(yrFrame, yrPlayLimit - 1)] : null

  function loopReady(loop) {
    return loop.ready === undefined ? loop.frames.length : loop.ready
  }

  function loopBase(loop) {
    return loop.base || loop.key
  }

  function publishYrLoop(boundary, nextFrame) {
    var loop = yrPending
    if (!loop || loop.viewKey !== yrViewKey) return false
    // A complete loop on screen changes only at a frame boundary; a partial
    // one at once, since it may be waiting on its newest frame.
    if (yrShownValid && !yrShown.partial && yrShown.frames.length > 1 && !boundary) return false
    // The same frames, more of them assembled: nothing on screen changes,
    // playback just has more to go on. New data: carry on at the same
    // time, not back at the start.
    var grown = yrShownValid && loopBase(yrShown) === loopBase(loop)
    var frame = 0
    if (yrShownValid) {
      var at = Math.min(nextFrame === undefined ? yrFrame : nextFrame, yrShown.frames.length - 1)
      frame = grown ? at : Model.radarFrameAt(loop.frames, yrShown.frames[at].timeMs)
      frame = Math.min(frame, loopReady(loop) - 1)
    }
    yrShown = loop
    yrPending = null
    if (!grown || frame !== yrFrame) yrPlayhead = { frame: frame, tick: yrPlayhead.tick + 1 }
    return true
  }

  // Pre-assembled frames (Model.frameComposeCommand): each frame becomes
  // one map-sized image, so playback decodes one image per frame instead of
  // 20–25 tiles. Assembled in download order, as batches arrive, while
  // nothing complete of this view is on screen; otherwise once all of a
  // loop's tiles are there.
  readonly property string yrViewKey: Model.mapViewKey(mapViewState, yrMapWidth, yrMapHeight)
  // How many frames (a prefix) of the loop yrComposedKey are assembled.
  property string yrComposedKey: ""
  property int yrComposedCount: 0

  function maybeComposeYrFrames() {
    if (!yrRadarActive || yrViewKey === "" || yrFramesProc.running) return
    var n = yrRadar.frames.length
    var composed = yrComposedKey === yrRadarKey ? yrComposedCount : 0
    var progressive = !(yrShownValid && !yrShown.partial)
    var ready = yrRadarReadyCount >= n ? n : progressive ? yrRadarReadyCount : 0
    if (ready === 0 || ready <= composed) return
    var key = yrRadarKey + (ready < n ? "|" + ready : "")
    var rv = Model.radarView(mapViewState)
    yrFramesProc.key = key
    yrFramesProc.loop = { frames: yrRadar.frames, ready: ready, partial: ready < n, base: yrRadarKey,
                         nowIndex: yrRadar.nowIndex, viewKey: yrViewKey, key: key }
    yrFramesProc.command = Model.frameComposeCommand(tilesDir, yrMapWidth, yrMapHeight, rv.px,
      Model.frameComposeSpecs(yrRadarTiles, yrRadar.frames.slice(0, ready), yrViewKey))
    yrFramesProc.running = true
  }

  function maybeDownloadYrTiles() {
    if (!yrRadarActive || yrRadarKey === "" || !yrRadar.frames.length || yrRadarProc.running || yrRetry.running
        || Date.now() < backoffUntil.yr) return
    if (yrRadarReadyCount < yrRadar.frames.length) {
      var from = yrRadarReadyCount
      var to = Math.min(yrRadar.frames.length, from + yrBatchFrames)
      yrRadarProc.key = yrRadarKey
      yrRadarProc.upTo = to
      yrRadarProc.command = Model.tileDownloadCommand(tilesDir, Model.radarDownloads(yrRadarTiles, yrRadar.frames.slice(from, to)), userAgent)
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
    // Switch to the next or previous favourite place.
    function favorite(direction: string): void { root.stepFavorite(direction === "previous" ? -1 : 1) }
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

  FileView {
    id: favoritesFile
    path: root.favoritesPath
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.favorites = Model.parseFavorites(text())
  }

  Process {
    id: mkdirProc
    // The settings folder too, for the favourites file.
    command: ["mkdir", "-p", root.cacheDir, Quickshell.env("HOME") + "/.local/state/omarchy/settings"]
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
  FetchProcess { id: yrObsProc; kind: "yrObs" }
  FetchProcess { id: yrNowProc; kind: "yrNow" }
  FetchProcess { id: lightningProc; kind: "lightning" }

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
      if (!ok || missing > 0) {
        root.yrRetryCount++
        yrRetry.restart()
      } else {
        root.yrRetryCount = 0
        Qt.callLater(root.maybeComposeYrFrames)
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
      if (ok && made === total) {
        root.yrComposedKey = loop.base
        root.yrComposedCount = loop.ready
        // A partial loop only stands in while nothing complete plays.
        if (loop.viewKey === root.yrViewKey && (!loop.partial || !(root.yrShownValid && !root.yrShown.partial))) {
          root.yrPending = loop
          root.publishYrLoop(false)
        }
      } else if (loop.base === root.yrRadarKey) {
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
      root.yrClockMs = Date.now()
      root.rebuild()
      root.maybeFetch(false)
    }
  }

  // The radar animation (one frame counter for every panel): one frame per
  // tick, 250 ms each. A frame whose images are still decoding holds
  // instead of being skipped.
  Timer {
    interval: 250
    repeat: true
    running: root.yrRadarActive && root.yrPlaying && !root.yrPaused
    onTriggered: {
      if (!root.yrImagesReady) return
      var next = Model.radarStep(root.yrFrame, root.yrPlayhead.tick, root.yrShown.frames.length, root.yrPlayLimit)
      if (next.tick === root.yrPlayhead.tick) return
      if (root.publishYrLoop(true, next.frame)) return
      root.yrPlayhead = next
    }
  }
}
