import QtQuick
import Quickshell
import "." as Weather
import "Model.js" as Model

Scope {
  id: test
  property int stage: 0
  property double started: Date.now()
  property double since: Date.now()
  property int savedFrame: 0
  property int savedTick: 0
  property var savedSet: null
  property var seenKeys: []
  property var downloadChecks: []
  // Index times are offsets from here (set by service.test.js, which also
  // names the tile files), so the newest observation is recent: older radar
  // isn't shown (Model.radarUsable).
  property double base: Number(Quickshell.env("RADAR_TEST_BASE"))

  // Exercise the actual service, processes and worker without network
  // requests or changing the user's location/settings.
  Weather.Service {
    id: service
    location: ({ name: "Test", latitude: 57.93, longitude: 12.53 })
    function maybeFetch(force) {}
    function yrIndexDue(kind, now) { return false }
    // Records whether the index's frames are known when downloads are
    // checked (no downloads run in the test).
    function maybeDownloadYrTiles() { if (yrRadarKey !== "") test.downloadChecks.push(yrRadar.frames.length > 0) }
    function setLocationIfChanged(next) {}
    function detectLocation() {}
  }
  Connections {
    target: service
    function onYrRadarKeyChanged() { if (service.yrRadarKey !== "") test.seenKeys.push(service.yrRadarKey) }
  }
  Weather.RadarImages {
    id: images
    loop: service.yrImageLoop
    playhead: service.yrShownValid ? service.yrPlayhead : ({ frame: 0, tick: 0 })
    directory: service.tilesDir
    token: service.yrPresentationToken
    onPrepared: function(token, ready) { service.radarImagesPrepared(token, ready) }
  }

  function check(ok, description) {
    if (!ok) throw new Error(description)
  }
  function next() { stage++; since = Date.now() }
  function loop(key, times) {
    return { key: key, viewKey: service.yrViewKey, nowIndex: 0,
             frames: times.map(function(t) { return { timeMs: t, runId: "", forecast: false } }) }
  }
  function viewer(open) { service.updateViewer("test", { open: open, radarOpen: open, width: 256, height: 192 }) }
  // fetchedMs: when our copy was fetched (now unless given).
  function index(times, fetchedMs) {
    service.yrShown = null
    service.yrPending = null
    service.cache = Object.assign({}, service.cache, { yrObs: { body: JSON.stringify({ times: times.map(function(t) {
      return { time: new Date(test.base + t).toISOString(), tiles: { png: "https://tiles.yr.no/test/{z}/{x}/{y}.png" } }
    }) }), fetchedMs: fetchedMs === undefined ? Date.now() : fetchedMs } })
    service.maybeComposeYrFrames()
  }

  function securityChecks() {
    var urls = service.requestUrls()
    var ok = "HTTP/2 200\r\ncontent-type: application/json\r\n\r\n"
    // Polar night and a moon that never sets, as MET sends them.
    var bodies = {
      sun: '{"properties":{"body":"Sun","sunrise":{"time":null,"azimuth":null},"sunset":{"time":null,"azimuth":null}}}',
      moon: '{"properties":{"body":"Moon","moonrise":{"time":null,"azimuth":null},"moonset":{"time":null,"azimuth":null},'
        + '"high_moon":{"time":"2026-12-21T21:37+01:00","disc_centre_elevation":35.82,"visible":true},"moonphase":136.57}}'
    }
    for (var kind in bodies) {
      service.handleResponse(kind, urls[kind], ok + bodies[kind])
      var previous = service.cache[kind]
      check(previous && previous.body === bodies[kind], kind + ": valid polar response is cached")
      for (var bad of ["<html>", "{}", '{"properties":{}}']) {
        service.handleResponse(kind, urls[kind], ok + bad)
        check(service.cache[kind] === previous, kind + ": malformed response must preserve good cache")
        check(service.failures[kind].count > 0, kind + ": malformed response backs off")
      }
      service.handleResponse(kind, urls[kind], "HTTP/2 304\r\n\r\n")
      check(service.cache[kind].body === bodies[kind], kind + ": 304 keeps validated data")
      check(!service.failures[kind], kind + ": successful refresh clears failures")
    }
    // Forecast and nowcast: only usable bodies replace what is stored, and
    // a later good response recovers.
    var hour = 3600000, t0 = Math.floor(Date.now() / hour) * hour
    // Forecasts in hours, nowcasts (meta given) in 5-minute steps from now.
    var series = function(count, details, symbol, meta) {
      var step = meta ? 300000 : hour, start = meta ? Math.floor(Date.now() / step) * step : t0
      var steps = []
      for (var s = 0; s < count; s++) steps.push({ time: new Date(start + s * step).toISOString(), data: {
        instant: { details: details }, next_1_hours: { summary: { symbol_code: symbol }, details: {} } } })
      return JSON.stringify({ properties: { meta: meta || {}, timeseries: steps } })
    }
    var timeseries = {
      forecast: [series(6, { air_temperature: 4 }, "cloudy"), series(6, { air_temperature: 7 }, "rain\u2028_day")],
      nowcast: [series(4, { precipitation_rate: 0 }, "cloudy", { radar_coverage: "ok" }),
                series(4, { precipitation_rate: 0.4 }, "rain", { radar_coverage: "ok" })]
    }
    var unusable = {
      forecast: ['{"properties":{"timeseries":[]}}', series(3, {}, "cloudy")],
      nowcast: [series(4, {}, "cloudy", { radar_coverage: "ok" }), series(4, { precipitation_rate: 0 }, "cloudy", {})]
    }
    for (var tk in timeseries) {
      service.handleResponse(tk, urls[tk], ok + timeseries[tk][0])
      var stored = service.cache[tk]
      check(stored && stored.body === timeseries[tk][0], tk + ": usable response is cached")
      for (var u = 0; u < unusable[tk].length; u++) {
        service.handleResponse(tk, urls[tk], ok + unusable[tk][u])
        check(service.cache[tk] === stored, tk + ": unusable response must preserve good cache")
        check(service.failures[tk].count > 0, tk + ": unusable response backs off")
      }
      check(service.view.ready, tk + ": the view stays ready")
      service.cache = Object.assign({}, service.cache, (function() { var o = {}; o[tk] = undefined; return o })())
      service.failures = ({})
      service.handleResponse(tk, urls[tk], "HTTP/2 304\r\n\r\n")
      check(service.cache[tk] === undefined && service.failures[tk].count > 0, tk + ": 304 with nothing stored is a failure")
      service.handleResponse(tk, urls[tk], ok + timeseries[tk][1])
      check(service.cache[tk].body === timeseries[tk][1] && !service.failures[tk], tk + ": a later usable response recovers")
    }
    check(service.view.ready && typeof service.view.current.description === "string", "a line separator in a symbol is harmless")
    // A warning 304 with nothing stored for the request is a failure, and no
    // Expires holds off the next check for more than a day.
    service.warnStore = ({})
    service.failures = ({})
    service.handleWarningResponse("warnSmhi", Model.SMHI_WARNINGS_URL, "HTTP/2 304\r\nexpires: Fri, 31 Dec 9999 23:59:59 GMT\r\n\r\n")
    check(service.failures.warnSmhi && !service.warnChecked.warnSmhi, "warning 304 without a stored source is a failure")
    service.warnStore = ({ smhi: { key: Model.SMHI_WARNINGS_URL, etag: "", lastModified: "", warnings: [] } })
    service.handleWarningResponse("warnSmhi", Model.SMHI_WARNINGS_URL, "HTTP/2 304\r\nexpires: Fri, 31 Dec 2099 23:59:59 GMT\r\n\r\n")
    check(service.warnChecked.warnSmhi && service.warnChecked.warnSmhi.expiresMs <= Date.now() + 24 * 3600000 + 1000,
          "warning checks expire within a day")
    service.warnStore = ({})
    service.warnChecked = ({})
    service.cache = {}

    var events = []
    for (var i = 0; i < 12000; i++) events.push([Date.now() / 1000 - i / 2, 12, 58])
    var lightningBody = JSON.stringify({ historicalData: JSON.stringify(events) })
    service.handleResponse("lightning", urls.lightning, ok + lightningBody)
    check(service.lightningStrikes.length === 8192, "lightning geometry is bounded")
    check(service.lightningStrikes === service.lightningEntry.strikes, "lightning reuses its validation parse")
    var strikes = service.lightningStrikes
    service.handleResponse("lightning", urls.lightning, "HTTP/2 304\r\n\r\n")
    check(service.lightningStrikes === strikes, "lightning 304 reuses geometry")
    service.lightningEntry = null
    console.log("SECURITY_SERVICE_PASS")
  }

  function step() {
    if (Date.now() - started > 15000) throw new Error("timeout at stage " + stage)
    if (stage === 0 && service.cacheLoaded && service.cacheReady) {
      securityChecks()
      service.cache = { prefs: { mapStep: 1 } }
      viewer(true)
      service.yrPending = loop("first", [0, 300000, 600000])
      check(service.publishYrLoop(false), "nothing on screen: publish at once")
      next()
    } else if (stage === 1 && service.yrShownValid && service.yrImagesReady && service.yrPlayhead.tick > 1) {
      service.togglePause()
      savedFrame = service.yrFrame
      next()
    } else if (stage === 2 && Date.now() - since > 300) {
      check(service.yrFrame === savedFrame, "pause must hold the frame")
      service.seekFrame(1)
      check(service.yrFrame === 1 && service.yrPaused, "seek must select a frame and stay paused")
      service.yrPending = loop("second", [300000, 600000, 900000])
      check(!service.publishYrLoop(false), "a loop on screen is only replaced at a frame boundary")
      service.togglePause()
      next()
    } else if (stage === 3 && service.yrShown.key === "second" && service.yrImagesReady) {
      // Replaced at the step from 5 min (frame 1 of the first loop) to
      // 10 min: the second loop carries on at 10 min or later, not at 5.
      check(service.yrCurrentFrame.timeMs >= 600000, "a new loop carries on at the same time")
      savedFrame = service.yrFrame
      savedTick = service.yrPlayhead.tick
      viewer(false)
      next()
    } else if (stage === 4 && Date.now() - since > 300) {
      check(service.yrFrame === savedFrame && service.yrPlayhead.tick === savedTick, "closed radar must not animate")
      viewer(true)
      index([1200000, 1500000])
      next()
    } else if (stage === 5 && Date.now() - since > 200) {
      // Nothing shows before the first frames are assembled (no still of
      // the newest frame that playback would then jump back from).
      check(!service.yrShownValid && service.yrImageLoop === null && service.yrCurrentFrame === null,
        "nothing shows until the first frames are assembled")
      // The first batch arrives: it is assembled and shown at once.
      service.yrRadarDoneKey = service.yrRadarKey
      service.yrRadarDoneCount = 1
      service.maybeComposeYrFrames()
      next()
    } else if (stage === 6 && service.yrShownValid && service.yrShown.partial && service.yrImagesReady) {
      check(service.yrPlayLimit === 1, "a partial loop plays what is assembled")
      savedSet = images.front
      savedTick = service.yrPlayhead.tick
      service.yrRadarDoneCount = 2
      service.maybeComposeYrFrames()
      next()
    } else if (stage === 7 && service.yrShownValid && !service.yrShown.partial && service.yrImagesReady) {
      check(service.yrShown.frames.length === 2 && service.yrPlayLimit === 2, "the complete loop replaces the partial one")
      check(images.front === savedSet, "a loop that only grew keeps its images")
      // Opening with an index refresh under way drops the loop; the refresh
      // brings the very same frames: the loop must come back, not stay empty.
      service.yrAwaiting = { yrObs: true, yrNow: false }
      check(!service.yrShownValid, "no loop while the refresh is awaited")
      service.yrAwaiting = { yrObs: false, yrNow: false }
      next()
    } else if (stage === 8 && service.yrShownValid && !service.yrShown.partial && service.yrImagesReady) {
      // The awaited refresh arrives with a newer index: the radar goes from
      // waiting straight to the new frames, never loading from the old ones
      // on the way (their first frame is at 20 min).
      seenKeys = []
      downloadChecks = []
      service.yrAwaiting = { yrObs: true, yrNow: false }
      var body = JSON.stringify({ times: [1500000, 1800000].map(function(t) {
        return { time: new Date(test.base + t).toISOString(), tiles: { png: "https://tiles.yr.no/test/{z}/{x}/{y}.png" } }
      }) })
      service.handleResponse("yrObs", "https://invalid.test/available.json", "HTTP/2 200\r\ncontent-type: application/json\r\n\r\n" + body)
      check(service.yrRadarUsable, "the stored refresh ends the wait")
      check(seenKeys.length > 0 && seenKeys.every(function(k) { return k.indexOf(String(test.base + 1200000)) < 0 }),
        "nothing loads from the old index while the refresh arrives")
      next()
    } else if (stage === 9 && downloadChecks.length > 0) {
      check(downloadChecks.every(function(known) { return known }), "downloads start with the new index's frames")
      // A frame whose tiles are gone after its batch was counted: assembly
      // fails, backs off and checks the tiles again.
      index([1800000])
      service.yrRadarDoneKey = service.yrRadarKey
      service.yrRadarDoneCount = 1
      service.maybeComposeYrFrames()
      next()
    } else if (stage === 10 && service.yrRetryCount === 1) {
      next()
    } else if (stage === 11 && Date.now() - since > 200) {
      check(service.yrRetryCount === 1 && service.yrRadarDoneKey === "", "failed assembly must back off and recheck its tiles")
      // Radar from hours ago (the computer slept): a loop left in memory
      // isn't played when the radar opens, and nothing is shown of it.
      index([-10800000, -10500000], Date.now() - 10800000)
      service.yrShown = loop("last night", [0, 300000])
      viewer(false)
      viewer(true)
      check(!service.yrRadarUsable && service.yrRadar.frames.length === 0, "old radar is not shown")
      check(!service.yrShownValid && service.yrImageLoop === null, "a loop from before isn't played on opening")
      // Frames that vanish from disk: the loop is dropped and tiles and
      // frames are checked again, instead of holding on a frame forever.
      service.yrShown = loop("vanished", [0, 300000])
      service.yrRadarDoneKey = "done"
      service.radarImagesFailed()
      check(!service.yrShownValid && service.yrRadarDoneKey === "",
        "missing frames reload instead of freezing")
      console.log("RADAR_SERVICE_PASS")
      Qt.quit()
    }
  }
  Timer {
    interval: 10
    running: true
    repeat: true
    onTriggered: {
      try { test.step() } catch (error) {
        console.error("RADAR_SERVICE_FAIL " + error)
        Qt.quit()
      }
    }
  }
}
