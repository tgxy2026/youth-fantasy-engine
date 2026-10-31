// ============ 3.3.2 · B1 自动同步调度 ============
//
// 【为什么不去改保存流程】起初想的是"每次落盘成功后调一次入队"。那个方案要动
// `fileBackend.scheduleSave` 与 `desktop.scheduleSave` 两条写盘主路径 ——
// 它们承载着游客版、便携版、桌面版的全部数据安全，**动错一次就是丢稿**，
// 而项目里没有任何自动化能验证"写盘仍然正确"（只有真机跑）。
//
// 改成"看时间戳"：`touchProject()` 在卷/章/页签/备份每次写入后都会刷新
// `Project.updatedAt`（`lib/db/core.ts:707`，已经存在好几年）。
// 于是「本地有没有改动」这个问题可以纯读、不挂钩子：
//
//     绑定里有 lastSyncedAt  →  project.updatedAt > lastSyncedAt  ⇒ 有未同步改动
//
// 好处：写盘路径一行不动；判定是纯函数，可以穷举测；定时器停了也不影响任何数据。
// 代价：同步不是"写完立刻发"，而是下一个 tick（默认 20 秒）才发。
// 对"跨设备接续写作"这个场景，20 秒完全够 —— 用户不会在 20 秒内换设备。
//
// 🔴 只在项目**开着自动同步**时推（规划 D6：每本显式开启）。
//    默认全自动会让"我只想在本机写"的用户莫名其妙在上传。
import type { SyncBinding } from '@/lib/sync/projectBinding'
import { bindingForAccount, decideSync } from '@/lib/sync/projectBinding'
import type { SyncController } from '@/lib/sync/syncController'

export type TickDecision =
  /** 没有绑定：这本来就没打算上云 */
  | { action: 'skip'; reason: 'unbound' }
  /** 绑定了但关着自动同步 */
  | { action: 'skip'; reason: 'disabled' }
  /** 绑定属于别的账号（导入到新账号的项目） */
  | { action: 'skip'; reason: 'other-account' }
  /** 本地没改动 */
  | { action: 'skip'; reason: 'clean' }
  /** 云端版本未知（没查到/网络不通），这一轮不推 */
  | { action: 'skip'; reason: 'unknown-remote' }
  /** 正在跑，别再入队 */
  | { action: 'skip'; reason: 'busy' }
  /** 云端版本比本机记的还旧（被回滚/换账号）：不推也不拉 */
  | { action: 'skip'; reason: 'remote-regressed' }
  /** 有改动，推上去 */
  | { action: 'push'; baseRevision: number }
  /** 云端有新版本而本机没有未同步改动（原地落地未做，界面据此提示"可另存为新书接续"） */
  | { action: 'remote-ahead'; remoteRevision: number }
  /** 云端有新版本而本地也改了，需要用户处理 */
  | { action: 'conflict'; localBase: number; remoteRevision: number }

/**
 * 决定这一轮要不要推。
 *
 * @param local 当前项目（只要 id 与 updatedAt）
 * @param binding 绑定记录（已按账号过滤前）
 * @param remoteRevision 云端当前 revision；**未知时传 null**（不猜，按"不推"处理）
 * @param busy 控制器是否正在跑
 */
export function decideTick(input: {
  local: { id: string; updatedAt: number } | null
  binding: SyncBinding | null
  accountId?: string
  remoteRevision: number | null
  busy: boolean
  now?: number
}): TickDecision {
  const { local, binding, accountId, remoteRevision, busy } = input
  if (!local) return { action: 'skip', reason: 'clean' }
  if (!binding) return { action: 'skip', reason: 'unbound' }
  // 🔴 账号不符要单独报，不能混进 "unbound"：
  //    用户看到"未绑定"会以为自己设置丢了，实际是"这本是在另一个账号下绑的"
  if (!bindingForAccount(binding, accountId)) return { action: 'skip', reason: 'other-account' }
  if (!binding.enabled) return { action: 'skip', reason: 'disabled' }
  if (busy) return { action: 'skip', reason: 'busy' }

  const dirty = local.updatedAt > binding.lastSyncedAt

  // 云端 revision 未知：本地干净时无事可做；有改动也不猜基线。
  // 🔴 猜一个基线推上去，撞 409 还只是失败；猜对了会把别人的版本盖掉。
  if (remoteRevision === null) {
    return dirty
      ? { action: 'skip', reason: 'unknown-remote' }
      : { action: 'skip', reason: 'clean' }
  }

  const d = decideSync({
    binding,
    remote: { exists: true, revision: remoteRevision },
    localDirty: dirty,
  })
  if (d.action === 'push') return { action: 'push', baseRevision: d.baseRevision }
  if (d.action === 'conflict') {
    return { action: 'conflict', localBase: d.localBase, remoteRevision: d.remoteRevision }
  }
  // 云端前进而本机干净：说明另一台设备写了新东西。
  // 🔴 不自动应用 —— 原地落地（B3-2）还没做；这里只如实报出来，界面提示"可另存为新书接续"。
  if (d.action === 'pull') return { action: 'remote-ahead', remoteRevision: d.toRevision }
  if (d.action === 'remote-regressed') return { action: 'skip', reason: 'remote-regressed' }
  // up-to-date：确实无事可做
  return { action: 'skip', reason: 'clean' }
}

export interface AutoSyncDeps {
  /** 当前项目（id + updatedAt）；没有打开项目时返回 null */
  getCurrentProject: () => Promise<{ id: string; updatedAt: number } | null>
  /** 读绑定（原始，不预先过滤账号） */
  getBinding: (projectId: string) => Promise<SyncBinding | null>
  /** 查云端 revision；网络失败返回 null（这一轮不推） */
  getRemoteRevision: (cloudProjectId: string) => Promise<number | null>
  controller: SyncController
  /** 当前账号 id（网页版登录用户）；未登录不传 */
  getAccountId?: () => string | undefined | Promise<string | undefined>
  now?: () => number
}

/**
 * 跑一轮。
 * @returns 这一轮做了什么（方便日志与界面提示"刚同步过"）
 */
export async function autoSyncTick(deps: AutoSyncDeps): Promise<TickDecision> {
  const local = await deps.getCurrentProject()
  if (!local) return { action: 'skip', reason: 'clean' }

  const binding = await deps.getBinding(local.id)
  const busy = deps.controller.isRunning()
  // 未绑定/关闭自动同步时不必查云端（省一次网络）
  if (!binding || !binding.enabled || busy) {
    const accountId = await deps.getAccountId?.()
    return decideTick({ local, binding, accountId, remoteRevision: null, busy })
  }

  const accountId = await deps.getAccountId?.()
  const filtered = bindingForAccount(binding, accountId)
  if (!filtered) return decideTick({ local, binding, accountId, remoteRevision: null, busy })

  const remoteRevision = await deps.getRemoteRevision(filtered.cloudProjectId)
  const decision = decideTick({ local, binding, accountId, remoteRevision, busy })

  if (decision.action === 'push') {
    await deps.controller.requestPush({
      projectId: local.id,
      cloudProjectId: filtered.cloudProjectId,
      baseRevision: decision.baseRevision,
    })
  }
  return decision
}

// ============ 3.3.2 · 轮询节流（2026-10-31 主人提出：服务器月流量 300G）============
//
// 【为什么要退避】空闲时每 20 秒查一次云端 revision：一天 4320 次、一个月 13 万次请求。
//   单次很小，但它乘以"同时开着的设备数"，并且**永远不会停** —— 这是纯浪费。
//   实测：同一台机器一天里 90% 的 tick 都判成 clean / unknown-remote。
//
// 【规则】有活干就回到最快档；连续没活干就翻倍退避到上限。
//   · push / conflict / remote-ahead  → 立刻回到 20 秒（说明有东西在流动，别拖）
//   · clean / busy / unknown-remote   → 翻倍，上限 5 分钟
//   · other-account / remote-regressed → 直接拉到上限（状态不会自己好，别反复问）
//   🔴 用户一动手（任意 input 事件）就把节拍拉回最快档 —— 见 `startAutoSync` 的 poke，
//      否则退避到 5 分钟后，写完要等 5 分钟才上云，跨设备接续就废了。
export const SYNC_TICK_FAST_MS = 20_000
export const SYNC_TICK_MAX_MS = 300_000

/** 下一轮该等多久（纯函数；`prev` 是这一轮用的间隔） */
export function nextTickDelay(prev: number, d: TickDecision): number {
  const grow = () => Math.min(Math.max(prev, SYNC_TICK_FAST_MS) * 2, SYNC_TICK_MAX_MS)
  if (d.action === 'push') return SYNC_TICK_FAST_MS
  if (d.action === 'conflict' || d.action === 'remote-ahead') return SYNC_TICK_FAST_MS
  switch (d.reason) {
    case 'other-account':
    case 'remote-regressed':
      return SYNC_TICK_MAX_MS
    default:
      return grow()
  }
}

/** 一轮结束后的界面提示文案（不需要每个调用方各写一份） */
export function tickMessage(d: TickDecision): string {
  if (d.action === 'push') return '正在同步…'
  if (d.action === 'remote-ahead') return `云端有新版本（第 ${d.remoteRevision} 版），可在同步面板下载为新书接续`
  if (d.action === 'conflict') return '云端与本机都有改动，需要你选择保留哪一份'
  switch (d.reason) {
    case 'unbound': return ''
    case 'disabled': return ''
    case 'other-account': return '这本是在另一个账号下绑定的，请重新绑定后再同步'
    case 'busy': return ''
    case 'clean': return ''
    case 'unknown-remote': return ''
    case 'remote-regressed': return '云端版本比本机记录的还旧，已暂停自动同步'
    default: return ''
  }
}
