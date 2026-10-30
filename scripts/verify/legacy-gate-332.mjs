// P2-4 · 旧路径门禁端到端自检（真服务 + 临时数据目录）
// 用法：node scripts/verify/legacy-gate-332.mjs
//
// 验的是「迁移后旧客户端还能读、但写不进去」这一件事：
//   读/导出照常（用户要能把自己东西带走），写一律 409 LEGACY_WRITE_BLOCKED。
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { blockLegacyWrites, unblockLegacyWrites, readLegacyGate } from '../../server/lib/legacyGate.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverEntry = path.resolve(here, '../../server/index.mjs')

const PORT = 18735
const root = mkdtempSync(path.join(os.tmpdir(), 'yfe-gate-'))
const dataDir = path.join(root, 'data')
const wwwDir = path.join(root, 'www')
mkdirSync(dataDir, { recursive: true })
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
    async req(method, url, body) {
      const headers = {}
      if (this.cookie) headers.cookie = this.cookie
      let payload
      if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body) }
      const res = await fetch(base + url, { method, headers, body: payload })
      for (const c of res.headers.getSetCookie?.() || []) {
        const [pair] = c.split(';')
        if (pair.startsWith('yfe_sid=')) this.cookie = pair
      }
      let json = null
      if ((res.headers.get('content-type') || '').includes('application/json')) {
        try { json = await res.json() } catch { /* ignore */ }
      }
      return { status: res.status, json, etag: res.headers.get('etag') }
    },
  }
}

const server = spawn(process.execPath, [serverEntry], {
  cwd: root,
  env: {
    ...process.env, PORT: String(PORT), YFE_DATA: dataDir, YFE_WWW: wwwDir,
    YFE_REGISTER: 'open', YFE_STATS: path.join(root, 'stats.log'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
server.stdout.on('data', (d) => { log += d })
server.stderr.on('data', (d) => { log += d })
const cleanup = () => {
  try { server.kill('SIGKILL') } catch { /* ignore */ }
  try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
}
process.on('exit', cleanup)

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/api/ping')).ok) return true } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

const doc = (text) => JSON.stringify({ app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 2, savedAt: 1, stores: { chapters: { a: { id: 'a', text } } } })

try {
  if (!(await waitReady())) throw new Error('服务未启动：\n' + log)

  const web = client()
  const reg = await web.req('POST', '/api/auth/register', { name: '门禁用户', password: 'pass1234' })
  const uid = reg.json?.user?.id
  ok('注册并拿到账号', reg.status === 200 && !!uid, reg.json)

  // 1. 门禁未开：旧整库写可用（现状行为不变）
  //    新账号还没有 data.json ⇒ 先 GET 拿到初始 revision，再带 If-Match（与真实客户端一致）
  const boot = await web.req('GET', '/api/data')
  const rev0 = boot.json?.revision || boot.etag || ''
  const firstRes = await fetch(base + '/api/data', {
    method: 'PUT',
    headers: { cookie: web.cookie, 'content-type': 'application/json', 'if-match': String(rev0) },
    body: doc('v1'),
  })
  const etag1 = firstRes.headers.get('etag')
  ok('门禁未开时整库写正常', firstRes.status === 200 && !!etag1, { status: firstRes.status, rev0 })

  // 2. 开启门禁
  blockLegacyWrites(v2Root, uid, { note: '自检：模拟迁移完成' })

  const blockedPut = await fetch(base + '/api/data', {
    method: 'PUT',
    headers: { cookie: web.cookie, 'content-type': 'application/json', 'if-match': etag1 },
    body: doc('v2-should-not-land'),
  })
  const blockedJson = await blockedPut.json().catch(() => null)
  ok('门禁后整库写被拒 409', blockedPut.status === 409 && blockedJson?.code === 'LEGACY_WRITE_BLOCKED', blockedJson)
  ok('拒绝回执给出可做的事', typeof blockedJson?.hint === 'string' && blockedJson.error.length > 0, blockedJson)

  const beacon = await fetch(base + '/api/data', {
    method: 'POST',
    headers: { cookie: web.cookie, 'content-type': 'application/json', 'if-match': etag1 },
    body: doc('beacon-should-not-land'),
  })
  ok('门禁后 beacon（POST）同样被拒', beacon.status === 409, beacon.status)

  // 3. 读仍然放行，且内容没被改写
  const read = await web.req('GET', '/api/data')
  ok('门禁后仍可读（用户要能导出）', read.status === 200, read.status)
  ok('被拒的写入没有落盘', JSON.stringify(read.json).includes('v1') && !JSON.stringify(read.json).includes('should-not-land'))

  // 4. blob 写/删同样被拒；读放行
  const blobPut = await web.req('PUT', '/api/blob?store=vecRows&id=x', { vec: [1, 2, 3] })
  ok('门禁后 blob 写被拒 409', blobPut.status === 409 && blobPut.json?.code === 'LEGACY_WRITE_BLOCKED', blobPut.json)
  const blobDel = await web.req('DELETE', '/api/blob?store=vecRows&id=x')
  ok('门禁后 blob 删也被拒 409', blobDel.status === 409, blobDel.status)
  const blobGet = await web.req('GET', '/api/blob?store=vecRows&id=x')
  ok('门禁后 blob 读不被拦（404 而非 409）', blobGet.status === 404 || blobGet.status === 200, blobGet.status)

  // 5. /api/auth/me 提前告知
  const me = await web.req('GET', '/api/auth/me')
  ok('/api/auth/me 带 legacyWriteBlocked=true', me.json?.legacyWriteBlocked === true, me.json)

  // 6. 解除后可写
  unblockLegacyWrites(v2Root, uid, { note: '自检：回滚' })
  const reopened = await fetch(base + '/api/data', {
    method: 'PUT',
    headers: { cookie: web.cookie, 'content-type': 'application/json', 'if-match': etag1 },
    body: doc('v3-after-unblock'),
  })
  ok('解除门禁后可以写回', reopened.status === 200, reopened.status)

  // 7. 全局急停
  ok('全局急停优先于账号状态', (() => {
    process.env.YFE_LEGACY_WRITE = 'block'
    const g = readLegacyGate(v2Root, uid)
    delete process.env.YFE_LEGACY_WRITE
    return g.blocked === true && g.source === 'global'
  })(), readLegacyGate(v2Root, uid))
} catch (e) {
  fails.push({ name: '未预期异常', extra: e instanceof Error ? e.message : String(e) })
  console.log('FAIL 未预期异常 — ' + (e instanceof Error ? e.message : String(e)))
} finally {
  cleanup()
}

console.log('')
if (fails.length) {
  console.log(`FAILED ${fails.length} / ${passed + fails.length}`)
  console.log(JSON.stringify(fails, null, 2))
  if (log) console.log('--- server log ---\n' + log.slice(-2000))
  process.exit(1)
}
console.log(`OK ${passed}/${passed}（${new Date().toISOString()}，Node ${process.version}）`)
process.exit(0)
