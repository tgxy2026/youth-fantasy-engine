// 真实服务进程：默认重启尽量保留页面原地址，端口被占时安全回退，显式参数优先。
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import net, { type AddressInfo } from 'node:net'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = process.cwd()
const dir = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/portable-restart-port-'))
const data = path.join(dir, 'data')
await fs.mkdir(data)
await fs.mkdir(path.join(dir, 'dist'))
await fs.writeFile(path.join(dir, 'dist/index.html'), '<html>isolated</html>')
const realDir = await fs.realpath(data)
const identity = createHash('sha256').update(process.platform === 'win32' ? realDir.toLowerCase() : realDir).digest('hex')
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function freePort() {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
let child: ChildProcess | undefined
let blocker: net.Server | undefined
async function start(port?: number) {
  const args = [path.join(root, 'scripts/portable-server.mjs'), '--root', dir, '--no-open']
  if (port) args.push('--port', String(port))
  let log = ''
  child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout?.on('data', chunk => { log += String(chunk) })
  child.stderr?.on('data', chunk => { log += String(chunk) })
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`service exited: ${child.exitCode}; ${log}`)
    try {
      const current = Number(await fs.readFile(path.join(data, '.port'), 'utf8'))
      const response = await fetch(`http://127.0.0.1:${current}/api/ping`, { signal: AbortSignal.timeout(500) })
      const ping = await response.json() as { instanceIdentity?: string }
      if (response.ok && ping.instanceIdentity === identity) return current
    } catch { /* 尚未启动，或 .port 是上次留下的记录 */ }
    await delay(100)
  }
  throw new Error('service did not start')
}
async function stop() {
  if (!child || child.exitCode !== null) return
  const process = child
  child = undefined
  const closed = new Promise<void>(resolve => process.once('close', () => resolve()))
  process.kill()
  await closed
}
try {
  const initial = await freePort()
  assert.equal(await start(initial), initial)
  assert.equal(Number(await fs.readFile(path.join(data, '.last-port'), 'utf8')), initial)
  await stop()
  assert.equal(await start(), initial, 'default restart should retain previous origin')
  await stop()

  blocker = net.createServer(socket => {
    socket.on('error', () => undefined)
    socket.once('data', () => socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'))
  })
  await new Promise<void>((resolve, reject) => { blocker!.once('error', reject); blocker!.listen(initial, '127.0.0.1', resolve) })
  const fallback = await start()
  assert.notEqual(fallback, initial, 'occupied previous port must not be reused')
  assert.equal(Number(await fs.readFile(path.join(data, '.last-port'), 'utf8')), fallback)
  await stop()
  await new Promise<void>(resolve => blocker!.close(() => resolve()))
  blocker = undefined
  assert.equal(await start(), fallback, 'restart should retain the successful fallback port')
  await stop()

  const explicit = await freePort()
  assert.equal(await start(explicit), explicit, 'explicit port must override remembered port')
  await stop()
  await fs.writeFile(path.join(data, '.last-port'), 'not-a-port')
  const recovered = await start()
  assert.ok(recovered > 0 && recovered <= 65535, 'corrupt preference must not prevent startup')
  console.log('PORTABLE_RESTART_PORT_PASS: stable restart, occupied fallback, explicit override, corrupt preference')
} finally {
  await stop()
  if (blocker?.listening) await new Promise<void>(resolve => blocker!.close(() => resolve()))
}
