import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import type { AddressInfo } from 'node:net'

const root = await fs.mkdtemp(path.resolve('.workbuddy/tmp/cloud-conditional-test-'))
const data = path.join(root, 'data'), www = path.join(root, 'www')
await fs.mkdir(data); await fs.mkdir(www); await fs.writeFile(path.join(www, 'index.html'), '<html><head></head><body>fixture</body></html>')
const listener = http.createServer()
await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
const port = (listener.address() as AddressInfo).port
await new Promise<void>(resolve => listener.close(() => resolve()))
const origin = 'http://127.0.0.1:' + port
const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), YFE_DATA: data, YFE_WWW: www, YFE_REGISTER: 'open', YFE_BOOTSTRAP_INVITE: '' }
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_OPTIONS']) delete (env as Record<string, string | undefined>)[key]
let server: ChildProcess | undefined, serverLog = '', passed = 0
const check = (name: string, ok: boolean) => { assert.ok(ok, name); passed++; console.log('PASS ' + name) }
const realFetch = globalThis.fetch
async function until(test: () => Promise<boolean>, timeout = 30000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 30)) }
  throw new Error('Timed out')
}
async function start() {
  server = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout?.on('data', bytes => { serverLog += bytes }); server.stderr?.on('data', bytes => { serverLog += bytes })
  await until(async () => { try { return (await realFetch(origin + '/api/ping')).ok } catch { return false } })
}
async function stop() {
  if (!server || server.exitCode !== null) return
  const closed = new Promise<void>(resolve => server!.once('close', () => resolve()))
  server.kill(); await closed
}
const PASSWORD = 'ProbeCas123!temporary'
async function auth(name: string, action = 'register') {
  const response = await realFetch(origin + '/api/auth/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, password: PASSWORD }) })
  assert.equal(response.status, 200, await response.text())
  return response.headers.get('set-cookie')!.split(';')[0]
}
const read = (cookie: string) => realFetch(origin + '/api/data', { headers: { Cookie: cookie } })
const document = (value: string) => JSON.stringify({ app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 2, savedAt: 1, stores: { meta: [{ key: 'draft', value }] } })
const write = (cookie: string, body: string, revision?: string, method = 'PUT') => realFetch(origin + '/api/data', { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(revision ? { 'If-Match': revision } : {}) }, body })
let relay: http.Server | undefined
try {
  await start()
  const a = await auth('probe-cas-a'), b = await auth('probe-cas-b')
  const emptyA = await read(a), emptyB = await read(b)
  const rev0 = emptyA.headers.get('etag')!
  check('首次空库也有版本且按账号绑定', emptyA.status === 404 && !!rev0 && rev0 !== emptyB.headers.get('etag'))
  const first = await write(a, document('initial'), rev0)
  check('首次条件写通过且版本变化', first.status === 200 && first.headers.get('etag') !== rev0)
  const rev1 = first.headers.get('etag')!
  const noCondition = await write(a, document('old-client'))
  const beacon = await write(a, document('old-beacon'), undefined, 'POST')
  check('旧客户端PUT和无条件beacon均拒绝', noCondition.status === 428 && beacon.status === 428)
  check('拒绝后磁盘正文不变', (await (await read(a)).json()).text === document('initial'))
  const pair = await Promise.all([write(a, document('A'.repeat(150000)), rev1), write(a, document('B'.repeat(150000)), rev1)])
  check('同时持有同基线的两请求只准一个提交', pair.filter(item => item.status === 200).length === 1 && pair.filter(item => item.status === 409).length === 1)
  const winner = await read(a), currentRevision = winner.headers.get('etag')!
  const winnerText = (await winner.json()).text as string
  check('获胜正文和响应版本对应', [document('A'.repeat(150000)), document('B'.repeat(150000))].includes(winnerText) && pair.find(item => item.status === 200)!.headers.get('etag') === currentRevision)
  check('陈旧POST同样拒绝', (await write(a, document('stale-exit'), rev1, 'POST')).status === 409)
  check('跨账号版本不能写入另一账号', (await write(b, document('cross-account'), currentRevision)).status === 409 && (await read(b)).status === 404)
  await stop(); await start()
  check('服务重启不更改既有版本或格式', (await read(a)).headers.get('etag') === currentRevision && (await (await read(a)).json()).text === winnerText)
  check('重启后旧版本仍拒绝', (await write(a, document('stale-after-restart'), rev1)).status === 409)
  const storedPath = (await (await read(a)).json()).path as string
  const kept = storedPath + '.io-fixture'
  await fs.rename(storedPath, kept); await fs.mkdir(storedPath)
  try {
    check('读取故障返回500且服务继续运行', (await read(a)).status === 500 && (await realFetch(origin + '/api/ping')).ok)
    check('故障写返回500且不伪造新版本', (await write(a, document('failed-io'), currentRevision)).status === 500)
  } finally { await fs.rmdir(storedPath); await fs.rename(kept, storedPath) }
  check('异常队列释放后可按原基线重试', (await write(a, winnerText, currentRevision)).status === 200)

  // A real TCP request whose body remains incomplete across **会话撤销** must not commit.
  //
  // 🔴 3.3.2 契约变更（2026-10-30）：旧版这里用「另一处登录」触发，因为旧实现是**单会话**
  //    —— 新登录直接顶掉本设备的令牌。3.3.2 起一个账号可多设备同时在线（这是本版的目的），
  //    「别处登录」不再使本设备失效，所以同一个安全属性换成新模型下的等价触发：
  //    **原会话被显式撤销**。判据本身没变：提交点必须重新鉴权，失效会话不得落库。
  const pending = http.request(origin + '/api/data', { method: 'PUT', headers: { Cookie: a, 'If-Match': currentRevision, 'Content-Type': 'application/json' } })
  const response = new Promise<number>(resolve => pending.on('response', res => { res.resume(); res.on('end', () => resolve(res.statusCode!)) }))
  const lateBody = document('late-session-write')
  pending.write(lateBody.slice(0, 20))
  const freshCookie = await auth('probe-cas-a', 'login')
  const sessionList = await (await realFetch(origin + '/api/auth/sessions', { headers: { Cookie: freshCookie } })).json() as { sessions: { sid: string; current: boolean }[] }
  const oldSid = sessionList.sessions.find(item => !item.current)!.sid
  await realFetch(origin + '/api/auth/sessions/revoke', {
    method: 'POST',
    headers: { Cookie: freshCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sid: oldSid }),
  })
  pending.end(lateBody.slice(20))
  check('请求体在途时会话撤销不能落库', await response === 401 && (await (await read(freshCookie)).json()).text === winnerText)

  // Real HTTP relay: drop the socket before or after an actual server commit; never fake a successful response.
  let mode: 'normal' | 'before' | 'after' | 'hold' = 'normal', putCount = 0
  let release = () => {}, entered = () => {}
  relay = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks), isPut = req.method === 'PUT'
    if (isPut) {
      putCount++
      if (mode === 'before') { req.socket.destroy(); return }
      if (mode === 'hold') { entered(); await new Promise<void>(resolve => { release = resolve }) }
    }
    const headers = { Cookie: freshCookie, 'Content-Type': 'application/json', ...(req.headers['if-match'] ? { 'If-Match': String(req.headers['if-match']) } : {}) }
    const reply = await realFetch(origin + (req.url ?? '/api/data'), { method: req.method, headers, ...(isPut ? { body } : {}) })
    const text = await reply.text()
    if (isPut && mode === 'after') { req.socket.destroy(); return }
    res.writeHead(reply.status, { 'Content-Type': 'application/json', ...(reply.headers.get('etag') ? { ETag: reply.headers.get('etag')! } : {}) }); res.end(text)
  })
  await new Promise<void>(resolve => relay!.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + (relay.address() as AddressInfo).port
  const owner = (await (await read(freshCookie)).json()).ownerId as string
  Object.assign(globalThis, { window: { __YFE_PORTABLE__: { apiBase: base }, __YFE_WEB__: true, __YFE_USER__: { id: owner } } })
  const fb = await import('../src/lib/storage/fileBackend')
  await fb.initPortableStore()
  check('真实云端协议前端启动未锁定', !fb.getPortableState().writeLocked)
  mode = 'before'; await fb.portableStore.put('meta', { key: 'draft', value: 'retry-before' })
  check('提交前断连保留dirty', !await fb.flushPortable() && fb.getPortableState().dirty)
  mode = 'normal'
  check('服务端版本未变可直接重试', await fb.flushPortable() && !fb.getPortableState().dirty)
  mode = 'after'; await fb.portableStore.put('meta', { key: 'draft', value: 'committed-no-response' })
  check('实际提交后响应丢失不误报成功', !await fb.flushPortable() && fb.getPortableState().dirty && (await (await read(freshCookie)).json()).text.includes('committed-no-response'))
  mode = 'normal'; await fb.portableStore.put('meta', { key: 'draft', value: 'newer-after-response-loss' })
  check('精确回读确认旧提交后继续保存新输入', await fb.flushPortable() && (await (await read(freshCookie)).json()).text.includes('newer-after-response-loss'))

  mode = 'hold'; const started = new Promise<void>(resolve => { entered = resolve })
  await fb.portableStore.put('meta', { key: 'draft', value: 'inflight-old' })
  const saving = fb.flushPortable(); await started
  await fb.portableStore.put('meta', { key: 'draft', value: 'inflight-new' })
  check('保存仍在途时退出不声称安全', !fb.flushPortableOnLeave() && fb.getPortableState().dirty)
  mode = 'normal'; release(); await saving
  check('旧回执不能清空在途新草稿', fb.getPortableState().dirty)
  check('下一次携带新版本提交新输入', await fb.flushPortable() && (await (await read(freshCookie)).json()).text.includes('inflight-new'))

  const otherBase = await read(freshCookie)
  await write(freshCookie, document('other-window-wins'), otherBase.headers.get('etag')!)
  await fb.portableStore.put('meta', { key: 'draft', value: 'local-conflicting-draft' })
  check('客户端冲突保留dirty并停止保存', !await fb.flushPortable() && fb.getPortableState().saveConflict && fb.getPortableState().dirty)
  check('冲突不覆盖他人正文', (await (await read(freshCookie)).json()).text === document('other-window-wins'))
  check('冲突草稿仍可收集导出', (await fb.portableDataJSON()).includes('local-conflicting-draft'))
  check('导出真实外置目录读取完整', (await fb.portableDataJSONReport()).missing.length === 0)
  const imported = await fb.importPortableData(document('must-not-replace-draft'))
  check('冲突中导入不替换内存草稿', !imported.ok && (await fb.portableDataJSON()).includes('local-conflicting-draft'))
  fb.unlockPortableWrite(); const count = putCount
  await fb.portableStore.put('meta', { key: 'draft', value: 'continued-local-draft' })
  check('通用解锁及手动保存不能绕过版本冲突', !await fb.flushPortable() && fb.getPortableState().saveConflict)
  await new Promise(resolve => setTimeout(resolve, 1000))
  check('冲突后停止自动重试', putCount === count)
  check('退出也不能绕过冲突或清dirty', !fb.flushPortableBeacon() && !fb.flushPortableOnLeave() && fb.getPortableState().dirty)
  console.log('cloudConditionalWrite: ' + passed + ' passed')
} finally {
  await new Promise<void>(resolve => { if (relay) relay.close(() => resolve()); else resolve() })
  await stop()
  await fs.writeFile(path.join(root, 'server.log'), serverLog)
}
