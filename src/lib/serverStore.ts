// 网页体验版 · 云端同步存储适配层（#003 云端同步特权）
// 实现 StoreOps：数据以整库快照形式存在服务端 /api/sync（单用户、独立同步邀请码鉴权）。
// 设计要点：
//  - 内存缓存 cache，按 store 名分桶；首个操作触发 ensureInit 拉取远端快照。
//  - 所有写操作（put/del/bulkPut/bulkDel）修改缓存并防抖上传（默认 800ms）。
//  - rev 版本号做乐观并发守卫：客户端上传时带 base rev，与服务端不一致返回 409，
//    此时拉取采用云端版本（last-write-wins），避免静默覆盖。
//  - 各 store 主键字段不同：formData/meta/settingsKV/dailyStats 用 tabId/key，其余用 id，
//    须按 store 映射键字段，否则会写串记录。
//  - 仅网页版（WEB）使用；桌面/便携版仍走各自的本地存储。
import type { StoreOps } from './portable'

// 参与同步的全部 store（与 db.ts 中对象库一致）
const SYNC_STORES = [
  'projects', 'volumes', 'chapters', 'formData', 'tableRows', 'cardRecords',
  'meta', 'snapshots', 'dailyStats', 'settingsKV', 'trash', 'backups',
] as const

// 各 store 的主键字段（keyPath）
const KEY_FIELD: Record<string, string> = {
  projects: 'id', volumes: 'id', chapters: 'id', tableRows: 'id',
  cardRecords: 'id', snapshots: 'id', trash: 'id', backups: 'id',
  formData: 'tabId', meta: 'key', settingsKV: 'key', dailyStats: 'key',
}

let code = ''
let cache: Record<string, any[]> = {}
let rev = 0
let pushTimer: ReturnType<typeof setTimeout> | null = null
let initPromise: Promise<void> | null = null

export function configureServerStore(c: string) {
  code = c
}

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${code}`, 'Content-Type': 'application/json' }
}

async function ensureInit() {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const r = await fetch('/api/sync', { headers: { Authorization: `Bearer ${code}` } })
        if (r.ok) {
          const data = await r.json().catch(() => ({ rev: 0, stores: {} }))
          rev = data.rev || 0
          cache = data.stores || {}
          return
        }
      } catch { /* 网络异常：退回空缓存，后续写操作会重试上传 */ }
      cache = {}
      rev = 0
    })()
  }
  return initPromise
}

/** 拉取当前快照（init 之后） */
export async function pullSnapshot(): Promise<{ rev: number; stores: Record<string, any[]> }> {
  await ensureInit()
  return { rev, stores: cache }
}

/** 用本地数据播种（仅当服务端为空时调用；getAll 取自当前默认本地存储） */
export async function seedFromLocal(getAll: (store: string) => Promise<any[]>) {
  for (const s of SYNC_STORES) {
    try {
      cache[s] = (await getAll(s)) || []
    } catch {
      cache[s] = []
    }
  }
  await pushNow(0)
}

async function pushNow(baseRev: number): Promise<{ conflict?: boolean }> {
  const r = await fetch('/api/sync', {
    method: 'POST',
    headers: authHeader(),
    body: JSON.stringify({ rev: baseRev, stores: cache }),
  })
  if (r.status === 409) {
    // 远端已有更新，拉取并采用云端版本
    const data = await r.json().catch(() => ({ rev, stores: cache }))
    rev = data.rev ?? rev
    cache = data.stores || cache
    return { conflict: true }
  }
  if (r.ok) {
    const data = await r.json().catch(() => ({ rev: baseRev + 1 }))
    rev = data.rev ?? baseRev + 1
    return { conflict: false }
  }
  throw new Error('sync push failed ' + r.status)
}

function schedulePush() {
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    pushTimer = null
    pushNow(rev).catch(() => { /* 失败静默，下次写操作会继续尝试 */ })
  }, 800)
}

function keyOf(store: string, value: any): unknown {
  return value?.[KEY_FIELD[store] ?? 'id']
}

export const serverStore: StoreOps = {
  getAll: async <T,>(store: string): Promise<T[]> => {
    await ensureInit()
    return ((cache[store] || []) as T[]).map((x) => ({ ...x }))
  },
  get: async <T,>(store: string, key: string): Promise<T | undefined> => {
    await ensureInit()
    const kf = KEY_FIELD[store] ?? 'id'
    return (cache[store] || []).find((x: any) => x[kf] === key) as T | undefined
  },
  put: async (store: string, value: any) => {
    await ensureInit()
    const arr = cache[store] || (cache[store] = [])
    const k = keyOf(store, value)
    const i = arr.findIndex((x: any) => x[KEY_FIELD[store] ?? 'id'] === k)
    if (i >= 0) arr[i] = value
    else arr.push(value)
    schedulePush()
  },
  del: async (store: string, key: string) => {
    await ensureInit()
    const kf = KEY_FIELD[store] ?? 'id'
    cache[store] = (cache[store] || []).filter((x: any) => x[kf] !== key)
    schedulePush()
  },
  getAllByIndex: async <T,>(store: string, indexName: string, value: unknown): Promise<T[]> => {
    await ensureInit()
    return ((cache[store] || []) as any[])
      .filter((x) => x[indexName] === value)
      .map((x) => ({ ...x })) as T[]
  },
  bulkPut: async (store: string, values: any[]) => {
    await ensureInit()
    const arr = cache[store] || (cache[store] = [])
    const kf = KEY_FIELD[store] ?? 'id'
    for (const v of values) {
      const k = v?.[kf]
      const i = arr.findIndex((x: any) => x[kf] === k)
      if (i >= 0) arr[i] = v
      else arr.push(v)
    }
    schedulePush()
  },
  bulkDel: async (store: string, keys: string[]) => {
    await ensureInit()
    const kf = KEY_FIELD[store] ?? 'id'
    const set = new Set(keys)
    cache[store] = (cache[store] || []).filter((x: any) => !set.has(x[kf]))
    schedulePush()
  },
}
