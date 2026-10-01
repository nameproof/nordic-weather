const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const https = require("node:https")
const { spawn, execFileSync } = require("node:child_process")

const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'"

// Keep the real curl's HTTPS and certificate checks. Only DNS routing and
// the trusted test certificate change; no production URL or flag is removed.
async function withHttpsServer(handler, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nordic-https-"))
  const cert = path.join(dir, "cert.pem"), key = path.join(dir, "key.pem")
  let server
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=tiles.yr.no", "-addext", "subjectAltName=DNS:tiles.yr.no",
      "-keyout", key, "-out", cert], { stdio: "ignore" })
    server = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, handler)
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const curl = execFileSync("which", ["curl"], { encoding: "utf8" }).trim()
    fs.writeFileSync(path.join(dir, "curl"), "#!/bin/bash\nexec " + quote(curl)
      + " -q --cacert " + quote(cert) + " --connect-to "
      + quote("tiles.yr.no:443:127.0.0.1:" + server.address().port) + ' "$@"\n', { mode: 0o755 })
    const env = { ...process.env, PATH: dir + ":" + process.env.PATH, NO_PROXY: "*", no_proxy: "*" }
    return await fn("https://tiles.yr.no", env)
  } finally {
    if (server) {
      server.closeAllConnections()
      server.close()
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// Run asynchronously so an in-process server can answer real commands.
function runCommand(cmd, env) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const proc = spawn(cmd[0], cmd.slice(1), { env: env || process.env })
    const out = [], err = []
    let bytes = 0
    proc.stdout.on("data", (chunk) => { bytes += chunk.length; if (bytes < 1e6) out.push(chunk) })
    proc.stderr.on("data", (chunk) => err.push(chunk))
    proc.on("error", reject)
    proc.on("close", (code) => resolve({ code, bytes, ms: Date.now() - started,
      stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }))
  })
}

module.exports = { withHttpsServer, runCommand }
