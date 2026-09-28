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
    property string flowData: "@FLOW_DATA@"
    property var reply: null
    property int replies: 0

    Component { id: imagesComponent; Weather.RadarImages {} }
    WorkerScript {
      id: worker
      source: Qt.resolvedUrl("../../FlowWorker.mjs")
      onMessage: function(message) { tests.reply = message; tests.replies++ }
    }

    function loop(key, times, flow) {
      return { key: key, viewKey: "test", frames: times.map(function(t) { return { timeMs: t } }), flow: flow || null }
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
      buffers.blend = 0.5
      compare(buffers.displayBlend, 0.5)
      for (var tick = 2; tick <= 7; tick++) {
        buffers.playhead = { frame: tick % 5, tick: tick }
        tryCompare(buffers, "ready", true)
        verify(String(buffers.current.source).endsWith("f_" + tick % 5 + "_test.png"))
      }
    }

    // A frame step and its new blend reach the drawing together: in between,
    // the next frame's blend would be drawn on the previous frame, a jump back.
    function test_step_and_blend_change_together() {
      var buffers = makeImages(loop("b", [0, 1, 2, 3, 4]))
      buffers.blend = 0.9
      tryCompare(buffers, "ready", true)
      var next = buffers.upcoming
      buffers.playhead = { frame: 1, tick: 1 }
      buffers.blend = 0.3
      // No waiting: the very next drawing must already show frame 1.
      compare(buffers.displayIndex, 1)
      compare(buffers.displayBlend, 0.3)
      compare(buffers.current, next)
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

    function test_atlas_must_match_replacement() {
      var buffers = makeImages(loop("first", [0, 1]))
      tryCompare(buffers, "ready", true)
      buffers.useFlow = true
      ignoreWarning(/.*Cannot open:.*missing.ppm/)
      buffers.loop = loop("missing-flow", [2, 3], { file: directory + "/missing.ppm" })
      tryVerify(function() { return buffers.staging !== null })
      wait(30)
      compare(buffers.ready, false)
      compare(buffers.front.loop.key, "first")
      buffers.loop = loop("complete-flow", [2, 3], { file: directory + "/flow.ppm" })
      tryCompare(buffers, "ready", true)
      compare(buffers.front.loop.key, "complete-flow")
      compare(buffers.flowReady, true)
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

    function test_worker_serialization() {
      var message = { key: "test", data: flowData, w: 64, h: 48, count: 3, mapWidth: 256, mapHeight: 192,
                      options: { times: [0, 300000, 600000] } }
      var before = replies
      worker.sendMessage(message)
      tryCompare(tests, "replies", before + 1, 10000)
      compare(reply.error, "")
      verify(reply.result !== null)
      verify(reply.result.knownCells > 0)
      var ppm = reply.result.ppm
      // Same frames, same field: nothing carries over between messages.
      worker.sendMessage(message)
      tryCompare(tests, "replies", before + 2, 10000)
      compare(reply.error, "")
      compare(reply.result.ppm, ppm)
    }
  }
}
