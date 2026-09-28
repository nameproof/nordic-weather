pragma ComponentBehavior: Bound
import QtQuick
import "Model.js" as Model

// Texture providers only: the panel's single shader draws these Images.
// Three rotating slots prefetch a frame ahead. A replacement loop gets its
// own short-lived staging set; the old set stays intact until both new
// endpoints and the matching flow atlas are decoded.
Item {
  id: root
  visible: false

  property var loop: null
  property var playhead: ({ frame: 0, tick: 0 })
  property real blend: 0
  property string directory: ""
  property string token: ""
  property bool useFlow: false
  property var front: null
  property var staging: null
  readonly property string snapshotKey: loop ? loop.key + "|" + (loop.flow ? loop.flow.file : "") : ""

  readonly property bool ready: front !== null && front.snapshotKey === snapshotKey && front.imagesReady
    && front.playhead.frame === playhead.frame && front.playhead.tick === playhead.tick
  readonly property var current: front ? front.current : null
  readonly property var upcoming: front ? front.upcoming : null
  readonly property var flow: front ? front.flow : null
  // No-coverage for the whole loop: its latest observation, once decoded.
  readonly property var coverage: front && front.coverage.status === Image.Ready ? front.coverage : current
  readonly property var flowInfo: front && front.loop.flow ? front.loop.flow : null
  readonly property bool flowReady: front !== null && useFlow && flowInfo !== null && front.flow.status === Image.Ready
  readonly property real displayBlend: front && front.imagesReady ? front.blend : 0
  readonly property int displayIndex: front ? front.playhead.frame : 0

  signal prepared(string token, bool ready)

  function report() { prepared(token, ready) }
  onTokenChanged: Qt.callLater(report)
  onReadyChanged: Qt.callLater(report)
  onLoopChanged: Qt.callLater(synchronize)
  // A step must reach the drawing together with its new blend (they change
  // in the same timer handler): deferred, one drawing would put the next
  // frame's blend on the previous frame, a visible step back.
  onPlayheadChanged: {
    if (front && front.snapshotKey === snapshotKey) front.playhead = playhead
    if (staging && staging.snapshotKey === snapshotKey) staging.playhead = playhead
    // Only a loop still being staged needs the full pass.
    if (!front || front.snapshotKey !== snapshotKey) Qt.callLater(synchronize)
  }
  onBlendChanged: {
    if (front && front.snapshotKey === snapshotKey) front.blend = blend
    if (staging && staging.snapshotKey === snapshotKey) staging.blend = blend
  }

  function synchronize() {
    if (!loop || !loop.frames.length) {
      if (staging) staging.destroy()
      if (front) front.destroy()
      staging = null
      front = null
      return
    }
    if (front && front.snapshotKey === snapshotKey) {
      if (staging) { staging.destroy(); staging = null }
      front.playhead = playhead
      front.blend = blend
    } else {
      if (staging && staging.snapshotKey !== snapshotKey) { staging.destroy(); staging = null }
      if (!staging) staging = layerComponent.createObject(root, { loop: loop, snapshotKey: snapshotKey, playhead: playhead, blend: blend })
      else { staging.playhead = playhead; staging.blend = blend }
      promote()
    }
    Qt.callLater(report)
  }

  function promote() {
    if (!staging || staging.snapshotKey !== snapshotKey || !staging.imagesReady) return
    var old = front
    front = staging
    staging = null
    if (old) old.destroy()
    Qt.callLater(report)
  }

  Component {
    id: layerComponent
    Item {
      id: imageSet
      required property var loop
      required property string snapshotKey
      required property var playhead
      property real blend: 0
      readonly property var slots: Model.radarImageSlots(loop.frames, playhead.frame, playhead.tick, loop.ready)
      readonly property var images: [image0, image1, image2]
      readonly property var current: images[slots.current]
      readonly property var upcoming: images[slots.upcoming]
      readonly property alias flow: flowImage
      readonly property alias coverage: coverageImage
      readonly property bool imagesReady: current.status === Image.Ready && upcoming.status === Image.Ready
        && (!root.useFlow || !loop.flow || flowImage.status === Image.Ready)
      onImagesReadyChanged: Qt.callLater(root.promote)

      function urlFor(frame) {
        return frame ? "file://" + root.directory + "/" + Model.radarFrameFile(frame, loop.viewKey) : ""
      }

      component FrameImage: Image {
        required property int slot
        visible: false
        // Filtered: Flow moves frames by fractions of a pixel (the shader
        // keeps the softening constant). Off and Fade sample pixel centres.
        smooth: true
        cache: false
        asynchronous: true
        retainWhileLoading: true
        source: imageSet.urlFor(imageSet.slots.frames[slot])
      }
      FrameImage { id: image0; slot: 0 }
      FrameImage { id: image1; slot: 1 }
      FrameImage { id: image2; slot: 2 }
      Image {
        id: flowImage
        visible: false
        smooth: true
        cache: false
        asynchronous: true
        source: root.useFlow && imageSet.loop.flow ? "file://" + imageSet.loop.flow.file : ""
      }
      Image {
        id: coverageImage
        visible: false
        smooth: true
        cache: false
        asynchronous: true
        source: imageSet.urlFor(imageSet.loop.frames[Math.max(0, imageSet.loop.nowIndex)] || null)
      }
    }
  }
}
