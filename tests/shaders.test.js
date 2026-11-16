// The compiled .qsb files must match their GLSL source: run
// scripts/build-shaders (scripts/dev-sync does it automatically).
// The source fingerprint check runs anywhere; the byte comparison against a
// fresh compile needs qsb (qt6-shadertools) and skips without it.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const crypto = require("node:crypto")
const { spawnSync } = require("node:child_process")

const dir = path.join(__dirname, "..", "shaders")
const qsb = process.env.QSB || "/usr/lib/qt6/bin/qsb"
const qsbFound = (() => { try { fs.accessSync(qsb, fs.constants.X_OK); return true } catch { return false } })()

for (const src of fs.readdirSync(dir).filter((f) => f.endsWith(".frag"))) {
  test(`${src}.qsb is built from the current source`, () => {
    const sum = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, src))).digest("hex")
    assert.ok(fs.existsSync(path.join(dir, src + ".qsb")), `${src}.qsb missing: run scripts/build-shaders`)
    const recorded = fs.readFileSync(path.join(dir, src + ".sha256"), "utf8").trim()
    assert.equal(recorded, sum, `${src} changed since its .qsb was built: run scripts/build-shaders`)
  })

  test(`${src}.qsb is what qsb compiles from the source`,
    { skip: !qsbFound && `shader binaries NOT verified: ${qsb} not found (qt6-shadertools)` }, () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nordic-qsb-"))
      try {
        const out = path.join(tmp, src + ".qsb")
        const run = spawnSync(qsb, ["--qt6", "-o", out, path.join(dir, src)], { encoding: "utf8" })
        const version = spawnSync(qsb, ["--version"], { encoding: "utf8" }).stdout.trim()
        assert.equal(run.status, 0, `${version} failed on ${src}:\n${run.stderr}${run.error || ""}`)
        assert.ok(fs.readFileSync(out).equals(fs.readFileSync(path.join(dir, src + ".qsb"))),
          `${src}.qsb differs from what ${version} builds: run scripts/build-shaders --force`)
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
      }
    })
}
