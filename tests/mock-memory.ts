// 内存版 StoreOps：Node 端测试用，替换掉 IndexedDB / 文件后端。
// 键规则与真实实现一致：meta / settingsKV / dailyStats 用 key，其余用 id。
const KEY_PATHS: Record<string, string> = { meta: 'key', settingsKV: 'key', dailyStats: 'key' }

const stores = new Map<string, Map<string, unknown>>()

function storeOf(name: string): Map<string, unknown> {
  let m = stores.get(name)
  if (!m) { m = new Map(); stores.set(name, m) }
  return m
}

export function __resetMockStores() { stores.clear() }

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
