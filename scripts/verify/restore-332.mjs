// P4-4 · 云端回收站恢复 · 端到端自检（真服务 + 临时数据目录，不碰真实账号）
//
// 盯六件事：
//   ① 删除写墓碑后，状态接口能区分「没有这本」与「在回收站」；
//   ② 恢复**产生新 revision**（不是倒退），内容回到删除前最后一个内容版本；
//   ③ 同 opId 重放不新增 revision；
//   ④ 没删除的作品不能"恢复"（409 NOT_DELETED）；
//   ⑤ 恢复后项目级墓碑被清掉，旧基线不能拿删除版复活；
//   ⑥ 恢复后基线可用：以新 revision 继续提交成功。
//
// 用法：node scripts/verify/restore-332.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverEntry = path.resolve(here, '../../server/index.mjs')

const PORT = 18739
const root = mkdtempSync(path.join(os.tmpdir(), 'yfe-restore-'))
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
    YFE_BOOTSTRAP_INVITE: 'RESTORE-INVITE-332',
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
  const reg = await web.req('POST', '/api/auth/register', { name: '恢复用户', password: 'pass1234' })
  ok('注册并登录', reg.status === 200 && !!web.cookie, reg.status)

  const created = await web.req('POST', '/api/v2/projects', { name: '回收站样本' })
  const pid = created.json?.cloudProjectId
  ok('新建云端作品', created.status === 200 && !!pid, created.json)

  const body1 = Buffer.from('restore-content-v1'.repeat(800), 'utf8')
  const h1 = sha(body1)
  const up = await web.req('PUT', `/api/v2/projects/${pid}/objects/${h1}`, undefined, body1)
  const manifest1 = {
    protocol: 1, createdAt: Date.now(),
    objects: [{ kind: 'chapters', hash: h1, bytes: body1.length }], assets: [], tombstones: [],
  }
  const c1 = await web.req('POST', `/api/v2/projects/${pid}/commit`, { opId: 'op-c1', baseRevision: 0, manifest: manifest1 })
  ok('初始提交 rev1', up.status === 200 && c1.status === 200 && c1.json?.revision === 1, c1.json)

  // ① 未删除时的状态
  const before = await web.req('GET', `/api/v2/projects/${pid}`)
  ok('未删除时状态 deleted=false', before.status === 200 && before.json?.deleted === false, before.json)

  // 未删除的作品不能"恢复"
  const notDeleted = await web.req('POST', `/api/v2/projects/${pid}/restore?opId=op-early`)
  ok('未删除时恢复被拒 409 NOT_DELETED', notDeleted.status === 409 && notDeleted.json?.code === 'NOT_DELETED', notDeleted.json)

  // ② 删除
  const del = await web.req('DELETE', `/api/v2/projects/${pid}?opId=op-del`)
  ok('删除推进到 rev2', del.status === 200 && del.json?.revision === 2, del.json)
  const afterDel = await web.req('GET', `/api/v2/projects/${pid}`)
  ok('删除后状态 deleted=true 且带删除时间', afterDel.status === 200 && afterDel.json?.deleted === true && afterDel.json?.deletedAt > 0, afterDel.json)

  // 缺 opId
  const noOp = await web.req('POST', `/api/v2/projects/${pid}/restore`)
  ok('恢复缺 opId 被拒 400', noOp.status === 400, noOp.status)

  // ③ 恢复：新 revision，内容来自删除前最后一版
  const r1 = await web.req('POST', `/api/v2/projects/${pid}/restore?opId=op-restore-1`)
  ok('恢复成功并产生 rev3（不是倒退）', r1.status === 200 && r1.json?.revision === 3, r1.json)
  ok('恢复报告内容来源 rev1', r1.json?.restoredFrom === 1, r1.json)

  const afterRestore = await web.req('GET', `/api/v2/projects/${pid}`)
  ok('恢复后状态 deleted=false', afterRestore.json?.deleted === false && afterRestore.json?.revision === 3, afterRestore.json)

  const m3 = await web.req('GET', `/api/v2/projects/${pid}/manifest`)
  ok('恢复版内容与删除前一致', m3.status === 200 && m3.json?.manifest?.objects?.[0]?.hash === h1, m3.json?.manifest)
  ok('恢复版不是删除标记', m3.json?.manifest?.deleted !== true)
  ok('恢复版有新的 snapshotId', m3.json?.manifest?.snapshotId !== c1.json?.snapshotId, { before: c1.json?.snapshotId, after: m3.json?.manifest?.snapshotId })

  // ④ 同 opId 重放：不新增 revision
  const r1r = await web.req('POST', `/api/v2/projects/${pid}/restore?opId=op-restore-1`)
  ok('同 opId 重放返回 rev3 且 replayed', r1r.status === 200 && r1r.json?.revision === 3 && r1r.json?.replayed === true, r1r.json)
  const afterReplay = await web.req('GET', `/api/v2/projects/${pid}`)
  ok('重放没有产生 rev4', afterReplay.json?.revision === 3, afterReplay.json?.revision)

  // ⑤ 重复恢复（已恢复）应当再次 409，而不是继续涨 revision
  const again = await web.req('POST', `/api/v2/projects/${pid}/restore?opId=op-restore-2`)
  ok('已恢复后再次恢复被拒 409', again.status === 409 && again.json?.code === 'NOT_DELETED', again.json)

  // ⑥ 恢复后基线可用：以 rev3 继续提交
  const body2 = Buffer.from('restore-content-v2'.repeat(800), 'utf8')
  const h2 = sha(body2)
  const up2 = await web.req('PUT', `/api/v2/projects/${pid}/objects/${h2}`, undefined, body2)
  const c4 = await web.req('POST', `/api/v2/projects/${pid}/commit`, {
    opId: 'op-c4', baseRevision: 3,
    manifest: { ...manifest1, objects: [{ kind: 'chapters', hash: h2, bytes: body2.length }] },
  })
  ok('恢复后以新基线继续提交成功 rev4', up2.status === 200 && c4.status === 200 && c4.json?.revision === 4, c4.json)

  // 删除版的旧基线依然不能复活
  const revive = await web.req('POST', `/api/v2/projects/${pid}/commit`, { opId: 'op-revive', baseRevision: 2, manifest: manifest1 })
  ok('删除版基线不能复活', revive.status === 409, revive.json)

  // 列表里的 deleted 标记回到 false
  const list = await web.req('GET', '/api/v2/projects')
  const row = (list.json?.projects || []).find((x) => x.cloudProjectId === pid)
  ok('列表里已不再标删除', row?.deleted === false && row?.revision === 4, row)

  // 跨账号：连"恢复"入口都看不到该项目
  const other = client()
  await other.req('POST', '/api/auth/register', { name: '另一个恢复用户', password: 'pass1234' })
  const otherRestore = await other.req('POST', `/api/v2/projects/${pid}/restore?opId=op-other`)
  ok('他人无法恢复本项目', otherRestore.status === 404 || otherRestore.status === 403, otherRestore.status)
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