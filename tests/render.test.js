const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const { spawnSync, execFileSync } = require("node:child_process")

// Opt in: a real Qt RHI renderer is required, unlike the software-backed
// image/service tests. Keep this runnable without opening a desktop window.
test("Qt RHI: radar rain and no-coverage pixels", {
  skip: process.env.RADAR_RENDER_TESTS !== "1" ? "set RADAR_RENDER_TESTS=1 with Qt Quick Test and OpenGL available" : false
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nordic-radar-render-"))
  try {
    fs.copyFileSync(path.join(__dirname, "qml", "tst_Render.qml"), path.join(dir, "tst_Render.qml"))
    fs.copyFileSync(path.join(__dirname, "..", "shaders", "radar.frag.qsb"), path.join(dir, "radar.qsb"))
    execFileSync("magick", ["-size", "64x64", "xc:black", "-fill", "blue", "-draw", "rectangle 16,16 31,47", path.join(dir, "a.png")])
    execFileSync("magick", ["-size", "64x64", "xc:black", "-fill", "white", "-draw", "rectangle 0,0 31,63", path.join(dir, "c.png")])
    const runtime = path.join(dir, "runtime")
    fs.mkdirSync(runtime, { mode: 0o700 })
    const result = spawnSync("/usr/lib/qt6/bin/qmltestrunner", ["-input", dir, "-nocrashhandler"], {
      encoding: "utf8", timeout: 30000,
      env: { ...process.env, QT_QPA_PLATFORM: "offscreen", QT_QUICK_BACKEND: "rhi", QSG_RHI_BACKEND: "opengl",
        XDG_RUNTIME_DIR: runtime, XDG_CACHE_HOME: path.join(dir, "cache"), QML_DISABLE_DISK_CACHE: "1" }
    })
    assert.equal(result.status, 0, (result.error || "") + result.stdout + result.stderr)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
