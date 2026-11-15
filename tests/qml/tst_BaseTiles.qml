import QtQuick
import QtTest
import "tiles.js" as Tiles

// Every shipped base map tile loads through Qt's own WebP plugin, at its size,
// and the channels mean what the shader reads: an all-sea tile is pure green
// (water is stored in green, roads in red, borders in blue).
Item {
  width: 400
  height: 400
  Image { id: img; asynchronous: false; cache: false; smooth: false }
  TestCase {
    name: "BaseTiles"
    when: windowShown

    function test_every_tile_loads() {
      var bad = []
      for (var i = 0; i < Tiles.list.length; i++) {
        var t = Tiles.list[i]
        img.source = ""
        img.source = "file://" + t[0]
        if (img.status !== Image.Ready || img.implicitWidth !== t[1] || img.implicitHeight !== t[1])
          bad.push(t[0] + " (status " + img.status + ", " + img.implicitWidth + "x" + img.implicitHeight + ")")
      }
      verify(Tiles.list.length > 0)
      compare(bad.length, 0, bad.slice(0, 5).join("; "))
    }

    function test_sea_is_water_in_green() {
      img.source = "file://" + Tiles.sea
      compare(img.status, Image.Ready)
      var shot = grabImage(img)
      compare(shot.red(20, 20), 0)
      compare(shot.green(20, 20), 255)
      compare(shot.blue(20, 20), 0)
    }
  }
}
