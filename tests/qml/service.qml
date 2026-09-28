import QtQuick
import Quickshell
import "." as Weather

Scope {
  id: test
  property int stage: 0
  property double started: Date.now()
  property double since: Date.now()
  property real savedPhase: 0
  property int savedFrame: 0

  // Exercise the actual service, processes and worker without network
  // requests or changing the user's location/settings.
  Weather.Service {
    id: service
    location: ({ name: "Test", latitude: 57.93, longitude: 12.53 })
    function maybeFetch(force) {}
    function maybeDownloadYrTiles() {}
    function setLocationIfChanged(next) {}
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
  function index(times) {
    service.yrShown = null
    service.yrPending = null
    service.yrPreview = null
    service.cache = Object.assign({}, service.cache, { yrObs: { body: JSON.stringify({ times: times.map(function(t) {
      return { time: new Date(t).toISOString(), tiles: { png: "https://invalid.test/{z}/{x}/{y}.png" } }
    }) }) } })
    service.yrRadarNowDoneKey = service.yrRadarKey
    service.maybeComposeYrFrames()
  }

  function step() {
    if (Date.now() - started > 15000) throw new Error("timeout at stage " + stage)
    if (stage === 0 && service.cacheLoaded) {
      service.cache = { prefs: { radarSource: "yr", mapStep: 1 } }
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
      savedPhase = service.yrPhaseMs
      viewer(false)
      next()
    } else if (stage === 4 && Date.now() - since > 300) {
      check(service.yrFrame === savedFrame && service.yrPhaseMs === savedPhase, "closed radar must not animate")
      viewer(true)
      index([1200000, 1500000])
      next()
    } else if (stage === 5 && service.yrPreviewValid && images.ready) {
      check(!service.yrPlaying && service.yrCurrentFrame.timeMs === 1500000, "show the assembled observation until frames can play")
      // The first batch arrives: it is assembled and shown at once.
      service.yrRadarDoneKey = service.yrRadarKey
      service.yrRadarDoneCount = 1
      service.maybeComposeYrFrames()
      next()
    } else if (stage === 6 && service.yrShownValid && service.yrShown.partial && service.yrImagesReady) {
      check(service.yrPlayLimit === 1, "a partial loop plays what is assembled")
      service.yrRadarDoneCount = 2
      service.maybeComposeYrFrames()
      next()
    } else if (stage === 7 && service.yrShownValid && !service.yrShown.partial && service.yrImagesReady) {
      check(service.yrShown.frames.length === 2 && service.yrPlayLimit === 2, "the complete loop replaces the partial one")
      index([1800000])
      next()
    } else if (stage === 8 && service.yrRetryCount === 1) {
      next()
    } else if (stage === 9 && Date.now() - since > 200) {
      check(service.yrRetryCount === 1 && service.yrRadarNowDoneKey === "", "failed preview must back off and recheck its tiles")
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
