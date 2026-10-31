// ============ 3.3.2 · P3-4 同步门面（生产接线）============
//
// 【它是什么】把「队列 + 驱动器 + 真实 HTTP」装到一起的那一层。
// 前面三个模块都是纯逻辑/注入式，本模块是唯一知道"真实世界长什么样"的地方：
// 请求发到哪、怎么带凭据、项目包从哪来。
//
// 🔴 三层分开的理由：`syncQueue`（状态持久化）/ `syncRunner`（编排）/ 本文件（IO）。
//    合起来写的话，「队列语义」就没法单测了 —— 一跑就得连服务器。
//
// 🔴 凭据走 Cookie，不用 `Authorization: Bearer`：
//    网页版与桌面网页壳都在同源下，Cookie 是 httpOnly 且自动附带，脚本拿不到也不该拿。
//    桌面原生窗口那套（Bearer + safeStorage）在 `electron/` 侧，不在这条路上。
//
// ⚠️ 尚未接线（诚实记录，别当成已实现）：
//    · 保存流程还没有调用 `enqueue` —— 接线点见下方 `markDirty()` 注释。
//    · 拉取（poll/pull）还缺一个"定时检查云端是否有新版本"的调度者，
//      现在只能由界面显式调 `check()`。
import type { ProjectBundle } from '@/lib/db/projects'
import { exportProject } from '@/lib/db/projects'
import type { SnapshotTombstone } from '@/lib/sync/projectSnapshot'
import type { TombstoneStore } from '@/lib/sync/projectTombstone'
import { clearSubmittedTombstones, tombstonesToSubmit } from '@/lib/sync/projectTombstone'
import type { UploadTransport } from '@/lib/sync/projectUploader'
import type { QueueStore, SyncJob } from '@/lib/sync/syncQueue'
import { deriveStateFromJobs, enqueuePush, pendingJobsOf } from '@/lib/sync/syncQueue'
import type { SyncState } from '@/lib/sync/syncMachine'
import { drainQueue, prepareQueue, type RunOneResult } from '@/lib/sync/syncRunner'

import { cloudBase, cloudFetch, fetchManifest } from '@/lib/cloud/syncApi'

/** 响应体 → 统一形状；网络异常不抛出，翻译成 NETWORK */
async function readJson(res: Response): Promise<Record<string, unknown>> {
  try { return (await res.json()) as Record<string, unknown> } catch { return {} }
}

/**
 * 真实 HTTP 传输层。
 *
 * 🔴 上传对象必须发**原始字节**（不是 JSON 包一层）：服务端按收到的字节流算哈希，
 *    包一层就永远对不上（这会表现成"每个对象都 HASH_MISMATCH"）。
 */
export function createHttpTransport(base?: string): UploadTransport {
  // 🔴 每次请求现取「通道 + 基地址」：桌面版登录/登出后 `configureCloudTransport` 会换通道，
  //    若在装配时把地址钉死，登录后仍然打本机地址（表现为全部 404）。
  const baseOf = () => base ?? cloudBase()
  return {
    async putObject(cloudProjectId, hash, bytes) {
      try {
        const res = await cloudFetch()(
          `${baseOf()}/api/v2/projects/${encodeURIComponent(cloudProjectId)}/objects/${encodeURIComponent(hash)}`,
          {
            method: 'PUT',
            credentials: 'same-origin',
            // `bytes` 的底层是 ArrayBuffer；直接传 Uint8Array 会被当成普通对象序列化
            body: bytes.slice().buffer as ArrayBuffer,
            headers: { 'Content-Type': 'application/octet-stream' },
          },
        )
        if (res.ok) return { ok: true }
        const body = await readJson(res)
        return { ok: false, code: String(body.code || (res.status >= 500 ? 'NETWORK' : `HTTP_${res.status}`)) }
      } catch {
        return { ok: false, code: 'NETWORK' }
      }
    },
    async commit(cloudProjectId, payload) {
      try {
        const res = await cloudFetch()(
          `${baseOf()}/api/v2/projects/${encodeURIComponent(cloudProjectId)}/commit`,
          {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
        )
        const body = await readJson(res)
        return {
          ok: res.ok,
          status: res.status,
          code: typeof body.code === 'string' ? body.code : undefined,
          revision: typeof body.revision === 'number' ? body.revision : undefined,
          snapshotId: typeof body.snapshotId === 'string' ? body.snapshotId : undefined,
          replayed: body.replayed === true,
          usedBytes: typeof body.usedBytes === 'number' ? body.usedBytes : undefined,
          quotaBytes: typeof body.quotaBytes === 'number' ? body.quotaBytes : undefined,
          message: typeof body.error === 'string' ? body.error : undefined,
        }
      } catch {
        return { ok: false, status: 0, code: 'NETWORK' }
      }
    },
  }
}

export interface SyncClientOptions {
  store: QueueStore
  /** 墓碑存储；不传则视为"这台设备不传播删除"（会显式记录，不静默） */
  tombstones?: TombstoneStore
  transport?: UploadTransport
  loadBundle?: (projectId: string) => Promise<ProjectBundle | null>
  loadTombstones?: (projectId: string) => Promise<SnapshotTombstone[]>
  now?: () => number
}

export interface SyncClient {
  /** 登记一次本地改动（保存后调用）→ 返回要跑的任务 */
  markDirty(input: { projectId: string; cloudProjectId: string; baseRevision: number }): Promise<SyncJob>
  /** 把队列跑空 */
  drain(): Promise<RunOneResult[]>
  /** 启动时调一次：崩溃恢复 + 清理 */
  prepare(): Promise<number>
  /** 该项目当前应对界面显示的状态 */
  stateOf(projectId: string): Promise<SyncState>
}

/**
 * ⚠️ **目前没有任何地方调用它**（应用真正的装配在 `app/syncBoot.ts` + `sync/syncController.ts`）。
 *
 * 2026-10-31 的教训：给「跳过云端已有对象」打补丁时改到了本函数里，
 * 编译、单测全绿、端口也不报错 —— 但线上行为一点没变，因为走的是 controller。
 * 所以：**要改同步行为，请改 `syncController`；本函数只是同功能的另一份实现**，
 * 留着是因为 `createHttpTransport` 就在本文件里、拆开反而更乱。
 */
export async function createSyncClient(opts: SyncClientOptions): Promise<SyncClient> {
  const { store } = opts
  const transport = opts.transport ?? createHttpTransport()
  const now = opts.now ?? Date.now
  const loadBundle = opts.loadBundle ?? (async (pid: string) => {
    try { return (await exportProject(pid)) as unknown as ProjectBundle } catch { return null }
  })
  const tombStore = opts.tombstones
  const loadTombstones = opts.loadTombstones ?? (async (pid: string) => (
    tombStore ? tombstonesToSubmit(tombStore, pid, now()) : []
  ))

  const runnerDeps = {
    store, transport, loadBundle, loadTombstones, now,
    /**
     * 云端基线版本已有哪些对象 —— 传给上传器跳过重传。
     *
     * 🔴 走服务端清单（`GET manifest?rev=`），不看本地缓存：对象可能已被回收、
     *    也可能这本被导入到了别的账号。清单拿不到就返回空集 ⇒ 退回全量上传（慢但正确）。
     */
    loadKnownHashes: async (job: { cloudProjectId: string; baseRevision: number }) => {
      const man = await fetchManifest(job.cloudProjectId, job.baseRevision)
      const out = new Set<string>()
      if (!man) return out
      const push = (arr: unknown) => {
        if (!Array.isArray(arr)) return
        for (const x of arr) {
          const h = x && typeof x === 'object' ? (x as { hash?: unknown }).hash : null
          if (typeof h === 'string' && h) out.add(h)
        }
      }
      push((man as { objects?: unknown }).objects)
      push((man as { assets?: unknown }).assets)
      return out
    },
    // 提交成功后只清"这次带走的那批"墓碑（提交期间新删的必须留下）
    afterCommit: tombStore
      ? async (job: { projectId: string }, cutoff: number) => {
          if (cutoff > 0) await clearSubmittedTombstones(tombStore, job.projectId, cutoff, now())
        }
      : undefined,
  }

  return {
    async markDirty(input) {
      return enqueuePush(store, { ...input, now: now() })
    },
    async drain() {
      return drainQueue(runnerDeps)
    },
    async prepare() {
      return prepareQueue(store, now())
    },
    async stateOf(projectId) {
      return deriveStateFromJobs(await pendingJobsOf(store, projectId))
    },
  }
}
