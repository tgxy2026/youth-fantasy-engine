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
//  - 加密：上传前用同步邀请码派生密钥加密载荷（rev 保持明文以便服务端做版本守卫）。
//    安全上下文(HTTPS/localhost)走 Web Crypto AES-GCM（真加密）；非安全上下文(HTTP 公网)
//    降级为 XOR 混淆（仅防服务器磁盘明文泄露，非密码学强度，需上 HTTPS 才真加密）。
//  - 敏感 meta（AI 配置/密钥：aiProviders / aiActiveProviderId / aiConfigMigratedToGlobal）
//    不上云：既不进缓存、也不上传、更不会被拉取覆盖（由 db.ts 的 cloudStore 回退到本地）。
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

// 不同步的敏感 meta（AI 模型配置含 apiKey；UI 已承诺「仅本地保存，不上传」）
export const EXCLUDED_META_KEYS = new Set<string>([
  'aiProviders', 'aiActiveProviderId', 'aiConfigMigratedToGlobal',
])

let code = ''
let cache: Record<string, any[]> = {}
let rev = 0
let pushTimer: ReturnType<typeof setTimeout> | null = null
let initPromise: Promise<void> | null = null

export function configureServerStore(c: string) {
  code = c
}

// ============ 加密（载荷级，rev 保持明文） ============
const hasSubtle = typeof globalThis !== 'undefined' && !!((globalThis as any).crypto && (globalThis as any).crypto.subtle)
const SYNC_SALT = 'yfe-cloud-sync-v1'

function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as any)
  }
  return btoa(bin)
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function deriveKey(c: string): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const material = await (globalThis as any).crypto.subtle.importKey('raw', enc.encode(c), 'PBKDF2', false, ['deriveKey'])
  return (globalThis as any).crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(SYNC_SALT), iterations: 100000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  ) as Promise<CryptoKey>
}

async function aesEncrypt(obj: unknown): Promise<string> {
  const iv = (globalThis as any).crypto.getRandomValues(new Uint8Array(12))
  const data = new TextEncoder().encode(JSON.stringify(obj))
  const buf = await (globalThis as any).crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deriveKey(code), data)
  const ct = new Uint8Array(buf)
  const combined = new Uint8Array(iv.length + ct.length)
  combined.set(iv, 0)
  combined.set(ct, iv.length)
  return 'a1:' + bytesToB64(combined)
}
async function aesDecrypt(s: string): Promise<any> {
  const combined = b64ToBytes(s.slice(3))
  const iv = combined.subarray(0, 12)
  const data = combined.subarray(12)
  const buf = await (globalThis as any).crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await deriveKey(code), data)
  return JSON.parse(new TextDecoder().decode(buf))
}

// HTTP 公网降级：XOR 混淆（非密码学强度，仅防服务器磁盘明文）
function xorKeystream(c: string): Uint8Array {
  const seed = new TextEncoder().encode(c + '::yfe-sync')
  const key = new Uint8Array(256)
  for (let i = 0; i < 256; i++) {
    let b = seed[i % seed.length]
    b = (b ^ ((i * 167) & 0xff) ^ ((i >>> 3) & 0xff)) & 0xff
    key[i] = b
  }
  return key
}
function xorObfuscate(obj: unknown): string {
  const data = new TextEncoder().encode(JSON.stringify(obj))
  const key = xorKeystream(code)
  const out = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i & 255]
  return 'x1:' + bytesToB64(out)
}
function xorDeobfuscate(s: string): any {
  const data = b64ToBytes(s.slice(3))
  const key = xorKeystream(code)
  const out = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i & 255]
  return JSON.parse(new TextDecoder().decode(out))
}

async function encryptObj(obj: unknown): Promise<string> {
  if (hasSubtle) return aesEncrypt(obj)
  return xorObfuscate(obj)
}
async function decryptObj(s: string): Promise<any> {
  // 注意：解密失败必须 throw，绝不能吞掉返回 {} —— 否则 cache 变空却保留真实 rev，
  // 下次 push 会用空库覆盖服务端，导致整库数据丢失。
  if (s.startsWith('a1:')) return await aesDecrypt(s)
  if (s.startsWith('x1:')) return xorDeobfuscate(s)
  return JSON.parse(s) // 兼容极老明文（正常不会出现）
}

// ============ 通信 ============
function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${code}`, 'Content-Type': 'application/json' }
}

async function ensureInit() {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const r = await fetch('/api/sync', { headers: { Authorization: `Bearer ${code}` } })
        if (r.ok) {
          const data = await r.json().catch(() => null)
          rev = Number(data?.rev) || 0
          if (data && typeof data.enc === 'string' && data.enc) {
            cache = await decryptObj(data.enc)
          } else {
            cache = {}
          }
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
  // 排除敏感 meta（AI 配置/密钥），不进云端缓存、不上传
  if (cache['meta']) {
    cache['meta'] = cache['meta'].filter((r: any) => !EXCLUDED_META_KEYS.has(r.key))
  }
  await pushNow(0)
}

async function pushNow(baseRev: number): Promise<{ conflict?: boolean }> {
  const enc = await encryptObj(cache)
  const r = await fetch('/api/sync', {
    method: 'POST',
    headers: authHeader(),
    body: JSON.stringify({ rev: baseRev, enc }),
  })
  if (r.status === 409) {
    // 远端已有更新，拉取并采用云端版本
    const data = await r.json().catch(() => ({ rev, enc: '' }))
    rev = data.rev ?? rev
    cache = data.enc ? await decryptObj(data.enc) : cache
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
