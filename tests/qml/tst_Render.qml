import QtQuick
import QtTest

Rectangle {
  color: "black"
  width: 64
  height: 64
  Image { id: a; visible: false; source: "a.png" }
  Image { id: c; visible: false; source: "c.png" }
  Image { id: tones; visible: false; source: "tones.png" }
  ShaderEffect {
    id: shader
    width: 64
    height: 64
    property var source: a
    property var coverageMap: a
    property real strength: 1
    property real dimStrength: 0
    property real lineStrength: 0
    property real lineSpacing: 4
    property real lineWidth: 1
    property color lineColor: "white"
    property real darkMap: 0
    fragmentShader: "radar.qsb"
  }
  TestCase {
    name: "RadarRender"
    when: windowShown

    function pixels() { wait(80); return grabImage(shader) }

    // Rain (a blue block at 16–31) at full strength, nothing around it.
    function test_rain() {
      tryCompare(a, "status", Image.Ready)
      verify(shader.GraphicsInfo.api !== GraphicsInfo.Software, "ShaderEffect requires RHI")
      var img = pixels()
      compare(img.blue(20, 32), 255)
      compare(img.blue(40, 32), 0)
    }

    // No-coverage comes from the coverage image (white left half), not from
    // the frame drawn: the hatch lines are there and only there.
    function test_coverage_from_its_own_image() {
      tryCompare(c, "status", Image.Ready)
      shader.coverageMap = c
      shader.lineStrength = 1
      shader.lineWidth = 2
      var img = pixels()
      var left = 0, right = 0
      for (var x = 0; x < 14; x++) left += img.red(x, 8)
      for (var x2 = 36; x2 < 64; x2++) right += img.red(x2, 8)
      verify(left > 14 * 40, "lines where the coverage image has none")
      compare(right, 0)
      shader.lineStrength = 0
      shader.lineWidth = 1
      shader.coverageMap = a
    }

    // yr.no's lightest rain (#91e4ff, left) and deepest blue (#0055ff,
    // right): unchanged on a light map; on a dark one the light rain turns
    // dim and see-through while the heavy rain comes out brightest.
    function test_dark_map_tones_rain() {
      tryCompare(tones, "status", Image.Ready)
      shader.source = tones
      shader.coverageMap = tones
      var light = pixels()
      compare(light.red(16, 32), 0x91)
      compare(light.green(16, 32), 0xe4)
      compare(light.green(48, 32), 0x55)
      shader.darkMap = 1
      var dark = pixels()
      verify(dark.green(16, 32) < 70, "light rain dimmed: " + dark.green(16, 32))
      verify(dark.blue(16, 32) < 110, "light rain dimmed: " + dark.blue(16, 32))
      verify(dark.green(48, 32) > 150, "heavy rain brightened: " + dark.green(48, 32))
      verify(dark.blue(48, 32) > dark.blue(16, 32) + 100, "heavy rain above light rain")
      shader.darkMap = 0
      shader.source = a
      shader.coverageMap = a
    }
  }
}
