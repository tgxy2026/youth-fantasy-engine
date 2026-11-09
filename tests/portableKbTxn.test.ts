// ============ 3.4.3 · 知识库跨文件事务（/api/kb-txn + 前滚日志恢复）============
//
// 现场：知识库删除/导入要同时改 kbDocs 与 kbBodies 两个整表文件。两次独立条件写
//   之间崩溃或写失败，会留下「元数据没了正文还在」或反过来的孤儿。
//   服务端用前滚日志收口：同一把锁核对双方版本 → 先写日志 → 逐个替换 → 删日志；
//   中断后由启动/下一次知识库操作恢复，发现恢复前被人改过则**拒绝覆盖**（失败关闭）。
//
// 这里起**真实便携服务进程**，只走 HTTP + 磁盘断言：
//   协议校验 / 双文件原子提交 / 旧版本 409 / 日志写失败不动数据 /
//   第二文件写失败留下日志与前态 / 恢复前滚 / 恢复拒绝覆盖外部修改 /
//   重启自动收口 / 事务与单表写互斥 / 客户端 transactWhole 接真服务。
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import type { SidecarApi, SidecarSpec, SidecarWholeCommitEntry, SidecarMultiWriteResult } from '../src/lib/storage/sidecar'
import { withSidecar, SIDECAR_WHOLE_KEY, SidecarUnsupportedError } from '../src/lib/storage/sidecar'
import type { StoreOps } from '../src/lib/storage/storeOps'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const ROOT = process.cwd()
const runRoot = await fs.mkdtemp(path.join(ROOT, '.workbuddy/tmp/portable-kb-txn-'))
const appRoot = path.join(runRoot, 'app')
const dataDir = path.join(appRoot, 'data')
const blobDir = path.join(dataDir, 'blobs')
const journalPath = path.join(dataDir, '.kb-txn.json')
await fs.mkdir(dataDir, { recursive: true })
await fs.mkdir(path.join(appRoot, 'dist'), { recursive: true })
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

const kbPath = (store: string) => path.join(blobDir, store, '__all__.json')
const diskKb = async (store: string) => {
  try { return await fs.readFile(kbPath(store), 'utf8') } catch { return null }
}
const journalPresent = () => fs.stat(journalPath).then(() => true, () => false)
const getBlob = async (store: string, id: string) => {
  const r = await fetch(`${origin}/api/blob?store=${encodeURIComponent(store)}&id=${encodeURIComponent(id)}`)
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
const putBlob = async (store: string, id: string, value: unknown, ifMatch?: string | null) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (ifMatch) headers['If-Match'] = ifMatch
  const r = await fetch(`${origin}/api/blob?store=${encodeURIComponent(store)}&id=${encodeURIComponent(id)}`, {
    method: 'PUT', headers, body: JSON.stringify(value),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
const delBlob = async (store: string, id: string, ifMatch?: string | null) => {
  const headers: Record<string, string> = {}
  if (ifMatch) headers['If-Match'] = ifMatch
  const r = await fetch(`${origin}/api/blob?store=${encodeURIComponent(store)}&id=${encodeURIComponent(id)}`, { method: 'DELETE', headers })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
const postTxn = async (payload: unknown) => {
  const r = await fetch(`${origin}/api/kb-txn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
const getTxn = async () => {
  const r = await fetch(`${origin}/api/kb-txn`)
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
const currentRevs = async () => ({
  kbDocs: (await getBlob('kbDocs', SIDECAR_WHOLE_KEY)).body.revision as string,
  kbBodies: (await getBlob('kbBodies', SIDECAR_WHOLE_KEY)).body.revision as string,
})
const docsOf = (ids: string[]) => ids.map(id => ({ id, projectId: 'p1', title: 'doc-' + id }))
const bodiesOf = (ids: string[]) => ids.map(id => ({ id, text: 'body-' + id }))

/**
 * Windows 文件锁注入：以 FileShare.Read 打开文件（允许读、拒绝写/删除/改名）。
 * 服务端的「读当前态」照常成功，但原子写的 rename 阶段必失败（EPERM，重试耗尽后抛出）
 * ⇒ 精确复现「第一文件已替换、第二文件写不进去」的中断现场。
 * 返回解锁函数（杀掉持锁进程）。
 */
async function lockFileReadOnly(abs: string): Promise<() => Promise<void>> {
  const esc = abs.replace(/'/g, "''")
  const script = `$h = [System.IO.File]::Open('${esc}', [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read); [Console]::Out.Write('locked'); [Console]::Out.Flush(); Start-Sleep -Seconds 600; $h.Close()`
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('文件锁注入超时：' + abs)), 15000)
    let out = ''
    proc.stdout?.on('data', (v) => {
      out += v
      if (out.includes('locked')) { clearTimeout(timer); resolve() }
    })
    proc.once('error', (e) => { clearTimeout(timer); reject(e) })
    proc.once('exit', (code) => { if (!out.includes('locked')) { clearTimeout(timer); reject(new Error('持锁进程提前退出：' + code)) } })
  })
  return async () => {
    const closed = new Promise((resolve) => proc.once('exit', resolve))
    proc.kill()
    await Promise.race([closed, new Promise((r) => setTimeout(r, 3000))])
  }
}

try {
  await start()

  // ---------- ① 协议校验与空日志诊断 ----------
  {
    const g = await getTxn()
    ok('① 无日志时 GET 诊断 ok 且 journalPresent=false', g.status === 200 && g.body.ok === true && g.body.journalPresent === false, JSON.stringify(g.body))
    const missing = await postTxn({ expect: { kbDocs: blobRevision('kbDocs', '__all__', null) }, next: { kbDocs: [], kbBodies: [] } })
    ok('🔴 ① 缺 kbBodies 前置版本 ⇒ 400（不许只提交一半）', missing.status === 400, String(missing.status))
    const badRev = await postTxn({ expect: { kbDocs: 'whatever', kbBodies: blobRevision('kbBodies', '__all__', null) }, next: { kbDocs: [], kbBodies: [] } })
    ok('① 非法版本格式 ⇒ 400', badRev.status === 400, String(badRev.status))
    const badNext = await postTxn({ expect: { kbDocs: blobRevision('kbDocs', '__all__', null), kbBodies: blobRevision('kbBodies', '__all__', null) }, next: { kbDocs: [], kbBodies: {} } })
    ok('① 新表不是数组 ⇒ 400', badNext.status === 400, String(badNext.status))
    ok('① 校验失败未产生日志', !(await journalPresent()))
  }

  // ---------- ② 双文件原子提交（从缺失首写） ----------
  {
    const expect = { kbDocs: blobRevision('kbDocs', '__all__', null), kbBodies: blobRevision('kbBodies', '__all__', null) }
    const next = { kbDocs: docsOf(['d1']), kbBodies: bodiesOf(['d1']) }
    const r = await postTxn({ expect, next })
    ok('② 首写双文件 ⇒ 200', r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 140)}`)
    ok('② 回执版本与正文一致',
      r.body.revisions?.kbDocs === blobRevision('kbDocs', '__all__', JSON.stringify(next.kbDocs))
      && r.body.revisions?.kbBodies === blobRevision('kbBodies', '__all__', JSON.stringify(next.kbBodies)),
      JSON.stringify(r.body).slice(0, 160))
    ok('🔴 ② 两个文件同时落盘（元数据与正文成对）',
      (await diskKb('kbDocs')) === JSON.stringify(next.kbDocs) && (await diskKb('kbBodies')) === JSON.stringify(next.kbBodies))
    ok('② 完成后日志已删除', !(await journalPresent()))
  }

  // ---------- ③ 旧版本：409 且一个字都不写 ----------
  {
    const stale = { kbDocs: blobRevision('kbDocs', '__all__', null), kbBodies: blobRevision('kbBodies', '__all__', null) }
    const beforeDocs = await diskKb('kbDocs')
    const beforeBodies = await diskKb('kbBodies')
    const r = await postTxn({ expect: stale, next: { kbDocs: docsOf(['ghost']), kbBodies: bodiesOf(['ghost']) } })
    ok('🔴 ③ 任一前置版本过期 ⇒ 409 DATA_CONFLICT', r.status === 409 && r.body.code === 'DATA_CONFLICT', `${r.status} ${JSON.stringify(r.body).slice(0, 140)}`)
    ok('③ 409 带回双方当前版本', typeof r.body.revisions?.kbDocs === 'string' && typeof r.body.revisions?.kbBodies === 'string')
    ok('🔴 ③ 被拒后两个文件原样', (await diskKb('kbDocs')) === beforeDocs && (await diskKb('kbBodies')) === beforeBodies)
    ok('③ 被拒后没有日志', !(await journalPresent()))
  }

  // ---------- ④ 无变化提交：200 且不产生日志 ----------
  {
    const expect = await currentRevs()
    const r = await postTxn({ expect, next: { kbDocs: docsOf(['d1']), kbBodies: bodiesOf(['d1']) } })
    ok('④ 内容未变的提交 ⇒ 200', r.status === 200, String(r.status))
    ok('④ 无变化不写日志', !(await journalPresent()))
  }

  // ---------- ⑤ 日志写失败：一个数据文件都不动 ----------
  {
    const expect = await currentRevs()
    const beforeDocs = await diskKb('kbDocs')
    const beforeBodies = await diskKb('kbBodies')
    // 摆一份「全部已是目标态」的合法日志并锁住它：恢复可通过，但新日志 rename 必失败
    const noopJournal = {
      version: 1,
      createdAt: Date.now(),
      files: [
        { store: 'kbBodies', beforeRevision: expect.kbBodies, afterRevision: expect.kbBodies, afterText: beforeBodies },
        { store: 'kbDocs', beforeRevision: expect.kbDocs, afterRevision: expect.kbDocs, afterText: beforeDocs },
      ],
    }
    await fs.writeFile(journalPath, JSON.stringify(noopJournal))
    const unlock = await lockFileReadOnly(journalPath)
    const r = await postTxn({ expect, next: { kbDocs: docsOf(['d1', 'd2']), kbBodies: bodiesOf(['d1', 'd2']) } })
    ok('🔴 ⑤ 日志写不进去 ⇒ 500 WRITE_FAILED', r.status === 500 && r.body.code === 'WRITE_FAILED', `${r.status} ${JSON.stringify(r.body).slice(0, 140)}`)
    ok('🔴 ⑤ 没有新日志就没有可恢复性：两个数据文件一字未动',
      (await diskKb('kbDocs')) === beforeDocs && (await diskKb('kbBodies')) === beforeBodies)
    await unlock()
    await fs.rm(journalPath, { force: true })
    const retry = await postTxn({ expect, next: { kbDocs: docsOf(['d1', 'd2']), kbBodies: bodiesOf(['d1', 'd2']) } })
    ok('⑤ 障碍解除后同一提交成功', retry.status === 200, String(retry.status))
  }

  // ---------- ⑥ 第二文件写失败：日志保留 + 恢复前滚 ----------
  {
    const expect = await currentRevs()
    const next = { kbDocs: docsOf(['d1', 'd2', 'd3']), kbBodies: bodiesOf(['d1', 'd2', 'd3']) }
    // 锁住 kbDocs：读当前态成功、rename 失败 ⇒ kbBodies 先落盘、kbDocs 中断
    const unlock = await lockFileReadOnly(kbPath('kbDocs'))
    const r = await postTxn({ expect, next })
    ok('🔴 ⑥ 部分落盘 ⇒ 500 KB_TXN_PENDING（不谎报成功）', r.status === 500 && r.body.code === 'KB_TXN_PENDING', `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`)
    ok('🔴 ⑥ 日志保留（恢复凭据在）', await journalPresent())
    ok('⑥ 第一文件已是目标态', (await diskKb('kbBodies')) === JSON.stringify(next.kbBodies))

    // 障碍还在时：诊断如实说未完成，知识库写入一律拒绝（失败关闭）
    const diag = await getTxn()
    ok('⑥ 障碍未除时诊断 ok=false 且日志仍在', diag.status === 200 && diag.body.ok === false && diag.body.journalPresent === true, JSON.stringify(diag.body).slice(0, 160))
    const blockedPost = await postTxn({ expect: await currentRevs(), next })
    ok('🔴 ⑥ 恢复未完成时新事务 ⇒ 503 KB_RECOVERY_PENDING', blockedPost.status === 503 && blockedPost.body.code === 'KB_RECOVERY_PENDING', String(blockedPost.status))
    const blockedPut = await putBlob('kbBodies', SIDECAR_WHOLE_KEY, bodiesOf(['x']), (await currentRevs()).kbBodies)
    ok('🔴 ⑥ 恢复未完成时单表写同样被拒', blockedPut.status === 503, String(blockedPut.status))

    // 解除占用后触发恢复 ⇒ 前滚到目标态
    await unlock()
    const rec = await getTxn()
    ok('🔴 ⑥ 恢复把未落盘的文件补写到目标态', rec.body.ok === true && (await diskKb('kbDocs')) === JSON.stringify(next.kbDocs), JSON.stringify(rec.body).slice(0, 160))
    ok('⑥ 恢复完成后日志删除、两表成对', !(await journalPresent()) && (await diskKb('kbBodies')) === JSON.stringify(next.kbBodies))
  }

  // ---------- ⑦ 恢复前被外部修改：拒绝覆盖（失败关闭） ----------
  {
    const expect = await currentRevs()
    const next = { kbDocs: docsOf(['d1', 'd2', 'd3', 'd4']), kbBodies: bodiesOf(['d1', 'd2', 'd3', 'd4']) }
    const unlock = await lockFileReadOnly(kbPath('kbDocs'))
    const r = await postTxn({ expect, next })
    ok('⑦ 再次制造部分落盘', r.status === 500 && r.body.code === 'KB_TXN_PENDING', String(r.status))
    await unlock()
    // 外部直接改文件（绕过服务）：既不是前态也不是目标态
    const intruder = JSON.stringify(docsOf(['intruder']))
    await fs.writeFile(kbPath('kbDocs'), intruder)
    const diag = await getTxn()
    ok('🔴 ⑦ 发现恢复前被改过 ⇒ blocked（不按日志覆盖）', diag.body.ok === false && diag.body.blocked === true, JSON.stringify(diag.body).slice(0, 180))
    ok('🔴 ⑦ 外部修改原样保留、日志保留', (await diskKb('kbDocs')) === intruder && (await journalPresent()))
    const p = await postTxn({ expect: await currentRevs(), next })
    ok('🔴 ⑦ blocked 期间新事务 ⇒ 409 KB_RECOVERY_BLOCKED', p.status === 409 && p.body.code === 'KB_RECOVERY_BLOCKED', `${p.status} ${JSON.stringify(p.body).slice(0, 140)}`)
    const revs = await currentRevs()
    const w = await putBlob('kbDocs', SIDECAR_WHOLE_KEY, docsOf(['w']), revs.kbDocs)
    const d = await delBlob('kbBodies', SIDECAR_WHOLE_KEY, revs.kbBodies)
    ok('🔴 ⑦ blocked 期间单表写/删都被拒（知识库整体失败关闭）', w.status === 409 && d.status === 409, `${w.status}/${d.status}`)
    ok('⑦ 拒绝期间数据未变', (await diskKb('kbDocs')) === intruder)
    // 非知识库功能不受牵连
    const vec = await putBlob('vecRows', SIDECAR_WHOLE_KEY, [], blobRevision('vecRows', '__all__', null))
    ok('⑦ 知识库阻断不影响其他外置 store', vec.status === 200, String(vec.status))
    // 模拟人工核对后移除日志 ⇒ 解除阻断
    await fs.rm(journalPath, { force: true })
    const after = await getTxn()
    ok('⑦ 人工处置后诊断恢复正常', after.body.ok === true && after.body.journalPresent === false, JSON.stringify(after.body))
  }

  // ---------- ⑧ 重启自动收口（进程被杀在事务中途） ----------
  {
    // 直接在磁盘摆出「中断现场」：kbBodies 已替换、kbDocs 仍是前态、日志在
    const beforeDocs = JSON.stringify(docsOf(['d1', 'd2', 'd3', 'intruder']))
    const afterDocs = JSON.stringify(docsOf(['r1']))
    const afterBodies = JSON.stringify(bodiesOf(['r1']))
    const currentBodies = (await diskKb('kbBodies')) ?? '[]'
    await stop()
    await fs.mkdir(path.dirname(kbPath('kbDocs')), { recursive: true })
    await fs.writeFile(kbPath('kbDocs'), beforeDocs)
    await fs.writeFile(kbPath('kbBodies'), afterBodies)
    const journal = {
      version: 1,
      createdAt: Date.now(),
      files: [
        { store: 'kbBodies', beforeRevision: blobRevision('kbBodies', '__all__', currentBodies), afterRevision: blobRevision('kbBodies', '__all__', afterBodies), afterText: afterBodies },
        { store: 'kbDocs', beforeRevision: blobRevision('kbDocs', '__all__', beforeDocs), afterRevision: blobRevision('kbDocs', '__all__', afterDocs), afterText: afterDocs },
      ],
    }
    await fs.writeFile(journalPath, JSON.stringify(journal))
    await start()
    ok('🔴 ⑧ 启动时前滚：未落盘文件补写、已落盘文件跳过',
      (await diskKb('kbDocs')) === afterDocs && (await diskKb('kbBodies')) === afterBodies)
    ok('⑧ 启动恢复后日志删除', !(await journalPresent()))
    const diag = await getTxn()
    ok('⑧ 重启后诊断正常', diag.body.ok === true && diag.body.journalPresent === false, JSON.stringify(diag.body))
  }

  // ---------- ⑨ 事务与单表条件写互斥：并发只放行一个 ----------
  {
    const expect = await currentRevs()
    const txnNext = { kbDocs: docsOf(['t1']), kbBodies: bodiesOf(['t1']) }
    const singleDocs = docsOf(['s1'])
    const [txn, single] = await Promise.all([
      postTxn({ expect, next: txnNext }),
      putBlob('kbDocs', SIDECAR_WHOLE_KEY, singleDocs, expect.kbDocs),
    ])
    const statuses = [txn.status, single.status].sort()
    ok('🔴 ⑨ 同基线并发（事务 vs 单表写）只准一个 200', statuses[0] === 200 && statuses[1] === 409, JSON.stringify([txn.status, single.status]))
    if (txn.status === 200) {
      ok('⑨ 事务赢：两表都是事务目标态',
        (await diskKb('kbDocs')) === JSON.stringify(txnNext.kbDocs) && (await diskKb('kbBodies')) === JSON.stringify(txnNext.kbBodies))
    } else {
      ok('⑨ 单表写赢：kbDocs 是单表内容、kbBodies 未被事务触碰',
        (await diskKb('kbDocs')) === JSON.stringify(singleDocs) && (await diskKb('kbBodies')) === JSON.stringify(bodiesOf(['r1'])))
    }
    ok('⑨ 并发收场后没有残留日志', !(await journalPresent()))
  }

  // ---------- ⑩ 单表知识库读写回归（新锁路径不破坏原协议） ----------
  {
    const revs = await currentRevs()
    const naked = await putBlob('kbDocs', SIDECAR_WHOLE_KEY, docsOf(['naked']))
    ok('🔴 ⑩ 整表无前置条件仍 428', naked.status === 428, String(naked.status))
    const good = await putBlob('kbDocs', SIDECAR_WHOLE_KEY, docsOf(['k1']), revs.kbDocs)
    ok('⑩ 带正确版本单表写 ⇒ 200', good.status === 200, String(good.status))
    const now = (await getBlob('kbDocs', SIDECAR_WHOLE_KEY)).body.revision as string
    const del = await delBlob('kbDocs', SIDECAR_WHOLE_KEY, now)
    ok('⑩ 条件删除 ⇒ 200 且文件消失', del.status === 200 && (await diskKb('kbDocs')) === null, String(del.status))
    // 收尾：把两表恢复成成对状态，供下一节使用
    const expect = await currentRevs()
    await postTxn({ expect, next: { kbDocs: docsOf(['base']), kbBodies: bodiesOf(['base']) } })
  }

  // ---------- ⑪ 客户端 transactWhole ↔ 真实服务 ----------
  {
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
        if (r.status === 409 || r.status === 428) return { ok: false, conflict: true }
        if (r.status !== 200) return { ok: false }
        return { ok: true }
      }
      async commitWhole(entries: SidecarWholeCommitEntry[]): Promise<SidecarMultiWriteResult> {
        const expect: Record<string, string | null> = {}
        const next: Record<string, unknown[]> = {}
        for (const e of entries) { expect[e.store] = e.expectedRevision; next[e.store] = e.value }
        try {
          const r = await postTxn({ expect, next })
          if (r.status === 404) return { ok: false, unsupported: true }
          if (r.status === 409 && r.body.code === 'DATA_CONFLICT') return { ok: false, conflict: true }
          if (r.status !== 200) return { ok: false }
          return { ok: true, revisions: r.body.revisions }
        } catch {
          return { ok: false, unknown: true }
        }
      }
    }
    const base: StoreOps = {
      async getAll<T>() { return [] as T[] },
      async get<T>() { return undefined as T | undefined },
      async put() {}, async del() {},
      async getAllByIndex<T>() { return [] as T[] },
      async bulkPut() {}, async bulkDel() {},
    }
    const spec: SidecarSpec = { kbDocs: { layout: 'whole', keyField: 'id' }, kbBodies: { layout: 'whole', keyField: 'id' } }
    const api = new HttpApi()
    const errsA: string[] = []
    const errsB: string[] = []
    const opsA = withSidecar(base, api, spec, m => errsA.push(m))
    const opsB = withSidecar(base, api, spec, m => errsB.push(m))
    const addDoc = (id: string) => (rows: Record<string, unknown[]>) => ({
      kbDocs: [...rows.kbDocs.filter(r => (r as { id: string }).id !== id), { id, projectId: 'p1' }],
      kbBodies: [...rows.kbBodies.filter(r => (r as { id: string }).id !== id), { id, text: 'body-' + id }],
    })
    await Promise.all([
      ...['a1', 'a2', 'a3'].map(id => opsA.transactWhole(['kbDocs', 'kbBodies'], addDoc(id), { kbDocs: new Set([id]), kbBodies: new Set([id]) })),
      ...['b1', 'b2', 'b3'].map(id => opsB.transactWhole(['kbDocs', 'kbBodies'], addDoc(id), { kbDocs: new Set([id]), kbBodies: new Set([id]) })),
    ])
    const docs = ((await getBlob('kbDocs', SIDECAR_WHOLE_KEY)).body as { value?: { id: string }[] }).value ?? []
    const bodies = ((await getBlob('kbBodies', SIDECAR_WHOLE_KEY)).body as { value?: { id: string }[] }).value ?? []
    const docIds = docs.map(r => r.id).sort()
    const bodyIds = bodies.map(r => r.id).sort()
    ok('🔴 ⑪ 两页并发跨表事务：6 条元数据与正文全部成对保留',
      JSON.stringify(docIds) === JSON.stringify(['a1', 'a2', 'a3', 'b1', 'b2', 'b3', 'base'])
      && JSON.stringify(bodyIds) === JSON.stringify(docIds),
      JSON.stringify({ docIds, bodyIds }))
    ok('⑪ 两页都没有失败告警', errsA.length === 0 && errsB.length === 0, JSON.stringify([...errsA, ...errsB]))
    ok('⑪ 并发收场后没有残留日志', !(await journalPresent()))

    // 同一记录被另一页先改：拒绝覆盖
    {
      let injected = false
      const racingApi: SidecarApi = {
        read: (s, i) => api.read(s, i), write: (s, i, v) => api.write(s, i, v),
        remove: (s, i) => api.remove(s, i), listIds: s => api.listIds(s),
        readVersioned: (s, i) => api.readVersioned(s, i),
        writeConditional: (s, i, v, e) => api.writeConditional(s, i, v, e),
        commitWhole: async (entries) => {
          if (!injected) {
            injected = true
            const revs = await currentRevs()
            const curDocs = ((await getBlob('kbDocs', SIDECAR_WHOLE_KEY)).body as { value?: { id: string; text?: string }[] }).value ?? []
            const curBodies = ((await getBlob('kbBodies', SIDECAR_WHOLE_KEY)).body as { value?: { id: string; text?: string }[] }).value ?? []
            const r = await postTxn({
              expect: revs,
              next: {
                kbDocs: curDocs.map(d => d.id === 'same' ? { ...d, title: 'newer' } : d),
                kbBodies: curBodies.map(b => b.id === 'same' ? { ...b, text: 'newer-body' } : b),
              },
            })
            if (r.status !== 200) throw new Error('注入并发事务失败：' + r.status)
          }
          return api.commitWhole(entries)
        },
      }
      // 先放入 same 记录
      await opsA.transactWhole(['kbDocs', 'kbBodies'], addDoc('same'), { kbDocs: new Set(['same']), kbBodies: new Set(['same']) })
      const errs: string[] = []
      const ops = withSidecar(base, racingApi, spec, m => errs.push(m))
      let rejected = false
      try {
        await ops.transactWhole(['kbDocs', 'kbBodies'], rows => ({
          kbDocs: rows.kbDocs.map(r => (r as { id: string }).id === 'same' ? { ...(r as Record<string, unknown>), title: 'old draft' } : r),
          kbBodies: rows.kbBodies.map(r => (r as { id: string }).id === 'same' ? { ...(r as Record<string, unknown>), text: 'old body' } : r),
        }), { kbDocs: new Set(['same']), kbBodies: new Set(['same']) })
      } catch { rejected = true }
      const finalDocs = ((await getBlob('kbDocs', SIDECAR_WHOLE_KEY)).body as { value?: { id: string; title?: string }[] }).value ?? []
      const finalBodies = ((await getBlob('kbBodies', SIDECAR_WHOLE_KEY)).body as { value?: { id: string; text?: string }[] }).value ?? []
      ok('🔴 ⑪ 同一记录并发跨表修改：拒绝覆盖，对方新内容成对保留',
        rejected && errs.length > 0
        && finalDocs.find(d => d.id === 'same')?.title === 'newer'
        && finalBodies.find(b => b.id === 'same')?.text === 'newer-body',
        JSON.stringify({ rejected, errs, finalDocs: finalDocs.filter(d => d.id === 'same'), finalBodies: finalBodies.filter(b => b.id === 'same') }))
    }

    // 旧通道（无 commitWhole）⇒ 类型化回退，不假装原子
    {
      const legacy: SidecarApi = {
        read: (s, i) => api.read(s, i), write: (s, i, v) => api.write(s, i, v),
        remove: (s, i) => api.remove(s, i), listIds: s => api.listIds(s),
        readVersioned: (s, i) => api.readVersioned(s, i),
        writeConditional: (s, i, v, e) => api.writeConditional(s, i, v, e),
      }
      const ops = withSidecar(base, legacy, spec)
      let unsupported = false
      try { await ops.transactWhole(['kbDocs', 'kbBodies'], addDoc('legacy'), { kbDocs: new Set(['legacy']), kbBodies: new Set(['legacy']) }) }
      catch (e) { unsupported = e instanceof SidecarUnsupportedError }
      ok('🔴 ⑪ 旧通道 ⇒ SidecarUnsupportedError（业务层回退补偿路径）', unsupported)
      const docsNow = ((await getBlob('kbDocs', SIDECAR_WHOLE_KEY)).body as { value?: { id: string }[] }).value ?? []
      ok('⑪ 回退前未写入任何数据', !docsNow.some(d => d.id === 'legacy'))
    }
  }
} catch (e) {
  ok('运行期未抛错', false, e instanceof Error ? e.message : String(e))
} finally {
  await stop()
  console.log(`\n———— portableKbTxn：${pass} 通过 / ${fail} 失败 ————`)
  if (fail) process.exitCode = 1
}