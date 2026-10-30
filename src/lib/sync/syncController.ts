// ============ 3.3.2 · P3-5 同步控制器（模块级单例）============
//
// 【为什么必须是模块级】`syncClient` 是无状态的装配对象，但"正在同步"这件事要跨页面存活：
//   · 切页签会卸载组件（红线段：切页签＝卸载 ⇒ 长任务放模块级 store）；
//   · 用户在同步中途切到图鉴再看回来，不该变成"卡在同步中"；
//   · 两处同时触发保存（自动保存 + 手动 Ctrl+S）必须收敛成一条队列。
//
// 🔴 本模块只管「什么时候跑、跑完告诉谁」，不碰 UI、不碰数据库实现（都靠注入）。
// 🔴 初始化幂等：重复调用 `initSync()` 只做一次崩溃恢复，避免热更新时反复扫库。
//
// ⚠️ 当前状态：模块本身完成并有单测，但**还没有被保存流程调用** ——
//    接线点是 `src/lib/app/useSaveHotkey.ts` 与自动保存那一侧，
//    需要一次真机回归（保存 → 队列 → 上传 → 徽标变化）才能算验收。
import type { ProjectBundle } from '@/lib/db/projects'
import type { UploadTransport } from '@/lib/sync/projectUploader'
import type { QueueStore, SyncJob } from '@/lib/sync/syncQueue'
import { deriveStateFromJobs, enqueuePush, pendingJobsOf } from '@/lib/sync/syncQueue'
import type { SyncState } from '@/lib/sync/syncMachine'
import { drainQueue, prepareQueue, type RunOneResult, type SyncRunnerDeps } from '@/lib/sync/syncRunner'
import type { TombstoneStore } from '@/lib/sync/projectTombstone'
import { clearSubmittedTombstones, tombstonesToSubmit } from '@/lib/sync/projectTombstone'

export interface SyncControllerDeps {
  store: QueueStore
  transport: UploadTransport
  loadBundle: (projectId: string) => Promise<ProjectBundle | null>
  tombstones?: TombstoneStore
  now?: () => number
  /** 状态变化广播（界面订阅它刷新徽标） */
  onState?: (projectId: string, state: SyncState) => void
}

export interface SyncController {
  /** 启动准备（崩溃恢复 + 清理），幂等 */
  init(): Promise<number>
  /** 登记一次本地改动并立刻跑一遍队列 */
  requestPush(input: { projectId: string; cloudProjectId: string; baseRevision: number }): Promise<SyncJob>
  /** 只登记不跑（比如断网时攒着） */
  enqueueOnly(input: { projectId: string; cloudProjectId: string; baseRevision: number }): Promise<SyncJob>
  /** 跑队列 */
  drain(): Promise<RunOneResult[]>
  /** 某项目当前状态 */
  stateOf(projectId: string): Promise<SyncState>
  /** 订阅状态变化；返回退订函数 */
  subscribe(fn: (projectId: string, state: SyncState) => void): () => void
  /** 是否有正在跑的一轮（防重入） */
  isRunning(): boolean
}

/**
 * 创建控制器。
 *
 * 🔴 `drain` 有**重入保护**：自动保存可能在一次同步还没跑完时又触发，
 *    两个 drain 并发会各自 claim 到不同任务、却共用同一条 HTTP 连接池；
 *    更糟的是状态回调会来回抖（同步中 → 已同步 → 同步中）。
 *    重入时第二次调用直接返回空数组，由正在跑的那次把队列跑空。
 */
export function createSyncController(deps: SyncControllerDeps): SyncController {
  const now = deps.now ?? Date.now
  let initialized: Promise<number> | null = null
  let running = false
  const listeners = new Set<(projectId: string, state: SyncState) => void>()
  // 🔴 `deps.onState` 必须登记进监听器集合：第一版只在 runner 里遍历 listeners，
  //    结果调用方传进来的 onState 从来没被调过 —— 界面永远收不到状态变化，
  //    而单测断言"顺序"时拿到的是空数组（这条是单测抓出来的）。
  if (deps.onState) listeners.add(deps.onState)

  const runnerDeps: SyncRunnerDeps = {
    store: deps.store,
    transport: deps.transport,
    loadBundle: deps.loadBundle,
    now,
    loadTombstones: deps.tombstones
      ? async (pid: string) => tombstonesToSubmit(deps.tombstones!, pid, now())
      : undefined,
    afterCommit: deps.tombstones
      ? async (job, cutoff) => {
          if (cutoff > 0) await clearSubmittedTombstones(deps.tombstones!, job.projectId, cutoff, now())
        }
      : undefined,
    onState: (pid, state) => {
      for (const fn of listeners) {
        try { fn(pid, state) } catch { /* 订阅方自己的异常不该影响同步 */ }
      }
    },
  }

  const ctl: SyncController = {
    async init() {
      if (!initialized) initialized = prepareQueue(deps.store, now())
      return initialized
    },

    async enqueueOnly(input) {
      return enqueuePush(deps.store, { ...input, now: now() })
    },

    async requestPush(input) {
      const job = await enqueuePush(deps.store, { ...input, now: now() })
      // 先把「排队中」广播出去：界面在等网络的那几秒里要有东西可显示，
      // 否则用户会以为按了没反应，然后反复点。
      for (const fn of listeners) { try { fn(input.projectId, 'queued') } catch { /* ignore */ } }
      await ctl.drain()
      return job
    },

    async drain() {
      if (running) return []
      running = true
      try {
        return await drainQueue(runnerDeps)
      } finally {
        running = false
      }
    },

    async stateOf(projectId) {
      return deriveStateFromJobs(await pendingJobsOf(deps.store, projectId))
    },

    subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },

    isRunning() { return running },
  }

  return ctl
}

/**
 * 全局单例（界面用这个）。
 *
 * 🔴 `install()` 只接受一次真实依赖：第二次调用直接返回已有的控制器。
 *    这样热更新、重复挂载都不会留下两套队列在跑。
 */
let singleton: SyncController | null = null

export function installSyncController(deps: SyncControllerDeps): SyncController {
  if (!singleton) singleton = createSyncController(deps)
  return singleton
}

export function getSyncController(): SyncController | null {
  return singleton
}

/** 仅用于测试：清掉单例 */
export function resetSyncControllerForTest(): void {
  singleton = null
}
