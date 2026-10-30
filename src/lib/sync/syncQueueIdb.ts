// ============ 3.3.2 · P3-2b 队列的 IndexedDB 后端 ============
//
// 独立库 `-syncq`，**刻意不进整库 JSON、不进云同步、不进备份**（红线段：
// 与 `-vec` / `-kb` 同一条处理原则 —— 它是本机的执行状态，不是作品内容）。
//
// 🔴 打开失败必须降级成内存，不能抛：隐私模式、磁盘满、老浏览器都会让 IDB 打不开。
//    队列打不开就把整个编辑器卡死在启动阶段，是最不能接受的结果 ——
//    降级成内存后同步仍能工作（只是重启会丢任务），比不能写作好得多。
import type { QueueStore, SyncJob } from '@/lib/sync/syncQueue'
import { createMemoryQueueStore } from '@/lib/sync/syncQueue'

export const SYNCQ_DB_NAME = 'youth-fantasy-engine-syncq'
export const SYNCQ_DB_VERSION = 1
export const SYNCQ_STORE = 'jobs'

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
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('IDB_OPEN_FAILED'))
    req.onblocked = () => reject(new Error('IDB_BLOCKED'))
  })
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | null): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(SYNCQ_STORE, mode)
    const s = t.objectStore(SYNCQ_STORE)
    let req: IDBRequest | null = null
    try { req = fn(s) } catch (e) { reject(e); return }
    t.oncomplete = () => resolve((req ? req.result : undefined) as T)
    t.onerror = () => reject(t.error || new Error('IDB_TX_FAILED'))
    t.onabort = () => reject(t.error || new Error('IDB_TX_ABORTED'))
  })
}

/**
 * 建立队列后端。**永不 reject**：打不开 IDB 就返回内存实现。
 * @param onFallback 降级回调（用来在日志里留痕、或让界面提示"本次任务的队列不持久"）
 */
export async function createIdbQueueStore(
  onFallback?: (reason: string) => void,
): Promise<QueueStore> {
  let db: IDBDatabase
  try {
    db = await openDb()
  } catch (e) {
    onFallback?.(e instanceof Error ? e.message : String(e))
    return createMemoryQueueStore()
  }
  return {
    async put(job: SyncJob) { await tx<void>(db, 'readwrite', (s) => s.put(job)) },
    async get(id: string) { return (await tx<SyncJob | undefined>(db, 'readonly', (s) => s.get(id))) ?? null },
    async all() { return (await tx<SyncJob[]>(db, 'readonly', (s) => s.getAll())) ?? [] },
    async remove(id: string) { await tx<void>(db, 'readwrite', (s) => s.delete(id)) },
  }
}
