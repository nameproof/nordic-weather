import QtQuick
import Quickshell
import "." as Weather

Scope {
  id: test
  property double started: Date.now()
  Weather.Service {
    id: service
    location: ({ name: "Test", latitude: 58, longitude: 12 })
    function maybeFetch(force) {}
    function setLocationIfChanged(next) {}
  }
  Timer {
    interval: 50
    running: true
    repeat: true
    onTriggered: {
      if (Date.now() - test.started > 3000) {
        console.error("CACHE_GUARD_FAIL: setup did not settle")
        Qt.exit(1)
      }
      if (!service.cacheLoaded) return
      try {
        if (service.cacheReady || Object.keys(service.cache).length)
          throw new Error("refused cache must never be read")
        service.updateViewer("test", { open: true, radarOpen: true, width: 256, height: 192 })
        if (service.yrRadarActive) throw new Error("refused cache must not start radar work")
        service.setPref("mapStep", 2)
        var url = service.requestUrls().sun
        service.handleResponse("sun", url, 'HTTP/2 200\r\n\r\n{"properties":{"sunrise":{"time":null},"sunset":{"time":null}}}')
        if (!service.cache.sun) throw new Error("weather must still work in memory")
        console.log("CACHE_GUARD_PASS")
        Qt.exit(0)
      } catch (error) {
        console.error("CACHE_GUARD_FAIL: " + error)
        Qt.exit(1)
      }
    }
  }
}
