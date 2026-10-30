// P4-5 · 云端彻底删除（回收站 → 永久删除）· 端到端自检
//
// 盯五件事：
//   ① 未进回收站的项目**不能**被彻底删除（409）；
//   ② 删除后项目目录与索引都没了（GET 404 / 列表不含）；
//   ③ **共享对象不在这里删**（另一个项目上传同内容应命中 reused）—— 否则会误删别人的内容；
//   ④ 返回释放的清单占用字节；
//   ⑤ 跨账号无法删除。
//
// 用法：node scripts/verify/purge-332.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverEntry = path.resolve(here, '../../server/index.mjs')

const PORT = 18740
const root = mkdtempSync(path.join(os.tmpdir(), 'yfe-purge-'))
const dataDir = path.join(root, 'data')
const wwwDir = path.join(root, 'www')
mkdirSync(dataDir, { recursive: true })
mkdirSync(wwwDir, { recursive: true })
writeFileSync(path.join(wwwDir, 'index.html'), '<!doctype html><title>fixture</title>')

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
      for (const c of set) {
        const [pair] = c.split(';')
        if (pair.startsWith('yfe_sid=')) this.cookie = pair
      }
      let json = null
      const ct = res.headers.get('content-type') || ''
      if (ct.includes('application/json')) { try { json = await res.json() } catch { /* ignore */ } }
      return { status: res.status, json }
    },
  }
}

const server = spawn(process.execPath, [serverEntry], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(PORT), YFE_DATA: dataDir, YFE_WWW: wwwDir,
    YFE_REGISTER: 'open', YFE_QUOTA: String(4 * 1024 * 1024),
    YFE_STATS: path.join(root, 'stats.log'),
    YFE_BOOTSTRAP_INVITE: 'PURGE-INVITE-332',
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
  const reg = await web.req('POST', '/api/auth/register', { name: '彻底删除用户', password: 'pass1234' })
  ok('注册并登录', reg.status === 200 && !!web.cookie, reg.status)

  const created = await web.req('POST', '/api/v2/projects', { name: '待彻底删除' })
  const pid = created.json?.cloudProjectId
  ok('新建云端作品', created.status === 200 && !!pid, created.json)

  const body1 = Buffer.from('purge-content-v1'.repeat(600), 'utf8')
  const h1 = sha(body1)
  await web.req('PUT', `/api/v2/projects/${pid}/objects/${h1}`, undefined, body1)
  const manifest1 = {
    protocol: 1, createdAt: Date.now(),
    objects: [{ kind: 'chapters', hash: h1, bytes: body1.length }], assets: [], tombstones: [],
  }
  const c1 = await web.req('POST', `/api/v2/projects/${pid}/commit`, { opId: 'op-p1', baseRevision: 0, manifest: manifest1 })
  ok('初始提交 rev1', c1.status === 200 && c1.json?.revision === 1, c1.json)

  // ① 未进回收站不能彻底删
  const early = await web.req('DELETE', `/api/v2/projects/${pid}?purge=1&opId=op-purge-early`)
  ok('未删除时彻底删被拒 409 NOT_DELETED', early.status === 409 && early.json?.code === 'NOT_DELETED', early.json)

  // ② 先删除进回收站
  const del = await web.req('DELETE', `/api/v2/projects/${pid}?opId=op-del`)
  ok('删除进回收站 rev2', del.status === 200 && del.json?.revision === 2, del.json)

  // ③ 彻底删除
  const purge = await web.req('DELETE', `/api/v2/projects/${pid}?purge=1&opId=op-purge`)
  ok('彻底删除成功并返回释放字节', purge.status === 200 && purge.json?.purged === true && Number(purge.json?.removedBytes) > 0, purge.json)

  const after = await web.req('GET', `/api/v2/projects/${pid}`)
  ok('彻底删除后状态 404', after.status === 404, after.status)

  const list = await web.req('GET', '/api/v2/projects')
  ok('列表里不再有这本', list.status === 200 && !(list.json?.projects || []).some((x) => x.cloudProjectId === pid), list.json)

  // ④ 共享对象没被删：另一个项目上传同内容应命中复用
  const p2 = await web.req('POST', '/api/v2/projects', { name: '另一本' })
  const pid2 = p2.json?.cloudProjectId
  const reuse = await web.req('PUT', `/api/v2/projects/${pid2}/objects/${h1}`, undefined, body1)
  ok('共享对象仍在（同内容上传 reused=true）', reuse.status === 200 && reuse.json?.reused === true, reuse.json)

  // ⑤ 跨账号
  const other = client()
  await other.req('POST', '/api/auth/register', { name: '另一个删除用户', password: 'pass1234' })
  const otherPurge = await other.req('DELETE', `/api/v2/projects/${pid2}?purge=1&opId=op-other`)
  ok('他人无法彻底删除本项目', otherPurge.status === 404 || otherPurge.status === 403, otherPurge.status)
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