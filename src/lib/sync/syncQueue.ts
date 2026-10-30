// ============ 3.3.2 · P3-2 待同步队列（持久、可恢复、同项目串行）============
//
// 【它解决什么】`projectUploader` 是「一次尝试」，`planApply` 是「一份计划」。
// 但它们都不记得「我上次跑到哪了」。应用一崩、网页一关、笔记本一合盖，
// 那次上传就凭空消失 —— 用户以为存上了，其实一个字都没上云。
//
// 【三条硬语义，全部有单测钉住】
//   ① **一个项目同时只有一个未完成任务**：同一项目反复保存不该排成十个任务，
//      而是复用同一个任务（含**同一个 opId**）。opId 复用是幂等的地基：
//      上一次可能已经提交成功、只是回执丢了；用同 opId 重跑，服务端识别成重放，
//      直接告诉我们「已提交，revision 是 X」，而不是又发一个新版本。
//   ② **崩溃恢复**：进程死掉时任务停在 `running`。重启后一律回 `pending` 并计一次尝试，
//      因为**没有任何办法知道**它到底提交没提交 —— 唯一的答案就是拿同 opId 再问一次。
//   ③ **同项目串行**：`claimNext` 跳过 projectId 已有 running 的任务，
//      所以「一边上传一边又触发一次」不会出现两条流互相把 revision 撞掉。
//
// 🔴 队列**不进整库 JSON、不进云同步、不进备份**（独立 IDB `-syncq`）。
//    它是本机的执行状态，跟着整库搬走只会变成"另一台机器上一堆跑不完的任务"。
//    这与 `-vec` / `-kb` 是同一条处理原则。
//
// 🔴 存储适配器注入：单测用内存实现，不碰 IndexedDB。也让将来"桌面主进程持队列"成为可能。
import { uid } from '@/lib/app/id'
import type { SyncState } from '@/lib/sync/syncMachine'

export type JobState =
  /** 待跑 */
  | 'pending'
  /** 正在跑（崩溃后会停在这里） */
  | 'running'
  /** 可重试失败，等退避 */
  | 'failed'
  /** 放弃自动重试（配额满 / 鉴权失效 / 格式不认识），等条件变化 */
  | 'blocked'
  /** 已完成（保留一小段时间用于"回执丢失后重放"的观察，随后清掉） */
  | 'done'

export interface SyncJob {
  /** 任务 id，**同时就是提交用的 opId** */
  id: string
  projectId: string
  cloudProjectId: string
  /** 提交时声明的基线版本 */
  baseRevision: number
  createdAt: number
  updatedAt: number
  state: JobState
  /** 尝试次数（含崩溃恢复计的那次） */
  attempts: number
  /** 已完成任务的 revision（幂等重放会用到） */
  revision?: number
  lastError?: string
  lastCode?: string
  /** 退避到什么时候才允许再跑（毫秒时间戳，0/缺省=立刻） */
  nextAttemptAt?: number
}

/** 队列后端：内存 / IndexedDB 都实现它 */
export interface QueueStore {
  put(job: SyncJob): Promise<void>
  get(id: string): Promise<SyncJob | null>
  all(): Promise<SyncJob[]>
  remove(id: string): Promise<void>
}

/** 内存实现：单测与"没有 IDB 的极端环境" */
export function createMemoryQueueStore(seed: SyncJob[] = []): QueueStore {
  const m = new Map<string, SyncJob>()
  for (const j of seed) m.set(j.id, { ...j })
  return {
    async put(j) { m.set(j.id, { ...j }) },
    async get(id) { const v = m.get(id); return v ? { ...v } : null },
    async all() { return [...m.values()].map((v) => ({ ...v })) },
    async remove(id) { m.delete(id) },
  }
}

/** 已完成任务在队列里多留一会儿：万一回执丢了，还能用同 opId 确认一次 */
export const DONE_TTL_MS = 10 * 60 * 1000
/** 失败退避上限（指数退避封顶，避免"等 4 小时"这种荒谬值） */
export const MAX_BACKOFF_MS = 5 * 60 * 1000

/**
 * 入队一次推送。
 *
 * @returns 真正要跑的任务（可能是复用的旧任务）
 *
 * 🔴 复用时**不换 opId**，只刷新 baseRevision 与时间戳：
 *    · 如果上次的提交其实已经成功（回执丢了），同 opId 会拿到 `replayed`；
 *    · 如果没成功，同 opId 本来就没有记录，等于一次普通提交。
 *    反过来若每次保存都换新 opId，回执丢失就会变成"一个内容两个版本"。
 * 🔴 `baseRevision` 每次都更新：用户在别的设备拉过新版本后，基线是会变的。
 */
export async function enqueuePush(
  store: QueueStore,
  input: { projectId: string; cloudProjectId: string; baseRevision: number; now?: number },
): Promise<SyncJob> {
  const now = input.now ?? Date.now()
  const list = await store.all()
  const existing = list.find(
    (j) => j.projectId === input.projectId && j.cloudProjectId === input.cloudProjectId
      && (j.state === 'pending' || j.state === 'running' || j.state === 'failed' || j.state === 'blocked'),
  )
  if (existing) {
    const next: SyncJob = {
      ...existing,
      // blocked 的任务被新改动"唤醒"：用户可能刚腾出了空间，值得再试一次
      state: existing.state === 'running' ? 'running' : 'pending',
      baseRevision: input.baseRevision,
      updatedAt: now,
      // 重新入队视为「现在就想跑」，清掉退避
      nextAttemptAt: 0,
    }
    await store.put(next)
    return next
  }
  const job: SyncJob = {
    id: `op_${uid()}`,
    projectId: input.projectId,
    cloudProjectId: input.cloudProjectId,
    baseRevision: input.baseRevision,
    createdAt: now,
    updatedAt: now,
    state: 'pending',
    attempts: 0,
  }
  await store.put(job)
  return job
}

/**
 * 崩溃恢复：把所有 `running` 打回 `pending`。
 *
 * 🔴 **这里不再给 attempts +1**，计数归 `claimNext` 负责（它每次领任务就 +1）。
 *    两处都加会把「一次崩溃」记成「两次尝试」，退避时间凭空翻倍 ——
 *    单测第 4 条就抓到过这个双计。
 *    「每次启动都崩」的无限重来仍然拦得住：每次 claim 都涨，退避随之指数上抬。
 * @returns 被打回的任务数
 */
export async function recoverRunning(store: QueueStore, now = Date.now()): Promise<number> {
  const list = await store.all()
  let n = 0
  for (const j of list) {
    if (j.state !== 'running') continue
    await store.put({
      ...j,
      state: 'pending',
      attempts: j.attempts,
      updatedAt: now,
      lastError: j.lastError || '上次同步被中断（应用关闭或崩溃），将自动重试',
      lastCode: j.lastCode || 'INTERRUPTED',
    })
    n++
  }
  return n
}

/**
 * 取下一个可以跑的任务。
 *
 * 跳过三类：跑着的（同项目串行）、退避未到期的、已完成/放弃的。
 * 同一项目只返回一条 —— 即使历史上意外存在多条未完成任务，也一次只跑一条。
 */
export async function claimNext(store: QueueStore, now = Date.now()): Promise<SyncJob | null> {
  const list = await store.all()
  const busyProjects = new Set(list.filter((j) => j.state === 'running').map((j) => j.projectId))
  const candidates = list
    .filter((j) => j.state === 'pending' || j.state === 'failed')
    .filter((j) => (j.nextAttemptAt ?? 0) <= now)
    .filter((j) => !busyProjects.has(j.projectId))
    .sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1))
  const chosen = candidates[0]
  if (!chosen) return null
  const running: SyncJob = { ...chosen, state: 'running', attempts: chosen.attempts + 1, updatedAt: now }
  await store.put(running)
  return running
}

/** 指数退避：第 n 次失败等 min(base * 2^(n-1), MAX) */
export function backoffFor(attempts: number, baseMs = 1500): number {
  const n = Math.max(1, attempts)
  const raw = baseMs * 2 ** (n - 1)
  return Math.min(raw, MAX_BACKOFF_MS)
}

/** 标记成功 */
export async function markDone(store: QueueStore, id: string, revision: number, now = Date.now()): Promise<void> {
  const j = await store.get(id)
  if (!j) return
  await store.put({ ...j, state: 'done', revision, updatedAt: now, nextAttemptAt: 0, lastError: undefined, lastCode: undefined })
}

/** 标记失败（可重试 → failed 并算退避；否则 → blocked 不再自动跑） */
export async function markFailed(
  store: QueueStore, id: string,
  info: { code: string; message: string; retryable: boolean },
  now = Date.now(),
): Promise<void> {
  const j = await store.get(id)
  if (!j) return
  const next: SyncJob = {
    ...j,
    state: info.retryable ? 'failed' : 'blocked',
    updatedAt: now,
    lastError: info.message,
    lastCode: info.code,
    nextAttemptAt: info.retryable ? now + backoffFor(j.attempts) : 0,
  }
  await store.put(next)
}

/** 清掉已完成/超期的任务（启动时与每次成功后各扫一次，避免队列无限长） */
export async function pruneQueue(store: QueueStore, now = Date.now(), ttlMs = DONE_TTL_MS): Promise<number> {
  const list = await store.all()
  let n = 0
  for (const j of list) {
    if (j.state !== 'done') continue
    if (now - j.updatedAt < ttlMs) continue
    await store.remove(j.id)
    n++
  }
  return n
}

/** 某项目当前的待跑任务（界面显示「待同步」用） */
export async function pendingJobsOf(store: QueueStore, projectId: string): Promise<SyncJob[]> {
  const list = await store.all()
  return list
    .filter((j) => j.projectId === projectId && j.state !== 'done')
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** 解绑 / 换账号：把这个项目的任务全清掉（否则会带着旧云端 id 反复失败） */
export async function clearProjectJobs(store: QueueStore, projectId: string): Promise<number> {
  const list = await store.all()
  let n = 0
  for (const j of list) {
    if (j.projectId !== projectId) continue
    await store.remove(j.id)
    n++
  }
  return n
}

/**
 * 从队列推导界面状态。
 *
 * 🔴 顺序有讲究：`running` 优先于 `blocked` —— 一边跑一边还有个旧的阻塞任务时，
 *    界面要说"正在同步"，不然用户以为卡住了。
 * 🔴 没有任何任务时返回 `idle` 而不是 `synced`：本模块不知道上次是不是真的成功过
 *    （队列里完成的记录会被清理）。要显示"已同步"得由调用方结合 `settingsKV` 里的
 *    上次 revision 判断 —— 那属于 P4 的绑定信息，这里不猜。
 */
export function deriveStateFromJobs(jobs: SyncJob[]): SyncState {
  if (jobs.some((j) => j.state === 'running')) return 'syncing'
  if (jobs.some((j) => j.state === 'pending')) return 'queued'
  if (jobs.some((j) => j.state === 'failed')) return 'failed'
  if (jobs.some((j) => j.state === 'blocked')) {
    // 阻塞原因里，基线不符是冲突、其余是硬阻塞 —— 界面文案不一样
    return jobs.some((j) => j.state === 'blocked' && j.lastCode === 'BASELINE_MISMATCH') ? 'conflict' : 'blocked'
  }
  return 'idle'
}
