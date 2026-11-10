import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const names = ['MCP第三方开发者适配规范.md', 'API与Agent互斥模式设计.md', 'README.md']
const read = file => readFileSync(path.join(root, file), 'utf8')
const check = (ok, message) => { if (!ok) throw new Error(`Agent docs: ${message}`) }
const desktop = read('electron-builder.yml')
const portable = read('scripts/build-portable-pkg.mjs')
for (const name of names) {
  const rel = `docs/agent/${name}`
  check(existsSync(path.join(root, rel)), `missing ${rel}`)
  check(desktop.includes(`from: ${rel}`) && desktop.includes(`to: ${rel}`), `desktop mapping ${rel}`)
  check(portable.includes(`'docs', 'agent', '${name}'`), `portable mapping ${rel}`)
}
check(read('src/lib/aiCore/backend/bridgeConfig.ts').includes(`docs/agent/${names[0]}`), 'connection prompt path')
check(read(`docs/agent/${names[0]}`).includes(`](${names[1]})`), 'mode design link')
check(read('README.md').includes(`docs/agent/${names[0]}`), 'discovery link')
console.log('Agent document paths verified')
