pragma ComponentBehavior: Bound
import QtQuick
import "Model.js" as Model

// Texture providers only: the panel's radar shader draws these Images.
// Three rotating slots decode frames ahead of playback. A replacement loop
// gets its own short-lived staging set; the old set stays on screen until
// the new one's frames are decoded. A loop that only grew (more of the
// same frames assembled, `base` unchanged) keeps its images.
Item {
  id: root
  visible: false

  property var loop: null
  property var playhead: ({ frame: 0, tick: 0 })
  property string directory: ""
  property string token: ""
  property var front: null
  property var staging: null
  readonly property string snapshotKey: keyOf(loop)

  // Which frames a loop is: a loop that only grew keeps its base.
  function keyOf(l) { return l ? (l.base || l.key) : "" }

  readonly property bool ready: front !== null && front.snapshotKey === snapshotKey && front.imagesReady
    && front.playhead.frame === playhead.frame && front.playhead.tick === playhead.tick
  readonly property var current: front ? front.current : null
  readonly property var upcoming: front ? front.upcoming : null
  // No-coverage for the whole loop: its latest observation
  // (Model.radarCoverageIndex), once decoded.
  readonly property var coverage: front && front.coverage.status === Image.Ready ? front.coverage : current

  signal prepared(string token, bool ready)
  // A frame's image file couldn't be loaded (e.g. cleaned from the cache).
  signal failed()

  function report() { prepared(token, ready) }
  onTokenChanged: Qt.callLater(report)
  onReadyChanged: Qt.callLater(report)
  // keyOf(loop), not snapshotKey: that binding may not have caught up yet.
  onLoopChanged: {
    var key = keyOf(loop)
    if (front && front.snapshotKey === key) front.loop = loop
    if (staging && staging.snapshotKey === key) staging.loop = loop
    Qt.callLater(synchronize)
  }
  // A step reaches the drawing at once, in the same update as the ruler and
  // the time label.
  onPlayheadChanged: {
    if (front && front.snapshotKey === snapshotKey) front.playhead = playhead
    if (staging && staging.snapshotKey === snapshotKey) staging.playhead = playhead
    // Only a loop still being staged needs the full pass.
    if (!front || front.snapshotKey !== snapshotKey) Qt.callLater(synchronize)
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
      front.loop = loop
      front.playhead = playhead
    } else {
      if (staging && staging.snapshotKey !== snapshotKey) { staging.destroy(); staging = null }
      if (!staging) staging = layerComponent.createObject(root, { loop: loop, snapshotKey: snapshotKey, playhead: playhead })
      else staging.playhead = playhead
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
      readonly property var slots: Model.radarImageSlots(loop.frames, playhead.frame, playhead.tick, loop.ready)
      readonly property var images: [image0, image1, image2]
      readonly property var current: images[slots.current]
      readonly property var upcoming: images[slots.upcoming]
      readonly property alias coverage: coverageImage
      readonly property bool imagesReady: current.status === Image.Ready && upcoming.status === Image.Ready
      onImagesReadyChanged: Qt.callLater(root.promote)
      readonly property bool imagesFailed: current.status === Image.Error || upcoming.status === Image.Error
      onImagesFailedChanged: if (imagesFailed) root.failed()

      function urlFor(frame) {
        return frame ? "file://" + root.directory + "/" + Model.radarFrameFile(frame, loop.viewKey) : ""
      }

      // Frames are drawn 1:1, sampled at pixel centres.
      component FrameImage: Image {
        required property int slot
        visible: false
        smooth: false
        cache: false
        asynchronous: true
        retainWhileLoading: true
        source: imageSet.urlFor(imageSet.slots.frames[slot])
      }
      FrameImage { id: image0; slot: 0 }
      FrameImage { id: image1; slot: 1 }
      FrameImage { id: image2; slot: 2 }
      FrameImage {
        id: coverageImage
        slot: -1
        source: imageSet.urlFor(imageSet.loop.frames[Model.radarCoverageIndex(imageSet.loop)] || null)
      }
    }
  }
}
