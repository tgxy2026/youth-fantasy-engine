// Run under the desktop account against a separately provisioned disposable
// standard account. Pass paths to synthetic fixtures and a DPAPI credential file.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { launchWindowsAcpJob } from '../agent-host/acp-job.mjs'

const [user, sid, credentialFile, nodeExe, workDirectory, privateCanary, componentCanary] = process.argv.slice(2)
assert.equal(process.platform, 'win32')
assert.match(user ?? '', /^YFEACP-[a-f0-9]{10}$/)
for (const file of [credentialFile, nodeExe, workDirectory, privateCanary, componentCanary]) {
  assert.ok(file && path.isAbsolute(file), 'All fixture paths must be absolute')
}

const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex')
const originalPrivate = await digest(privateCanary)
const originalComponent = await digest(componentCanary)
const workFile = path.join(workDirectory, 'synthetic-' + randomBytes(8).toString('hex') + '.txt')
const fixture = workFile + '.cjs'
const system = process.env.SystemRoot ?? 'C:\\Windows'
const sample = randomBytes(12).toString('hex')
const checkFiles = `
  const fs = require('node:fs')
  function denied(action) {
    try { action(); return false }
    catch (error) { return error.code === 'EACCES' || error.code === 'EPERM' }
  }
  const privateFile = process.env.YFE_PRIVATE_CANARY
  const component = process.env.YFE_COMPONENT_CANARY
  const checks = {
    privateRead: denied(() => fs.readFileSync(privateFile)),
    privateWrite: denied(() => fs.closeSync(fs.openSync(privateFile, 'r+'))),
    componentRead: fs.readFileSync(component).length > 0,
    componentWrite: denied(() => fs.closeSync(fs.openSync(component, 'r+'))),
  }
`
const payload = checkFiles + `
  if (process.argv[2] === 'descendant') {
    console.log(JSON.stringify(checks))
  } else {
    const child = require('node:child_process').spawnSync(process.execPath, [__filename, 'descendant'], { encoding: 'utf8' })
    const input = fs.readFileSync(0, 'utf8')
    fs.writeFileSync(process.env.YFE_WORK_CANARY, input, { flag: 'wx' })
    console.error('synthetic-stderr')
    console.log(JSON.stringify({ checks, child: JSON.parse(child.stdout), input }))
  }
`
const errors = []
const output = []
await writeFile(fixture, payload, { flag: 'wx' })
const job = launchWindowsAcpJob({
  runId: randomBytes(16).toString('hex'), binary: nodeExe, cwd: workDirectory,
  childArguments: `"${fixture}"`,
  sandbox: { user, sid, credentialFile },
  env: {
    SystemRoot: system, WINDIR: system, PATH: path.join(system, 'System32'),
    YFE_PRIVATE_CANARY: privateCanary, YFE_COMPONENT_CANARY: componentCanary,
    YFE_WORK_CANARY: workFile,
  },
  onStderr: bytes => errors.push(bytes),
})
job.output.on('data', bytes => output.push(bytes))
job.input.on('error', () => {})
job.input.end(sample)
try {
  const exit = await Promise.race([job.exited, delay(25_000, null, { ref: false })])
  assert.equal(exit?.code, 0, Buffer.concat(errors).toString().trim())
  assert.match(Buffer.concat(errors).toString(), /synthetic-stderr/)
  const result = JSON.parse(Buffer.concat(output).toString())
  const deniedAndAllowed = { privateRead: true, privateWrite: true, componentRead: true, componentWrite: true }
  assert.deepEqual(result.checks, deniedAndAllowed)
  assert.deepEqual(result.child, deniedAndAllowed)
  assert.equal(result.input, sample)
  assert.equal(await readFile(workFile, 'utf8'), sample)
  assert.equal(await digest(privateCanary), originalPrivate)
  assert.equal(await digest(componentCanary), originalComponent)
  console.log('PASS synthetic stdio, workspace write, private file denial, read-only component and child access')
} finally {
  await job.stop()
  await Promise.all([fixture, workFile].map(file => rm(file, { force: true })))
}
