import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Keep all eleven historical paths and positional root arguments. Back up before replacing old implementations. */
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const target = path.join(root, '.workbuddy/tmp')
fs.mkdirSync(target, { recursive: true })
const names = ['scan', 'dead', 'graph', 'arch', 'content', 'prompt', 'ui', 'func', 'sec', 'coverage', 'label-consistency', 'platform']
const backup = path.join(target, `audit-entrypoints-backup-${Date.now()}`)
for (const name of names) {
  const dest = path.join(target, `audit-${name}.mjs`)
  if (fs.existsSync(dest) && !fs.readFileSync(dest, 'utf8').includes('YFE_AUDIT_COMPAT_ENTRY')) {
    if (!process.argv.includes('--replace')) throw new Error(`Existing entrypoint preserved: ${dest}. Use --replace to back up and upgrade.`)
    fs.mkdirSync(backup, { recursive: true })
    fs.copyFileSync(dest, path.join(backup, path.basename(dest)))
  }
  const text = name === 'platform' ? `// YFE_AUDIT_COMPAT_ENTRY — additional specialised entry; historical eleven paths unchanged.
await import('../../scripts/audit/platform/run.mjs')
` : `// YFE_AUDIT_COMPAT_ENTRY — historical filename, arguments and base output are preserved.
import path from 'node:path'
import {fileURLToPath} from 'node:url'
const root = path.resolve(process.argv[2] || fileURLToPath(new URL('../..', import.meta.url)))
if (!process.argv[2]) process.argv[2] = root
await import('../../scripts/audit/legacy/audit-${name}.mjs')
`
  fs.writeFileSync(dest, text, 'utf8')
}
console.log('11 historical entrypoints retained; platform entry added in .workbuddy/tmp; previous files backed up when replaced.')
