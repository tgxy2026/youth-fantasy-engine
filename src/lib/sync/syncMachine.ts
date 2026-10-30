// ============ 3.3.2 · P3-1 同步状态机 ============
//
// 【为什么要单独一个状态机，而不是在队列里塞一堆布尔量】
//   同步有八种"看起来都像没在动"的状态：未绑定、排队中、传输中、已同步、冲突、可重试失败、
//   硬阻塞（配额/鉴权/格式不认识）、离线。用 `loading/syncing/error` 三个布尔量拼，
//   必然出现"既在同步又报冲突"这种自相矛盾的界面，而且**崩溃重启后无从判断该不该自动继续**。
//
// 🔴 本模块是**纯函数**：不读库、不判网络、不碰时间。所有外部事实由调用方作为事件传入。
//    这样"哪些转移合法"可以用单测穷举钉住，而不是靠读代码猜。
//
// 🔴 非法事件**返回原状态**而不是抛异常。原因很实际：传输层的回调可能重复触发
//    （网络重试、组件重挂），抛异常会让一条本该无害的重复通知把整个同步跑挂掉。
import type { UploadOutcome } from '@/lib/sync/projectUploader'

export type SyncState =
  /** 未绑定云端，或绑定了但一次都没同步过 */
  | 'idle'
  /** 已入队，等上一次跑完 / 等退避到期 */
  | 'queued'
  /** 正在跑 */
  | 'syncing'
  /** 本地与云端一致 */
  | 'synced'
  /** 基线不符：需要用户选保留哪份 */
  | 'conflict'
  /** 可重试的失败（网络抖动、5xx、超时） */
  | 'failed'
  /** 不该自动重试的失败（配额满、鉴权失效、数据格式不认识） */
  | 'blocked'
  /** 断网 / 云端不可达 */
  | 'offline'

export type SyncEvent =
  | { type: 'enqueue' }
  | { type: 'start' }
  | { type: 'finish' }
  | { type: 'conflict' }
  | { type: 'fail'; retryable: boolean }
  | { type: 'offline' }
  | { type: 'online' }
  /** 用户处理完冲突 / 腾出空间 / 重新登录后解除阻塞 */
  | { type: 'clear' }
  /** 解绑或换账号：回到未绑定 */
  | { type: 'reset' }

/**
 * 合法转移表。
 * 值里出现的状态就是「该事件可以到达的目的地」；没出现的组合一律保持原状。
 *
 * 几处刻意设计：
 * · `syncing` 只认 `finish/conflict/fail/offline` —— 不认 `enqueue`，
 *   否则同步中又被入队会把状态刷回「排队中」，界面显示成没在跑。
 * · `conflict` 不认 `start` —— 冲突没解决就不该自动重跑，否则会反复用旧基线撞 409。
 * · `blocked` 只认 `clear/reset` —— 配额满、鉴权失效重试一万次也不会好。
 * · `offline` 认 `start`（网络恢复后马上跑），但 `fail` 仍留在 offline，
 *   避免断网时把「离线」降级成「失败」让用户以为稿子出了问题。
 * · 表里**没有** `fail` 这一项：同一事件要按 `retryable` 分叉成 failed / blocked，
 *   表只能按名字查，分叉逻辑在 `nextState` 里。
 */
const TRANSITIONS: Record<SyncState, Partial<Record<SyncEvent['type'], SyncState>>> = {
  idle: { enqueue: 'queued', start: 'syncing', reset: 'idle', clear: 'idle' },
  queued: { start: 'syncing', enqueue: 'queued', offline: 'offline', reset: 'idle', clear: 'idle' },
  syncing: { finish: 'synced', conflict: 'conflict', offline: 'offline', reset: 'idle' },
  synced: { enqueue: 'queued', start: 'syncing', offline: 'offline', reset: 'idle', clear: 'synced' },
  conflict: { clear: 'queued', reset: 'idle', offline: 'offline' },
  failed: { enqueue: 'queued', start: 'syncing', offline: 'offline', reset: 'idle', clear: 'idle' },
  blocked: { clear: 'idle', reset: 'idle', offline: 'offline' },
  offline: { enqueue: 'queued', start: 'syncing', reset: 'idle', clear: 'idle' },
}

/**
 * 一次转移。非法组合原样返回。
 */
export function nextState(cur: SyncState, ev: SyncEvent): SyncState {
  // `fail` 分两路：可重试进 failed，不可重试进 blocked。
  // 这条不做成表里的一项，是因为同一事件名要按事件内容分叉 —— 表只能按名字查。
  if (ev.type === 'fail') {
    if (!ev.retryable) {
      // 硬失败（配额满 / 鉴权失效 / 格式不认识）在哪个状态都成立，一律进 blocked
      return cur === 'syncing' || cur === 'queued' || cur === 'offline' || cur === 'failed' ? 'blocked' : cur
    }
    // 可重试失败：
    //  · 本来就在 offline ⇒ 继续留在 offline。断网时把状态降级成「失败」，
    //    用户会以为稿子出了问题，而实际上只是网没通。
    if (cur === 'offline') return 'offline'
    if (cur === 'syncing' || cur === 'queued') return 'failed'
    return cur
  }
  return TRANSITIONS[cur]?.[ev.type] ?? cur
}

/** 该状态下是否还有「要让用户看见」的告警（界面据此决定要不要挂红点） */
export function isTrouble(s: SyncState): boolean {
  return s === 'conflict' || s === 'failed' || s === 'blocked' || s === 'offline'
}

/** 该状态是否允许自动重试（不需要用户点任何东西） */
export function canAutoRetry(s: SyncState): boolean {
  return s === 'failed' || s === 'offline'
}

/** 该状态下本地改动是否已经安全落到云端（用来决定"能不能关窗口"） */
export function isDurable(s: SyncState): boolean {
  // 🔴 `blocked` 也算 durable 的**反面**：配额满时稿件只在本机，
  //    不能让界面显示"已保存到云端"（那是最典型的"写了一整晚白工"）。
  return s === 'synced' || s === 'idle'
}

/** 把上传结局翻译成事件（上传层与状态机之间的唯一翻译点，避免两处各写一份映射） */
export function eventFromOutcome(o: UploadOutcome): SyncEvent {
  if (o.ok) return { type: 'finish' }
  switch (o.status) {
    case 'conflict': return { type: 'conflict' }
    case 'quota': return { type: 'fail', retryable: false }
    case 'error':
      // 网络类 → 离线（用户看到的是"网络不通"，不是"同步失败"）；其余按 retryable 分流
      if (o.code === 'NETWORK' || o.code === 'TIMEOUT' || o.code === 'ECONNRESET') return { type: 'offline' }
      return { type: 'fail', retryable: o.retryable }
    default: return { type: 'fail', retryable: true }
  }
}
