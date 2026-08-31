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
import { WEB } from './env'

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
let pushing = false
let pendingPush = false
let initPromise: Promise<void> | null = null

// #007/#008：必须区分「同步码无效/已失效(401)」与「网络异常」。
// 二者旧代码都落到 cache={}, rev=0，于是鉴权失效时用户看到的是空白项目列表
// （本地 IndexedDB 被空缓存遮蔽而非丢失），且之后每次编辑都静默 401 丢弃。
// authFailed 为真时，db.ts 的 cloudStore 会整体回退本地 idbOps。
let authFailed = false

// #011：网络异常（断网 / DNS 失败 / 服务重启 / 超时）同样必须让出存储控制权。
// 旧代码把它与 401 一样落到 cache={}, rev=0，但 authFailed 仍为 false，
// 于是 cloudStore 照常用空缓存接管 —— 用户看到空白项目列表，之后每次编辑都被静默丢弃。
// 与「码失效」的关键区别：网络异常是**暂时的**，必须允许后续自动重试，网络恢复后接管回来。
let transientUnavailable = false

// 被服务端限流（429）的截止时间。限流是暂时的，与「码失效」不同：
// 不清本地码、不提示失效，只需暂停接管存储并如实展示状态。
let rateLimitedUntil = 0

// 同步状态（#008：失败必须有可见指示，不能让用户零感知）
// #011 新增 'offline'：网络异常（断网/服务不可达）与 401/429 并列，同样不接管存储
export type SyncStatus = 'idle' | 'syncing' | 'ok' | 'error' | 'auth-failed' | 'rate-limited' | 'offline'
let syncStatus: SyncStatus = 'idle'
const STATUS_EVENT = 'yfe:sync-status'

function setStatus(s: SyncStatus) {
  if (syncStatus === s) return
  syncStatus = s
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: s }))
    } catch { /* 忽略事件派发失败 */ }
  }
}
export function getSyncStatus(): SyncStatus {
  return syncStatus
}
/** 云端鉴权是否已失效（收到过 401）。为 true 时上层应回退本地存储。 */
export function isCloudAuthFailed(): boolean {
  return authFailed
}
/**
 * 云端当前是否不可用（鉴权失效 401 / 被限流 429 / 网络异常）——三者都不该接管存储，
 * 否则用户会看到空白数据。#011 把「网络异常」也纳入，此前它会被当成可用而用空缓存接管。
 */
export function isCloudUnavailable(): boolean {
  return authFailed || transientUnavailable || Date.now() < rateLimitedUntil
}
/** 是否因网络异常暂时离线（#011）。与码失效不同，网络恢复后会自动重试接管。 */
export function isCloudOffline(): boolean {
  return transientUnavailable
}

/** 被服务端限流（429）——与网络异常区分，避免被当成「可以重试的普通失败」反复打 */
export class RateLimitError extends Error {
  constructor(public retryAfter = 600) {
    super(`尝试过于频繁，请 ${Math.ceil(retryAfter / 60)} 分钟后再试`)
    this.name = 'RateLimitError'
  }
}

/** 同步码无效/已失效（服务端 401）——与网络异常明确区分，便于上层给出准确提示 */
export class CloudAuthError extends Error {
  constructor(msg = '同步码无效或已失效') {
    super(msg)
    this.name = 'CloudAuthError'
  }
}

export function configureServerStore(c: string) {
  code = c
  // 每次（重新）设码都重置 init 状态：否则模块级 initPromise 已 resolved 后会用旧码
  // 的拉取结果短路，导致"重新连接"换码后拉到的不是新码的数据（#003 可靠性修复）。
  cache = {}
  rev = 0
  initPromise = null
  authFailed = false
  transientUnavailable = false
  rateLimitedUntil = 0
  baseCache = {}
  setStatus('idle')
  // 至此才算「已启用云端同步」，此时才注册卸载兜底 flush。
  // 早于此处注册会让未开同步的访客发出无码 POST（#023）。
  if (c) armUnloadFlush()
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
        if (r.status === 401) {
          // 鉴权失败＝码无效/已失效。绝不落到「空缓存接管存储」，否则用户会看到
          // 空白项目列表并在此后静默丢弃所有编辑（#008 数据丢失级隐患）。
          authFailed = true
          setStatus('auth-failed')
          cache = {}
          rev = 0
          return
        }
        if (r.status === 429) {
          // 限流：绝不落到空缓存接管存储，否则被限流的用户会看到空白数据
          const d = await r.json().catch(() => null)
          const sec = Number(d?.retryAfter) || 600
          rateLimitedUntil = Date.now() + sec * 1000
          setStatus('rate-limited')
          return
        }
        if (r.ok) {
          const data = await r.json().catch(() => null)
          rev = Number(data?.rev) || 0
          if (data && typeof data.enc === 'string' && data.enc) {
            cache = await decryptObj(data.enc)
          } else {
            cache = {}
          }
          authFailed = false
          transientUnavailable = false
          // 拉取成功即确立基线：之后的本地改动才有参照，才能判断「谁改了」
          baseCache = snapshotOf(cache)
          return
        }
        throw new Error('sync pull failed ' + r.status)
      } catch {
        /* 网络异常（断网 / DNS / 服务重启 / 超时）：#011 起与 401/429 一样绝不让空缓存接管存储。
           置 transientUnavailable 让 cloudStore 回退本地 idbOps，用户看到的始终是自己的数据；
           同时清掉 initPromise，使下一次操作能重新握手 —— 网络恢复后自动接管回来，
           不像鉴权失效那样需要用户重新输码。 */
        transientUnavailable = true
        setStatus('offline')
        initPromise = null
      }
      cache = {}
      rev = 0
    })()
  }
  return initPromise
}

/** 拉取当前快照（init 之后）。码无效时抛 CloudAuthError，而非返回空快照。 */
export async function pullSnapshot(): Promise<{ rev: number; stores: Record<string, any[]> }> {
  await ensureInit()
  if (authFailed) throw new CloudAuthError()
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
  // 排除敏感 meta（AI 配置/密钥）与本地专属的冲突副本，不进云端缓存
  if (cache['meta']) {
    cache['meta'] = cache['meta'].filter((r: any) => !isExcludedMetaKey(r.key))
  }
  await pushNow(0)
}

// ============ #005 冲突备份（网页版专用）============
// 上次成功同步时的基线快照。没有基线就无法区分「只有本地改」和「两端都改」，
// 只能一律本地覆盖——那会把云端的改动无声吞掉。三路合并必须有它。
let baseCache: Record<string, any[]> = {}

export type SyncConflictInfo = {
  store: string
  key: unknown
  local: any
  server: any
  at: number
}
let conflictHandler: ((info: SyncConflictInfo) => void) | null = null
/** 注册冲突处理器：两端都改过同一条记录时，把云端那版交给上层另存副本 */
export function onSyncConflict(h: (info: SyncConflictInfo) => void) {
  conflictHandler = h
}

export const CONFLICT_KEY_PREFIX = 'syncConflict:'
/** 敏感/本地专属 meta：AI 配置不上云；冲突副本只落本地、不上传 */
export function isExcludedMetaKey(key: unknown): boolean {
  if (typeof key !== 'string') return false
  return EXCLUDED_META_KEYS.has(key) || key.startsWith(CONFLICT_KEY_PREFIX)
}

function eqRecord(a: any, b: any): boolean {
  if (a === b) return true
  if (!a || !b) return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}
function snapshotOf(c: Record<string, any[]>): Record<string, any[]> {
  const out: Record<string, any[]> = {}
  for (const k of Object.keys(c || {})) out[k] = (c[k] || []).slice()
  return out
}

/**
 * 三路合并（base 基线 / server 云端 / local 本地）。
 * 与旧版「一律本地覆盖」的区别：只有云端改时采用云端；两端都改时才以本地为准，
 * 并把云端那版交给 conflictHandler 另存副本，用户可比对照恢复（#005）。
 */
function mergeCaches(
  base: Record<string, any[]>,
  server: Record<string, any[]>,
  local: Record<string, any[]>,
): Record<string, any[]> {
  const out: Record<string, any[]> = {}
  const stores = new Set([
    ...Object.keys(base || {}),
    ...Object.keys(server || {}),
    ...Object.keys(local || {}),
  ])
  for (const s of stores) {
    const kf = KEY_FIELD[s] ?? 'id'
    const bMap = new Map<any, any>()
    const sMap = new Map<any, any>()
    const lMap = new Map<any, any>()
    for (const r of (base && base[s]) || []) if (r && r[kf] !== undefined) bMap.set(r[kf], r)
    for (const r of (server && server[s]) || []) if (r && r[kf] !== undefined) sMap.set(r[kf], r)
    for (const r of (local && local[s]) || []) if (r && r[kf] !== undefined) lMap.set(r[kf], r)

    const arr: any[] = []
    for (const k of new Set([...bMap.keys(), ...sMap.keys(), ...lMap.keys()])) {
      const b = bMap.get(k)
      const sv = sMap.get(k)
      const lo = lMap.get(k)
      const note = (localV: any, serverV: any) => {
        try {
          conflictHandler?.({ store: s, key: k, local: localV, server: serverV, at: Date.now() })
        } catch {
          /* 冲突处理失败绝不影响主同步流程 */
        }
      }

      // —— 本地没有这条记录 ——
      // 注意：不能一律 continue，否则「另一端新建的记录」会被直接丢弃（丢数据）。
      if (lo === undefined) {
        if (sv === undefined) continue // 两端皆无
        if (b === undefined) {
          arr.push(sv) // 基线无、云端有 → 另一端新增（或本地尚未拉取），采用云端
          continue
        }
        // 基线有、本地删了：若云端同期还改过，删除不可逆，宁可多留一份并记冲突
        if (!eqRecord(sv, b)) {
          arr.push(sv)
          note(null, sv)
        }
        continue // 云端未改 → 尊重本地删除
      }

      // —— 云端没有这条记录 ——
      if (sv === undefined) {
        // 云端删了且本地未改 → 尊重删除；否则保留本地（本地新增或改过）
        if (b !== undefined && eqRecord(lo, b)) continue
        arr.push(lo)
        continue
      }

      if (eqRecord(lo, sv)) {
        arr.push(lo) // 两端一致
        continue
      }
      const localChanged = !eqRecord(lo, b)
      const serverChanged = !eqRecord(sv, b)
      if (!localChanged) {
        arr.push(sv) // 只有云端改 → 采用云端（旧版会错误地用本地覆盖）
        continue
      }
      if (!serverChanged) {
        arr.push(lo) // 只有本地改 → 采用本地
        continue
      }
      // 两端都改且不同 → 本地优先，云端那版另存副本供比对恢复
      arr.push(lo)
      note(lo, sv)
    }
    out[s] = arr
  }
  return out
}

const MAX_CONFLICT_RETRY = 5

// 推送（带 rev 守卫）。冲突(409)时：合并云端版本（本地优先）后用最新 rev 重试，
// 绝不把本地未保存改动直接丢弃——这是修复「保存的数据被系统自动刷新掉」的核心。
async function pushNow(baseRev: number, depth = 0): Promise<{ conflict?: boolean }> {
  const enc = await encryptObj(cache)
  let r: Response
  try {
    r = await fetch('/api/sync', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify({ rev: baseRev, enc }),
    })
  } catch {
    // #011：推送时的网络异常同样置位，让上层回退本地；网络恢复后下一次写操作会重新握手。
    transientUnavailable = true
    setStatus('offline')
    throw new Error('sync push network error')
  }
  if (r.status === 409) {
    const data = await r.json().catch(() => ({ rev: baseRev, enc: null }))
    const serverRev = data.rev ?? baseRev
    let serverCache: Record<string, any[]> | null = null
    if (data.enc) {
      try { serverCache = await decryptObj(data.enc) } catch { serverCache = null }
    }
    // 关键：本地改动优先合并，绝不直接用云端版本覆盖掉未保存的本地编辑
    if (serverCache) cache = mergeCaches(baseCache, serverCache, cache)
    rev = serverRev
    if (depth < MAX_CONFLICT_RETRY) {
      return pushNow(serverRev, depth + 1) // 用云端最新 rev 重新推送，保留本地改动
    }
    // 极罕见：仍冲突则保留本地改动、接受云端 rev，不再重试（本地编辑已留在 cache）
    return { conflict: true }
  }
  if (r.status === 401) {
    // 码失效（服务端轮换白名单、槽位被清理等）：标记后交由上层回退本地并提示用户
    authFailed = true
    setStatus('auth-failed')
    throw new CloudAuthError()
  }
  if (r.status === 429) {
    // 被限流：标记暂停时间，交由上层回退本地，避免用户看到空白数据
    const d = await r.json().catch(() => null)
    const sec = Number(d?.retryAfter) || 600
    rateLimitedUntil = Date.now() + sec * 1000
    setStatus('rate-limited')
    throw new RateLimitError(sec)
  }
  if (r.ok) {
    const data = await r.json().catch(() => ({ rev: baseRev + 1 }))
    rev = data.rev ?? baseRev + 1
    // 推送成功：当前 cache 即为双方一致的最新状态，确立为新基线
    baseCache = snapshotOf(cache)
    setStatus('ok')
    return { conflict: false }
  }
  setStatus('error')
  throw new Error('sync push failed ' + r.status)
}

// 串行化推送：同一时刻只允许一个在途请求；在途期间的新写入标记 pending，结束后补推一次，
// 避免两个标签/设备的推送互相 409 打架导致本地改动被覆盖。
async function flushNow(): Promise<void> {
  // 未启用云端同步（尚无同步码）时绝不能发请求。
  // 否则每次切标签/隐藏页面/关页面都会发出一个「无码 POST」被 401：
  // 既把 access.jsonl 灌满，又会让访客把自家 IP 的限流额度耗光，
  // 等他真正输入正确同步码时反而卡在封锁期里（#023）。
  if (!code) return
  if (pushTimer) { clearTimeout(pushTimer); pushTimer = null }
  if (pushing) { pendingPush = true; return }
  pushing = true
  setStatus('syncing')
  try {
    await pushNow(rev)
  } catch (e) {
    // 失败保留本地改动，下次写操作/页面卸载时会重试。
    // 401 → auth-failed、网络异常 → offline，二者已由 pushNow 置好状态，此处不要覆盖；
    // 其余（5xx 等）标 error —— 状态必须可见（#008）。
    if (!(e instanceof CloudAuthError) && !transientUnavailable) setStatus('error')
  } finally {
    pushing = false
    if (pendingPush) { pendingPush = false; schedulePush() }
  }
}

function schedulePush() {
  if (!code) return // 同理：未启用同步就不排推送（#023）
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    pushTimer = null
    void flushNow()
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

// 页面隐藏/卸载前尽力把待推送改动刷到云端，避免 800ms 防抖窗口内关闭导致丢数据。
// 必须「延迟到真正启用同步时」才注册，不能在模块顶层无条件注册：
//  - 桌面/便携版 WEB=false：顶层副作用会让 serverStore 无法被 tree-shake，且每次切后台/
//    关窗口都白跑一次 PBKDF2 密钥派生与一次注定失败（file:// 无 /api/sync）的请求；
//  - 网页版未开同步的访客：顶层注册会让其每次切标签/关页面发出「无码 POST」被 401，
//    灌满日志并耗尽自家 IP 的限流额度，等真输正确码时反被 429 拦下（#023）。
let unloadHooked = false
export function armUnloadFlush() {
  if (unloadHooked || !WEB || typeof window === 'undefined') return
  unloadHooked = true
  const onHide = () => { if (document.visibilityState === 'hidden') void flushNow() }
  window.addEventListener('pagehide', () => void flushNow())
  window.addEventListener('beforeunload', () => void flushNow())
  document.addEventListener('visibilitychange', onHide)
}
