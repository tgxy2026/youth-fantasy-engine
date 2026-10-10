// 3.0 · W3-2 · §11.2 建议 3 —— 同步层「恢复 / 回滚 / 镜像」三条路径的专职测试
//
// 为什么单开一个文件（§11.2 建议 3 原文）：2.9.3 修的那条 P1（从云端备份恢复被**静默撤销**）
// 与历史两条（墓碑四路径「删了会复活」、`baseCache` 启动即空）**是同一个家族** ——
// 都是「静默地让某个动作白做」，而 `syncGuards` 当时只覆盖了其中一部分（幽灵项目那四条）。
//
// 本文件补三条**动作路径**：
//   ⑮ 恢复：`restoreFromCloudBackup` 回滚到检查点 + **清墓碑**（否则下次合并又把它丢掉）+ 镜像回调；
//   ⑯ 回滚防护：恢复后推送撞 409 且重试耗尽 ⇒ 返回 false **且状态 error**（绝不谎报「已恢复」）；
//   ⑰ 镜像：推送/拉取被挡时 `onFallback` 收到的快照**不可为空**（清了就等于静默丢改动）。
import { createCloudStore, onCloudRestored } from '../src/lib/sync/syncCore'
import { isDeleted } from '../src/lib/sync/syncTombstone'
import type { SyncTransport } from '../src/lib/sync/syncTransport'
import { __resetMockStores, __resetLocalStorage } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

type PushRec = { baseRev: number; enc: string }

/** 可编排的传输层替身（与 syncGuards 同款）：pull / push 行为由用例给定，并记录每次 push。 */
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
  // ---------- ⑮ 恢复：回滚到云端检查点 + 清墓碑 + 镜像回调 ----------
  //
  // 病灶（2026-10-02 六维审计 P2）：这条路径直接给 cache 赋值，**绕过了 put/bulkPut 的 clearDeleted** ——
  //   本机删过（有墓碑）、备份里还留着的那条，恢复后会在下一次三路合并里被判「本机删过」而丢弃
  //   → drifted 回推 → **恢复被静默撤销**。作者以为恢复成功了，白忙一场。
  {
    __resetMockStores()
    __resetLocalStorage()

    const { t, pushes } = scriptedTransport({})
    const cloud = createCloudStore(t)
    cloud.configure('restore-key')
    await cloud.pullSnapshot() // 跑完 init，避免后续 put 的首次 ensureInit 清掉刚写入的数据

    // 放入 p1 并立即推一次 —— 顺带生成「今日云备份」（含 p1），这就是那个检查点
    await cloud.store.put('projects', { id: 'p1', name: '甲' })
    await cloud.flushNow()
    ok('前置：云备份已生成', !!cloud.getCloudBackupMeta(), String(cloud.getCloudBackupMeta()))
    const pushesBefore = pushes.length

    // 本机删掉 p1 → 记墓碑（正是「恢复被静默撤销」的前一半场景）
    await cloud.store.del('projects', 'p1')
    ok('前置：本机删了 p1 → 有墓碑', isDeleted('projects', 'p1'))
    ok('前置：本机此刻确实没有 p1', (await cloud.store.getAll<{ id: string }>('projects')).length === 0)

    // 登记恢复后的「镜像回本机数据文件」回调（2026-10-10 P1 的那条接线）
    let mirrored: unknown = null
    onCloudRestored((cache) => { mirrored = cache })

    const restored = await cloud.restoreFromCloudBackup()
    ok('🔴 恢复返回 true', restored === true)

    const rows = await cloud.store.getAll<{ id: string }>('projects')
    ok('🔴 回滚到检查点：p1 回来了', rows.length === 1 && rows[0].id === 'p1', JSON.stringify(rows))
    ok('🔴 恢复一并清墓碑（否则下次合并又丢弃它 = 恢复被静默撤销）', !isDeleted('projects', 'p1'))
    ok('恢复后重新推了云端（回滚上传）', pushes.length > pushesBefore, `${pushesBefore} → ${pushes.length}`)

    const m = mirrored as { projects?: unknown[] } | null
    ok('🔴 镜像回调被调，且带回了恢复后的数据（写回本机文件，否则界面 reload 又盖回去）',
      !!m && Array.isArray(m.projects) && m.projects.length === 1, JSON.stringify(m))

  }

  // ---------- ⑯ 回滚防护：恢复后推送撞 409 且重试耗尽 ⇒ false + error（不谎报成功） ----------
  //
  // 病灶（2026-09-20 六维审计 P2）：`pushNow` 在重试耗尽时是**返回** `{conflict:true}` 而不是抛。
  //   忽略它 ⇒ `restoreFromCloudBackup` 照旧 `return true` ⇒ 界面报「已从备份恢复」，
  //   而云端其实一个字都没变 —— 下次拉取又把 cache 覆盖回去。
  {
    __resetMockStores()
    __resetLocalStorage()

    // push 恒 409 且不带 enc（不提供可合并的云端版本）⇒ 重试耗尽必落 conflict:true
    const { t } = scriptedTransport({ push: () => ({ status: 409, rev: 99 }) })
    const cloud = createCloudStore(t)
    cloud.configure('rollback-key')
    await cloud.pullSnapshot()

    await cloud.store.put('projects', { id: 'x1' })
    // 先推一次让「今日云备份」生成（pushNowRaw 在发请求**之前**就写了 cloudBackup）
    await cloud.flushNow().catch(() => { /* 409 耗尽会置 error，这里只关心 cloudBackup 已生成 */ })
    ok('前置：云备份已生成（即便推送失败）', !!cloud.getCloudBackupMeta())

    const r = await cloud.restoreFromCloudBackup()
    ok('🔴 恢复后推送没能落地 ⇒ 返回 false（绝不谎报「已恢复」）', r === false)
    ok('🔴 且状态落到 error（界面能看出来，不是一直转圈）', cloud.getStatus() === 'error', cloud.getStatus())

  }

  // ---------- ⑰ 镜像：推送/拉取被挡时，兜底回调收到的快照不可为空 ----------
  //
  // 病灶（2026-09-21 六维审计 P1）：拉取失败时若**清空 cache**，随后 `fallbackHandler(snapshotOf(cache))`
  //   会拿到**空快照** → 镜像什么都不写 → 「把未推送改动镜像回本地」这条唯一的兜底被无声抵消。
  //   本项目的红线是「绝不返回空库，否则 push 覆盖云端」；保留旧 cache 才是安全的那一侧。
  {
    __resetMockStores()
    __resetLocalStorage()

    const { t } = scriptedTransport({})
    const cloud = createCloudStore(t)
    let captured: unknown = null
    cloud.onFallback((cache) => { captured = cache })

    cloud.configure('mirror-key')
    await cloud.pullSnapshot()

    // 本机写入一条（只存在于内存 cache —— 云模式下这正是会被关窗丢掉的那批改动）
    await cloud.store.put('projects', { id: 'f1', name: '乙' })

    // 把传输层换成「什么都不可用」，触发闩锁
    const dead = scriptedTransport({ pull: () => ({ status: 0 }), push: () => ({ status: 0 }) })
    cloud.setTransport(dead.t)

    // 第一次 flushNow：闩锁尚未置位 → 走正常推送 → 网络错 → transientUnavailable=true
    await cloud.flushNow().catch(() => {})
    // 第二次 flushNow：已处闩锁期 → 自愈尝试（pull 仍失败）→ 走兜底分支
    await cloud.flushNow().catch(() => {})

    const c = captured as { projects?: unknown[] } | null
    ok('🔴 兜底回调被调', !!c, String(captured))
    ok('🔴 且拿到的快照**非空**（含未推送的 f1；清了就等于静默丢改动）',
      !!c && Array.isArray(c.projects) && c.projects.some(p => (p as { id?: string })?.id === 'f1'),
      JSON.stringify(c))

  }

  console.log(`\n———— 结果：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  process.exitCode = 1
})
