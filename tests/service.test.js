const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const { spawnSync, execFileSync } = require("node:child_process")
const M = require("./load-model")

test("Quickshell: service prepares, publishes, pauses, reuses and bounds retries", {
  skip: !fs.existsSync("/usr/bin/qs") || !fs.existsSync("/usr/share/omarchy/shell/Commons")
    || !fs.existsSync("/usr/bin/magick") ? "Quickshell, Omarchy and ImageMagick required" : false
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nordic-radar-service-"))
  try {
    for (const file of ["Service.qml", "RadarImages.qml", "Model.js", "Flow.mjs", "FlowWorker.mjs"])
      fs.copyFileSync(path.join(__dirname, "..", file), path.join(dir, file))
    fs.copyFileSync(path.join(__dirname, "qml", "service.qml"), path.join(dir, "shell.qml"))
    fs.symlinkSync("/usr/share/omarchy/shell/Commons", path.join(dir, "Commons"))
    const cache = path.join(dir, "cache")
    const tiles = path.join(cache, M.PLUGIN_ID, "tiles")
    fs.mkdirSync(tiles, { recursive: true })
    const view = M.mapView(1, 57.93, 12.53, 256, 192)
    const key = M.mapViewKey(view, 256, 192)
    for (let k = 0; k < 4; k++) {
      const pixels = Buffer.alloc(256 * 192 * 3)
      for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) {
        const u = x - 4 * k
        if ((u - 128) ** 2 + (y - 96) ** 2 <= 80 ** 2)
          pixels[(y * 256 + x) * 3 + 2] = Math.round(120 + 90 * Math.sin(u / 9.2) * Math.cos(y / 12.4))
      }
      execFileSync("magick", ["-size", "256x192", "-depth", "8", "rgb:-",
        path.join(tiles, M.radarFrameFile({ timeMs: k * 300000 }, key))], { input: pixels })
    }
    const tile = path.join(dir, "tile.png")
    execFileSync("magick", ["-size", "256x256", "xc:blue", tile])
    for (const timeMs of [1200000, 1500000])
      for (const t of M.viewTiles(M.radarView(view), 256, 192))
        fs.copyFileSync(tile, path.join(tiles, M.radarTileFile(t, { timeMs })))
    const runtime = path.join(dir, "runtime")
    fs.mkdirSync(runtime, { mode: 0o700 })
    const result = spawnSync("qs", ["-p", path.join(dir, "shell.qml"), "--no-color"], {
      encoding: "utf8", timeout: 20000,
      env: { ...process.env, QT_QPA_PLATFORM: "offscreen", QT_QUICK_BACKEND: "software",
        XDG_RUNTIME_DIR: runtime, XDG_CACHE_HOME: cache, QML_DISABLE_DISK_CACHE: "1" }
    })
    const output = (result.stdout || "") + (result.stderr || "")
    assert.equal(result.status, 0, (result.error || "") + output)
    assert.match(output, /RADAR_SERVICE_PASS/, output)
    assert.doesNotMatch(output, /RADAR_SERVICE_FAIL|ReferenceError|TypeError|Binding loop/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
