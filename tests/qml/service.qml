import QtQuick
import Quickshell
import "." as Weather

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
      return { time: new Date(test.base + t).toISOString(), tiles: { png: "https://invalid.test/{z}/{x}/{y}.png" } }
    }) }), fetchedMs: fetchedMs === undefined ? Date.now() : fetchedMs } })
    service.maybeComposeYrFrames()
  }

  function step() {
    if (Date.now() - started > 15000) throw new Error("timeout at stage " + stage)
    if (stage === 0 && service.cacheLoaded) {
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
        return { time: new Date(test.base + t).toISOString(), tiles: { png: "https://invalid.test/{z}/{x}/{y}.png" } }
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
      service.radarImagesFailed("vanished")
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
