import QtQuick
import QtTest

Rectangle {
  color: "black"
  width: 64
  height: 64
  Image { id: a; visible: false; source: "a.png"; smooth: true }
  Image { id: b; visible: false; source: "b.png"; smooth: true }
  Image { id: f; visible: false; source: "flow.ppm"; smooth: true }
  Image { id: c; visible: false; source: "c.png"; smooth: true }
  ShaderEffect {
    id: shader
    width: 64
    height: 64
    property var sourceA: a
    property var sourceB: b
    property var flowField: f
    property var coverageMap: a
    property real blend: 0
    property real flowOn: 0
    property real flowPair: 0
    property real flowPairs: 1
    property real flowUnit: 2
    property vector2d flowGrid: Qt.vector2d(1, 1)
    property vector2d flowCell: Qt.vector2d(64, 64)
    property vector2d mapSize: Qt.vector2d(64, 64)
    property real strength: 1
    property real dimStrength: 0
    property real lineStrength: 0
    property real lineSpacing: 4
    property real lineWidth: 1
    property color lineColor: "white"
    fragmentShader: "radar.qsb"
  }
  TestCase {
    name: "RadarRender"
    when: windowShown

    function pixels() { wait(80); return grabImage(shader) }
    function atlas(name) {
      f.source = name + ".ppm"
      tryCompare(f, "status", Image.Ready)
      return pixels()
    }

    function test_pixels() {
      tryCompare(a, "status", Image.Ready)
      tryCompare(b, "status", Image.Ready)
      tryCompare(f, "status", Image.Ready)
      verify(shader.GraphicsInfo.api !== GraphicsInfo.Software, "ShaderEffect requires RHI")
      var img = pixels()
      compare(img.blue(20, 32), 255)
      compare(img.blue(40, 32), 0)
      shader.blend = 0.5
      img = pixels()
      verify(Math.abs(img.blue(20, 32) - 128) <= 1)
      verify(Math.abs(img.blue(40, 32) - 128) <= 1)
      // Flow: the block (16 px right from A to B) slides, always at full
      // strength; never a half-strength average of the two frames.
      shader.flowOn = 1
      img = pixels()
      compare(img.blue(28, 32), 255)
      compare(img.blue(20, 32), 0)
      compare(img.blue(44, 32), 0)
      shader.blend = 0.25                       // A moved 4 px: 20–35
      img = pixels()
      compare(img.blue(22, 32), 255)
      compare(img.blue(18, 32), 0)
      compare(img.blue(38, 32), 0)
      shader.blend = 0.75                       // B moved back 4 px: 28–43
      img = pixels()
      compare(img.blue(42, 32), 255)
      compare(img.blue(26, 32), 0)
      // No trusted motion: no movement, and a switch to B halfway, as with
      // smoothing off, rather than a fade.
      shader.blend = 0.25
      img = atlas("fade")
      compare(img.blue(20, 32), 255)
      compare(img.blue(40, 32), 0)
      shader.blend = 0.5
      img = pixels()
      compare(img.blue(20, 32), 0)
      compare(img.blue(40, 32), 255)
      // Half-trusted motion moves half as far: B back 4 px, 28–43.
      img = atlas("mixed")
      compare(img.blue(30, 32), 255)
      compare(img.blue(26, 32), 0)
      // 48 px of motion: B pulled back 24 px (8–23) where that stays on the
      // map; where it would read past the edge (x ≥ 40), no motion instead of
      // a smear of edge pixels.
      img = atlas("edge")
      compare(img.blue(20, 32), 255)
      compare(img.blue(40, 32), 255, "out-of-crop motion must not smear the edge")
    }

    // No-coverage comes from the coverage image (white left half), not from
    // the frame drawn: the hatch lines are there and only there.
    function test_coverage_from_its_own_image() {
      tryCompare(c, "status", Image.Ready)
      shader.coverageMap = c
      shader.flowOn = 0
      shader.blend = 0
      shader.lineStrength = 1
      shader.lineWidth = 2
      var img = pixels()
      var left = 0, right = 0
      for (var x = 0; x < 28; x++) left += img.red(x, 8)
      for (var x2 = 36; x2 < 64; x2++) right += img.red(x2, 8)
      verify(left > 28 * 40, "lines where the coverage image has none")
      compare(right, 0)
      shader.lineStrength = 0
      shader.lineWidth = 1
      shader.coverageMap = a
    }
  }
}
