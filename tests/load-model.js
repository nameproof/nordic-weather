// Loads Model.js in node. Its first line is the QML directive
// `.pragma library` (share one copy between importers), which is not
// JavaScript, so it is blanked out before evaluating the file.
const fs = require("node:fs")
const path = require("node:path")

const file = path.join(__dirname, "..", "Model.js")
const source = fs.readFileSync(file, "utf8").replace(/^\.pragma library[ \t]*$/m, "")
const mod = { exports: {} }
new Function("module", "exports", "require", source)(mod, mod.exports, require)

module.exports = mod.exports
