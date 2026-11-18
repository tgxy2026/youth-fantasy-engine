// ============ 本机同步队列的 IDB 后端契约（3.6.1 · B1 零覆盖债）============
//
// syncQueueIdb 是同步链路里**唯一会把队列弄丢**的地方：它一出问题，表现不是报错，
// 而是「关掉页面后待同步任务静默消失」或者「整个编辑器卡在启动阶段」。
// 文件头写着三条不能破的规矩，这里逐条钉住：
//   ① 打开失败必须**降级内存且不抛**（隐私模式 / 磁盘满 / 老浏览器）；
//   ② 入队出队往返 + 同 id 覆盖（主键去重，靠它避免同项目排十个任务）；
//   ③ 墓碑上报后能清干净；事务出错要**如实 reject**，不能静默吞掉。
//
// 🔴 不装 fake-indexeddb（项目不引新依赖）：被测文件开了 `SyncQueueIdbPorts` 注入位，
//    这里用最小 IDB 桩跑。桩只实现被测代码真正用到的四个动作（put/get/getAll/delete）。
import { enqueuePush, type SyncJob } from '../src/lib/sync/syncQueue'
import { createSyncStateStores, SYNCQ_DB_NAME, SYNCQ_DB_VERSION } from '../src/lib/sync/syncQueueIdb'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- 最小 IDB 桩 ----------
type Handler = (() => void) | null

class FakeRequest {
  result: unknown = undefined
  error: Error | null = null
  onsuccess: Handler = null
  onerror: Handler = null
  onblocked: Handler = null
  onupgradeneeded: Handler = null
}

interface FakeOptions {
  /** open() 直接失败（模拟隐私模式 / 磁盘满） */
  failOpen?: boolean
  /** 事务失败（模拟配额满 / 库被删） */
  failTx?: boolean
}

function makeFakeIdb(options: FakeOptions = {}) {
  const stores = new Map<string, Map<string, unknown>>()
  const opened: { name: string; version: number | undefined }[] = []

  const makeDb = () => ({
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => {
      stores.set(name, new Map())
      return { createIndex: () => undefined }
    },
    transaction: (name: string) => {
      const rows = stores.get(name) ?? new Map<string, unknown>()
      const keyOf = (value: unknown) => {
        const record = value as { id?: unknown; projectId?: unknown }
        return String(record.id ?? record.projectId)
      }
      const tx = {
        error: null as Error | null,
        oncomplete: null as Handler,
        onerror: null as Handler,
        onabort: null as Handler,
        objectStore: () => ({
          put: (value: unknown) => {
            const req = new FakeRequest()
            rows.set(keyOf(value), value)
            queueMicrotask(() => req.onsuccess?.())
            return req
          },
          get: (key: string) => {
            const req = new FakeRequest()
            req.result = rows.get(String(key))
            queueMicrotask(() => req.onsuccess?.())
            return req
          },
          getAll: () => {
            const req = new FakeRequest()
            req.result = [...rows.values()]
            queueMicrotask(() => req.onsuccess?.())
            return req
          },
          delete: (key: string) => {
            const req = new FakeRequest()
            rows.delete(String(key))
            queueMicrotask(() => req.onsuccess?.())
            return req
          },
        }),
      }
      // 事务在下一轮宏任务结束：此时各请求的 result 已经就位
      setTimeout(() => {
        if (options.failTx) { tx.error = new Error('IDB_TX_FAILED'); tx.onerror?.() } else tx.oncomplete?.()
      }, 0)
      return tx
    },
  })

  const factory = {
    open: (name: string, version?: number) => {
      opened.push({ name, version })
      const req = new FakeRequest()
      queueMicrotask(() => {
        if (options.failOpen) { req.error = new Error('IDB_OPEN_FAILED'); req.onerror?.(); return }
        req.result = makeDb()
        const missing = [...['jobs', 'tombstones']].some(store => !stores.has(store))
        if (missing) req.onupgradeneeded?.()
        req.onsuccess?.()
      })
      return req
    },
  }
  return { factory: factory as unknown as IDBFactory, opened, stores }
}

const job = (id: string, over: Partial<SyncJob> = {}): SyncJob => ({
  id, projectId: 'p-1', cloudProjectId: 'c-1', baseRevision: 3,
  createdAt: 1, updatedAt: 1, state: 'pending', attempts: 0, ...over,
})

async function main() {
  // ① 没有 IndexedDB（Node / 老浏览器）：降级内存，永不抛
  {
    const reasons: string[] = []
    const { queue, tombstones } = await createSyncStateStores(r => reasons.push(r), { indexedDb: null })
    ok('没有 IndexedDB 时降级而不是抛错', reasons[0] === 'NO_IDB', reasons.join(','))
    await queue.put(job('j-noidb'))
    ok('降级后的内存队列仍可入队出队', (await queue.get('j-noidb'))?.id === 'j-noidb')
    await tombstones.put('p-1', [{ kind: 'chapters', id: 'c1', deletedAt: 1 }])
    ok('降级后的墓碑也可用', (await tombstones.list('p-1')).length === 1)
  }

  // ② 打开失败（隐私模式 / 磁盘满）：同样降级，且回调拿到原因
  {
    const { factory } = makeFakeIdb({ failOpen: true })
    const reasons: string[] = []
    const { queue } = await createSyncStateStores(r => reasons.push(r), { indexedDb: factory })
    ok('打开失败时降级并上报原因', reasons[0] === 'IDB_OPEN_FAILED', reasons.join(','))
    await queue.put(job('j-fail-open'))
    ok('打开失败后内存队列可用（不影响写作）', (await queue.get('j-fail-open'))?.id === 'j-fail-open')
  }

  // ③ 正常打开：库名/版本正确，入队出队往返
  {
    const fake = makeFakeIdb()
    const { queue } = await createSyncStateStores(undefined, { indexedDb: fake.factory })
    ok('按约定的库名与版本打开', fake.opened[0]?.name === SYNCQ_DB_NAME && fake.opened[0]?.version === SYNCQ_DB_VERSION, JSON.stringify(fake.opened))
    ok('升级时建出 jobs 与 tombstones 两个 store', fake.stores.has('jobs') && fake.stores.has('tombstones'), [...fake.stores.keys()].join(','))

    await queue.put(job('j-1'))
    ok('入队后可按 id 读回', (await queue.get('j-1'))?.id === 'j-1')
    ok('all() 返回全部任务', (await queue.all()).length === 1)
    await queue.remove('j-1')
    ok('出队后读回 null', (await queue.get('j-1')) === null)
    ok('出队后 all() 为空', (await queue.all()).length === 0)
  }

  // ④ 同 id 重复写入 = 覆盖（主键去重，不是排两条）
  {
    const fake = makeFakeIdb()
    const { queue } = await createSyncStateStores(undefined, { indexedDb: fake.factory })
    await queue.put(job('j-dup', { attempts: 1 }))
    await queue.put(job('j-dup', { attempts: 2 }))
    const all = await queue.all()
    ok('同一任务重复写入只有一条', all.length === 1, JSON.stringify(all))
    ok('重复写入按后写覆盖', all[0]?.attempts === 2, JSON.stringify(all))
  }

  // ⑤ 走真实入队语义：同项目同云端项目复用同一个任务（同 opId）
  {
    const fake = makeFakeIdb()
    const { queue } = await createSyncStateStores(undefined, { indexedDb: fake.factory })
    const first = await enqueuePush(queue, { projectId: 'p-1', cloudProjectId: 'c-1', baseRevision: 1, now: 10 })
    const second = await enqueuePush(queue, { projectId: 'p-1', cloudProjectId: 'c-1', baseRevision: 2, now: 20 })
    ok('重复入队复用同一个任务 id（opId 不换）', first.id === second.id, `${first.id}/${second.id}`)
    ok('重复入队只留一条待跑任务', (await queue.all()).length === 1)
    ok('复用任务会刷新基线版本', (await queue.get(first.id))?.baseRevision === 2)
  }

  // ⑥ 墓碑：写、读、清
  {
    const fake = makeFakeIdb()
    const { tombstones } = await createSyncStateStores(undefined, { indexedDb: fake.factory })
    await tombstones.put('p-1', [{ kind: 'chapters', id: 'c1', deletedAt: 1 }])
    await tombstones.put('p-1', [
      { kind: 'chapters', id: 'c1', deletedAt: 1 },
      { kind: 'cardRecords', id: 'r1', deletedAt: 2 },
    ])
    ok('墓碑按项目整体覆盖写入', (await tombstones.list('p-1')).length === 2)
    ok('未写过墓碑的项目读到空数组', (await tombstones.list('p-2')).length === 0)
    await tombstones.clear('p-1')
    ok('上报后清理墓碑', (await tombstones.list('p-1')).length === 0)
  }

  // ⑦ 事务失败要如实 reject（不能静默当成写成功）
  {
    const fake = makeFakeIdb({ failTx: true })
    const { queue } = await createSyncStateStores(undefined, { indexedDb: fake.factory })
    let rejected = ''
    try { await queue.put(job('j-tx-fail')) } catch (e) { rejected = e instanceof Error ? e.message : String(e) }
    ok('事务失败时写入如实报错', rejected === 'IDB_TX_FAILED', rejected)
  }

  // ⑧ 降级态语义：每次创建都是全新的内存队列（重启即丢任务）
  {
    const first = await createSyncStateStores(undefined, { indexedDb: null })
    await first.queue.put(job('j-ephemeral'))
    const second = await createSyncStateStores(undefined, { indexedDb: null })
    ok('降级态不跨创建保留任务（重启会丢，故必须留痕提示）', (await second.queue.all()).length === 0)
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} syncQueueIdb ${pass}/${pass + fail}`)
  if (fail) process.exitCode = 1
}

await main()
