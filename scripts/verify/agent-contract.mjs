import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProcess } from './process.mjs'
import { AGENT_AUDIT } from '../audit/agent-contracts.mjs'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const id = process.argv[2]
const spec = AGENT_AUDIT[id]
if (!spec) throw new Error('Unknown agent audit contract')
const result = await runProcess(process.execPath, ['tests/build-test.mjs', spec.test], { cwd: root, timeoutMs: 120000 })
const lines = new Set(result.stdout.split(/\r?\n/))
const cases = Object.entries(spec.cases).map(([name, label]) => ({ case: name, ok: result.ok && lines.has('PASS ' + label) }))
const passed = cases.filter(c => c.ok).length
const dir = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/agent-audit-'))
const artifact = path.join(dir, id + '.json')
await fs.writeFile(path.join(dir, id + '.test.log'), result.out)
await fs.writeFile(artifact, JSON.stringify({ contract: id, samples: cases.length, passed, failed: cases.length - passed, cases, process: { ok: result.ok, exitCode: result.exitCode } }, null, 2))
console.log(`AGENT_AUDIT samples=${cases.length} passed=${passed} failed=${cases.length - passed}`)
console.log('artifact=' + path.relative(root, artifact).replaceAll('\\', '/'))
if (!result.ok || passed !== cases.length) process.exitCode = 1
