// ============ 云同步防呆：空载荷守卫 / 云端载荷解不开就别覆盖 / 推不上去要报错 ============
//
// 这三条锁的是 2026-09-15 那轮审计里**最危险的一类静默路径**（都能让云端数据无声消失）：
//   ① 空推守卫原先用 `Object.keys(...).length` 判空 —— `liveStores` 会把每个 store 都放成键
//      （哪怕是空数组），12 个空数组就能骗过它，一份空快照照样被推上云端。
//   ② 409（远端更新）时若 `decryptObj(resp.enc)` 抛错，旧实现把 serverCache 置 null 继续
//      以本地 cache 重试 → 用 serverRev 覆盖那份**只有云端才有**的加密载荷，连 .corrupt 都不留。
//   ③ `flushNow` 只对「抛错」设 error，而 pushNow 重试耗尽时是**返回** {conflict:true}（不抛）
//      → 状态永远停在 'syncing'（界面一直转圈，实际一条都没上传）。
//
// 这三条都靠端到端点不出来（需要一个真出错的云盘目录），所以必须先锁死。
import { createCloudStore } from '../src/lib/syncCore'
import fs from 'node:fs'
import path from 'node:path'
import { SAVE_DEBOUNCE_MS } from '../src/lib/constants'
import type { SyncTransport } from '../src/lib/syncTransport'
import { __resetMockStores, __resetLocalStorage } from './mock-memory'

/** 读源码 —— ⑫ 的接线断言要看**位置关系**，光跑行为测不出来（见那条的说明） */
const read = (rel: string) => {
  const p = path.join(process.cwd(), rel)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type PushRec = { baseRev: number; enc: string }

/** 可编排的传输层替身：pull / push 的行为由用例给定，并记录每次 push。 */
function scriptedTransport(opts: {
  pull?: () => Promise<{ status: number; rev?: number; enc?: string | null }> | { status: number; rev?: number; enc?: string | null }
  push?: (baseRev: number, enc: string) => Promise<{ status: number; rev?: number; enc?: string | null }> | { status: number; rev?: number; enc?: string | null }
}) {
  const pushes: PushRec[] = []
  const t: SyncTransport = {
    mode: 'file',
    setCode() { /* 测试不关心槽位 */ },
    async pull() { return opts.pull ? await opts.pull() : { status: 200, rev: 0, enc: null } },
    async push(baseRev, enc) {
      pushes.push({ baseRev, enc })
      return opts.push ? await opts.push(baseRev, enc) : { status: 200, rev: baseRev + 1 }
    },
    startWatch() { /* 测试不轮询 */ },
    stopWatch() { /* 同上 */ },
  }
  return { t, pushes }
}

async function main() {
  __resetMockStores()

  // ---------- ① 全空载荷必须被拒（键数判法会被「12 个空数组」骗过去） ----------
  {
    const { t, pushes } = scriptedTransport({})
    const cloud = createCloudStore(t)
    cloud.configure('test-key')

    // 先正常播种一份有内容的数据 → push 成功 → baseCache 变成非空
    await cloud.seedFromLocal(async () => [{ id: 'p1' }])
    const afterSeed = pushes.length
    ok('正常播种会推一次', afterSeed === 1, String(afterSeed))

    // 再把「全是空数组」的载荷喂进去（模拟 cache 被清空的瞬间）
    let threw = false
    let msg = ''
    try {
      await cloud.seedFromLocal(async () => [])
    } catch (e) {
      threw = true
      msg = e instanceof Error ? e.message : String(e)
    }
    ok('🔴 全空载荷被拒（不是「12 个空 store 也算有内容」）', threw && /empty push/.test(msg), msg)
    ok('被拒时没有真的推上去', pushes.length === afterSeed, `${pushes.length} vs ${afterSeed}`)
  }

  // ---------- ② 409 且云端载荷解不开 → 停止重试，绝不覆盖 ----------
  {
    let pushCount = 0
    const { t } = scriptedTransport({
      pull: () => ({ status: 200, rev: 1, enc: null }),
      // 远端永远「比本地新」，且交回来的是一段解不开的负载
      push: () => { pushCount++; return { status: 409, rev: 2, enc: 'not-a-valid-encrypted-payload' } },
    })
    const cloud = createCloudStore(t)
    cloud.configure('test-key')

    let threw = false
    let msg = ''
    try {
      await cloud.seedFromLocal(async () => [{ id: 'p1' }])
    } catch (e) {
      threw = true
      msg = e instanceof Error ? e.message : String(e)
    }
    ok('🔴 云端载荷解不开时抛错（不再拿本地 cache 去覆盖它）', threw && /undecryptable/.test(msg), msg)
    ok('🔴 只尝试了一次，不进入重试循环', pushCount === 1, String(pushCount))
    ok('状态置为 error（界面不会假装同步中）', cloud.getStatus() === 'error', cloud.getStatus())
  }

  // ---------- ③ 重试耗尽（conflict 是「返回」不是「抛」）→ 状态必须落到 error ----------
  {
    const { t } = scriptedTransport({
      pull: () => ({ status: 200, rev: 1, enc: null }),
      // 每次都是「远端更新但没有负载可合并」→ 上层合并后重试，直到 MAX_CONFLICT_RETRY 用尽
      push: (baseRev) => ({ status: 409, rev: baseRev + 1, enc: null }),
    })
    const cloud = createCloudStore(t)
    cloud.configure('test-key')

    // 走防抖那条路（flushNow），这才是真实写入路径
    await cloud.store.put('projects', { id: 'p1' })
    await sleep(1400) // 等防抖窗口过完
    ok('🔴 推不上去时状态是 error，而不是永远 syncing', cloud.getStatus() === 'error', cloud.getStatus())
  }

  // ---------- ④ 🔴 闩锁自愈（审计 P0-2）：一次推送抖动不能把同步永久锁死 ----------
  //
  // 修前：`transport.push` 抛错会置 `transientUnavailable`，而能复位它的 `ensureInit` 被
  // `initPromise` 记忆化（此后再不会被调用）、`backgroundPull` 又开头就 return ——
  // 于是标志再没有清掉的机会，只剩「换目录 / 重开同步」一条路。
  // 后果：包装层（`isCloudUnavailable()`）一直把读写切在本地库上，关窗镜像又拿**陈旧 cache**
  // 覆盖本地新记录 —— 编辑先落本地生效、随即被静默回滚并写盘（磁盘不可逆丢失）。
  {
    let pushDown = false
    const { t } = scriptedTransport({
      pull: () => ({ status: 200, rev: 1, enc: null }),
      push: () => (pushDown ? Promise.reject(new Error('disk busy')) : { status: 200, rev: 2 }),
    })
    const cloud = createCloudStore(t)
    cloud.onFallback(() => { /* 用例只关心闩锁状态，兜底回调不必做事 */ })
    cloud.configure('latch-key')

    // 先正常写一次 → init 落定、push 成功
    await cloud.store.put('projects', { id: 'p1' })
    await sleep(1400)
    ok('前置：正常写入后云端可用', cloud.isCloudUnavailable() === false, String(cloud.isCloudUnavailable()))

    // 抖动开始：push 抛错（等价于网盘客户端占住同步目录 / 网络瞬断）
    pushDown = true
    await cloud.store.put('projects', { id: 'p2' })
    await sleep(1400)
    ok('🔴 推送失败后进入「云端不可用」', cloud.isCloudUnavailable() === true, String(cloud.isCloudUnavailable()))

    // 抖动结束：再走一次 flushNow（真实里的关窗 / 轮询回落路径）应当能自愈
    pushDown = false
    await cloud.flushNow()
    ok('🔴 恢复后能自愈（修前是单向闩锁，永远停在不可用）', cloud.isCloudUnavailable() === false, String(cloud.isCloudUnavailable()))
    ok('自愈后状态不再停在 offline', cloud.getStatus() !== 'offline', cloud.getStatus())
  }

  // ---------- ④ 并发推送必须串行（P1-7） ----------
  // FileTransport.push 是「读 rev → 写 baseRev+1」的**非原子序列**：两次同 baseRev 的并发写
  // 会互相覆盖、rev 不推进（两边都回 200），其中一份内容静默消失。
  // 防抖路径（flushNow）本来有 pushing 守卫，但 restoreFromCloudBackup / seedFromLocal
  // 是直接 await pushNow() 的、绕过了它 —— 修法是在最底层把 push 串行化。
  {
    let inFlight = 0, maxInFlight = 0
    const seen: number[] = []
    const { t } = scriptedTransport({
      push: async (baseRev) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        seen.push(baseRev)
        await sleep(40)          // 制造重叠窗口：不串行的话两次 push 会同时在这 40ms 里
        inFlight--
        return { status: 200, rev: baseRev + 1 }
      },
    })
    const cloud = createCloudStore(t)
    cloud.configure('concurrency-key')
    await cloud.seedFromLocal(async () => [{ id: 'c1' }])   // 建立基线（rev 0→1）并产生 cloudBackup
    const afterSeed = seen.length

    // 同时发起两次「从备份恢复」——两个入口原先都直接 await pushNow，会并发写同一 baseRev
    await Promise.all([cloud.restoreFromCloudBackup(), cloud.restoreFromCloudBackup()])
    const raws = seen.slice(afterSeed)

    ok('🔴 并发推送被串行化（任一时刻只有一次在途）', maxInFlight === 1, `maxInFlight=${maxInFlight}`)
    ok('第二次推送用的是**推进后**的 rev（不是排到时已过期的基线）',
      raws.length === 2 && raws[1] === raws[0] + 1, JSON.stringify(raws))
  }

  // ---------- ⑤ 换目录：待推送的防抖计时器必须清掉（P2-1） ----------
  // 不清的话：旧计时器在 transport 已指向新目录时才触发，而 cache 此刻已被清空
  // → 把一份空载荷当「rev=0 的第一份」推上去（新目录凭空多出 rev=1），
  //   并让本该走「空则播种」的流程被推进 409 冲突分支。
  {
    const { t, pushes } = scriptedTransport({})
    const cloud = createCloudStore(t)
    cloud.configure('dir-a')
    await cloud.store.put('projects', { id: 'p1' })   // 写一笔 → 排下一次防抖推送
    cloud.configure('dir-b')                          // 立刻换目录
    await sleep(SAVE_DEBOUNCE_MS + 700)
    ok('🔴 换目录后旧计时器不再补推（否则新目录会多出一份空载荷）',
      pushes.length === 0, '实际推了 ' + pushes.length + ' 次：' + JSON.stringify(pushes.map(p => p.baseRev)))
  }

  // ---------- ⑥ 换目录必须清掉云备份元信息（P2-2） ----------
  // cloudBackup 属于**上一个目录**；同名日切换时 day 相同 → pushNow 里「day 变了才重建」
  // 不成立 → 旧目录的备份被写进新目录载荷，点「从备份恢复」还会回灌旧目录内容。
  {
    const { t } = scriptedTransport({})
    const cloud = createCloudStore(t)
    cloud.configure('dir-a')
    await cloud.seedFromLocal(async () => [{ id: 'x1' }])   // 正常播种 → 产生 cloudBackup
    ok('前置：播种后确实存在云备份元信息', cloud.getCloudBackupMeta() !== null)
    cloud.configure('dir-b')
    ok('🔴 换目录后云备份元信息被清掉（不会把旧目录的备份带到新目录）',
      cloud.getCloudBackupMeta() === null, JSON.stringify(cloud.getCloudBackupMeta()))
  }

  // ---------- ⑦ 播种时读本地失败 → 中止，绝不推残缺载荷（P2-3） ----------
  {
    const { t, pushes } = scriptedTransport({})
    const cloud = createCloudStore(t)
    cloud.configure('seed-partial')
    let n = 0
    let threw = false, msg = ''
    try {
      await cloud.seedFromLocal(async () => {
        n++
        if (n === 2) throw new Error('read failed')   // 第 2 个 store 读失败
        return [{ id: 'ok-' + n }]
      })
    } catch (e) { threw = true; msg = e instanceof Error ? e.message : String(e) }
    ok('🔴 播种时某个 store 读失败 → 抛出并中止（不再静默当空继续推）', threw && /播种失败/.test(msg), msg)
    ok('中止时一次都没推（残缺载荷不会成为新基线）', pushes.length === 0, String(pushes.length))
  }

  // ---------- ⑧ 「幽灵项目」：本机删掉的记录，不能被云端旧快照带回来 ----------
  //
  // 2026-09-19 老大实测：删掉的项目每次打开软件又出现在项目管理页（且反复出现）。
  // 根因：`baseCache` 只活在内存里、**每次启动都是空的**，启动后第一次合并时
  //       「本地没有、云端有」的记录因基线里查不到而被判成「另一端新增」→ 采用云端；
  //       删掉的记录于是被带回来，复活后又被推回云端 → 此后每次启动稳定复现（自锁）。
  // 修复（两件事缺一不可）：
  //   ① `store.del` 记**墓碑** —— "本机明确删过它"的唯一凭据；
  //   ② 启动合并把**本地库**当 `local` 路 —— 证明"我这份库是有内容的"，
  //      否则空 cache 会让墓碑判定被安全闸挡住（怕误删云端数据）。
  {
    __resetMockStores()
    __resetLocalStorage()

    // —— 第一次同步：云端与本地库都有 p1 / p2，并推上一份云端载荷 ——
    const { t, pushes } = scriptedTransport({})
    const cloud = createCloudStore(t)
    cloud.configure('ghost-key')
    // 先跑完 ensureInit（mock 的 pull 返回 enc:null，会让 cache 归零）——
    // 否则下面 del 里的首次 ensureInit 会顺手把刚 seed 进去的数据清掉。
    await cloud.pullSnapshot()
    await cloud.seedFromLocal(async (s) => (s === 'projects' ? [{ id: 'p1' }, { id: 'p2' }] : []))
    const cloudEnc = pushes[pushes.length - 1]?.enc
    ok('前置：播种推了一次并留下云端载荷', pushes.length === 1 && !!cloudEnc, String(pushes.length))

    // —— 本机删除 p2（这就是老大删掉的那个项目）——
    await cloud.store.del('projects', 'p2')
    const afterDel = await cloud.store.getAll<{ id: string }>('projects')
    ok('前置：本机已删掉 p2', afterDel.length === 1 && afterDel[0].id === 'p1', JSON.stringify(afterDel))

    // —— 模拟「重启软件」：新实例（基线归零）、墓碑仍在 localStorage；
    //     本地库（数据文件）含 p1、不含 p2 —— 正是老大机器上的真实形态 ——
    const t2 = scriptedTransport({ pull: () => ({ status: 200, rev: 9, enc: cloudEnc }) })
    const cloud2 = createCloudStore(t2.t)
    cloud2.configure('ghost-key')
    cloud2.onLocalSnapshot(async () => ({ projects: [{ id: 'p1' }] }))
    await cloud2.pullSnapshot()
    const merged = await cloud2.store.getAll<{ id: string }>('projects')
    ok('🔴 重启后合并：被删的 p2 不会被云端旧快照带回来（幽灵项目修复）',
      merged.length === 1 && merged[0].id === 'p1', JSON.stringify(merged))
  }

  // ---------- ⑨ 反例①：全新设备首同步仍要采纳云端（修复不能误伤「真·新增」） ----------
  // 修复里那道 `localHasContent` 闸就是为它立的：本机还没见过这些记录时，
  // 必须原样采纳云端 —— 否则新设备首次同步会把整库云端数据丢掉，比幽灵项目严重得多。
  {
    __resetMockStores()
    __resetLocalStorage() // 全新设备：无墓碑、本地库为空
    const { t, pushes } = scriptedTransport({})
    const cloud = createCloudStore(t)
    cloud.configure('newdev-key')
    // 先跑完 ensureInit（mock 的 pull 返回 enc:null，会让 cache 归零）——
    // 否则下面 del 里的首次 ensureInit 会顺手把刚 seed 进去的数据清掉。
    await cloud.pullSnapshot()
    await cloud.seedFromLocal(async (s) => (s === 'projects' ? [{ id: 'x1' }, { id: 'x2' }] : []))
    const enc = pushes[pushes.length - 1]?.enc

    __resetMockStores()
    __resetLocalStorage()
    const t2 = scriptedTransport({ pull: () => ({ status: 200, rev: 9, enc }) })
    const cloud2 = createCloudStore(t2.t)
    cloud2.configure('newdev-key')
    cloud2.onLocalSnapshot(async () => ({})) // 本机数据文件是空的
    await cloud2.pullSnapshot()
    const rows = await cloud2.store.getAll<{ id: string }>('projects')
    ok('🔴 反例：全新设备（无墓碑、本地库为空）照样采纳云端记录，不会丢数据',
      rows.length === 2, JSON.stringify(rows))
  }

  // ---------- ⑩ 反例②：删掉又重建（put 清墓碑）不能被墓碑永久挡住 ----------
  // 墓碑若只在 del 里加、不在 put 里清，"删掉再导入回来"的记录就会被永久挡住 ——
  // 那是个比幽灵项目更难发现的死记录。
  {
    __resetMockStores()
    __resetLocalStorage()
    const { t, pushes } = scriptedTransport({})
    const cloud = createCloudStore(t)
    cloud.configure('revive-key')
    // 先跑完 ensureInit（mock 的 pull 返回 enc:null，会让 cache 归零）——
    // 否则下面 del 里的首次 ensureInit 会顺手把刚 seed 进去的数据清掉。
    await cloud.pullSnapshot()
    await cloud.seedFromLocal(async (s) => (s === 'projects' ? [{ id: 'r1' }] : []))
    const enc = pushes[pushes.length - 1]?.enc

    await cloud.store.del('projects', 'r1') // 删 → 记墓碑
    await cloud.store.put('projects', { id: 'r1' }) // 重建同 id → 应清墓碑
    const back = await cloud.store.getAll<{ id: string }>('projects')
    ok('前置：删掉又重建后，本机重新持有 r1', back.length === 1, JSON.stringify(back))

    const t2 = scriptedTransport({ pull: () => ({ status: 200, rev: 9, enc }) })
    const cloud2 = createCloudStore(t2.t)
    cloud2.configure('revive-key')
    cloud2.onLocalSnapshot(async () => ({ projects: [{ id: 'r1' }] }))
    await cloud2.pullSnapshot()
    const rows = await cloud2.store.getAll<{ id: string }>('projects')
    ok('🔴 反例：墓碑随写入清除，重建后的记录能正常同步（不是删得掉、进不来）',
      rows.length === 1, JSON.stringify(rows))
  }

  // ---------- ⑪ 负面对照：**不注册**「读本地库快照」⇒ 被删的记录立刻复活 ----------
  //
  // 这是 ⑧ 的反面，也是 2026-09-20 六维审计那条 P0 的真身。
  // 🔴 为什么 ⑧ 抓不到它：⑧ 在测试里**手动**调了 `cloud2.onLocalSnapshot(...)` ——
  //    等于替产品补上了那一步接线。于是「syncCore 的合并逻辑正确」恒成立，
  //    而「产品的启动路径到底有没有注册」谁也没验。
  //    **测试替身补上的那一步，正是产品漏掉的那一步** —— 这类接线缺口只能靠
  //    「把替身拿掉，看还剩什么」来暴露（⑫ 再用源码位置把它钉死）。
  {
    __resetMockStores()
    __resetLocalStorage()

    const { t, pushes } = scriptedTransport({})
    const cloud = createCloudStore(t)
    cloud.configure('ghost-key')
    await cloud.pullSnapshot()
    await cloud.seedFromLocal(async (s) => (s === 'projects' ? [{ id: 'p1' }, { id: 'p2' }] : []))
    const cloudEnc = pushes[pushes.length - 1]?.enc
    ok('前置：云端已有一份含 p1 / p2 的载荷', !!cloudEnc, String(pushes.length))

    await cloud.store.del('projects', 'p2') // 本机删掉 p2（墓碑落在 localStorage）

    // —— 模拟重启：新实例 + 墓碑仍在，但**故意不注册** onLocalSnapshot（复刻漏注册现场）——
    const t2 = scriptedTransport({ pull: () => ({ status: 200, rev: 9, enc: cloudEnc }) })
    const cloud2 = createCloudStore(t2.t)
    cloud2.configure('ghost-key')
    await cloud2.pullSnapshot()
    const merged = await cloud2.store.getAll<{ id: string }>('projects')
    ok('🔴🔴 负面对照：漏注册「读本地库快照」⇒ 被删的 p2 复活（P0 的完整机制）',
      merged.length === 2, JSON.stringify(merged))
  }

  // ---------- ⑫ 接线：注册必须落在「所有云模式入口的必经之路」上 ----------
  //
  // ⑪ 证明「漏了就坏」，这条证明「现在不会再漏」。
  // 🔴 判据是**位置关系**而非「文本存在」：原文里确实有注册语句，只是挂错了地方
  //    （只在手动开启那条路径上），所以「grep 一下有就通过」的写法正是它能长期存活的原因。
  {
    const core = read('src/lib/db/core.ts')
    const callIdx = core.indexOf('onDesktopLocalSnapshot(async () => {')
    const bootIdx = core.indexOf('if (CLOUD_FILE_SYNC) {')
    const enableIdx = core.indexOf('export async function enableDesktopCloudSync')
    const storeIdx = core.indexOf('const desktopLocalStore')

    ok('前置：core.ts 里能找到注册回调', callIdx > 0, `callIdx=${callIdx}`)
    ok('🔴 注册在 desktopLocalStore 定义**之后**（否则读不到本机数据文件）',
      storeIdx > 0 && storeIdx < callIdx, `storeIdx=${storeIdx} callIdx=${callIdx}`)
    ok('🔴 注册在**模块顶层**（不在任何函数体内 ⇒ 早于手动开启函数）',
      enableIdx > 0 && callIdx < enableIdx, `callIdx=${callIdx} enableIdx=${enableIdx}`)
    ok('🔴 注册早于启动恢复块（模块顶层求值先于它的 async IIFE）⇒ 启动首次合并带得上本地快照',
      bootIdx > 0 && callIdx < bootIdx, `callIdx=${callIdx} bootIdx=${bootIdx}`)
    ok('🔴 全文件只有这一处注册（两处＝两处会各自漂移的口径，漏的那处单测看不出来）',
      (core.match(/onDesktopLocalSnapshot\(/g) ?? []).length === 1,
      String((core.match(/onDesktopLocalSnapshot\(/g) ?? []).length))
  }

  console.log(`\nsyncGuards: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  process.exitCode = 1
})
