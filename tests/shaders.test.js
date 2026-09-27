// The compiled .qsb files must match their GLSL source: run
// scripts/build-shaders (scripts/dev-install does it automatically).
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")

const dir = path.join(__dirname, "..", "shaders")

for (const src of fs.readdirSync(dir).filter((f) => f.endsWith(".frag"))) {
  test(`${src}.qsb is built from the current source`, () => {
    const sum = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, src))).digest("hex")
    assert.ok(fs.existsSync(path.join(dir, src + ".qsb")), `${src}.qsb missing: run scripts/build-shaders`)
    const recorded = fs.readFileSync(path.join(dir, src + ".sha256"), "utf8").trim()
    assert.equal(recorded, sum, `${src} changed since its .qsb was built: run scripts/build-shaders`)
  })
}
