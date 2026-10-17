const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
function sourceFingerprint(root) {
  const entries = []
  function walk(dir) {
    if (!fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name)
      if (e.isDirectory()) walk(f); else entries.push(f)
    }
  }
  for (const dir of ['src', 'electron']) walk(path.join(root, dir))
  const h = crypto.createHash('sha256')
  for (const file of entries.sort()) { h.update(path.relative(root, file)); h.update('\0'); h.update(fs.readFileSync(file)); h.update('\0') }
  return h.digest('hex')
}
module.exports = { sourceFingerprint }
