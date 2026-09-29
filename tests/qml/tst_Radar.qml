import QtQuick
import QtTest
import "../.." as Weather

Item {
  width: 100
  height: 100

  TestCase {
    id: tests
    name: "Radar"
    when: windowShown
    property string directory: Qt.resolvedUrl("frames").toString().replace(/^file:\/\//, "")

    Component { id: imagesComponent; Weather.RadarImages {} }
    Component { id: spyComponent; SignalSpy {} }

    function loop(key, times) {
      return { key: key, viewKey: "test", nowIndex: 0, frames: times.map(function(t) { return { timeMs: t } }) }
    }

    function makeImages(data) {
      return createTemporaryObject(imagesComponent, tests, { directory: directory, loop: data })
    }

    function test_rotating_images() {
      var buffers = makeImages(loop("a", [0, 1, 2, 3, 4]))
      verify(buffers !== null)
      tryCompare(buffers, "ready", true)
      var decoded = buffers.upcoming
      var source = decoded.source
      buffers.playhead = { frame: 1, tick: 1 }
      tryCompare(buffers, "ready", true)
      compare(buffers.current, decoded)
      compare(buffers.current.source, source)
      for (var tick = 2; tick <= 7; tick++) {
        buffers.playhead = { frame: tick % 5, tick: tick }
        tryCompare(buffers, "ready", true)
        verify(String(buffers.current.source).endsWith("f_" + tick % 5 + "_test.png"))
      }
    }

    // A step reaches the drawing at once, in the same update as the ruler
    // and the time label: no waiting, the next drawing shows frame 1.
    function test_step_reaches_the_drawing_at_once() {
      var buffers = makeImages(loop("b", [0, 1, 2, 3, 4]))
      tryCompare(buffers, "ready", true)
      var next = buffers.upcoming
      buffers.playhead = { frame: 1, tick: 1 }
      compare(buffers.current, next)
      verify(String(buffers.current.source).endsWith("f_1_test.png"))
    }

    // No-coverage comes from the loop's latest observation, whatever frame
    // is on screen.
    function test_coverage_from_the_latest_observation() {
      var data = loop("c", [0, 1, 2, 3])
      data.nowIndex = 2
      var buffers = makeImages(data)
      tryCompare(buffers, "ready", true)
      tryVerify(function() { return String(buffers.coverage.source).endsWith("f_2_test.png") })
      buffers.playhead = { frame: 3, tick: 1 }
      verify(String(buffers.coverage.source).endsWith("f_2_test.png"))
    }

    function test_replacement_keeps_old_textures_until_ready() {
      var first = loop("first", [0, 1, 2])
      var buffers = makeImages(first)
      tryCompare(buffers, "ready", true)
      var current = buffers.current
      var upcoming = buffers.upcoming
      ignoreWarning(/.*Cannot open:.*f_99_test.png/)
      buffers.loop = loop("missing", [3, 99])
      tryVerify(function() { return buffers.staging !== null })
      wait(30)
      compare(buffers.ready, false)
      compare(buffers.current, current)
      compare(buffers.upcoming, upcoming)
      compare(buffers.front.loop.key, "first")
      buffers.loop = first
      tryCompare(buffers, "ready", true)
      tryCompare(buffers, "staging", null)
      compare(buffers.current, current)
      buffers.loop = loop("complete", [3, 4])
      tryCompare(buffers, "ready", true)
      compare(buffers.front.loop.key, "complete")
      verify(String(buffers.current.source).endsWith("f_3_test.png"))
      compare(buffers.staging, null)
    }

    // More of the same frames assembled: the same images carry on, nothing
    // is staged or decoded again, and readiness never lapses.
    function test_grown_loop_keeps_its_images() {
      var partial = { key: "g|2", base: "g", viewKey: "test", nowIndex: 0, ready: 2,
                      frames: [0, 1, 2, 3, 4].map(function(t) { return { timeMs: t } }) }
      var buffers = makeImages(partial)
      tryCompare(buffers, "ready", true)
      var set = buffers.front, current = buffers.current
      buffers.loop = Object.assign({}, partial, { key: "g|4", ready: 4 })
      compare(buffers.front, set)
      compare(buffers.current, current)
      compare(buffers.staging, null)
      compare(buffers.ready, true)
      wait(50)
      compare(buffers.front, set)
      compare(buffers.staging, null)
    }

    // A loop still being assembled takes coverage from its newest assembled
    // frame until its latest observation is there, then switches to it.
    function test_coverage_while_assembling() {
      var partial = { key: "p|2", base: "p", viewKey: "test", nowIndex: 3, ready: 2,
                      frames: [0, 1, 2, 3, 4].map(function(t) { return { timeMs: t } }) }
      var buffers = makeImages(partial)
      tryCompare(buffers, "ready", true)
      tryVerify(function() { return String(buffers.coverage.source).endsWith("f_1_test.png") })
      buffers.loop = Object.assign({}, partial, { key: "p", ready: 5 })
      tryVerify(function() { return String(buffers.coverage.source).endsWith("f_3_test.png") })
      tryCompare(buffers.coverage, "status", Image.Ready)
    }

    // A frame whose file is gone (cleaned from the cache) is reported, so
    // the service can reload instead of holding on it.
    function test_missing_frame_is_reported() {
      ignoreWarning(/.*Cannot open:.*f_98_test.png/)
      var buffers = makeImages(loop("gone", [98, 99]))
      var spy = createTemporaryObject(spyComponent, tests, { target: buffers, signalName: "failed" })
      spy.wait(2000)
      compare(spy.signalArguments[0][0], "gone")
    }

    function test_single_preview_and_unload() {
      var buffers = makeImages(loop("preview", [4]))
      tryCompare(buffers, "ready", true)
      compare(buffers.current, buffers.upcoming)
      buffers.loop = null
      tryCompare(buffers, "front", null)
      compare(buffers.current, null)
      compare(buffers.ready, false)
    }
  }
}
