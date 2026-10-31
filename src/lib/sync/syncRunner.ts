// ============ 3.3.2 · P3-3 队列驱动器 ============
//
// 【它做的事】把「队列里有任务」变成「任务跑完、状态落地」。
// 一个循环：`claimNext` → 组快照 → 上传 → 把结局写回队列与状态机 → 再取下一条。
//
// 🔴 本模块不直接读数据库、不直接发请求：三件事都注入
//    （`loadBundle` / `transport` / `store`）。所以它可以被单测完整覆盖，
//    也能在桌面主进程里跑（那边没有 `@/lib/db`）。
//
// 🔴 一条任务失败**不中断整条队列**：继续下一条。
//    理由很实际：一本大书因为图片太大传不上去，不该把另外九本书的同步一起卡死。
//    这与"事务"不是一回事 —— 每本书的提交在服务端各自原子。
//
// 🔴 结局 → 队列状态的映射只写在这里一处。`syncMachine.eventFromOutcome` 负责
//    「结局 → 界面状态」，本模块负责「结局 → 任务状态」，两边共用同一个 outcome，
//    不会各自解释一遍。
import type { ProjectBundle } from '@/lib/db/projects'
import type { UploadOutcome, UploadTransport } from '@/lib/sync/projectUploader'
import { uploadSnapshot } from '@/lib/sync/projectUploader'
import { buildProjectSnapshot, type BuiltSnapshot, type SnapshotTombstone } from '@/lib/sync/projectSnapshot'
import type { QueueStore, SyncJob } from '@/lib/sync/syncQueue'
import {
  claimNext, markDone, markFailed, pruneQueue, recoverRunning,
} from '@/lib/sync/syncQueue'
import type { SyncState } from '@/lib/sync/syncMachine'
import { eventFromOutcome, nextState } from '@/lib/sync/syncMachine'

export interface SyncRunnerDeps {
  store: QueueStore
  transport: UploadTransport
  /** 取项目包（生产环境 = `exportProject(projectId)`；单测注入假数据） */
  loadBundle: (projectId: string) => Promise<ProjectBundle | null>
  /** 取该项目的墓碑（删除记录必须带走，否则对方设备上"删了又活"） */
  loadTombstones?: (projectId: string) => Promise<SnapshotTombstone[]>
  /**
   * 取「云端基线版本已包含的对象哈希」，用于跳过重传。
   *
   * 🔴 不传就等于**每次同步都把整本书重传一遍**：自动同步是 20 秒一跳，
   *    改一个字就把 40 MiB 的含图作品再上行一次（2026-10-31 实机验证发现）。
   * 🔴 必须来自服务端清单，不能是本地缓存（对象可能被回收或换了账号）；
   *    真空了服务端会回 OBJECT_MISSING，`uploadSnapshot` 会自动补传一轮。
   */
  loadKnownHashes?: (job: SyncJob) => Promise<ReadonlySet<string>>
  /**
   * 记下「这一版云端有哪些对象」——供**下一次**推送直接复用，省掉一次清单下载。
   *
   * 🔴 为什么值得：每次推送都要先 `GET manifest?rev=base` 才能知道"哪些对象已经存在"。
   *    但那份清单就是**我们上一次提交的那份**，内容一个字都没变。
   *    含图作品的清单可以到几十 KB，连续写作时每 20 秒一份，纯属白搬。
   * 🔴 只记最近一版：`baseRevision` 对不上就照常去服务端问（别人的设备也可能提交过）。
   */
  rememberHashes?: (job: SyncJob, revision: number, hashes: ReadonlySet<string>) => void
  /** 状态变化回调（界面据此刷新徽标；不传就纯后台跑） */
  onState?: (projectId: string, state: SyncState, detail?: { job?: SyncJob; outcome?: UploadOutcome }) => void
  now?: () => number
  /**
   * 提交成功后的收尾（清掉已上报的墓碑）。
   * @param tombstoneCutoff 本次快照带走的墓碑时间上限（只该清 ≤ 它的）
   * 🔴 放在成功之后单独一步，而不是包进 transport：清墓碑失败**不能**把一次成功的提交
   *    说成失败（那会让客户端重推一遍，白费一次全量上传）。
   */
  afterCommit?: (job: SyncJob, tombstoneCutoff: number, revision: number) => Promise<void>
  /** 每次尝试的重试次数（透传给 uploadSnapshot） */
  retries?: number
  backoffMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface RunOneResult {
  jobId: string
  projectId: string
  state: SyncState
  outcome: UploadOutcome | null
}

/** 结局 → 任务落库 */
async function settle(
  deps: SyncRunnerDeps, job: SyncJob, outcome: UploadOutcome,
  state: SyncState, now: number,
): Promise<void> {
  if (outcome.ok) {
    await markDone(deps.store, job.id, outcome.revision, now)
    return
  }
  if (outcome.status === 'conflict') {
    // 冲突**不是失败**：任务要留着，等用户选了保留哪份再重跑。
    // 标成 blocked 而不是 failed —— failed 会被自动重试，而冲突自动重试只会反复撞 409。
    await markFailed(deps.store, job.id, {
      code: 'BASELINE_MISMATCH',
      message: '云端已有更新的版本，需要你选择保留哪一份',
      retryable: false,
    }, now)
    return
  }
  if (outcome.status === 'quota') {
    await markFailed(deps.store, job.id, {
      code: 'QUOTA_EXCEEDED',
      message: '云端空间不足，本次未上传（稿件仍在本机）',
      retryable: false,
    }, now)
    return
  }
  await markFailed(deps.store, job.id, {
    code: outcome.code,
    message: outcome.message || '同步失败',
    retryable: outcome.retryable,
  }, now)
  void state
}

/**
 * 跑一条任务。
 * @returns 该任务最终的界面状态
 */
export async function runOneJob(deps: SyncRunnerDeps, job: SyncJob): Promise<RunOneResult> {
  const now = deps.now ?? Date.now
  let state: SyncState = 'syncing'
  deps.onState?.(job.projectId, state, { job })

  let outcome: UploadOutcome
  let tombstoneCutoff = 0
  /** 供提交成功后记缓存用；快照可能没建成（异常分支），所以单独存一份 */
  let builtForCache: BuiltSnapshot | null = null
  try {
    const bundle = await deps.loadBundle(job.projectId)
    if (!bundle) {
      // 项目在本机已被删除：任务作废，不算失败（否则会一直重试一个不存在的项目）
      await markFailed(deps.store, job.id, {
        code: 'PROJECT_GONE', message: '本机已删除该项目，取消同步', retryable: false,
      }, now())
      state = nextState(state, { type: 'fail', retryable: false })
      deps.onState?.(job.projectId, state, { job })
      return { jobId: job.id, projectId: job.projectId, state, outcome: null }
    }
    const tombstones = deps.loadTombstones ? await deps.loadTombstones(job.projectId) : []
    // 记下"带走的是哪些"，成功后只清这一批（提交期间新删的必须留下）
    if (tombstones.length) tombstoneCutoff = now()
    // 🔴 快照在这里**现算**，不用入队时的那份：
    //    排队期间用户可能又写了几章，用旧快照提交等于把新写的覆盖掉。
    const built = await buildProjectSnapshot(bundle, { tombstones, now: now() })
    builtForCache = built
    // 云端已有的对象不必重传（拿不到就当作"一个都没有"，退回全量上传）
    let knownHashes: ReadonlySet<string> | undefined
    if (deps.loadKnownHashes && job.baseRevision > 0) {
      try {
        knownHashes = await deps.loadKnownHashes(job)
      } catch {
        knownHashes = undefined
      }
    }

    outcome = await uploadSnapshot({
      cloudProjectId: job.cloudProjectId,
      built,
      baseRevision: job.baseRevision,
      opId: job.id,
      knownHashes,
      transport: deps.transport,
      retries: deps.retries,
      backoffMs: deps.backoffMs,
      sleep: deps.sleep,
    })
  } catch (e) {
    // 组快照本身炸了（数据损坏、图片解码失败…）：当作不可重试，别拿同一份坏数据反复试
    outcome = {
      ok: false, status: 'error', code: 'SNAPSHOT_FAILED',
      message: e instanceof Error ? e.message : '生成同步快照失败', retryable: false,
    }
  }

  state = nextState('syncing', eventFromOutcome(outcome))
  await settle(deps, job, outcome, state, now())
  // 成功提交后把这一版的对象集合记下来（下一次推送省一次清单下载）
  if (outcome.ok && deps.rememberHashes) {
    try {
      // `built` 在上面 try 里声明，这里用闭包外的作用域拿不到 —— 见下面的 `builtForCache`
      if (builtForCache) {
        const hs = new Set<string>()
        for (const o of builtForCache.manifest.objects) hs.add(o.hash)
        for (const a of builtForCache.manifest.assets) hs.add(a.hash)
        deps.rememberHashes(job, outcome.revision, hs)
      }
    } catch { /* 只是缓存，失败不影响结果 */ }
  }
  if (outcome.ok && deps.afterCommit) {
    try {
      await deps.afterCommit(job, tombstoneCutoff, outcome.revision)
    } catch { /* 收尾失败不影响"已提交"这个事实 */ }
  }
  deps.onState?.(job.projectId, state, { job, outcome })
  return { jobId: job.id, projectId: job.projectId, state, outcome }
}

/**
 * 把队列跑空。
 *
 * @param maxJobs 单轮上限（防"任务不断入队"导致的死循环；默认 20）
 * @returns 本轮的每条结果
 */
export async function drainQueue(deps: SyncRunnerDeps, maxJobs = 20): Promise<RunOneResult[]> {
  const now = deps.now ?? Date.now
  const out: RunOneResult[] = []
  for (let i = 0; i < maxJobs; i++) {
    const job = await claimNext(deps.store, now())
    if (!job) break
    out.push(await runOneJob(deps, job))
  }
  try { await pruneQueue(deps.store, now()) } catch { /* 清理是维护动作，不影响结果 */ }
  return out
}

/**
 * 启动时的准备：崩溃恢复 + 清掉超期的已完成任务。
 * 应用启动时调用一次。**不做网络请求**，所以可以在界面首帧之前跑。
 * @returns 被打回重跑的任务数
 */
export async function prepareQueue(store: QueueStore, now = Date.now()): Promise<number> {
  const n = await recoverRunning(store, now)
  try { await pruneQueue(store, now) } catch { /* 同上 */ }
  return n
}
