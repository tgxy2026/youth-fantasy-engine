// P2-1 · 项目版本服务 HTTP 端到端自检（真服务 + 临时数据目录，不碰真实账号）
// 用法：node scripts/verify/project-api-332.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverEntry = path.resolve(here, '../../server/index.mjs')

const PORT = 18734
const root = mkdtempSync(path.join(os.tmpdir(), 'yfe-v2-'))
const dataDir = path.join(root, 'data')
const wwwDir = path.join(root, 'www')
mkdirSync(dataDir, { recursive: true })
mkdirSync(wwwDir, { recursive: true })
writeFileSync(path.join(wwwDir, 'index.html'), '<!doctype html><title>fixture</title>')

const base = `http://127.0.0.1:${PORT}`
const QUOTA = 4 * 1024 * 1024
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
      for (const c of set) {
        const [pair] = c.split(';')
        if (pair.startsWith('yfe_sid=')) this.cookie = pair
      }
      let json = null
      const ct = res.headers.get('content-type') || ''
      if (ct.includes('application/json')) { try { json = await res.json() } catch { /* ignore */ } }
      return { status: res.status, json, headers: res.headers }
    },
  }
}

const server = spawn(process.execPath, [serverEntry], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(PORT), YFE_DATA: dataDir, YFE_WWW: wwwDir,
    YFE_REGISTER: 'open', YFE_QUOTA: String(QUOTA),
    YFE_STATS: path.join(root, 'stats.log'),
    YFE_BOOTSTRAP_INVITE: 'V2-INVITE-332',
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

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

try {
  if (!(await waitReady())) throw new Error('服务未启动：\n' + log)

  const web = client()
  const reg = await web.req('POST', '/api/auth/register', { name: 'v2用户', password: 'pass1234' })
  ok('注册并登录', reg.status === 200 && !!web.cookie, reg.status)

  // 未登录必须 401（且不能落任何字节）
  const anon = client()
  const anonList = await anon.req('GET', '/api/v2/projects')
  ok('未登录访问 v2 被拒 401', anonList.status === 401, anonList.status)

  // 1. 新建云端作品
  const created = await web.req('POST', '/api/v2/projects', { name: '样本作品' })
  const pid = created.json?.cloudProjectId
  ok('新建云端作品', created.status === 200 && /^prj_[A-Za-z0-9_-]+$/.test(pid || ''), created.json)

  // 2. 上传对象（流式）
  const body1 = Buffer.from('chapters-content-v1'.repeat(1000), 'utf8')
  const h1 = sha(body1)
  const up = await web.req('PUT', `/api/v2/projects/${pid}/objects/${h1}`, undefined, body1)
  ok('上传对象成功且字节数一致', up.status === 200 && up.json?.bytes === body1.length && up.json?.reused === false, up.json)

  const upAgain = await web.req('PUT', `/api/v2/projects/${pid}/objects/${h1}`, undefined, body1)
  ok('同内容重复上传直接复用', upAgain.status === 200 && upAgain.json?.reused === true, upAgain.json)

  // 3. 哈希不符被拒
  const wrongHash = sha(Buffer.from('what-client-claimed'))
  const badUp = await web.req('PUT', `/api/v2/projects/${pid}/objects/${wrongHash}`, undefined, body1)
  ok('哈希不符的上传被拒 400', badUp.status === 400 && badUp.json?.code === 'HASH_MISMATCH', badUp.json)

  // 4. 提交
  const manifest1 = {
    protocol: 1, createdAt: Date.now(),
    objects: [{ kind: 'chapters', hash: h1, bytes: body1.length }], assets: [], tombstones: [],
  }
  const c1 = await web.req('POST', `/api/v2/projects/${pid}/commit`, { opId: 'op-1', baseRevision: 0, manifest: manifest1 })
  ok('提交生成 revision 1', c1.status === 200 && c1.json?.revision === 1 && c1.json?.replayed === false, c1.json)

  // 5. 回执重放
  const c1r = await web.req('POST', `/api/v2/projects/${pid}/commit`, { opId: 'op-1', baseRevision: 0, manifest: manifest1 })
  ok('同 opId 重放返回同 revision（replayed）', c1r.status === 200 && c1r.json?.replayed === true && c1r.json?.revision === 1, c1r.json)

  // 6. 基线不符 409
  const stale = await web.req('POST', `/api/v2/projects/${pid}/commit`, { opId: 'op-stale', baseRevision: 0, manifest: manifest1 })
  ok('旧基线提交 409 BASELINE_MISMATCH', stale.status === 409 && stale.json?.code === 'BASELINE_MISMATCH', stale.json)

  // 7. 引用未上传对象 400
  const missHash = sha(Buffer.from('never-uploaded'))
  const missing = await web.req('POST', `/api/v2/projects/${pid}/commit`, {
    opId: 'op-miss', baseRevision: 1,
    manifest: { ...manifest1, objects: [{ kind: 'chapters', hash: missHash, bytes: 10 }] },
  })
  ok('引用未上传对象 400 OBJECT_MISSING', missing.status === 400 && missing.json?.code === 'OBJECT_MISSING', missing.json)

  // 8. 读 manifest
  const got = await web.req('GET', `/api/v2/projects/${pid}/manifest`)
  ok('读回 manifest 且对象一致', got.status === 200 && got.json?.manifest?.objects?.[0]?.hash === h1, got.json)

  // 9. 列表
  const list = await web.req('GET', '/api/v2/projects')
  const row = (list.json?.projects || []).find((x) => x.cloudProjectId === pid)
  ok('作品列表含该项目与 revision', list.status === 200 && row?.revision === 1, list.json)

  // 10. 配额：声明 8 MiB（配额 4 MiB）→ 413
  const bigManifest = {
    ...manifest1,
    objects: [{ kind: 'chapters', hash: h1, bytes: 8 * 1024 * 1024 }],
  }
  const over = await web.req('POST', `/api/v2/projects/${pid}/commit`, { opId: 'op-big', baseRevision: 1, manifest: bigManifest })
  ok('超配额提交 413 QUOTA_EXCEEDED', over.status === 413 && over.json?.code === 'QUOTA_EXCEEDED', over.json)

  // 11. 路径穿越
  const evil = await web.req('GET', '/api/v2/projects/..%2F..%2Fetc/manifest')
  ok('非法 pid（路径穿越）被拒', evil.status === 400 || evil.status === 404, evil.status)

  // 12. 删除写墓碑，旧基线不能复活
  const del = await web.req('DELETE', `/api/v2/projects/${pid}?opId=op-del`)
  ok('删除作品推进 revision', del.status === 200 && del.json?.revision === 2, del.json)
  const revive = await web.req('POST', `/api/v2/projects/${pid}/commit`, { opId: 'op-old', baseRevision: 1, manifest: manifest1 })
  ok('删除后离线旧基线不能复活', revive.status === 409, revive.json)

  // 13. 跨账号隔离：另一个账号既看不到该项目，也不能按哈希取对象
  const other = client()
  await other.req('POST', '/api/auth/register', { name: '另一个用户', password: 'pass1234' })
  const otherList = await other.req('GET', '/api/v2/projects')
  const otherGet = await other.req('GET', `/api/v2/projects/${pid}/manifest`)
  const otherObj = await other.req('GET', `/api/v2/projects/${pid}/objects/${h1}`)
  ok('他人列表看不到本项目', otherList.status === 200 && !(otherList.json.projects || []).some((x) => x.cloudProjectId === pid), otherList.json)
  ok('他人访问本项目被 404', otherGet.status === 404, otherGet.status)
  ok('他人无法按哈希取本项目对象', otherObj.status === 404, otherObj.status)
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
  if (log) console.log('--- server log ---\n' + log.slice(-2500))
  process.exit(1)
}
console.log(`OK ${passed}/${passed}（${new Date().toISOString()}，Node ${process.version}）`)
process.exit(0)
