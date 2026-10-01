// scripts/dev-sync, run from a copy of the repo with its own HOME and with
// build-shaders and the omarchy commands replaced by stubs that only log,
// so nothing outside the test's temp folder is touched.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync, execFileSync } = require("node:child_process")

const ID = "io.github.nameproof.nordic-weather"
const repo = path.join(__dirname, "..")
const skip = !fs.existsSync("/usr/bin/rsync") && "rsync not installed"

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nw-devsync-"))
  const src = path.join(root, "src")
  const home = path.join(root, "home")
  const bin = path.join(root, "bin")
  const log = path.join(root, "log")
  for (const file of execFileSync("git", ["-C", repo, "ls-files"]).toString().trim().split("\n")) {
    if (!fs.existsSync(path.join(repo, file))) continue
    fs.mkdirSync(path.dirname(path.join(src, file)), { recursive: true })
    fs.copyFileSync(path.join(repo, file), path.join(src, file))
  }
  fs.copyFileSync(path.join(repo, "scripts", "dev-sync"), path.join(src, "scripts", "dev-sync"))
  fs.chmodSync(path.join(src, "scripts", "dev-sync"), 0o755)
  const stub = (file) => fs.writeFileSync(file, `#!/bin/bash\necho "${path.basename(file)} $*" >> "${log}"\n`, { mode: 0o755 })
  stub(path.join(src, "scripts", "build-shaders"))
  fs.mkdirSync(bin)
  for (const name of ["omarchy", "omarchy-shell", "omarchy-plugin-validate"]) stub(path.join(bin, name))
  const plugins = path.join(home, ".config", "omarchy", "plugins")
  fs.mkdirSync(plugins, { recursive: true })
  const run = () => spawnSync(path.join(src, "scripts", "dev-sync"), [], {
    env: { ...process.env, HOME: home, PATH: bin + ":" + process.env.PATH },
  })
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []
  return { root, src, plugins, dest: path.join(plugins, ID), run, calls }
}

// Every file under dir with its content, for before/after comparisons.
function snapshot(dir) {
  const out = {}
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name)
    out[path.relative(dir, file)] = entry.isFile() ? fs.readFileSync(file, "utf8") : entry.isDirectory() ? "<dir>" : "<other>"
  }
  return out
}

test("dev-sync refuses a symlinked plugin folder and leaves its target alone", { skip }, () => {
  const s = setup()
  const target = path.join(s.root, "elsewhere")
  fs.mkdirSync(path.join(target, "sub"), { recursive: true })
  fs.writeFileSync(path.join(target, "notes.txt"), "keep me")
  fs.writeFileSync(path.join(target, "sub", "more.txt"), "and me")
  const before = snapshot(target)
  fs.symlinkSync(target, s.dest)
  const r = s.run()
  assert.equal(r.status, 1)
  assert.match(r.stderr.toString(), /is a symlink/)
  assert.deepEqual(snapshot(target), before)
  assert.deepEqual(s.calls(), [])  // stopped before building or calling anything
})

test("dev-sync refuses a dangling symlink and doesn't create its target", { skip }, () => {
  const s = setup()
  const target = path.join(s.root, "missing")
  fs.symlinkSync(target, s.dest)
  const r = s.run()
  assert.equal(r.status, 1)
  assert.match(r.stderr.toString(), /is a symlink/)
  assert.ok(!fs.existsSync(target))
  assert.deepEqual(s.calls(), [])
})

test("dev-sync refuses a plugin path that is a file", { skip }, () => {
  const s = setup()
  fs.writeFileSync(s.dest, "a file")
  const r = s.run()
  assert.equal(r.status, 1)
  assert.match(r.stderr.toString(), /not a folder/)
  assert.equal(fs.readFileSync(s.dest, "utf8"), "a file")
  assert.deepEqual(s.calls(), [])
})

test("dev-sync syncs into a real plugin folder", { skip }, () => {
  const s = setup()
  fs.mkdirSync(path.join(s.dest, ".git"), { recursive: true })
  fs.writeFileSync(path.join(s.dest, ".git", "HEAD"), "ref: refs/heads/main")
  fs.writeFileSync(path.join(s.dest, "stale.qml"), "old")
  const r = s.run()
  assert.equal(r.status, 0, r.stderr.toString())
  assert.equal(fs.readFileSync(path.join(s.dest, "manifest.json"), "utf8"),
               fs.readFileSync(path.join(s.src, "manifest.json"), "utf8"))
  assert.ok(!fs.existsSync(path.join(s.dest, "stale.qml")))  // removed: not in the repo
  assert.ok(fs.existsSync(path.join(s.dest, ".git", "HEAD")))  // kept: a git-managed install's own
  assert.deepEqual(s.calls(), ["build-shaders ", "omarchy-plugin-validate " + s.dest, "omarchy restart shell"])
  // Unchanged code: no restart, just a rescan.
  const again = s.run()
  assert.equal(again.status, 0)
  assert.equal(s.calls().at(-1), "omarchy-shell shell rescanPlugins")
})

test("dev-sync follows a symlinked plugins directory above the plugin folder", { skip }, () => {
  // Only the plugin folder itself must be real; ~/.config/omarchy (or the
  // plugins folder) may be a link, e.g. from a dotfiles manager.
  const s = setup()
  const real = path.join(s.root, "dotfiles-plugins")
  fs.renameSync(s.plugins, real)
  fs.symlinkSync(real, s.plugins)
  const r = s.run()
  assert.equal(r.status, 0, r.stderr.toString())
  assert.ok(fs.existsSync(path.join(real, ID, "manifest.json")))
})
