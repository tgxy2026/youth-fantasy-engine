import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { launchWindowsAcpJob, verifyWindowsJobGone } from '../../scripts/agent-host/acp-job.mjs'

const runId = randomBytes(16).toString('hex')
const moduleUrl = new URL('../../scripts/agent-host/acp-job.mjs', import.meta.url).href
const childCode = "const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)']);console.log(child.pid);setInterval(()=>{},1000)"
const childArgs = '-e "' + childCode + '"'
const host = spawn(process.execPath, ['--input-type=module', '-e', `
  import { launchWindowsAcpJob } from ${JSON.stringify(moduleUrl)}
  const job = launchWindowsAcpJob({
    runId:${JSON.stringify(runId)}, binary:process.execPath, cwd:process.cwd(), env:process.env,
    childArguments:${JSON.stringify(childArgs)},
  })
  job.output.pipe(process.stdout)
  job.input.on('error',()=>{})
  await job.exited
`], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
const exited = once(host, 'close')
let pid
try {
  const [bytes] = await Promise.race([once(host.stdout, 'data'), delay(8000, undefined, { ref: false }).then(() => { throw new Error('Job fixture timed out') })])
  pid = Number(String(bytes).trim())
  assert.ok(Number.isInteger(pid) && pid > 0)
  process.kill(pid, 0)
} finally {
  host.kill()
  await exited
  await verifyWindowsJobGone(runId)
}
assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
console.log('PASS Windows Job removes grandchild after host termination')

const invalidRun = randomBytes(16).toString('hex')
const output = []
const rejected = launchWindowsAcpJob({
  runId: invalidRun, binary: process.execPath, cwd: process.cwd(), env: process.env,
  childArguments: '-e "console.log(1)"',
  sandbox: { user: 'invalid-user', sid: 'invalid-sid', credentialFile: 'invalid-path' },
})
rejected.output.on('data', chunk => output.push(chunk))
rejected.input.on('error', () => {})
const rejectedResult = await rejected.exited
assert.equal(rejectedResult.code, 1)
assert.equal(rejectedResult.failure, null)
assert.deepEqual(output, [], 'An invalid sandbox identity must not launch under the host account')
await verifyWindowsJobGone(invalidRun)
console.log('PASS Invalid sandbox configuration cannot start a same-user process')
