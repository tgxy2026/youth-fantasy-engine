// ============ 3.4.3 · 便携外置整表条件写（/api/blob + ETag/If-Match）============
//
// 现场：vecRows / kbDocs / kbBodies 是「整表一个文件」，客户端每次写都是
//   「GET 整表 → 内存改 → PUT 整表」。没有版本前置条件时，两个标签同时改不同行，
//   后保存的会把先保存的整表静默覆盖 —— 丢向量、丢知识库正文。
//
// 这里起**真实便携服务进程**（scripts/portable-server.mjs --root 临时目录），
// 只走 HTTP，不 mock 服务内部：验证 428 / 409 / 200、并发只放行一个、重启后版本跟正文走。
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import type { SidecarApi, SidecarStoreSpec } from '../src/lib/storage/sidecar'
import { withSidecar, SIDECAR_WHOLE_KEY } from '../src/lib/storage/sidecar'
import type { StoreOps } from '../src/lib/storage/storeOps'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const ROOT = process.cwd()
const runRoot = await fs.mkdtemp(path.join(ROOT, '.workbuddy/tmp/portable-blob-cas-'))
const appRoot = path.join(runRoot, 'app')
const dataDir = path.join(appRoot, 'data')
const blobDir = path.join(dataDir, 'blobs')
await fs.mkdir(dataDir, { recursive: true })
await fs.mkdir(path.join(appRoot, 'dist'), { recursive: true })
// 便携服务启动时检查前端产物；本测试只打 API，放一个最小 index.html 即可。
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
    try { const r = await fetch(origin + '/api/ping', { signal: AbortSignal.timeout(800) }); if (r.ok) return } catch { /* 还没起来 */ }
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

/** 与服务端同一算法（owner 固定 portable，含 store / id） */
const blobRevision = (store: string, id: string, text: string | null) =>
  '"yfe-' + createHash('sha256')
    .update('portable\0blob\0' + store + '\0' + id + '\0' + (text === null ? 'missing' : 'text\0' + text))
    .digest('hex') + '"'

const blobPath = (store: string, id: string) => path.join(blobDir, store, `${id}.json`)
const diskBlob = async (store: string, id: string) => {
  try { return await fs.readFile(blobPath(store, id), 'utf8') } catch { return null }
}
const getBlob = async (store: string, id: string) => {
  const r = await fetch(`${origin}/api/blob?store=${encodeURIComponent(store)}&id=${encodeURIComponent(id)}`)
  return { status: r.status, etag: r.headers.get('etag'), body: await r.json().catch(() => ({})) }
}
const putBlob = async (store: string, id: string, value: unknown, ifMatch?: string | null) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (ifMatch) headers['If-Match'] = ifMatch
  const r = await fetch(`${origin}/api/blob?store=${encodeURIComponent(store)}&id=${encodeURIComponent(id)}`, {
    method: 'PUT', headers, body: JSON.stringify(value),
  })
  return { status: r.status, etag: r.headers.get('etag'), body: await r.json().catch(() => ({})) }
}
const delBlob = async (store: string, id: string, ifMatch?: string | null) => {
  const headers: Record<string, string> = {}
  if (ifMatch) headers['If-Match'] = ifMatch
  const r = await fetch(`${origin}/api/blob?store=${encodeURIComponent(store)}&id=${encodeURIComponent(id)}`, { method: 'DELETE', headers })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
const rows = (ids: string[]) => ids.map((id) => ({ id, projectId: 'p1', vecB64: 'AA==' }))

try {
  await start()

  // ---------- ① 缺失整表：404 也要给版本（首写才能带前置条件） ----------
  {
    const r = await getBlob('vecRows', '__all__')
    ok('① 缺失整表 GET 404', r.status === 404, String(r.status))
    ok('① 404 带 revision 且与 ETag 同值', typeof r.body.revision === 'string' && r.etag === r.body.revision, JSON.stringify(r.body).slice(0, 140))
    ok('① 404 版本与算法一致（missing）', r.body.revision === blobRevision('vecRows', '__all__', null), String(r.body.revision))
  }

  // ---------- ② 整表无前置条件：428 且不落盘 ----------
  {
    const r = await putBlob('vecRows', '__all__', rows(['v1']))
    ok('🔴 ② 整表无条件 PUT ⇒ 428（旧页面不得裸写）', r.status === 428, String(r.status))
    ok('② 428 带 REVISION_REQUIRED 与当前版本', r.body.code === 'REVISION_REQUIRED' && typeof r.body.revision === 'string', JSON.stringify(r.body).slice(0, 140))
    ok('🔴 ② 被拒后磁盘没有该外置文件（一个字都没写）', (await diskBlob('vecRows', '__all__')) === null)
  }

  // ---------- ③ 旧版本：409 且不覆盖 ----------
  {
    const missing = (await getBlob('vecRows', '__all__')).body.revision as string
    const goodText = JSON.stringify(rows(['v1']))
    const good = await putBlob('vecRows', '__all__', rows(['v1']), missing)
    ok('③ 正确版本首写 ⇒ 200', good.status === 200, `${good.status} ${JSON.stringify(good.body).slice(0, 120)}`)
    ok('③ 回执版本与正文一致', good.body.revision === blobRevision('vecRows', '__all__', goodText), String(good.body.revision))
    ok('③ 磁盘正文就是提交内容', (await diskBlob('vecRows', '__all__')) === goodText)

    const stale = await putBlob('vecRows', '__all__', rows(['v2']), missing)
    ok('🔴 ③ 拿旧版本写整表 ⇒ 409', stale.status === 409, String(stale.status))
    ok('③ 409 带 DATA_CONFLICT 与当前版本', stale.body.code === 'DATA_CONFLICT' && typeof stale.body.revision === 'string', JSON.stringify(stale.body).slice(0, 140))
    ok('🔴 ③ 磁盘仍是先写成功的整表', (await diskBlob('vecRows', '__all__')) === goodText)
  }

  // ---------- ④ 同基线两个并发：只准一个成功 ----------
  {
    const base = (await getBlob('vecRows', '__all__')).body.revision as string
    const a = rows(['a1', 'a2'])
    const b = rows(['b1'])
    const both = await Promise.all([
      putBlob('vecRows', '__all__', a, base),
      putBlob('vecRows', '__all__', b, base),
    ])
    const statuses = both.map((x) => x.status).sort()
    ok('🔴 ④ 同基线并发只准一个 200、另一个 409', statuses[0] === 200 && statuses[1] === 409, JSON.stringify(statuses))
    const finalText = await diskBlob('vecRows', '__all__')
    ok('④ 磁盘内容正是赢家的整表', finalText === JSON.stringify(a) || finalText === JSON.stringify(b), String(finalText).slice(0, 80))
    const winner = both[0].status === 200 ? both[0] : both[1]
    ok('④ 磁盘版本与赢家回执一致', winner.body.revision === blobRevision('vecRows', '__all__', finalText), String(winner.body.revision))
  }

  // ---------- ⑤ 每种整表 store 都强制条件写 ----------
  {
    for (const store of ['kbDocs', 'kbBodies']) {
      const r = await putBlob(store, '__all__', [{ id: 'x' }])
      ok(`🔴 ⑤ ${store} 无前置条件同样 428`, r.status === 428, `${r.status}`)
      ok(`⑤ ${store} 被拒后未落盘`, (await diskBlob(store, '__all__')) === null)
    }
  }

  // ---------- ⑥ per-id 备份载荷保持无条件写（旧客户端兼容） ----------
  {
    const r = await putBlob('backupPayloads', 'b1', { id: 'b1', bytes: 10 })
    ok('⑥ per-id 无前置条件仍可写（兼容旧备份脚本）', r.status === 200, String(r.status))
    ok('⑥ per-id 回执带版本', typeof r.body.revision === 'string', JSON.stringify(r.body).slice(0, 120))
    const g = await getBlob('backupPayloads', 'b1')
    ok('⑥ per-id 读回内容与版本', g.status === 200 && (g.body as { value?: { id?: string } }).value?.id === 'b1' && g.etag === g.body.revision, JSON.stringify(g.body).slice(0, 120))

    const after = (await getBlob('backupPayloads', 'b1')).body.revision as string
    const stale = await putBlob('backupPayloads', 'b1', { id: 'b1', bytes: 20 }, blobRevision('backupPayloads', 'b1', 'x'))
    ok('⑥ per-id 显式带错版本 ⇒ 409（条件写可选生效）', stale.status === 409, String(stale.status))
    const good = await putBlob('backupPayloads', 'b1', { id: 'b1', bytes: 20 }, after)
    ok('⑥ per-id 带正确版本 ⇒ 200', good.status === 200, String(good.status))
  }

  // ---------- ⑦ 条件删除：旧版本不删，新版本才删 ----------
  {
    const current = (await getBlob('vecRows', '__all__')).body.revision as string
    const naked = await delBlob('vecRows', '__all__')
    ok('🔴 ⑦ 整表无条件 DELETE ⇒ 428 且文件仍在', naked.status === 428 && (await diskBlob('vecRows', '__all__')) !== null, String(naked.status))
    const bad = await delBlob('vecRows', '__all__', blobRevision('vecRows', '__all__', JSON.stringify(rows(['ghost']))))
    ok('🔴 ⑦ 条件删除版本不符 ⇒ 409 且文件仍在', bad.status === 409 && (await diskBlob('vecRows', '__all__')) !== null, String(bad.status))
    const good = await delBlob('vecRows', '__all__', current)
    ok('⑦ 条件删除版本正确 ⇒ 200 且文件消失', good.status === 200 && (await diskBlob('vecRows', '__all__')) === null, JSON.stringify(good.body).slice(0, 120))
    const missing = await getBlob('vecRows', '__all__')
    ok('⑦ 删除后 GET 404 版本 = missing', missing.status === 404 && missing.body.revision === blobRevision('vecRows', '__all__', null), String(missing.body.revision))
  }

  // ---------- ⑧ 重启：版本跟正文走，不跟进程走 ----------
  {
    const text = JSON.stringify(rows(['r1']))
    const before = (await getBlob('vecRows', '__all__')).body.revision as string
    const w = await putBlob('vecRows', '__all__', rows(['r1']), before)
    ok('⑧ 重启前写入成功', w.status === 200, String(w.status))
    const revision = w.body.revision as string
    await stop()
    await start()
    const after = await getBlob('vecRows', '__all__')
    ok('⑧ 重启后同一正文得到同一版本', after.status === 200 && after.body.revision === revision, `${revision} vs ${String(after.body.revision)}`)
    ok('⑧ 重启后正文未变', (await diskBlob('vecRows', '__all__')) === text)
    const stale = await putBlob('vecRows', '__all__', rows(['r2']), before)
    ok('🔴 ⑧ 重启后旧版本仍被拒（409）', stale.status === 409, String(stale.status))
  }

  // ---------- ⑨ 原有安全边界未被条件写挤掉 ----------
  {
    const badStore = await getBlob('../../etc', '__all__')
    ok('⑨ 未知 store 仍被拒（400）', badStore.status === 400, String(badStore.status))
    const badId = await getBlob('vecRows', '../x')
    ok('⑨ 非法 id 仍被拒（400）', badId.status === 400, String(badId.status))
    const current = (await getBlob('vecRows', '__all__')).body.revision as string
    const badJson = await fetch(`${origin}/api/blob?store=vecRows&id=__all__`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': current }, body: 'not-json',
    })
    ok('⑨ 非 JSON 载荷仍被拒（400）', badJson.status === 400, String(badJson.status))
  }

  // ---------- ⑩ 客户端 sidecar 条件写 ↔ 真实服务：并发两页合并 ----------
  //
  // ⑨ 之前验证的是「服务端协议」；这一节用与生产适配器同构的 HTTP 实现，
  // 把 `withSidecar` 真正接到服务上，验证两个页面并发写不同行时最终都不丢。
  class HttpApi implements SidecarApi {
    async read(store: string, id: string): Promise<unknown | undefined> {
      const g = await getBlob(store, id)
      if (g.status === 404) return undefined
      if (g.status !== 200) throw new Error('外置载荷读取失败：HTTP ' + g.status)
      return (g.body as { value?: unknown }).value
    }
    async write(store: string, id: string, value: unknown): Promise<boolean> {
      return (await putBlob(store, id, value)).status === 200
    }
    async remove(store: string, id: string): Promise<boolean> {
      return (await delBlob(store, id)).status === 200
    }
    async listIds(store: string): Promise<string[]> {
      const r = await fetch(`${origin}/api/blob/list?store=${encodeURIComponent(store)}`)
      if (!r.ok) throw new Error('外置载荷目录读取失败：HTTP ' + r.status)
      return ((await r.json()) as { ids?: string[] }).ids ?? []
    }
    async readVersioned(store: string, id: string) {
      const g = await getBlob(store, id)
      const revision = typeof g.body.revision === 'string' ? g.body.revision : null
      if (g.status === 404) return { value: undefined, revision }
      if (g.status !== 200) throw new Error('外置载荷读取失败：HTTP ' + g.status)
      return { value: (g.body as { value?: unknown }).value, revision }
    }
    async writeConditional(store: string, id: string, value: unknown, expected: string | null) {
      const r = await putBlob(store, id, value, expected)
      const revision = typeof r.body.revision === 'string' ? r.body.revision : null
      if (r.status === 409 || r.status === 428) return { ok: false, conflict: true, revision }
      if (r.status !== 200) return { ok: false, revision }
      return { ok: true, revision }
    }
  }

  /** 未外置 store 的底座（本测试只用 whole store，不会走到） */
  const base: StoreOps = {
    async getAll<T>() { return [] as T[] },
    async get<T>() { return undefined as T | undefined },
    async put() {},
    async del() {},
    async getAllByIndex<T>() { return [] as T[] },
    async bulkPut() {},
    async bulkDel() {},
  }
  const spec: Record<string, SidecarStoreSpec> = { vecRows: { layout: 'whole', keyField: 'id' } }
  const api = new HttpApi()
  const errsA: string[] = []
  const errsB: string[] = []
  const opsA = withSidecar(base, api, spec, (m) => errsA.push(m))
  const opsB = withSidecar(base, api, spec, (m) => errsB.push(m))

  // 从空表开始（当前表里可能已有前面用例的 r1）
  {
    const current = (await getBlob('vecRows', SIDECAR_WHOLE_KEY)).body.revision as string
    const cleared = await putBlob('vecRows', SIDECAR_WHOLE_KEY, [], current)
    ok('⑩ 清空整表准备并发用例', cleared.status === 200, String(cleared.status))
  }

  await Promise.all([
    ...[0, 1, 2, 3, 4].map((i) => opsA.put('vecRows', { id: `a-${i}`, projectId: 'p1' })),
    ...[0, 1, 2, 3, 4].map((i) => opsB.put('vecRows', { id: `b-${i}`, projectId: 'p1' })),
  ])
  const merged = ((await getBlob('vecRows', SIDECAR_WHOLE_KEY)).body as { value?: { id: string }[] }).value ?? []
  const mergedIds = merged.map((r) => r.id).sort()
  ok('🔴 ⑩ 两个页面并发各写多行：最终整表包含双方全部 10 行',
    mergedIds.length === 10 && mergedIds.every((id) => id.startsWith('a-') || id.startsWith('b-')),
    JSON.stringify(mergedIds))
  ok('⑩ 两页都没有写失败告警', errsA.length === 0 && errsB.length === 0, JSON.stringify([...errsA, ...errsB]))

  // 强制制造一次「读后另一页先写」：在 A 的条件写之前用 B 的通道先落盘
  {
    let injected = false
    const racingApi: SidecarApi = {
      read: (s, i) => api.read(s, i),
      write: (s, i, v) => api.write(s, i, v),
      remove: (s, i) => api.remove(s, i),
      listIds: (s) => api.listIds(s),
      readVersioned: (s, i) => api.readVersioned!(s, i),
      writeConditional: async (s, i, v, expected) => {
        if (!injected) {
          injected = true
          const g = await getBlob(s, i)
          const currentRows = ((g.body as { value?: { id: string }[] }).value ?? []).slice()
          const external = [...currentRows, { id: 'external' }]
          const w = await putBlob(s, i, external, g.body.revision as string)
          if (w.status !== 200) throw new Error('注入的另一个窗口写入失败：' + w.status)
        }
        return api.writeConditional!(s, i, v, expected)
      },
    }
    const errs: string[] = []
    const ops = withSidecar(base, racingApi, spec, (m) => errs.push(m))
    await ops.put('vecRows', { id: 'mine', projectId: 'p1' })
    const ids = (((await getBlob('vecRows', SIDECAR_WHOLE_KEY)).body as { value?: { id: string }[] }).value ?? [])
      .map((r) => r.id)
      .sort()
    ok('🔴 ⑩ 读到旧版本后另一页先落盘：冲突重试后 external 与 mine 都在',
      ids.includes('external') && ids.includes('mine'), JSON.stringify(ids))
    ok('⑩ 强制冲突后没有告警（已成功合并）', errs.length === 0, JSON.stringify(errs))
  }
  {
    let injected = false
    const racingApi: SidecarApi = {
      ...api,
      read: (s, i) => api.read(s, i), write: (s, i, v) => api.write(s, i, v),
      remove: (s, i) => api.remove(s, i), listIds: (s) => api.listIds(s),
      readVersioned: (s, i) => api.readVersioned(s, i),
      writeConditional: async (s, i, v, expected) => {
        if (!injected) {
          injected = true
          const g = await getBlob(s, i)
          const currentRows = ((g.body as { value?: { id: string; text?: string }[] }).value ?? [])
          const w = await putBlob(s, i, [...currentRows.filter(r => r.id !== 'same'), { id: 'same', text: 'newer' }], g.body.revision as string)
          if (w.status !== 200) throw new Error('注入并发更新失败')
        }
        return api.writeConditional(s, i, v, expected)
      },
    }
    const errs: string[] = []
    const ops = withSidecar(base, racingApi, spec, m => errs.push(m))
    let rejected = false
    try { await ops.put('vecRows', { id: 'same', text: 'old draft' }) } catch { rejected = true }
    const rows = ((await getBlob('vecRows', SIDECAR_WHOLE_KEY)).body as { value: { id: string; text?: string }[] }).value
    ok('真实服务同一记录并发更新拒绝覆盖', rejected && errs.length > 0 && rows.find(r => r.id === 'same')?.text === 'newer', JSON.stringify({ rows, errs }))
  }
} catch (e) {
  ok('运行期未抛错', false, e instanceof Error ? e.message : String(e))
} finally {
  await stop()
  console.log(`\n———— portableBlobCas：${pass} 通过 / ${fail} 失败 ————`)
  if (fail) process.exitCode = 1
}
