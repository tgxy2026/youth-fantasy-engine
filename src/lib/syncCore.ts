// 云端同步核心（传输层无关）：加密 / 载荷结构 / rev 合并 / #030 空推防护 / 三路合并 / 状态机。
// 由 createCloudStore(transport) 产出一个完整的云端 StoreOps 实例。
//
// 设计要点：
//  - 本文件不关心「字节怎么落地」——那是 SyncTransport 的职责（HTTP / 本地文件）。
//  - 当前唯一使用方是 desktopCloudSync（File 传输，由云盘客户端搬运，无需服务器）。
//    ⚠️ 2026-09-15：网页版服务器同步（serverStore）已随「只做桌面版」的决定下线，
//      跨设备同步的唯一途径是**云盘文件**。本核心本身无平台假设，故原样保留。
//  - 加密：载荷用同步码派生密钥加密（rev 保持明文以便做版本守卫）。
//    安全上下文(HTTPS/localhost)走 Web Crypto AES-GCM（真加密）；非安全上下文降级为 XOR 混淆。
import type { StoreOps } from './storeOps'
import {
  type SyncTransport,
  type RawSyncResponse,
} from './syncTransport'
import { SAVE_DEBOUNCE_MS } from './constants'
import { todayKey } from './date'

// 对象库清单（与 db.ts 中对象库一致，作为对账依据）。
// ⚠️ 注意 'backups' 是**本地专属**：上传侧 liveStores() 会把它从载荷里剔除，
//    读取侧 db.ts 的 makeCloudStoreWrapper 也把它的读写短路到本地 store（#026）。
//    因此「云端载荷」实际不含它——真正会被同步的是除 backups 外的其余 store。
export const SYNC_STORES = [
  'projects', 'volumes', 'chapters', 'formData', 'tableRows', 'cardRecords',
  'meta', 'snapshots', 'dailyStats', 'settingsKV', 'trash', 'backups', 'tavernReports',
] as const

// 各 store 的主键字段（keyPath）
export const KEY_FIELD: Record<string, string> = {
  projects: 'id', volumes: 'id', chapters: 'id', tableRows: 'id',
  cardRecords: 'id', snapshots: 'id', trash: 'id', backups: 'id', tavernReports: 'id',
  formData: 'tabId', meta: 'key', settingsKV: 'key', dailyStats: 'key',
}

// 不同步的敏感 meta（AI 模型配置含 apiKey；UI 已承诺「仅本地保存，不上传」）
export const EXCLUDED_META_KEYS = new Set<string>([
  'aiProviders', 'aiActiveProviderId', 'aiConfigMigratedToGlobal',
])

export const CONFLICT_KEY_PREFIX = 'syncConflict:'

// #005 冲突处理器：两端都改过同一条记录时，把云端那版交给上层另存副本
let conflictHandler: ((info: SyncConflictInfo) => void) | null = null
export function onSyncConflict(h: (info: SyncConflictInfo) => void) {
  conflictHandler = h
}

/**
 * 「推不出去」时的兜底处理器：收到当前内存 cache，由上层负责落盘。
 * 见 createCloudStore().onFallback 与 flushNow() 的 blocked 分支。
 */
let fallbackHandler: ((cache: Record<string, any[]>) => void) | null = null

/** 敏感/本地专属 meta：AI 配置不上云；冲突副本只落本地、不上传 */
export function isExcludedMetaKey(key: unknown): boolean {
  if (typeof key !== 'string') return false
  return EXCLUDED_META_KEYS.has(key) || key.startsWith(CONFLICT_KEY_PREFIX)
}

/**
 * 一份载荷里的**记录总数**（把所有 store 的行数加起来）。
 *
 * 🔴 判断「是不是空载荷」必须用它，不能用 `Object.keys(...).length`：
 *    `liveStores` 会把每个 store 都放成键（哪怕是空数组），12 个空数组照样能骗过键数判断
 *    —— 一份「看起来有 12 个 store」的空快照就这么被推上云端，覆盖掉真实数据。
 */
export function totalRecords(m: Record<string, any[]>): number {
  return Object.values(m || {}).reduce((n, rows) => n + (Array.isArray(rows) ? rows.length : 0), 0)
}

export type SyncStatus =
  | 'idle'
  | 'syncing'
  | 'ok'
  | 'error'
  | 'auth-failed'
  | 'rate-limited'
  | 'too-large'
  | 'offline'

export type SyncConflictInfo = {
  store: string
  key: unknown
  local: any
  server: any
  at: number
}

// #026/A+：云端每日滚动备份（最新一份，按自然日滚动）。
export type CloudBackup = { day: string; ts: number; data: Record<string, any[]> }
export type CloudBackupMeta = { day: string; ts: number }

/** 被服务端限流（429）——与网络异常区分 */
class RateLimitError extends Error {
  constructor(public retryAfter = 600) {
    super(`尝试过于频繁，请 ${Math.ceil(retryAfter / 60)} 分钟后再试`)
    this.name = 'RateLimitError'
  }
}

/** 同步码无效/已失效（服务端 401）——与网络异常明确区分 */
export class CloudAuthError extends Error {
  constructor(msg = '同步码无效或已失效') {
    super(msg)
    this.name = 'CloudAuthError'
  }
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

// ↓ 注意：encryptObj/decryptObj 及 aesEncrypt/aesDecrypt/xorObfuscate/xorDeobfuscate
// 依赖模块级 `code`，该变量由 createCloudStore 闭包持有，故这些函数定义在工厂内部（见下）。
// 此处仅保留纯工具（bytesToB64/b64ToBytes/deriveKey/xorKeystream 均不引用 code）。

function eqRecord(a: any, b: any): boolean {
  if (a === b) return true
  if (!a || !b) return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}
/**
 * 两个 store 快照内容是否一致。
 * 用途：三路合并后判断「是否留下了云端没有的本地改动」（是则必须立刻推回，见 backgroundPull）。
 */
function sameStores(a: Record<string, any[]>, b: Record<string, any[]>): boolean {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})])
  for (const k of keys) {
    const av = a?.[k] ?? []
    const bv = b?.[k] ?? []
    if (av.length !== bv.length) return false
    const bm = new Map<any, any>(bv.map((r: any) => [r?.id ?? r?.key, r]))
    for (const r of av) {
      const other = bm.get(r?.id ?? r?.key)
      if (!other || !eqRecord(r, other)) return false
    }
  }
  return true
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
    // #026：backups 是本地专属保险，云端永不参与其增删
    if (s === 'backups') {
      out[s] = (local && local[s]) || []
      continue
    }
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
      if (lo === undefined) {
        if (sv === undefined) continue // 两端皆无
        if (b === undefined) {
          arr.push(sv) // 基线无、云端有 → 另一端新增（或本地尚未拉取），采用云端
          continue
        }
        if (!eqRecord(sv, b)) {
          arr.push(sv)
          note(null, sv)
        }
        continue // 云端未改 → 尊重本地删除
      }

      // —— 云端没有这条记录 ——
      if (sv === undefined) {
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
        arr.push(sv) // 只有云端改 → 采用云端
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

// ============ 云端 StoreOps 实例工厂（传输层无关）============
export interface CloudStoreInstance {
  store: StoreOps
  configure(code: string): void
  setTransport(t: SyncTransport): void
  pullSnapshot(): Promise<{ rev: number; stores: Record<string, any[]> }>
  seedFromLocal(getAll: (store: string) => Promise<any[]>): Promise<void>
  getStatus(): SyncStatus
  isCloudUnavailable(): boolean
  isCloudAuthFailed(): boolean
  getCloudBackupMeta(): CloudBackupMeta | null
  restoreFromCloudBackup(): Promise<boolean>
  backgroundPull(): Promise<void>
  onSyncConflict(h: (info: SyncConflictInfo) => void): void
  /** 注册「推不出去时的本地兜底」：回调收到当前内存 cache（store 名 → 行数组）。
   *  云模式下写入先进内存、再推同步目录；推送被挡时若不兜底，关窗即丢。 */
  onFallback(h: (cache: Record<string, any[]>) => void): void
  armUnloadFlush(): void
  /** 立即把内存里未推送的改动推出去（不等防抖计时器）。关同步 / 关窗前调用。 */
  flushNow(): Promise<void>
  /** 当前内存 cache 的快照（store 名 → 行数组）。用于「关闭同步前把云端数据镜像进本地」。 */
  getCacheSnapshot(): Record<string, any[]>
}

const MAX_CONFLICT_RETRY = 5
const STATUS_EVENT = 'yfe:sync-status'

export function createCloudStore(initialTransport: SyncTransport): CloudStoreInstance {
  let code = ''
  let cache: Record<string, any[]> = {}
  let rev = 0
  let pushTimer: ReturnType<typeof setTimeout> | null = null
  let pushing = false
  let pendingPush = false
  /** 已排队的推送链：保证任意两次推送**串行**执行（见 pushNow 的说明） */
  let pushChain: Promise<unknown> = Promise.resolve()
  let initPromise: Promise<void> | null = null
  let transport: SyncTransport = initialTransport

  let authFailed = false
  let transientUnavailable = false
  let rateLimitedUntil = 0
  let syncStatus: SyncStatus = 'idle'

  let cloudBackup: CloudBackup | null = null
  let baseCache: Record<string, any[]> = {}

  function setStatus(s: SyncStatus) {
    if (syncStatus === s) return
    syncStatus = s
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: s }))
      } catch { /* 忽略事件派发失败 */ }
    }
  }

  // 仅含活数据（排除本地专属的 backups 与敏感 meta）
  function liveStores(src: Record<string, any[]>): Record<string, any[]> {
    const out: Record<string, any[]> = {}
    for (const s of Object.keys(src || {})) {
      if (s === 'backups') continue
      out[s] = (src[s] || []).slice()
    }
    if (out.meta) out.meta = out.meta.filter((r: any) => !isExcludedMetaKey(r.key))
    return out
  }

  function adoptCloudBackup(obj: any) {
    if (obj && obj.__cloudBackup) {
      cloudBackup = obj.__cloudBackup
      delete obj.__cloudBackup
    }
  }

  // 以下 4 个函数引用闭包内的 `code`，必须定义在工厂内部（createCloudStore 提供 `code` 作用域）。
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
    if (s.startsWith('a1:')) return await aesDecrypt(s)
    if (s.startsWith('x1:')) return xorDeobfuscate(s)
    return JSON.parse(s)
  }

  // ============ 通信（经传输层抽象）============
  async function ensureInit() {
    if (!initPromise) {
      initPromise = (async () => {
        try {
          const resp: RawSyncResponse = await transport.pull()
          const r = resp.status
          if (r === 401) {
            authFailed = true
            setStatus('auth-failed')
            cache = {}
            rev = 0
            return
          }
          if (r === 429) {
            const sec = 600
            rateLimitedUntil = Date.now() + sec * 1000
            setStatus('rate-limited')
            return
          }
          if (r === 200) {
            rev = Number(resp.rev) || 0
            if (resp.enc) {
              cache = await decryptObj(resp.enc)
              adoptCloudBackup(cache)
            } else {
              cache = {}
            }
            authFailed = false
            transientUnavailable = false
            baseCache = snapshotOf(cache)
            return
          }
          if (r === 0) throw new Error('sync pull network error')
          throw new Error('sync pull failed ' + r)
        } catch {
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

  /**
   * 🔴 闩锁自愈：`transientUnavailable` 曾经是一条**单向闩锁**。
   *
   * 置位之后（网盘客户端占用同步目录 / 网络瞬断 → pull 抛错或非 200）：
   *   · `backgroundPull` 开头直接 return —— 拉取被自己挡住了；
   *   · 唯一能复位它的 `ensureInit` 又被 `initPromise` 记忆化，正常使用中不再执行；
   *   · 于是只剩 `configure()`（换目录 / 重开同步）一条路。
   * 后果：包装层（`isCloudUnavailable()`）会**一直**把读写切在本地库上，
   * 而关窗兜底的镜像又拿陈旧的 cache 去覆盖本地新记录 —— 静默回滚、磁盘不可逆丢失（审计 P0-2）。
   *
   * 这里给一条明确的恢复通道：清掉记忆化的 init，重跑一次拉取，成功即解锁。
   * 失败时**保持闩锁**（除 `initPromise` 外什么都不动），不会产生额外副作用。
   */
  async function tryRecoverFromTransient(): Promise<boolean> {
    if (!transientUnavailable) return !authFailed
    if (authFailed) return false
    initPromise = null
    try {
      await ensureInit()
    } catch {
      /* ensureInit 自身会吞异常并置 offline，这里只关心最终状态 */
    }
    return !transientUnavailable && !authFailed
  }

  /** 拉取当前快照（init 之后）。码无效时抛 CloudAuthError，而非返回空快照。 */
  async function pullSnapshot(): Promise<{ rev: number; stores: Record<string, any[]> }> {
    await ensureInit()
    if (authFailed) throw new CloudAuthError()
    return { rev, stores: cache }
  }

  /** 云端每日备份元信息（用于 UI 展示「最近一份备份日期」）。无则返回 null。 */
  function getCloudBackupMeta(): CloudBackupMeta | null {
    return cloudBackup ? { day: cloudBackup.day, ts: cloudBackup.ts } : null
  }

  /** 从云端每日备份恢复：回滚到该检查点并重新上传同步。 */
  async function restoreFromCloudBackup(): Promise<boolean> {
    if (!cloudBackup) return false
    const restored = liveStores(cloudBackup.data)
    // #027：备份为空时拒绝回滚——否则会把空备份当最新状态推上去，反而清空整库。
    if (totalRecords(restored) === 0) return false
    cache = restored
    baseCache = snapshotOf(cache)
    await pushNow(() => rev)
    return true
  }

  /** 用本地数据播种（仅当远端为空时调用）。 */
  async function seedFromLocal(getAll: (store: string) => Promise<any[]>) {
    // 🔴 审计 2026-09-18（P2-3）：逐 store 读失败**绝不能静默当空**继续播种。
    //    残缺载荷一旦推上去就成了新基线，另一台设备 mergeCaches 时按「云端没有该记录、
    //    本地也没改过」丢弃那些记录 —— 真实数据在**两端一起消失**。
    //    所以先读到临时对象、全部成功才提交；有任何失败就中止（界面报错，下次再播）。
    const next: Record<string, any[]> = {}
    const failed: string[] = []
    for (const s of SYNC_STORES) {
      // backups 是本地专属保险（#026）：上传侧 liveStores 会剔除它，读取侧 db.ts 的包装层
      // 也把它短路到本地 store——读进 cache 没有任何下游消费者，纯属无用功。
      // 而备份体量不小（每份是一整份项目副本，最多 30 份滚动），播种时白读一次的代价真实可感。
      if (s === 'backups') continue
      try {
        next[s] = (await getAll(s)) || []
      } catch {
        failed.push(s)
      }
    }
    if (failed.length) {
      throw new Error(`播种失败：读取本地数据出错（${failed.join('、')}），已中止以免把残缺数据推上云端`)
    }
    if (next['meta']) {
      next['meta'] = next['meta'].filter((r: any) => !isExcludedMetaKey(r.key))
    }
    cache = next
    await pushNow(0)
  }

  // 轮询发现远端更新时主动拉取并三路合并（文件模式跨设备同步的核心）。
  async function backgroundPull() {
    if (!code || authFailed) return
    // 🔴 闩锁期要**真的尝试**一次拉取 —— 这是唯一的自愈入口（详见 tryRecoverFromTransient）。
    //    以前这里直接 return，导致标志一旦置位就再没有人能把它清掉。
    if (transientUnavailable && !(await tryRecoverFromTransient())) return
    try {
      const resp: RawSyncResponse = await transport.pull()
      if (resp.status !== 200) return
      const remoteRev = resp.rev ?? 0
      if (remoteRev <= rev) return
      if (resp.enc) {
        const serverCache = await decryptObj(resp.enc)
        adoptCloudBackup(serverCache)
        cache = mergeCaches(baseCache, serverCache, cache)
        rev = remoteRev
        // 🔴 先判断合并结果与云端是否一致（不一致 = 本地有改动被保下来了），**再**认领新基线。
        //    顺序反过来的话，这批本地改动会被写进 baseCache，下次合并时被判成「本地未改」
        //    而静默采用云端版本 —— 改动无声消失，且走的是常规分支、不产生冲突副本。
        const drifted = !sameStores(cache, serverCache)
        baseCache = snapshotOf(cache)
        if (drifted) schedulePush()
        setStatus('ok')
      }
    } catch {
      /* 忽略，下次轮询重试 */
    }
  }

  // 推送（带 rev 守卫）。冲突(409)时合并云端版本（本地优先）后用最新 rev 重试。
  async function pushNowRaw(baseRev: number, depth = 0): Promise<{ conflict?: boolean }> {
    const uploadCache: Record<string, any> = liveStores(cache)
    // #027：防整库清空——本地缓存为空但存在已知良好基线时，绝不能用空库覆盖云端。
    // 🔴 用**记录总数**判（见 totalRecords 的说明），键数判法会被「12 个空数组」骗过去。
    if (totalRecords(uploadCache) === 0 && totalRecords(liveStores(baseCache)) > 0) {
      setStatus('error')
      throw new Error('refuse empty push: 本地缓存为空但基线非空，已阻止空推覆盖云端')
    }
    if (!cloudBackup || cloudBackup.day !== todayKey()) {
      cloudBackup = { day: todayKey(), ts: Date.now(), data: liveStores(cache) }
    }
    uploadCache.__cloudBackup = cloudBackup
    const enc = await encryptObj(uploadCache)
    let resp: RawSyncResponse
    try {
      resp = await transport.push(baseRev, enc)
    } catch {
      transientUnavailable = true
      setStatus('offline')
      throw new Error('sync push network error')
    }
    const r = resp.status
    if (r === 409) {
      const serverRev = resp.rev ?? baseRev
      let serverCache: Record<string, any[]> | null = null
      if (resp.enc) {
        try {
          serverCache = await decryptObj(resp.enc)
          adoptCloudBackup(serverCache)
        } catch {
          // 🔴 云端那版**解不开**时必须停下来：继续重试会用本地 cache 以 serverRev 覆盖它，
          //    而加密载荷只有云端那一份 —— 覆盖之后连 .corrupt 都没留，那版彻底消失。
          //    （原先把它当成「云端没内容」继续合并推送，是最危险的一条静默路径。）
          setStatus('error')
          throw new Error('sync conflict payload undecryptable: 已停止重试以免覆盖云端数据')
        }
      }
      if (serverCache) cache = mergeCaches(baseCache, serverCache, cache)
      rev = serverRev
      if (depth < MAX_CONFLICT_RETRY) {
        return pushNowRaw(serverRev, depth + 1)
      }
      return { conflict: true }
    }
    if (r === 401) {
      authFailed = true
      setStatus('auth-failed')
      throw new CloudAuthError()
    }
    if (r === 429) {
      const sec = 600
      rateLimitedUntil = Date.now() + sec * 1000
      setStatus('rate-limited')
      throw new RateLimitError(sec)
    }
    if (r === 413) {
      setStatus('too-large')
      throw new Error('sync payload too large')
    }
    if (r === 422) {
      setStatus('error')
      throw new Error('server refused empty push')
    }
    if (r === 0) {
      transientUnavailable = true
      setStatus('offline')
      throw new Error('sync push network error')
    }
    if (r === 200) {
      rev = resp.rev ?? baseRev + 1
      baseCache = snapshotOf(cache)
      setStatus('ok')
      return { conflict: false }
    }
    setStatus('error')
    throw new Error('sync push failed ' + r)
  }

  /**
   * 推送（**串行化入口**）。`baseRev` 可传函数 —— 排队期间 `rev` 可能已被前一次推送推进，
   * 执行时才取值，才不会拿着过期基线去撞 409。
   *
   * 🔴 为什么必须在**最底层**串行：`FileTransport.push` 是「读 rev → 写 baseRev+1」的
   *    **非原子序列**，两次同 baseRev 的并发写会互相覆盖、rev 不推进（两边都回 200），
   *    其中一份内容静默消失（审计 P1-7）。
   *    防抖路径（flushNow）本来有 `pushing` 守卫，但 `restoreFromCloudBackup` /
   *    `seedFromLocal` 是直接 `await pushNow()` 的、绕过了它；收口到这里之后，
   *    以后新增的推送入口也自动受保护。
   *    ⚠️ 409 重试必须调用 `pushNowRaw` —— 走 `pushNow` 会排到自己后面，直接死锁。
   */
  function pushNow(baseRev: number | (() => number)): Promise<{ conflict?: boolean }> {
    const run = () => pushNowRaw(typeof baseRev === 'function' ? baseRev() : baseRev)
    const next = pushChain.then(run, run)
    pushChain = next.catch(() => { /* 失败不阻断后续排队 */ })
    return next
  }

  async function flushNow(): Promise<void> {
    if (!code) return
    await ensureInit()
    // 🔴 闩锁期先试一次自愈（清掉记忆化的 init 再拉一次）。成功就落到下面的正常推送路径 ——
    //    只靠 fallbackHandler 兜底的话，标志永远清不掉：本地库会一直顶替云端，
    //    而下面的镜像又会用陈旧的 cache 覆盖本地的新记录（P0-2 静默回滚）。
    if (transientUnavailable && !authFailed) await tryRecoverFromTransient()
    if (authFailed || transientUnavailable) {
      // 🔴 推不出去的时刻：把内存 cache 交上层做本地兜底。
      //    云模式下这批改动只存在于内存 —— 关窗兜底写的是 desktopStore（不经过它），两边都没有。
      //    只在异常路径触发，不影响「云模式下普通 store 不写本地」的常态约定。
      //    ⚠️ 兜底方**必须按「只补缺失」写**，不能整体覆盖：闩锁期包装层已把读写切到本地库，
      //       用户的新编辑正躺在那里，而这里的 cache 是闩锁前的旧数据（见 db.ts 的镜像函数）。
      try { fallbackHandler?.(snapshotOf(cache)) } catch { /* 兜底失败不影响主流程 */ }
      return
    }
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null }
    if (pushing) { pendingPush = true; return }
    pushing = true
    setStatus('syncing')
    try {
      const r = await pushNow(() => rev)
      // 🔴 pushNow 在重试耗尽时**返回** {conflict:true} 而不抛 —— 不处理的话状态会一直停在
      //    'syncing'（界面转圈，实际一条都没传上去）。
      if (r?.conflict) setStatus('error')
    } catch (e) {
      if (!(e instanceof CloudAuthError) && !transientUnavailable) setStatus('error')
    } finally {
      pushing = false
      if (pendingPush) { pendingPush = false; schedulePush() }
    }
  }

  function schedulePush() {
    if (!code) return
    if (pushTimer) clearTimeout(pushTimer)
    pushTimer = setTimeout(() => {
      pushTimer = null
      void flushNow()
    }, SAVE_DEBOUNCE_MS)
  }

  function keyOf(store: string, value: any): unknown {
    return value?.[KEY_FIELD[store] ?? 'id']
  }

  const store: StoreOps = {
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

  /** 卸载落盘的监听只注册一次 —— 旧实现每次 configure 都加 3 个且从不注销，反复开关同步会不断累积 */
  let unloadArmed = false
  function armUnloadFlush() {
    if (typeof window === 'undefined' || unloadArmed) return
    unloadArmed = true
    const onHide = () => { if (document.visibilityState === 'hidden') void flushNow() }
    window.addEventListener('pagehide', () => void flushNow())
    window.addEventListener('beforeunload', () => void flushNow())
    document.addEventListener('visibilitychange', onHide)
  }

  return {
    store,
    configure(c: string) {
      code = c
      cache = {}
      rev = 0
      initPromise = null
      authFailed = false
      transientUnavailable = false
      rateLimitedUntil = 0
      baseCache = {}
      // 🔴 审计 2026-09-18（P2-1）：换目录时必须清掉**待执行的防抖推送**。旧计时器会在
      //    transport 已指向新目录之后才触发，而此刻 cache 已被清空 → 它会把一份空载荷
      //    当成「rev=0 的第一份」推上去（新目录凭空多出 rev=1），并把本该走
      //    「空则播种」的流程推进 409 冲突分支。
      // 🔴 同日换目录（P2-2）：cloudBackup 属于**上一个目录**；day 相同时 pushNow 里
      //    「day 变了才重建」的判断不成立 → 旧目录的备份被写进新目录载荷，
      //    作者点「从备份恢复」还会把旧目录的内容回灌进来。必须一起清掉。
      if (pushTimer) { clearTimeout(pushTimer); pushTimer = null }
      pendingPush = false
      cloudBackup = null
      setStatus('idle')
      transport.setCode(c)
      if (c) transport.startWatch(() => void backgroundPull())
      else transport.stopWatch()
      if (c) armUnloadFlush()
    },
    setTransport(t: SyncTransport) {
      if (transport) transport.stopWatch()
      transport = t
      if (code) transport.setCode(code)
    },
    pullSnapshot,
    seedFromLocal,
    getStatus: () => syncStatus,
    isCloudUnavailable: () => authFailed || transientUnavailable || Date.now() < rateLimitedUntil,
    isCloudAuthFailed: () => authFailed,
    getCloudBackupMeta,
    restoreFromCloudBackup,
    backgroundPull,
    onSyncConflict: (h) => onSyncConflict(h),
    onFallback: (h) => { fallbackHandler = h },
    armUnloadFlush,
    flushNow,
    getCacheSnapshot: () => snapshotOf(cache),
  }
}
