// ============ 3.3.2 · P3/P4 本机同步状态的 IndexedDB 后端 ============
//
// 一个库 `-syncq`、两个 store：
//   · `jobs`       —— 待同步队列（P3）
//   · `tombstones` —— 待上报的删除墓碑（P4）
//
// 刻意**不进整库 JSON、不进云同步、不进备份**（与 `-vec` / `-kb` 同一条处理原则）：
// 它们都是本机的执行状态，跟着整库搬走只会变成"另一台机器上一堆跑不完的任务 + 别人的墓碑"。
//
// 🔴 打开失败必须降级成内存，不能抛：隐私模式、磁盘满、老浏览器都会让 IDB 打不开。
//    队列打不开就把整个编辑器卡死在启动阶段，是最不能接受的结果 ——
//    降级成内存后同步仍能工作（只是重启会丢任务），比不能写作好得多。
import type { QueueStore, SyncJob } from '@/lib/sync/syncQueue'
import { createMemoryQueueStore } from '@/lib/sync/syncQueue'
import type { TombstoneStore, Tombstone } from '@/lib/sync/projectTombstone'
import { createMemoryTombstoneStore } from '@/lib/sync/projectTombstone'

export const SYNCQ_DB_NAME = 'youth-fantasy-engine-syncq'
/**
 * 2：新增 `tombstones` store（P4）。
 * 🔴 3.3.2 尚未发布，v1 只是开发期的库；升 v2 不需要迁移代码，
 *    但**上线后**再改结构就必须写迁移了（`onupgradeneeded` 里按 oldVersion 分支）。
 */
export const SYNCQ_DB_VERSION = 2
export const SYNCQ_STORE = 'jobs'
export const SYNCQ_TOMB_STORE = 'tombstones'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('NO_IDB')); return }
    const req = indexedDB.open(SYNCQ_DB_NAME, SYNCQ_DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(SYNCQ_STORE)) {
        const s = db.createObjectStore(SYNCQ_STORE, { keyPath: 'id' })
        // 按项目查待跑任务是最高频查询（界面显示"待同步"时每次都查）
        s.createIndex('byProject', 'projectId', { unique: false })
      }
      if (!db.objectStoreNames.contains(SYNCQ_TOMB_STORE)) {
        // 主键 = projectId，值 = { projectId, items: Tombstone[] }
        db.createObjectStore(SYNCQ_TOMB_STORE, { keyPath: 'projectId' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('IDB_OPEN_FAILED'))
    req.onblocked = () => reject(new Error('IDB_BLOCKED'))
  })
}

function tx<T>(
  db: IDBDatabase, store: string, mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest | null,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode)
    const s = t.objectStore(store)
    let req: IDBRequest | null = null
    try { req = fn(s) } catch (e) { reject(e); return }
    t.oncomplete = () => resolve((req ? req.result : undefined) as T)
    t.onerror = () => reject(t.error || new Error('IDB_TX_FAILED'))
    t.onabort = () => reject(t.error || new Error('IDB_TX_ABORTED'))
  })
}

/**
 * 建立两块后端。**永不 reject**：打不开 IDB 就两块都降级内存。
 * @param onFallback 降级回调（用来留痕 / 提示"本次任务的队列不持久"）
 */
export async function createSyncStateStores(
  onFallback?: (reason: string) => void,
): Promise<{ queue: QueueStore; tombstones: TombstoneStore }> {
  let db: IDBDatabase
  try {
    db = await openDb()
  } catch (e) {
    onFallback?.(e instanceof Error ? e.message : String(e))
    return { queue: createMemoryQueueStore(), tombstones: createMemoryTombstoneStore() }
  }

  const queue: QueueStore = {
    async put(job: SyncJob) { await tx<void>(db, SYNCQ_STORE, 'readwrite', (s) => s.put(job)) },
    async get(id: string) { return (await tx<SyncJob | undefined>(db, SYNCQ_STORE, 'readonly', (s) => s.get(id))) ?? null },
    async all() { return (await tx<SyncJob[]>(db, SYNCQ_STORE, 'readonly', (s) => s.getAll())) ?? [] },
    async remove(id: string) { await tx<void>(db, SYNCQ_STORE, 'readwrite', (s) => s.delete(id)) },
  }

  type Row = { projectId: string; items: Tombstone[] }
  const readRow = async (pid: string) =>
    (await tx<Row | undefined>(db, SYNCQ_TOMB_STORE, 'readonly', (s) => s.get(pid)))
  const tombstones: TombstoneStore = {
    async list(pid: string) { return (await readRow(pid))?.items ?? [] },
    async put(pid: string, items: readonly Tombstone[]) {
      await tx<void>(db, SYNCQ_TOMB_STORE, 'readwrite', (s) => s.put({ projectId: pid, items: [...items] }))
    },
    async clear(pid: string) {
      await tx<void>(db, SYNCQ_TOMB_STORE, 'readwrite', (s) => s.delete(pid))
    },
  }

  return { queue, tombstones }
}

/** 只要队列（P3 单用） */
export async function createIdbQueueStore(onFallback?: (reason: string) => void): Promise<QueueStore> {
  return (await createSyncStateStores(onFallback)).queue
}
