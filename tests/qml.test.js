const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const { spawnSync, execFileSync } = require("node:child_process")

test("Qt: radar image readiness, loop replacement and coverage", {
  skip: !fs.existsSync("/usr/lib/qt6/bin/qmltestrunner") || !fs.existsSync("/usr/bin/magick")
    ? "Qt Quick Test and ImageMagick required" : false
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nordic-radar-qml-"))
  try {
    const input = path.join(dir, "tests", "qml")
    const frames = path.join(input, "frames")
    fs.mkdirSync(frames, { recursive: true })
    for (const file of ["RadarImages.qml", "Model.js"])
      fs.copyFileSync(path.join(__dirname, "..", file), path.join(dir, file))
    for (let i = 0; i < 5; i++)
      execFileSync("magick", ["-size", "16x16", `xc:rgb(${i * 40},100,200)`, path.join(frames, `f_${i}_test.png`)])
    fs.copyFileSync(path.join(__dirname, "qml", "tst_Radar.qml"), path.join(input, "tst_Radar.qml"))
    const runtime = path.join(dir, "runtime")
    fs.mkdirSync(runtime, { mode: 0o700 })
    const result = spawnSync("/usr/lib/qt6/bin/qmltestrunner", ["-input", input], {
      encoding: "utf8", timeout: 30000,
      env: { ...process.env, QT_QPA_PLATFORM: "offscreen", QT_QUICK_BACKEND: "software",
        XDG_RUNTIME_DIR: runtime, XDG_CACHE_HOME: path.join(dir, "cache"), QML_DISABLE_DISK_CACHE: "1" }
    })
    assert.equal(result.status, 0, (result.error || "") + result.stdout + result.stderr)
    assert.doesNotMatch(result.stdout + result.stderr, /ReferenceError|TypeError|Binding loop/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
