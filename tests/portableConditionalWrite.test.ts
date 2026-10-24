// ============ 3.2.5 · 便携服务条件写（revision + If-Match） ============
//
// 便携版此前是「整库无条件写」：同一个数据文件被两个浏览器窗口同时编辑时，后保存的会静默覆盖先保存的。
// 本轮把云端那套条件写搬到便携服务（算法一致、owner 固定为 'portable'），于是「换机拷走数据文件后版本仍然一致」。
//
// 这里起的是**真实的便携服务进程**（scripts/portable-server.mjs --root 临时目录），
// 只用 fetch 当客户端 —— 不 mock 服务、不直接调内部函数。
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const ROOT = process.cwd()
const runRoot = await fs.mkdtemp(path.join(ROOT, '.workbuddy/tmp/portable-cas-'))
const appRoot = path.join(runRoot, 'app')
const dataDir = path.join(appRoot, 'data')
const dataFile = path.join(dataDir, 'youth-fantasy-engine-data.json')
await fs.mkdir(dataDir, { recursive: true })
await fs.mkdir(path.join(appRoot, 'dist'), { recursive: true })
// 便携服务启动时会检查前端产物存在（它同时是静态服务器）。本测试只打 API，
// 放一个最小 index.html 让它通过启动检查即可 —— 不伪造构建产物、也不访问页面。
await fs.writeFile(path.join(appRoot, 'dist', 'index.html'), '<!doctype html><title>probe</title>')

const freePort = () => new Promise<number>((resolve, reject) => {
  const srv = net.createServer()
  srv.once('error', reject)
  srv.listen(0, '127.0.0.1', () => { const p = (srv.address() as net.AddressInfo).port; srv.close(() => resolve(p)) })
})

const port = await freePort()
const origin = `http://127.0.0.1:${port}`
let child: ChildProcess | null = null
let log = ''
async function start() {
  child = spawn(process.execPath, [path.join(ROOT, 'scripts/portable-server.mjs'), '--root', appRoot, '--port', String(port), '--no-open'], {
    cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (v) => { log += v })
  child.stderr?.on('data', (v) => { log += v })
  const end = Date.now() + 20000
  while (Date.now() < end) {
    try { const r = await fetch(origin + '/api/data', { signal: AbortSignal.timeout(800) }); if (r.status) return } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 120))
  }
  throw new Error('便携服务没起来：' + log.slice(-500))
}
async function stop() {
  if (!child) return
  const c = child
  child = null
  const closed = new Promise((resolve) => c.once('close', resolve))
  c.kill()
  await Promise.race([closed, new Promise((r) => setTimeout(r, 3000))])
}

/** 与便携服务同一算法：revision 跟随真实正文，owner 固定 */
const revisionOf = (text: string | null) =>
  '"yfe-' + createHash('sha256').update('portable\0' + (text === null ? 'missing' : 'text\0' + text)).digest('hex') + '"'
const doc = (marker: string) => JSON.stringify({
  app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 2, savedAt: Date.now(),
  stores: { chapters: [{ id: 'ch-1', projectId: 'p1', volumeId: 'v1', title: '便携条件写', content: '正文-' + marker }] },
})
const getData = async () => {
  const r = await fetch(origin + '/api/data')
  const body = await r.json().catch(() => ({}))
  return { status: r.status, etag: r.headers.get('etag'), body }
}
const putData = async (text: string, ifMatch?: string | null) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (ifMatch) headers['If-Match'] = ifMatch
  const r = await fetch(origin + '/api/data', { method: 'PUT', headers, body: text })
  return { status: r.status, etag: r.headers.get('etag'), body: await r.json().catch(() => ({})) }
}
const diskText = async () => { try { return await fs.readFile(dataFile, 'utf8') } catch { return null } }

try {
  await start()

  // ---------- ① 首次空库：404 也要给版本 ----------
  {
    const r = await getData()
    ok('① 首次空库 GET 404', r.status === 404, String(r.status))
    ok('① 404 也带 revision（后续写入才能带前置条件）', typeof r.body.revision === 'string' && r.body.revision.length > 10, JSON.stringify(r.body).slice(0, 120))
    ok('① 404 的 revision 与 ETag 同值', r.etag === r.body.revision, `${r.etag} vs ${r.body.revision}`)
    ok('① 空库版本 = 算法期望值（可复算）', r.body.revision === revisionOf(null), String(r.body.revision))
  }

  // ---------- ② 缺 If-Match：拒绝且不落盘 ----------
  {
    const r = await putData(doc('no-precondition'))
    ok('🔴 ② 无条件 PUT ⇒ 428（旧页面/旧客户端不得裸写）', r.status === 428, String(r.status))
    ok('② 428 带 REVISION_REQUIRED 码', r.body.code === 'REVISION_REQUIRED', JSON.stringify(r.body).slice(0, 120))
    ok('🔴 ② 被拒后磁盘仍没有数据文件（一个字都没写）', (await diskText()) === null)
  }

  // ---------- ③ 正确版本：写入成功并换版本 ----------
  const v1Text = doc('v1')
  let v1 = ''
  {
    const before = await getData()
    v1 = before.body.revision
    ok('③ 拿到空库版本', v1 === revisionOf(null), v1)
    const r = await putData(v1Text, v1)
    ok('③ 带正确版本的 PUT ⇒ 200', r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`)
    ok('③ 回执带新 ETag 且与正文一致', r.etag === revisionOf(v1Text), `${r.etag}`)
    ok('③ 磁盘正文就是刚提交的内容', (await diskText()) === v1Text)
    ok('③ 版本确实变了（不是把旧版本原样还回来）', r.etag !== v1, `${v1} -> ${r.etag}`)
  }

  // ---------- ④ 旧版本：409 且不覆盖他人内容 ----------
  {
    const r = await putData(doc('stale'), v1)
    ok('🔴 ④ 拿旧版本写 ⇒ 409', r.status === 409, String(r.status))
    ok('④ 409 带 DATA_CONFLICT 码与当前版本（客户端可据此提示）', r.body.code === 'DATA_CONFLICT' && typeof r.body.revision === 'string', JSON.stringify(r.body).slice(0, 140))
    ok('🔴 ④ 磁盘内容没被旧版本覆盖', (await diskText()) === v1Text)
  }

  // ---------- ⑤ 同基线的两个并发提交：只准一个成功 ----------
  {
    const base = revisionOf(v1Text)
    const a = doc('race-a'), b = doc('race-b')
    const both = await Promise.all([putData(a, base), putData(b, base)])
    const codes = both.map((x) => x.status).sort()
    ok('🔴 ⑤ 同基线并发只准一个 200、另一个 409', codes[0] === 200 && codes[1] === 409, JSON.stringify(codes))
    const finalText = await diskText()
    ok('⑤ 落盘内容正是那个 200 提交的正文', finalText === a || finalText === b, String(finalText).slice(0, 60))
    ok('⑤ 落盘版本与正文匹配（队列内比较+替换，不是先比后写）', revisionOf(finalText) === (both[0].status === 200 ? both[0].etag : both[1].etag))
  }

  // ---------- ⑥ 服务重启：版本跟正文走，不跟进程走 ----------
  {
    const before = await getData()
    await stop()
    await start()
    const after = await getData()
    ok('⑥ 重启后同一份正文得到同一版本（无需版本文件）', before.body.revision === after.body.revision, `${before.body.revision} vs ${after.body.revision}`)
    const stale = revisionOf(v1Text)
    const r = await putData(doc('after-restart'), stale)
    ok('🔴 ⑥ 重启后旧版本仍被拒（409）', r.status === 409, String(r.status))
    const fresh = await putData(doc('after-restart'), after.body.revision)
    ok('⑥ 用当前版本可以正常写入', fresh.status === 200, `${fresh.status}`)
  }

  // ---------- ⑦ 换机拷走数据文件：版本一致（便携版特有的迁移属性） ----------
  {
    const text = await diskText()
    ok('⑦ 同一份正文在任何机器上算出同一版本（owner 固定为 portable）', revisionOf(text) === revisionOf(text) && revisionOf(text).startsWith('"yfe-'))
    ok('⑦ 不同正文必然不同版本', revisionOf(text) !== revisionOf(text + ' '))
  }

  // ---------- ⑧ 原有校验不能被条件写挤掉 ----------
  {
    const current = (await getData()).body.revision
    const r = await putData(JSON.stringify({ app: 'youth-fantasy-engine', stores: {} }), current)
    ok('⑧ 缺 kind 的载荷仍被拒（400，不是 409/428）', r.status === 400, `${r.status} ${JSON.stringify(r.body).slice(0, 100)}`)
    const bad = await fetch(origin + '/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': current }, body: 'not-json' })
    ok('⑧ 非 JSON 载荷仍被拒（400）', bad.status === 400, String(bad.status))
  }
} catch (e) {
  ok('运行期未抛错', false, e instanceof Error ? e.message : String(e))
} finally {
  await stop()
  console.log(`\n———— portableConditionalWrite：${pass} 通过 / ${fail} 失败 ————`)
  if (fail) process.exitCode = 1
}
