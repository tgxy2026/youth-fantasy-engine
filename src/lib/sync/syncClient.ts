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
//    · 项目级**墓碑**：`loadTombstones` 默认返回空数组，跨设备删除暂不会传播。
//      这是 P4 的活（要按项目收集"上次成功提交以来删掉了哪些记录"）。
//    · 保存流程还没有调用 `enqueue` —— 接线点见下方 `markDirty()` 注释。
import type { ProjectBundle } from '@/lib/db/projects'
import { exportProject } from '@/lib/db/projects'
import type { SnapshotTombstone } from '@/lib/sync/projectSnapshot'
import type { UploadTransport } from '@/lib/sync/projectUploader'
import type { QueueStore, SyncJob } from '@/lib/sync/syncQueue'
import { deriveStateFromJobs, enqueuePush, pendingJobsOf } from '@/lib/sync/syncQueue'
import type { SyncState } from '@/lib/sync/syncMachine'
import { drainQueue, prepareQueue, type RunOneResult } from '@/lib/sync/syncRunner'

/** 与服务端一致的接口前缀（同源，所以默认空串） */
function apiBase(): string {
  const m = typeof window !== 'undefined' ? window.__YFE_PORTABLE__ : null
  if (m && typeof m === 'object' && typeof m.apiBase === 'string' && m.apiBase) return m.apiBase
  return ''
}

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
export function createHttpTransport(base = apiBase()): UploadTransport {
  return {
    async putObject(cloudProjectId, hash, bytes) {
      try {
        const res = await fetch(
          `${base}/api/v2/projects/${encodeURIComponent(cloudProjectId)}/objects/${encodeURIComponent(hash)}`,
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
        const res = await fetch(
          `${base}/api/v2/projects/${encodeURIComponent(cloudProjectId)}/commit`,
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

export async function createSyncClient(opts: SyncClientOptions): Promise<SyncClient> {
  const { store } = opts
  const transport = opts.transport ?? createHttpTransport()
  const now = opts.now ?? Date.now
  const loadBundle = opts.loadBundle ?? (async (pid: string) => {
    try { return (await exportProject(pid)) as unknown as ProjectBundle } catch { return null }
  })
  // ⚠️ 墓碑未接线：跨设备删除暂不传播（P4 补）。这里显式保留注入点，
  //    而不是静默返回空数组后假装"已经处理了删除"。
  const loadTombstones = opts.loadTombstones ?? (async () => [])

  const runnerDeps = { store, transport, loadBundle, loadTombstones, now }

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
