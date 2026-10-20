// 内存版 StoreOps：Node 端测试用，替换掉 IndexedDB / 文件后端。
//
// 🔴 主键映射**必须与 src/lib/app/desktop.ts 的 KEY_PATHS 逐项一致**。
//    漏一项的后果不是报错，而是**静默错位**：put/get 的 key 取成 `String(undefined)`，
//    该 store 的所有记录都落到同一个 `'undefined'` 键上互相覆盖，而按正常 key 又一条都读不到。
//    2026-09-18 实测：这里原先漏了 `formData: 'tabId'` —— 于是**所有表单型页签在测试里都读回空**，
//    依赖表单数据的断言全在空跑（`tests/antiSpoiler.test.ts` 的排查中顺出来的）。
export const KEY_PATHS: Record<string, string> = {
  tavernReports: 'id',
  aiRuns: 'id',
  projects: 'id', volumes: 'id', chapters: 'id', tableRows: 'id',
  cardRecords: 'id', snapshots: 'id', trash: 'id',
  // C2：备份元数据与载荷分开存（须与 src/lib/app/desktop.ts 逐项一致）
  backups: 'id', backupPayloads: 'id',
  formData: 'tabId', meta: 'key', dailyStats: 'key', settingsKV: 'key',
  // 3.0 · 多世界：本桩原先漏了这一项（`?? 'id'` 兜底让它静默没炸 —— 主键恰好也是 id）。
  // 由 tests/portableBackend.test.ts 的四表一致性守卫抓出（2026-10-11 审计）。
  worlds: 'id',
  // 3.2.0 · W2 工作产物存储：revisionJobs 项目级、revisionPayloads 本地专属
  revisionJobs: 'id', revisionPayloads: 'id',
}

const stores = new Map<string, Map<string, unknown>>()

function storeOf(name: string): Map<string, unknown> {
  let m = stores.get(name)
  if (!m) { m = new Map(); stores.set(name, m) }
  return m
}

export function __resetMockStores() { stores.clear() }

/**
 * 让指定 store 的「读」故意抛错，模拟真实的存储读失败（writeLocked / 云同步瞬时失败 / 磁盘错误）。
 *
 * 为什么需要它：ESM 的命名空间对象（`import * as store from '…/store'`）**只有 getter、不可赋值**，
 * 所以测试里没法 `store.getMemory = …` 打桩（会 `TypeError: has only a getter`）。
 * 从最底层的 StoreOps 注入才是唯一可靠的位置 —— 它上面的每一层（db.getMeta → store.getMemory）
 * 都会如实把异常往上抛。
 *
 * 用法：`__failReads('meta', key => key.includes(':memory:'))` 后记得 `__failReads(null)` 复位。
 */
let failReadMatcher: ((store: string, key: string) => boolean) | null = null

export function __failReads(matcher: ((store: string, key: string) => boolean) | null): void {
  failReadMatcher = matcher
}

function checkReadFailure(store: string, key: string): void {
  if (failReadMatcher?.(store, key)) throw new Error(`模拟存储读失败：${store}/${key}`)
}

/** 全库快照（幂等性对比用）：按 store 名 → 排序后的 JSON 行 */
export function __dumpAll(): string {
  const out: string[] = []
  for (const [name, m] of [...stores.entries()].sort()) {
    const rows = [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
    out.push(`${name}=${rows.map(([, v]) => JSON.stringify(v)).join(';')}`)
  }
  return out.join('|')
}

export const memoryOps = {
  async getAll<T>(store: string): Promise<T[]> {
    return [...storeOf(store).values()] as T[]
  },
  async get<T>(store: string, key: string): Promise<T | undefined> {
    checkReadFailure(store, key)
    return storeOf(store).get(key) as T | undefined
  },
  async put(store: string, value: unknown): Promise<void> {
    const kp = KEY_PATHS[store] ?? 'id'
    const key = String((value as Record<string, unknown>)[kp])
    storeOf(store).set(key, value)
  },
  async del(store: string, key: string): Promise<void> {
    storeOf(store).delete(key)
  },
  async getAllByIndex<T>(store: string, indexName: string, value: unknown): Promise<T[]> {
    return [...storeOf(store).values()].filter(it => (it as Record<string, unknown>)[indexName] === value) as T[]
  },
  async bulkPut(store: string, values: unknown[]): Promise<void> {
    for (const v of values) await memoryOps.put(store, v)
  },
  async bulkDel(store: string, keys: (string | number)[]): Promise<void> {
    for (const k of keys) storeOf(store).delete(String(k))
  },
}

// ============ localStorage mock（Node 端没有这个全局对象）============
//
// 🔴 为什么必须装：syncCore 的「曾存在过」主键名单（区分「本地删除」与「另一端新增」，
//    见 syncCore.ts 顶部说明）要落 localStorage。Node 里没有它，那段读写会被 try/catch
//    **静默降级为空** —— 测试照样全绿，而实际一行都没验证到（这类"看着通过其实空跑"的
//    假绿是这套测试最危险的形态，2026-09-18 的 formData 键漏配就是同类问题）。
//
// ⚠️ 这里**故意不在 __resetMockStores 里清空** —— 「重启后仍然记得曾经见过的记录」
//    正是要验证的行为，清了就等于把被测前提删了。需要隔离时用 __resetLocalStorage。
const lsMap = new Map<string, string>()
if (typeof (globalThis as { localStorage?: unknown }).localStorage === 'undefined') {
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (lsMap.has(k) ? (lsMap.get(k) as string) : null),
    setItem: (k: string, v: string) => { lsMap.set(k, String(v)) },
    removeItem: (k: string) => { lsMap.delete(k) },
    clear: () => { lsMap.clear() },
    key: (i: number) => [...lsMap.keys()][i] ?? null,
    get length() { return lsMap.size },
  }
}

/** 清空 mock localStorage（仅用于需要"全新设备"语义的测试） */
export function __resetLocalStorage() { lsMap.clear() }
