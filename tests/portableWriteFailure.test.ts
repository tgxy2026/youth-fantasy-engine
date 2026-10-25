// ============ 3.2.6 · 便携服务：写盘失败必须回 500，绝不能「挂死」 ============
//
// 【为什么单独一条】这是 3.2.6 实测抓到的真缺陷，不是探针问题：
//   大表夹具（1000 行 × 74 列，整库 4.6 MB）在便携后端连续保存到第 3 次时，Windows 上
//   `renameSync` 抛了 `EPERM: operation not permitted`（网盘客户端 / 杀软 / 索引器正在扫刚写完的文件）。
//   旧代码里这个异常**从 HTTP 处理器里逃了出去** ⇒ 变成「未处理的 Promise 拒绝」、响应永远不发
//   ⇒ 前端一直停在「正在保存」，测量探针干等 180 秒超时。
//   作者的真实场景就是「数据放在 OneDrive / 坚果云 / 百度网盘同步目录」—— 这个坑一定会再遇到。
//
// 这里起**真实的便携服务进程**（真磁盘、真 HTTP），把写入路径堵死，断言四件事：
//   ① 5 秒内一定拿到响应（挂死就是回归）；
//   ② 状态 500 + 可读文案（不是静默丢弃）；
//   ③ 原数据文件一个字节都没被动过（不许留半个文件、更不许清空）；
//   ④ 堵点解除后同一份数据能正常保存（失败不该把服务锁死）。
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
const runRoot = await fs.mkdtemp(path.join(ROOT, '.workbuddy/tmp/portable-writefail-'))
const appRoot = path.join(runRoot, 'app')
const dataDir = path.join(appRoot, 'data')
const dataFile = path.join(dataDir, 'youth-fantasy-engine-data.json')
/** 与便携服务内部同一个原子写临时文件；把它变成一个**目录**就能稳定复现「写不进去」 */
const tmpBlocker = path.join(dataDir, '.data.json.tmp')
await fs.mkdir(dataDir, { recursive: true })
await fs.mkdir(path.join(appRoot, 'dist'), { recursive: true })
// 便携服务同时是静态服务器，启动时会检查前端产物；放一个最小 index.html 让它通过即可
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

/** 与服务端同一算法：owner 固定 'portable'，正文参与哈希（便于独立复核 revision） */
const revisionOf = (text: string | null) =>
  '"yfe-' + createHash('sha256').update('portable\0' + (text === null ? 'missing' : 'text\0' + text)).digest('hex') + '"'
const doc = (marker: string) => JSON.stringify({
  app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 2, savedAt: Date.now(),
  stores: { chapters: [{ id: 'ch-1', projectId: 'p1', volumeId: 'v1', title: '写盘失败', content: '正文-' + marker }] },
})
const getData = async () => {
  const r = await fetch(origin + '/api/data')
  return { status: r.status, etag: r.headers.get('etag'), body: await r.json().catch(() => ({})) }
}
/** 🔴 6 秒超时：旧缺陷的表现就是「永不返回」，用 timeout 把它变成一条可断言的失败 */
const putData = async (text: string, ifMatch?: string | null) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (ifMatch) headers['If-Match'] = ifMatch
  const r = await fetch(origin + '/api/data', { method: 'PUT', headers, body: text, signal: AbortSignal.timeout(6000) })
  return { status: r.status, etag: r.headers.get('etag'), body: await r.json().catch(() => ({})) }
}
const diskText = async () => { try { return await fs.readFile(dataFile, 'utf8') } catch { return null } }
const isAlive = async () => {
  try { const r = await fetch(origin + '/api/data', { signal: AbortSignal.timeout(1500) }); return r.status > 0 } catch { return false }
}

try {
  await start()
  const empty = await getData()
  ok('① 首次空库 GET 404 且带可复算版本', empty.status === 404 && empty.body.revision === revisionOf(null), `${empty.status} ${String(empty.body.revision)}`)

  // ---------- 堵死写入路径：tmp 位置被目录占住 ⇒ writeFileSync 抛 EISDIR ----------
  await fs.mkdir(tmpBlocker).catch(() => {})
  const first = doc('A')
  let threw = ''
  const startedAt = Date.now()
  let failure: Awaited<ReturnType<typeof putData>> | null = null
  try { failure = await putData(first, empty.body.revision as string) } catch (e) { threw = String(e) }
  const elapsed = Date.now() - startedAt

  ok('② 写不进去时**必须**有响应（不许挂死）', !threw && failure !== null, threw || 'no response')
  ok('② 5 秒内返回（超时上限 6s，实测 ' + elapsed + 'ms）', elapsed < 5500, String(elapsed))
  ok('② 状态是 500（不是 200 假成功）', failure?.status === 500, String(failure?.status))
  ok('② 文案可读且带 WRITE_FAILED 码', failure?.body?.code === 'WRITE_FAILED' && String(failure?.body?.error ?? '').includes('写入数据文件失败'),
    JSON.stringify(failure?.body).slice(0, 160))
  ok('③ 原数据文件没有被写出来（不许留半个文件）', (await diskText()) === null, String((await diskText())?.length))
  ok('③ 服务还活着（不是崩了）', await isAlive())

  // ---------- 解除堵点：同一份数据必须能正常保存 ----------
  await fs.rmdir(tmpBlocker)
  const retry = await putData(first, empty.body.revision as string)
  ok('④ 堵点解除后 200 且版本可复算', retry.status === 200 && retry.etag === revisionOf(first), `${retry.status} ${retry.etag}`)
  ok('④ 磁盘内容与提交内容逐字节一致', (await diskText()) === first)

  // ---------- 旧缺陷的直接特征：不许再出现未处理的 Promise 拒绝 ----------
  ok('⑤ 日志里没有「未处理的 Promise 拒绝」', !log.includes('未处理的 Promise 拒绝'), log.slice(-300))
} catch (e) {
  fail++
  console.log('FAIL 未捕获异常 :: ' + String((e as Error)?.stack ?? e))
} finally {
  await stop()
  await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n———— portableWriteFailure：${pass} 通过 / ${fail} 失败 ————`)
process.exit(fail > 0 ? 1 : 0)
