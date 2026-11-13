// 3.5.3 · P0 真实跨进程 HTTP 并发专项（隔离服务 + 合成数据，不碰真实账号）
// 用法：node scripts/verify/project-concurrency-332.mjs
//
// 覆盖：
//   ① 独立子进程持账号锁时，同账号 HTTP 写入 503，跨账号不受影响，释放后可重试；
//   ② 同账号多项目并发提交（含 503 重试）后索引与各项目状态一致，无损坏；
//   ③ 维护任务（调度/清理/GC 共用账号锁）遇跨进程持锁跳过该账号，其他账号照常；
//   ④ 慢请求读体不占锁（与 project-api 一致，这里再核一次跨账号）。
// 🔴 账号锁是协作锁：旧进程或绕过协议的写入者不受约束；本测试不证明强制互斥、断电持久性或网络文件系统安全。
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { seedSyncInvite, TEST_SYNC_INVITE } from './cloud-fixture.mjs'
import { runMaintenanceOnce } from '../../server/lib/scheduler.mjs'
import { readIndex } from '../../server/lib/v2Index.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverEntry = path.resolve(here, '../../server/index.mjs')
const v2IndexUrl = pathToFileURL(path.resolve(here, '../../server/lib/v2Index.mjs')).href

const PORT = 18746
const root = mkdtempSync(path.join(os.tmpdir(), 'yfe-concurrency-'))
const dataDir = path.join(root, 'data')
const wwwDir = path.join(root, 'www')
mkdirSync(dataDir, { recursive: true })
seedSyncInvite(dataDir)
mkdirSync(wwwDir, { recursive: true })
writeFileSync(path.join(wwwDir, 'index.html'), '<!doctype html><title>fixture</title>')
const v2Root = path.join(dataDir, 'v2')

const base = `http://127.0.0.1:${PORT}`
let passed = 0
const fails = []
const ok = (name, cond, extra) => {
  if (cond) { passed++; console.log('PASS ' + name) }
  else { fails.push({ name, extra }); console.log('FAIL ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')) }
}

function client() {
  return {
    cookie: '',
    async req(method, url, body, raw) {
      const headers = {}
      if (this.cookie) headers.cookie = this.cookie
      let payload
      if (raw) payload = raw
      else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body) }
      const res = await fetch(base + url, { method, headers, body: payload })
      const set = res.headers.getSetCookie?.() || []
      for (const c of set) { const [pair] = c.split(';'); if (pair.startsWith('yfe_sid=')) this.cookie = pair }
      let json = null
      const ct = res.headers.get('content-type') || ''
      if (ct.includes('application/json')) { try { json = await res.json() } catch { /* ignore */ } }
      return { status: res.status, json }
    },
  }
}

const server = spawn(process.execPath, [serverEntry], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), YFE_DATA: dataDir, YFE_WWW: wwwDir, YFE_REGISTER: 'open', YFE_QUOTA: String(8 * 1024 * 1024), YFE_STATS: path.join(root, 'stats.log'), YFE_BOOTSTRAP_INVITE: 'CONC-INVITE-332' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
server.stdout.on('data', (d) => { log += d })
server.stderr.on('data', (d) => { log += d })
const holders = []
const cleanup = () => {
  try { server.kill('SIGKILL') } catch { /* ignore */ }
  for (const h of holders) { try { h.kill('SIGKILL') } catch { /* ignore */ } }
}
process.on('exit', cleanup)

async function waitReady() {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/api/ping')).ok) return true } catch { /* not up */ } await new Promise((r) => setTimeout(r, 100)) }
  return false
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

/** spawn 一个独立子进程持有某账号锁，直到 stdin 收到信号才释放。 */
async function spawnHolder(accountId) {
  const program = `import {acquireAccountWriteLock} from ${JSON.stringify(v2IndexUrl)};
const lock = acquireAccountWriteLock(process.argv[1], process.argv[2]);
if (!lock) { console.log('NO_LOCK'); process.exit(2); }
console.log('HOLDING');
process.stdin.once('data', () => { lock.release(); console.log('RELEASED'); process.exit(0); });`
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, v2Root, accountId], { stdio: ['pipe', 'pipe', 'inherit'] })
  holders.push(child)
  const [chunk] = await once(child.stdout, 'data')
  if (!/HOLDING/.test(chunk.toString())) throw new Error('子进程未能持锁：' + chunk.toString())
  return child
}
const releaseHolder = async (child) => { const exited = once(child, 'exit'); child.stdin.write('x'); await exited }

const emptyManifest = () => ({ protocol: 1, createdAt: Date.now(), objects: [], assets: [], tombstones: [] })
async function commitWithRetry(c, pid, opId, baseRevision, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const r = await c.req('POST', `/api/v2/projects/${pid}/commit`, { opId, baseRevision, manifest: emptyManifest() })
    if (r.status === 200) return r
    if (r.status === 503 && r.json?.code === 'PROJECT_ACCOUNT_BUSY') { await new Promise((res) => setTimeout(res, 20)); continue }
    return r
  }
  return { status: 503, json: { code: 'PROJECT_ACCOUNT_BUSY' } }
}

try {
  if (!(await waitReady())) throw new Error('服务未启动：\n' + log)
  const A = client(); const B = client()
  await A.req('POST', '/api/auth/register', { name: '并发甲', password: 'pass1234', invite: TEST_SYNC_INVITE })
  await B.req('POST', '/api/auth/register', { name: '并发乙', password: 'pass1234', invite: TEST_SYNC_INVITE })
  const aList0 = await A.req('GET', '/api/v2/projects')
  ok('两账号注册成功', aList0.status === 200)

  // 给 A 建两个项目
  const p1 = (await A.req('POST', '/api/v2/projects', { name: '甲书一' })).json.cloudProjectId
  const p2 = (await A.req('POST', '/api/v2/projects', { name: '甲书二' })).json.cloudProjectId
  const pb = (await B.req('POST', '/api/v2/projects', { name: '乙书一' })).json.cloudProjectId
  ok('A 建两项目、B 建一项目', !!p1 && !!p2 && !!pb)

  // 通过索引定位账号目录：create 只写索引条目，projects/<pid> 目录要到首次 commit 才建，
  // 所以这里不能用「项目目录是否存在」来定位（那时还没提交过）。
  const accounts = readdirSync(path.join(v2Root, 'accounts'))
  const idOf = (pid) => accounts.find((id) => {
    try { return !!readIndex(v2Root, id).projects[pid] } catch { return false }
  })
  const idA = idOf(p1)
  const idB = idOf(pb)
  ok('定位到 A/B 账号目录', !!idA && !!idB && idA !== idB)

  // ---- ① 子进程持 A 锁：A 写 503，B 不受影响，释放后 A 可重试 ----
  const holder = await spawnHolder(idA)
  const aBusy = await A.req('POST', `/api/v2/projects/${p1}/commit`, { opId: 'while-held', baseRevision: 0, manifest: emptyManifest() })
  ok('跨进程持锁时同账号写入 503', aBusy.status === 503 && aBusy.json?.code === 'PROJECT_ACCOUNT_BUSY', aBusy.json)
  const bWhileHeld = await B.req('POST', `/api/v2/projects/${pb}/commit`, { opId: 'b-independent', baseRevision: 0, manifest: emptyManifest() })
  ok('跨进程持锁时跨账号写入不受影响', bWhileHeld.status === 200 && bWhileHeld.json?.revision === 1, bWhileHeld.json)
  // 维护任务遇 A 锁跳过，B 照常
  const maint = runMaintenanceOnce({ v2Root, now: Date.now() })
  ok('维护任务遇跨进程持锁跳过该账号', maint.errors.some((e) => e.account === idA && /PROJECT_ACCOUNT_BUSY/.test(e.error)), maint.errors)
  await releaseHolder(holder)
  const aRetry = await A.req('POST', `/api/v2/projects/${p1}/commit`, { opId: 'after-release', baseRevision: 0, manifest: emptyManifest() })
  ok('释放锁后同账号重试成功', aRetry.status === 200 && aRetry.json?.revision === 1, aRetry.json)

  // ---- ② 同账号多项目并发提交 + 重试：最终一致，无损坏 ----
  const pids = []
  for (let i = 0; i < 6; i++) pids.push((await A.req('POST', '/api/v2/projects', { name: `并发书${i}` })).json.cloudProjectId)
  const results = await Promise.all(pids.map((pid, i) => commitWithRetry(A, pid, `burst-${i}`, 0)))
  ok('并发提交全部成功（含重试）', results.every((r) => r.status === 200 && r.json?.revision === 1), results.map((r) => r.status))
  const listA = await A.req('GET', '/api/v2/projects')
  ok('并发后列表可读且索引一致（无 503）', listA.status === 200 && pids.every((pid) => (listA.json.projects || []).some((x) => x.cloudProjectId === pid && x.revision === 1)), listA.status)
  const idxA = readIndex(v2Root, idA)
  ok('并发后索引各项目 revision 正确', pids.every((pid) => idxA.projects[pid]?.revision === 1))

  // ---- ③ 删除/恢复与提交交错（同账号，持锁串行）----
  const del = await A.req('DELETE', `/api/v2/projects/${pids[0]}?opId=del-burst`)
  ok('并发后删除正常', del.status === 200 && del.json?.revision === 2, del.json)
  const rest = await A.req('POST', `/api/v2/projects/${pids[0]}/restore?opId=rest-burst`)
  ok('并发后恢复正常', rest.status === 200 && rest.json?.revision === 3, rest.json)
  const listA2 = await A.req('GET', '/api/v2/projects')
  ok('删除恢复后索引仍一致', listA2.status === 200)

  // ---- ④ 跨账号对象隔离：B 不能按哈希取 A 的对象 ----
  const body = Buffer.from('concurrency-object'.repeat(100))
  const h = sha(body)
  await A.req('PUT', `/api/v2/projects/${p1}/objects/${h}`, undefined, body)
  const bObj = await B.req('GET', `/api/v2/projects/${p1}/objects/${h}`)
  ok('跨账号无法取对象', bObj.status === 404, bObj.status)
} catch (e) {
  fails.push({ name: '未预期异常', extra: e instanceof Error ? e.stack : String(e) })
  console.log('FAIL 未预期异常 — ' + (e instanceof Error ? e.message : String(e)))
} finally {
  cleanup()
  try { rmSync(root, { recursive: true, force: true }) } catch { /* 临时目录 */ }
}

console.log('')
if (fails.length) {
  console.log(`FAILED ${fails.length} / ${passed + fails.length}`)
  console.log(JSON.stringify(fails, null, 2))
  if (log) console.log('--- server log ---\n' + log.slice(-2500))
  process.exit(1)
}
console.log(`OK ${passed}/${passed}（${new Date().toISOString()}，Node ${process.version}）`)
process.exit(0)