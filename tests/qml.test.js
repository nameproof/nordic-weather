const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const { spawnSync, execFileSync } = require("node:child_process")

test("Qt: radar image readiness, loop replacement and V4 worker messages", {
  skip: !fs.existsSync("/usr/lib/qt6/bin/qmltestrunner") || !fs.existsSync("/usr/bin/magick")
    ? "Qt Quick Test and ImageMagick required" : false
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nordic-radar-qml-"))
  try {
    const input = path.join(dir, "tests", "qml")
    const frames = path.join(input, "frames")
    fs.mkdirSync(frames, { recursive: true })
    for (const file of ["RadarImages.qml", "Model.js", "Flow.mjs", "FlowWorker.mjs"])
      fs.copyFileSync(path.join(__dirname, "..", file), path.join(dir, file))
    for (let i = 0; i < 5; i++)
      execFileSync("magick", ["-size", "16x16", `xc:rgb(${i * 40},100,200)`, path.join(frames, `f_${i}_test.png`)])
    fs.writeFileSync(path.join(frames, "flow.ppm"), "P3\n1 1\n255\n132 128 255\n")
    const pixels = []
    for (let k = 0; k < 3; k++) {
      const bytes = Buffer.alloc(64 * 48)
      for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) {
        const u = x - k
        if ((u - 32) ** 2 + (y - 24) ** 2 <= 20 ** 2)
          bytes[y * 64 + x] = Math.round(120 + 90 * Math.sin(u / 2.3) * Math.cos(y / 3.1))
      }
      pixels.push(bytes)
    }
    const source = fs.readFileSync(path.join(__dirname, "qml", "tst_Radar.qml"), "utf8")
      .replace("@FLOW_DATA@", Buffer.concat(pixels).toString("base64"))
    fs.writeFileSync(path.join(input, "tst_Radar.qml"), source)
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
