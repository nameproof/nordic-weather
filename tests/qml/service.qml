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
  property int savedSequence: 0
  property string firstAtlas: ""

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
    blend: service.yrBlend
    directory: service.tilesDir
    token: service.yrPresentationToken
    useFlow: true
    onPrepared: function(token, ready) { service.radarImagesPrepared(token, ready) }
  }

  function check(ok, description) {
    if (!ok) throw new Error(description)
  }
  function next() { stage++; since = Date.now() }
  function loop(key, times) {
    return { key: key, viewKey: service.yrViewKey, width: 256, height: 192, nowIndex: 0, flow: null,
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
      service.cache = { prefs: { radarSource: "yr", radarSmoothing: "flow", radarFps: 12, mapStep: 1 } }
      viewer(true)
      service.yrPending = loop("first", [0, 300000, 600000])
      next()
    } else if (stage === 1 && service.yrShown && service.yrShown.flow && service.yrImagesReady && service.yrPhaseMs > 0) {
      firstAtlas = service.yrShown.flow.file
      check(service.yrShown.flow.knownCells > 0, "worker must find motion")
      service.togglePause()
      savedPhase = service.yrPhaseMs
      savedFrame = service.yrFrame
      next()
    } else if (stage === 2 && Date.now() - since > 200) {
      check(service.yrPhaseMs === savedPhase && service.yrFrame === savedFrame, "pause must freeze interpolation")
      service.seekFrame(1)
      check(service.yrPhaseMs === 0 && service.yrPaused, "seek must select a source frame")
      service.yrPending = loop("second", [300000, 600000, 900000])
      next()
    } else if (stage === 3 && service.yrPending && service.yrPending.flow) {
      check(service.yrShown.key === "first", "paused loop must not be replaced")
      check(service.yrPending.flow.file !== firstAtlas, "pending atlas must not overwrite the active atlas")
      service.togglePause()
      next()
    } else if (stage === 4 && service.yrShown.key === "second" && service.yrImagesReady) {
      savedSequence = service.yrFlowSequence
      savedFrame = service.yrFrame
      savedPhase = service.yrPhaseMs
      viewer(false)
      next()
    } else if (stage === 5 && Date.now() - since > 200) {
      check(service.yrFrame === savedFrame && service.yrPhaseMs === savedPhase, "closed radar must not animate")
      viewer(true)
      next()
    } else if (stage === 6 && service.yrImagesReady) {
      check(service.yrFlowSequence === savedSequence, "reopening should reuse the prepared loop")
      service.yrPending = loop("single", [300000])
      service.publishYrLoop(true)
      next()
    } else if (stage === 7 && Date.now() - since > 100) {
      check(service.yrFlowSequence === savedSequence && service.yrFlowBusy === "", "one frame must not start flow work")
      service.yrPending = loop("bad", [9900000, 10200000])
      next()
    } else if (stage === 8 && service.yrFlowFailure.attempts === 1 && !service.yrFlowWorking) {
      next()
    } else if (stage === 9 && Date.now() - since > 200) {
      check(service.yrFlowFailure.attempts === 1, "failure must back off")
      service.yrFlowFailure = { key: "bad", attempts: 1, nextMs: 0 }
      service.maybeEstimateFlow()
      next()
    } else if (stage === 10 && service.yrFlowFailure.attempts === 2 && !service.yrFlowWorking) {
      service.yrFlowFailure = { key: "bad", attempts: 2, nextMs: 0 }
      service.maybeEstimateFlow()
      next()
    } else if (stage === 11 && service.yrFlowFailure.attempts === 3 && !service.yrFlowWorking) {
      next()
    } else if (stage === 12 && Date.now() - since > 200) {
      check(service.yrFlowFailure.attempts === 3 && service.yrFlowBusy === "", "retries must stop after three failures")
      index([1200000, 1500000])
      next()
    } else if (stage === 13 && service.yrPreviewValid && images.ready) {
      check(!service.yrPlaying && service.yrCurrentFrame.timeMs === 1500000, "show the assembled observation until frames can play")
      // The first batch arrives: it is assembled and shown at once.
      service.yrRadarDoneKey = service.yrRadarKey
      service.yrRadarDoneCount = 1
      service.maybeComposeYrFrames()
      next()
    } else if (stage === 14 && service.yrShownValid && service.yrShown.partial && service.yrImagesReady) {
      check(service.yrPlayLimit === 1 && !service.yrShown.flow, "a partial loop plays what is assembled, without flow")
      service.yrRadarDoneCount = 2
      service.maybeComposeYrFrames()
      next()
    } else if (stage === 15 && service.yrShownValid && !service.yrShown.partial && service.yrShown.flow && service.yrImagesReady) {
      check(service.yrShown.frames.length === 2 && service.yrPlayLimit === 2, "the complete loop, with flow, replaces the partial one")
      index([1800000])
      next()
    } else if (stage === 16 && service.yrRetryCount === 1) {
      next()
    } else if (stage === 17 && Date.now() - since > 200) {
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
