import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const root = process.cwd(), fixture = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/audit-function-scope-'))
const orphanRelative = ['src', 'components', 'Orphan.tsx'].join('/')
await fs.mkdir(path.join(fixture, 'src/components'), { recursive: true })
await fs.mkdir(path.join(fixture, 'src/lib'), { recursive: true })
await fs.mkdir(path.join(fixture, '.workbuddy/tmp'), { recursive: true })
await fs.mkdir(path.join(fixture, 'release-build'), { recursive: true })
await fs.writeFile(path.join(fixture, orphanRelative), "import { aiChatJson } from '../lib/ai'; export function Unwired(){ return <button onClick={() => aiChatJson()}>run</button> }")
await fs.writeFile(path.join(fixture, 'src/lib/ai.ts'), 'export async function aiChatJson(){ return null }')
for (const file of ['.workbuddy/tmp/old-build.js', 'release-build/old-build.js']) await fs.writeFile(path.join(fixture, file), 'ARTIFACT_ONLY_NOT_SOURCE')
const preload = path.join(fixture, 'guard.mjs'), trace = path.join(fixture, 'reads.json')
await fs.writeFile(preload, `import fs from 'node:fs'; import path from 'node:path';
const root=${JSON.stringify(fixture)}, trace=${JSON.stringify(trace)}, reads=[];
for(const name of ['readFileSync','readdirSync']){
 const native=fs[name]; fs[name]=function(file,...args){
  if(typeof file==='string'){
   const relative=path.relative(root,path.resolve(file)).replaceAll('\\\\','/');
   if(relative.startsWith('.workbuddy/')||relative.startsWith('release-build/')) throw Error('Generated artifact scan: '+relative);
   if(relative.startsWith('src/')) reads.push(relative);
  }
  return native.call(this,file,...args);
 }
}
process.on('exit',()=>fs.writeFileSync(trace,JSON.stringify(reads)));
`)
const { stdout } = await promisify(execFile)(process.execPath, ['--import', pathToFileURL(preload).href, path.join(root, 'scripts/audit/legacy/audit-func.mjs'), fixture], { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 })
const reads = JSON.parse(await fs.readFile(trace, 'utf8')) as string[]
assert.ok(reads.includes(orphanRelative) && reads.includes('src/lib/ai.ts'))
assert.ok(stdout.includes('Orphan.tsx') && stdout.includes('Unwired'), 'AI guard and orphan checks still inspect real UI source')
assert.ok(stdout.includes('F3.') && stdout.includes('F4.') && stdout.includes('AST'), 'all functional rule families and AST supplement remain active')
assert.ok(!stdout.includes('ARTIFACT_ONLY_NOT_SOURCE'))
console.log('PASS all functional checks retain their source scope without reading generated evidence/build trees')
