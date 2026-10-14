// 云端同步核心（传输层无关）：加密 / 载荷结构 / rev 合并 / #030 空推防护 / 三路合并 / 状态机。
// 由 createCloudStore(transport) 产出一个完整的云端 StoreOps 实例。
//
// 设计要点：
//  - 本文件不关心「字节怎么落地」——那是 SyncTransport 的职责（HTTP / 本地文件）。
//  - 当前唯一使用方是 desktopCloudSync（File 传输，由云盘客户端搬运，无需服务器）。
//    ⚠️ 2026-09-15：网页版服务器同步（serverStore）已随「只做桌面版」的决定下线，
//      跨设备同步的唯一途径是**云盘文件**。本核心本身无平台假设，故原样保留。
//  - 加密：载荷用内置密钥派生加密（rev 保持明文以便做版本守卫）。
//    安全上下文(HTTPS/localhost)走 Web Crypto AES-GCM（真加密）；非安全上下文降级为 XOR 混淆。
import type { StoreOps } from '@/lib/storage/storeOps'
import {
  type SyncTransport,
  type RawSyncResponse,
} from '@/lib/sync/syncTransport'
import { SAVE_DEBOUNCE_MS } from '@/lib/constants'
import { todayKey } from '@/lib/app/date'
import { isDeleted, markDeleted, clearDeleted, resetTombs } from '@/lib/sync/syncTombstone'
// 🔴 WebCrypto 取用器放在**叶子模块**：syncTransport 也要用它，而从 syncCore 导出会让
//    syncTransport → syncCore 与本文件的 syncCore → syncTransport 凑成环（importCycles 会报红）。
import { webcrypto, hasWebCrypto } from '@/lib/storage/webcrypto'
// 敏感 meta 键清单（叶子模块）—— 云同步 / 数据文件导出 / 项目包导出三处共用一份判据
import { SENSITIVE_META_KEYS } from '@/lib/storage/sensitiveMeta'

// 对象库清单（与 db.ts 中对象库一致，作为对账依据）。
// ⚠️ 注意 'backups' / 'backupPayloads' 是**本地专属**（详见下方 LOCAL_ONLY_STORES）。
export const SYNC_STORES = [
  'projects', 'volumes', 'chapters', 'formData', 'tableRows', 'cardRecords',
  'meta', 'snapshots', 'dailyStats', 'settingsKV', 'trash', 'backups', 'backupPayloads', 'tavernReports',
  'aiRuns', 'worlds',
] as const

// 各 store 的主键字段（keyPath）
export const KEY_FIELD: Record<string, string> = {
  projects: 'id', volumes: 'id', chapters: 'id', tableRows: 'id',
  cardRecords: 'id', snapshots: 'id', trash: 'id', backups: 'id', backupPayloads: 'id', tavernReports: 'id',
  aiRuns: 'id', worlds: 'id',
  formData: 'tabId', meta: 'key', settingsKV: 'key', dailyStats: 'key',
}

/**
 * **本地专属 store**（云端永不参与其增删）—— 唯一判据，所有路径都从这里取。
 *
 * 🔴 为什么要收成一个常量（C2 · 2.4.2）：原先「backups 是本地专属」这件事被**写死在 6 处**
 *    （上传侧剔除 / 合并读取 / 播种跳过 / 落盘快照跳过 / 云包装层短路 ×2），
 *    每加一个本地专属 store 就要把这 6 处**一处不落地**找齐 —— 漏一处的后果是静默的：
 *    记录进了云端 cache 被上传，或本地写被挡在云端而刷新即丢。
 *    （2026-09-22 六维审计那条「同一个病的所有路径要一次找齐」就是这类。）
 *    ⇒ 现在新增本地专属 store 只需往这里加一个名字。
 */
export const LOCAL_ONLY_STORES = ['backups', 'backupPayloads'] as const
export function isLocalOnlyStore(store: string): boolean {
  return (LOCAL_ONLY_STORES as readonly string[]).includes(store)
}

// 不同步的敏感 meta（含密钥；UI 已承诺「仅本地保存，不上传」）
//
// 🔴 2026-09-22 六维审计 P1：加入 `app.search`。
//    检索设置里有搜索服务的 apiKey，而 UI 明确写着「存在本机数据文件里，**不会上传到任何服务器**」
//    （SearchSettingsPanel 密钥栏 hint）。但同步是**整条 key-value** 写出，没法只排除某个字段，
//    原来的排除表只挡了 AI 那三个键 ⇒ 开启云盘同步后检索密钥会随 `.yfe` 文件落到网盘。
//    与 `aiProviders` 完全同构：整条本地专属，换设备需要重填一次（安全上这是正确取舍）。
//
// 🔴 2026-10-13：清单**真源已下沉**到叶子模块 `lib/storage/sensitiveMeta.ts`。
//    原因：除云同步外，「导出数据文件」与「导出项目包」也要用同一份判据，而它们分属
//    storage / app / db 三层 —— 从本文件导出会让那几处反向依赖 sync 层，凑成 import 环
//    （tests/importCycles 会报红）。此处保留 re-export 只为不打断既有引用点。
export const EXCLUDED_META_KEYS = new Set<string>(SENSITIVE_META_KEYS)

export const CONFLICT_KEY_PREFIX = 'syncConflict:'

// ============ 同步层通用类型（2.3.0 · D7）============
// 为什么要有这一组别名：同步层原先散着 100+ 处 `any`，读的人分不清「这里真的什么都可能」
// 和「懒得写类型」。收窄到一处声明后，`any` 只剩在**真正无法静态描述**的边界（见各处的注释），
// 其余位置读字段得到 `unknown` —— 用之前必须显式收窄，正是我们要的摩擦力。

/**
 * 一条已落库记录。同步层**不关心**具体形状 —— 它只按主键（`id` / `key`）比对、搬运、判重。
 * 故用索引签名而非 `any`：读字段得 `unknown`，迫使调用点说清「我凭什么认为它是这个形状」。
 */
export type SyncRow = Record<string, unknown>
/** store 名 → 该 store 的记录数组。同步载荷（快照 / 缓存 / 备份 / 每日备份）统一是它。 */
export type SyncStores = Record<string, SyncRow[]>
/** 加密载荷解密后的形状：就是 store 快照本身，另挂一个可选的每日备份（#026）。 */
// 只在本文件内用（外部无引用）→ **不 export**：audit-dead 的「多余 export」清单是刻意压着的，
// 新增一个它就长一格，而那个清单一旦失控就再也看不出真正的死代码（见 skill 里的验尸率教训）
type SyncPayload = SyncStores & { __cloudBackup?: CloudBackup }


// #005 冲突处理器：两端都改过同一条记录时，把云端那版交给上层另存副本
let conflictHandler: ((info: SyncConflictInfo) => void) | null = null
export function onSyncConflict(h: (info: SyncConflictInfo) => void) {
  conflictHandler = h
}

/**
 * 「从云端备份恢复」**成功之后**的处理器：收到恢复结果，由上层镜像回本机数据文件。
 *
 * 🔴 为什么必须有它（2026-10-10 六维审计 P1）：云模式下本机数据文件是「开启同步那一刻的冻结快照」，
 *    会话内的编辑只进内存 cache。恢复完不镜像 ⇒ 界面随即 reload、`ensureInit` 会拿**冻结的旧文件**
 *    当三路合并的「本地那一份」，而 `baseCache` 启动即空 ⇒ 走「两端都改 → 本地优先」分支
 *    ⇒ **恢复被自己静默撤销**（界面还报「已从备份恢复」）。
 *
 * ⚠️ 走注册回调而不是本文件直接 import：`db/core.ts` 已经 import 本文件，反向 import 会成环
 *    （与上面的 conflictHandler、以及 desktopCloudSync 的 fallbackHandler 同一模式）。
 */
let cloudRestoreHandler: ((cache: SyncStores) => void | Promise<void>) | null = null

/** 注册「恢复成功后」的镜像钩子（由 `db/core.ts` 调用一次） */
export function onCloudRestored(h: (cache: SyncStores) => void | Promise<void>) {
  cloudRestoreHandler = h
}

/**
 * 「推不出去」时的兜底处理器：收到当前内存 cache，由上层负责落盘。
 * 见 createCloudStore().onFallback 与 flushNow() 的 blocked 分支。
 */
let fallbackHandler: ((cache: SyncStores) => void) | null = null

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
export function totalRecords(m: SyncStores): number {
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
  local: unknown
  server: unknown
  at: number
}

// #026/A+：云端每日滚动备份（最新一份，按自然日滚动）。
export type CloudBackup = { day: string; ts: number; data: SyncStores }
export type CloudBackupMeta = { day: string; ts: number }

/** 被服务端限流（429）——与网络异常区分 */
class RateLimitError extends Error {
  constructor(public retryAfter = 600) {
    super(`尝试过于频繁，请 ${Math.ceil(retryAfter / 60)} 分钟后再试`)
    this.name = 'RateLimitError'
  }
}

/** 同步凭据无效/已失效（服务端 401；服务器模式已下线，此分支为遗留路径）——与网络异常明确区分 */
export class CloudAuthError extends Error {
  constructor(msg = '同步凭据无效或已失效') {
    super(msg)
    this.name = 'CloudAuthError'
  }
}

// ============ 加密（载荷级，rev 保持明文） ============
// 探测逻辑已抽到 webcrypto.ts（syncTransport 也要判同一件事，不能各写一份）
const hasSubtle = hasWebCrypto
const SYNC_SALT = 'yfe-cloud-sync-v1'

function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    // 用 apply 而非展开：单块 32768 个参数，展开写法在部分引擎上会撞「参数过多」
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
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
  const subtle = webcrypto().subtle
  const material = await subtle.importKey('raw', enc.encode(c), 'PBKDF2', false, ['deriveKey'])
  return subtle.deriveKey(
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

function eqRecord(a: unknown, b: unknown): boolean {
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
function sameStores(a: SyncStores, b: SyncStores): boolean {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})])
  for (const k of keys) {
    const av = a?.[k] ?? []
    const bv = b?.[k] ?? []
    if (av.length !== bv.length) return false
    // 🔴 2026-09-22 六维审计 P1：主键必须走 `KEY_FIELD`，不能只认 `id ?? key`。
    //    本文件别处（830/842/852/861/878/890）都用 `KEY_FIELD[store] ?? 'id'`，只有这里手写 `id ?? key` ——
    //    `formData` 的主键是 **tabId**（见第 36 行），既没有 `id` 也没有 `key`，
    //    于是它的每一条都被映射成 `undefined`，Map 里互相覆盖只剩最后一条：
    //    formData ≥2 条时本函数**恒返回 false** ⇒ `backgroundPull` 恒判 drifted ⇒ `schedulePush`，
    //    两端都持有 formData 时会形成「收到即回推」的同步乒乓、rev 持续自增。
    const kf = KEY_FIELD[k] ?? 'id'
    const bm = new Map<unknown, SyncRow>(bv.map(r => [(r as SyncRow)?.[kf], r] as const))
    for (const r of av) {
      const other = bm.get((r as SyncRow)?.[kf])
      if (!other || !eqRecord(r, other)) return false
    }
  }
  return true
}

function snapshotOf(c: SyncStores): SyncStores {
  const out: SyncStores = {}
  for (const k of Object.keys(c || {})) out[k] = (c[k] || []).slice()
  return out
}

/**
 * 三路合并（base 基线 / server 云端 / local 本地）。
 * 与旧版「一律本地覆盖」的区别：只有云端改时采用云端；两端都改时才以本地为准，
 * 并把云端那版交给 conflictHandler 另存副本，用户可比对照恢复（#005）。
 */
function mergeCaches(
  base: SyncStores,
  server: SyncStores,
  local: SyncStores,
): SyncStores {
  const out: SyncStores = {}
  const stores = new Set([
    ...Object.keys(base || {}),
    ...Object.keys(server || {}),
    ...Object.keys(local || {}),
  ])
  /**
   * 「本地这份快照算不算一份有内容的库」。
   * 只有它非空时，才能把"本地没有这条记录"读成"本机删掉了它" —— 若整库为空
   * （新设备首同步 / 启动瞬间 cache 尚未建立），那只说明"还没拉下来"，必须采用云端。
   * 缺了这道闸，新设备首次同步会把云端数据整片丢掉。
   */
  const localHasContent = Object.keys(local || {}).some((k) => ((local || {})[k] || []).length > 0)

  for (const s of stores) {
    // #026：本地专属 store（backups / backupPayloads）云端永不参与其增删，一律以本机为准
    if (isLocalOnlyStore(s)) {
      out[s] = (local && local[s]) || []
      continue
    }
    const kf = KEY_FIELD[s] ?? 'id'
    const bMap = new Map<unknown, SyncRow>()
    const sMap = new Map<unknown, SyncRow>()
    const lMap = new Map<unknown, SyncRow>()
    for (const r of (base && base[s]) || []) if (r && r[kf] !== undefined) bMap.set(r[kf], r)
    for (const r of (server && server[s]) || []) if (r && r[kf] !== undefined) sMap.set(r[kf], r)
    for (const r of (local && local[s]) || []) if (r && r[kf] !== undefined) lMap.set(r[kf], r)

    const arr: SyncRow[] = []
    for (const k of new Set([...bMap.keys(), ...sMap.keys(), ...lMap.keys()])) {
      const b = bMap.get(k)
      const sv = sMap.get(k)
      const lo = lMap.get(k)
      const note = (localV: unknown, serverV: unknown) => {
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
          /**
           * 基线快照里也没有它 —— 「谁删的」只能靠**墓碑**（本机明确的删除记忆）来判断。
           * 🔴 这一步就是「幽灵项目」的修复点：旧实现一律判为「另一端新增」而采用云端，
           *    于是凡是云端还留着、而本机早已删掉的记录都会被搬回来（2026-09-19 实测）。
           * ⚠️ 必须同时满足 `localHasContent`（见其说明）—— 否则会丢掉整库云端数据。
           */
          if (localHasContent && isDeleted(s, k)) {
            continue // 本机删过 + 本地没有 + 云端有 → 尊重删除，不采用云端
          }
          arr.push(sv) // 没删过 + 云端有 → 另一端新增（或本地尚未拉取），采用云端
          continue
        }
        if (!eqRecord(sv, b)) {
          // 🔴 云端改过、而本机删过它（2026-09-23 六维审计）：这一支原先无条件采用云端，
          //    与上面那支（本地删过 + 本地没有 + 云端有）**不对称**，是第三条「删了会复活」路径 ——
          //    尊重删除，但把云端的改动记进冲突，作者在冲突面板里仍能捞回来。
          if (localHasContent && isDeleted(s, k)) {
            note(null, sv)
            continue
          }
          arr.push(sv)
          note(null, sv)
        }
        continue // 云端未改 → 尊重本地删除
      }

      // —— 云端没有这条记录 ——
      if (sv === undefined) {
        /**
         * 🔴 这一支同样要查墓碑（P0，2026-09-21 六维审计）—— 原先它完全没有墓碑判断，
         *    与上一支（本地没有、云端有）**不对称**，于是留下第二条「删了会复活」的路径：
         *
         *    云模式下**本机数据文件是「开启同步那一刻」的冻结快照**（此后读写都走 memory cache，
         *    见 db/core.ts 的 mirrorCloudCacheToLocal 说明）。于是
         *    「开着同步删掉某条 → 不关同步直接关窗重启」时，陈旧本地文件里那条**还在**：
         *    合并遇到 lo 有、sv 无 ⇒ 旧实现无条件 arr.push(lo) ⇒ 删除被撤销并回推云端（自锁）。
         *
         *    判据与上一支对齐：本机明确删过（墓碑）+ 本地确有内容（防空库误判）+ 本地那份没被改过。
         */
        if (localHasContent && isDeleted(s, k) && (b === undefined || eqRecord(lo, b))) continue
        if (b !== undefined && eqRecord(lo, b)) continue
        arr.push(lo)
        continue
      }

      if (eqRecord(lo, sv)) {
        /**
         * 🔴 两端一致也要查墓碑（2026-10-01 六维审计 P0）—— 这是「删了会复活」的**第四条**路径，
         *    判据必须与上面两支（本地没有 / 云端没有）口径一致：
         *
         *    云模式下本机数据文件是「开启同步那一刻」的冻结快照（见本函数上方那段说明）。
         *    某条记录 Y 在开启同步前就已存在（冻结文件里有它、云端也有它，**逐字相同**），
         *    开启同步后本机删掉 Y（`store.del` 记墓碑 + cache 移除），但这次 push **没成功**
         *    （断网 / 网盘占住同步目录 / 防抖窗口内关窗）。重启后 baseCache 为空（只活在内存），
         *    而 `lo`（冻结文件）与 `sv`（云端）都还留着 Y 且相等 ⇒ 原实现无条件 `arr.push(lo)`
         *    ⇒ 删除被撤销、还会被推回云端，此后每次启动稳定复现。
         *
         *    ⚠️ 为什么只有这一支会漏：另两支的 `lo`/`sv` 有一侧是 undefined，
         *      写「本地删过」的判断时很自然；而「两端一致」看着最无害，最容易被当成不需要判。
         */
        if (localHasContent && isDeleted(s, k)) continue // 本机删过 → 尊重删除，两端一致也不采用
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
  pullSnapshot(): Promise<{ rev: number; stores: SyncStores }>
  seedFromLocal(getAll: (store: string) => Promise<unknown[]>): Promise<void>
  getStatus(): SyncStatus
  isCloudUnavailable(): boolean
  isCloudAuthFailed(): boolean
  getCloudBackupMeta(): CloudBackupMeta | null
  restoreFromCloudBackup(): Promise<boolean>
  backgroundPull(): Promise<void>
  onSyncConflict(h: (info: SyncConflictInfo) => void): void
  /** 注册「推不出去时的本地兜底」：回调收到当前内存 cache（store 名 → 行数组）。
   *  云模式下写入先进内存、再推同步目录；推送被挡时若不兜底，关窗即丢。 */
  onFallback(h: (cache: SyncStores) => void): void
  /**
   * 注册「读本地库快照」的回调。`ensureInit` 启动合并时把它当三路合并的 `local` 路 ——
   * 用来区分「本机删掉了某记录」与「本机还没见过它（新设备 / 首次同步）」。
   * 不注册时退回只用内存 cache（保守：不会误删云端数据，但也治不了幽灵项目）。
   */
  onLocalSnapshot(h: () => Promise<SyncStores>): void
  armUnloadFlush(): void
  /** 立即把内存里未推送的改动推出去（不等防抖计时器）。关同步 / 关窗前调用。 */
  flushNow(): Promise<void>
  /** 当前内存 cache 的快照（store 名 → 行数组）。用于「关闭同步前把云端数据镜像进本地」。 */
  getCacheSnapshot(): SyncStores
}

const MAX_CONFLICT_RETRY = 5
const STATUS_EVENT = 'yfe:sync-status'

export function createCloudStore(initialTransport: SyncTransport): CloudStoreInstance {
  let code = ''
  let cache: SyncStores = {}
  let rev = 0
  let remoteVersion: string | undefined
  let pushTimer: ReturnType<typeof setTimeout> | null = null
  let pushing = false
  let pendingPush = false
  /** 已排队的推送链：保证任意两次推送**串行**执行（见 pushNow 的说明） */
  let pushChain: Promise<unknown> = Promise.resolve()
  let initPromise: Promise<void> | null = null
  let transport: SyncTransport = initialTransport

  let authFailed = false
  let transientUnavailable = false
  /**
   * 目录代际号：每次 `configure()`（换目录 / 重开同步）递增。
   * 🔴 用来丢弃「换目录期间在途的那次 push」的回写（2026-09-19 六维审计 P1-11）：
   *    它拿的是**旧目录**的 rev，写回来会让新目录的基线虚高，`backgroundPull` 的
   *    `remoteRev <= rev` 于是永久挡住拉取 —— 跨设备同步静默停摆，界面上看不出来。
   */
  let epoch = 0
  let rateLimitedUntil = 0
  let syncStatus: SyncStatus = 'idle'

  let cloudBackup: CloudBackup | null = null
  let baseCache: SyncStores = {}
  /** 「读本地库快照」的注入回调，见 CloudStoreInstance.onLocalSnapshot */
  let localSnapshotProvider: (() => Promise<SyncStores>) | null = null

  /**
   * 三路合并里「本地那一份」的**唯一来源**（L2 收口 · 2026-10-10 六维审计遗留项）。
   *
   * 为什么必须收口：`mergeCaches` 的第三路 `local` 决定两件事 ——
   *   ① `localHasContent`（能否把「本地没有这条」读成「本机删掉了它」）；
   *   ② 各 store 的 `lo` 取值。
   * 而云模式下**内存 cache 在首次 `ensureInit` 完成之前是空的**（启动瞬间）。
   * 只看它会得出 `localHasContent = false`、把整条墓碑闸短路 —— 正是「删了会复活 / 幽灵项目」那条链。
   * `localSnapshotProvider`（db 层注入）读的是磁盘上真正的本机库，才是那个窗口期里可信的「本地」。
   *
   * 返回 `null` ＝「注册了回调但读取失败」⇒ **本机状态未知**。调用方一律按「中止本次合并」处理
   * （绝不退化成空 cache 硬合），与 `ensureInit` 既有的 P2 处置同口径。
   * 未注册回调时退回内存 `cache`（保守侧：不误删云端，与收口前的行为一致）。
   */
  async function localForMerge(): Promise<SyncStores | null> {
    if (!localSnapshotProvider) return cache
    try {
      return await localSnapshotProvider()
    } catch {
      return null
    }
  }

  /**
   * 认领新基线（推送成功后调用）。
   * 墓碑不在这里维护 —— 它记录的是「删除事件」，由 store.put / store.del 各自维护。
   */
  function adoptBaseline() {
    baseCache = snapshotOf(cache)
  }

  function setStatus(s: SyncStatus) {
    if (syncStatus === s) return
    syncStatus = s
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: s }))
      } catch { /* 忽略事件派发失败 */ }
    }
  }

  // 仅含活数据（排除本地专属 store 与敏感 meta）
  function liveStores(src: SyncStores): SyncStores {
    const out: SyncStores = {}
    for (const s of Object.keys(src || {})) {
      if (isLocalOnlyStore(s)) continue
      out[s] = (src[s] || []).slice()
    }
    if (out.meta) out.meta = out.meta.filter((r) => !isExcludedMetaKey(r.key))
    return out
  }

  function adoptCloudBackup(obj: unknown) {
    // 形参是 unknown（解密出来的东西可能根本不是对象），故先断言成载荷形状再判存在性
    const o = obj as SyncPayload | null
    if (o && o.__cloudBackup) {
      cloudBackup = o.__cloudBackup
      delete o.__cloudBackup
    }
  }

  // 以下 4 个函数引用闭包内的 `code`，必须定义在工厂内部（createCloudStore 提供 `code` 作用域）。
  async function aesEncrypt(obj: unknown): Promise<string> {
    const iv = webcrypto().getRandomValues(new Uint8Array(12))
    const data = new TextEncoder().encode(JSON.stringify(obj))
    const buf = await webcrypto().subtle.encrypt({ name: 'AES-GCM', iv }, await deriveKey(code), data)
    const ct = new Uint8Array(buf)
    const combined = new Uint8Array(iv.length + ct.length)
    combined.set(iv, 0)
    combined.set(ct, iv.length)
    return 'a1:' + bytesToB64(combined)
  }
  async function aesDecrypt(s: string): Promise<SyncPayload> {
    const combined = b64ToBytes(s.slice(3))
    const iv = combined.subarray(0, 12)
    const data = combined.subarray(12)
    const buf = await webcrypto().subtle.decrypt({ name: 'AES-GCM', iv }, await deriveKey(code), data)
    return JSON.parse(new TextDecoder().decode(buf))
  }
  function xorObfuscate(obj: unknown): string {
    const data = new TextEncoder().encode(JSON.stringify(obj))
    const key = xorKeystream(code)
    const out = new Uint8Array(data.length)
    for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i & 255]
    return 'x1:' + bytesToB64(out)
  }
  function xorDeobfuscate(s: string): SyncPayload {
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
  async function decryptObj(s: string): Promise<SyncPayload> {
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
            remoteVersion = undefined
            return
          }
          if (r === 429) {
            const sec = 600
            rateLimitedUntil = Date.now() + sec * 1000
            setStatus('rate-limited')
            return
          }
          if (r === 200) {
            // 🔴 「读本机快照失败」必须在**推进 rev 之前**就中止本次拉取（2026-09-20 六维审计 P2）：
            //    ① 退化成 null ⇒ `local = cache`（启动时是空的）⇒ localHasContent=false
            //       ⇒ 墓碑闸被短路 —— 正是 P0 那条幽灵项目链路；
            //    ② 更不能"推进 rev 但不合并"：那样下次推送会拿**旧 cache** 当基线覆盖云端（丢数据）。
            //    本机状态未知时唯一安全的动作是：状态置 error、什么都不动、等下次远端变化再拉。
            // 🔴 L2 收口：本机那一份统一走 `localForMerge`（与 backgroundPull / 409 合并同源）。
            //    返回 null ＝注册了回调但读失败 ⇒ 本机状态未知，必须在**推进 rev 之前**中止本次拉取。
            let localSnapPre: SyncStores | null = null
            if (resp.enc) {
              localSnapPre = await localForMerge()
              if (localSnapPre === null) {
                setStatus('error')
                return
              }
            }
            rev = Number(resp.rev) || 0
            remoteVersion = resp.version
            if (resp.enc) {
              const serverCache = await decryptObj(resp.enc)
              adoptCloudBackup(serverCache)
              // 🔴 不能写成 `cache = serverCache` 直接整体替换（2026-09-19 老大实测）：
              //    那样等于把内存数据整片换成云端那一版 —— 启动后界面会先显示**旧状态**，
              //    本地早已删掉的记录也会被云端那份顺手带回来。
              //    改走同一套三路合并，并且把**本地库**当成 `local` 路：云模式下内存 cache
              //    此刻通常是空的，只看它无法区分"本机删了这条"和"还没拉下来"，
              //    而这两种判反的代价并不对称（误判成删除会丢云端数据，误判成新增会让删掉的项目复活）。
              // 本机实况已在上面取过一次（失败就在这里之前中止了）—— 复用，不再重复调用
              cache = mergeCaches(baseCache, serverCache, localSnapPre ?? cache)
            } else if (totalRecords(liveStores(baseCache)) > 0) {
              // 🔴 2.4.4 六维审计 P1：200 + 空载荷（.yfe 被网盘客户端截断/缺失时 parseRev 会当成空库）
              //    绝不能把 cache/baseCache 清成空 —— 中途自愈路径（tryRecoverFromTransient 重入
              //    ensureInit）没有启动路径那道 totalRecords 空库守卫：清空后 adoptBaseline 会把
              //    baseCache 一并归零，空推守卫随之失效，未推送改动全部蒸发、空载荷成为云端新基线。
              //    「另一端合法清空」会被那端的空推守卫拦下，走不到这里 ⇒ enc 为空且本机有基线
              //    只可能是异常，按读失败处理（走下面的 catch：状态 offline、cache 原样保留）。
              throw new Error('sync pull returned empty payload while local baseline is non-empty')
            } else {
              cache = {}
            }
            authFailed = false
            transientUnavailable = false
            // 🔴 自愈成功要把状态拨回 'ok'（2026-09-19 六维审计 P2-5）：`ensureInit` 是闩锁自愈的
            //    唯一通道，只清标志不报状态时界面会一直显示「离线」—— 而 `backgroundPull` 只在
            //    「远端有更新」时才置 ok，无更新时直接 return，永远轮不到它复位。
            setStatus('ok')
            adoptBaseline()
            return
          }
          if (r === 0) throw new Error('sync pull network error')
          throw new Error('sync pull failed ' + r)
        } catch {
          transientUnavailable = true
          setStatus('offline')
          initPromise = null
          /**
           * 🔴 拉取失败**不要清空 cache**（P1，2026-09-21 六维审计）。
           *
           *    清空只应发生在「本次会话从未成功拉取过」时 —— 而那种情况下 cache 本来就是空的，
           *    所以这里的清空动作**只对"曾经拉取成功过"的情况生效**，恰好是最不该清的那种：
           *    随后 `fallbackHandler(snapshotOf(cache))` 会拿到**空快照**，
           *    于是 `mirrorCloudCacheToLocal({}, false)` 什么都不写 ——
           *    兜底链条（闩锁期把 cache 镜像回本地、保住未推送的改动）被上游这一步无声抵消。
           *
           *    保留旧 cache 是更安全的一侧：本项目的红线是「绝不返回空库，否则 push 覆盖云端」。
           */
          return
        }
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
  async function pullSnapshot(): Promise<{ rev: number; stores: SyncStores }> {
    await ensureInit()
    if (authFailed) throw new CloudAuthError()
    // 🔴 拉取失败时必须**抛**，不能返回 `{rev:0, stores:{}}`（2026-09-19 六维审计 P1-7）：
    //    那个空快照与「云端确实是空库」在返回值上完全一样，调用方只能猜 ——
    //    db.ts 猜成「空库」→ 清掉「已开启」标记 → 同步被**静默关掉**（界面上看不出来）。
    if (transientUnavailable) throw new Error('云端暂不可用（网盘未就绪 / 同步目录被占用）')
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
    // 🔴 2026-10-02 六维审计 P2：这条路径直接给 cache 赋值，**绕过了 put / bulkPut 的 clearDeleted** ——
    //    本机删过（有墓碑）、而备份里还留着的那条记录，恢复后会在下一次 backgroundPull 的三路合并里
    //    被判「本机删过」而 continue 丢弃 → drifted 回推 → **恢复被静默撤销**（与墓碑家族同根）。
    //    恢复本就是从检查点整体回滚（作者显式动作），语义上等于「把这些记录请回来」⇒ 一并清墓碑。
    for (const [store, rows] of Object.entries(restored)) {
      const kf = KEY_FIELD[store] ?? 'id'
      clearDeleted(store, rows.map(r => r?.[kf]))
    }
    adoptBaseline()
    const r = await pushNow(() => rev)
    // 🔴 pushNow 在重试耗尽时是**返回** `{conflict:true}` 而不是抛（2026-09-20 六维审计 P2）：
    //    忽略它 ⇒ 函数照旧 `return true` ⇒ 界面报「已从备份恢复」，而云端其实一个字都没变，
    //    下次拉取又会把 cache 覆盖回去 —— 作者以为恢复成功了，白忙一场。
    if (r?.conflict) {
      setStatus('error')
      return false
    }
    // 🔴 恢复成功后把结果**镜像回本机数据文件**（2026-10-10 六维审计 P1）：
    //    不镜像的话，界面接着 reload、三路合并会拿「冻结的旧本机文件」当本地那一份、
    //    按「本地优先」把恢复结果盖回去 —— 恢复被静默撤销。实现由 db 层注册（避免反向 import 成环）。
    await cloudRestoreHandler?.(restored)
    return true
  }

  /** 用本地数据播种（仅当远端为空时调用）。 */
  async function seedFromLocal(getAll: (store: string) => Promise<unknown[]>) {
    // 🔴 审计 2026-09-18（P2-3）：逐 store 读失败**绝不能静默当空**继续播种。
    //    残缺载荷一旦推上去就成了新基线，另一台设备 mergeCaches 时按「云端没有该记录、
    //    本地也没改过」丢弃那些记录 —— 真实数据在**两端一起消失**。
    //    所以先读到临时对象、全部成功才提交；有任何失败就中止（界面报错，下次再播）。
    const next: SyncStores = {}
    const failed: string[] = []
    for (const s of SYNC_STORES) {
      // 本地专属 store（backups / backupPayloads，判据见 LOCAL_ONLY_STORES）：
      // 上传侧 liveStores 会剔除它们，读取侧 db/core.ts 的包装层也把读写短路到本地 store
      // ——读进 cache 没有任何下游消费者，纯属无用功。
      // 而备份体量不小（每份是一整份项目副本，最多 30 份滚动），播种时白读一次的代价真实可感。
      if (isLocalOnlyStore(s)) continue
      try {
        // StoreOps.getAll 的签名是 Promise<unknown[]>（各业务域的记录类型），
        // 落进同步通用 cache 前断言成 SyncRow[] —— 形状由写入方（put/bulkPut）保证
        next[s] = ((await getAll(s)) || []) as SyncRow[]
      } catch {
        failed.push(s)
      }
    }
    if (failed.length) {
      throw new Error(`播种失败：读取本地数据出错（${failed.join('、')}），已中止以免把残缺数据推上云端`)
    }
    if (next['meta']) {
      next['meta'] = next['meta'].filter((r) => !isExcludedMetaKey(r.key))
    }
    cache = next
    const r = await pushNow(0)
    // 🔴 同上：播种推送没成功就必须抛，否则调用方以为「已用本地数据播种」，
    //    而云端仍是空的 / 旧的 —— 下次另一台设备同步会把这份"播种"当成不存在。
    if (r?.conflict) {
      setStatus('error')
      throw new Error('播种未能推送到云端（并发更新重试已用尽），请稍后重试')
    }
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
      const remoteVersionChanged = resp.version !== remoteVersion
      if (remoteRev < rev || (remoteRev === rev && !remoteVersionChanged)) return
      if (resp.enc) {
        const serverCache = await decryptObj(resp.enc)
        adoptCloudBackup(serverCache)
        // 🔴 L2 收口：本地那一份必须走 `localForMerge` —— 首次 ensureInit 之前内存 cache 是空的，
        //    只看它会判 `localHasContent=false`、把墓碑闸短路（幽灵项目链路）。
        //    本机状态未知（null）⇒ 中止本次拉取且**不推进 rev**，留给下次轮询重试。
        const local = await localForMerge()
        if (local === null) return
        cache = mergeCaches(baseCache, serverCache, local)
        rev = remoteRev
        remoteVersion = resp.version
        // 🔴 先判断合并结果与云端是否一致（不一致 = 本地有改动被保下来了），**再**认领新基线。
        //    顺序反过来的话，这批本地改动会被写进 baseCache，下次合并时被判成「本地未改」
        //    而静默采用云端版本 —— 改动无声消失，且走的是常规分支、不产生冲突副本。
        const drifted = !sameStores(cache, serverCache)
        adoptBaseline()
        if (drifted) schedulePush()
        setStatus('ok')
      }
    } catch {
      /* 忽略，下次轮询重试 */
    }
  }

  // 推送（带 rev 守卫）。冲突(409)时合并云端版本（本地优先）后用最新 rev 重试。
  async function pushNowRaw(baseRev: number, depth = 0): Promise<{ conflict?: boolean }> {
    // 记下这次 push 属于哪一代目录（见 epoch 的说明）
    const myEpoch = epoch
    const uploadCache: SyncPayload = liveStores(cache)
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
      resp = await transport.push(baseRev, enc, remoteVersion)
    } catch {
      transientUnavailable = true
      setStatus('offline')
      throw new Error('sync push network error')
    }
    const r = resp.status
    if (r === 409) {
      const serverRev = resp.rev ?? baseRev
      if (serverRev > 0 && !resp.enc) {
        setStatus('error')
        throw new Error('sync conflict payload missing: 已停止重试以免覆盖云端数据')
      }
      let serverCache: SyncStores | null = null
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
      if (serverCache) {
        // 🔴 L2 收口：同源。本机状态未知 ⇒ 停手报错，绝不拿空 cache 硬合
        //    （那会把云端整片当「本地没见过」而采用，本地改动全丢）。
        const local = await localForMerge()
        if (local === null) {
          setStatus('error')
          throw new Error('sync conflict merge aborted: 本机状态读取失败，已停止重试以免误合丢数据')
        }
        cache = mergeCaches(baseCache, serverCache, local)
      }
      rev = serverRev
      remoteVersion = resp.version
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
      // 🔴 换目录期间在途的那次 push 不回写（2026-09-19 六维审计 P1-11）：它拿的是**旧目录**
      //    的 rev，写回来会让新目录基线虚高 → `backgroundPull` 的 `remoteRev <= rev` 永久挡住
      //    拉取。丢弃结果即可，新一轮 push 会重新建立基线。
      if (myEpoch !== epoch) return { conflict: false }
      rev = resp.rev ?? baseRev + 1
      remoteVersion = resp.version
      adoptBaseline()
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
      //       用户的新编辑正躺在那里，而这里的 cache 是闩锁前的旧数据（见 db/core.ts 的镜像函数）。
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

  function keyOf(store: string, value: unknown): unknown {
    return (value as SyncRow | undefined)?.[KEY_FIELD[store] ?? 'id']
  }

  const store: StoreOps = {
    getAll: async <T,>(store: string): Promise<T[]> => {
      await ensureInit()
      // cast 是「边界断言」：cache 里存的是各业务域的具体记录（Project/Chapter/…），
      // 与 StoreOps 的泛型签名对齐只能靠它 —— 形状由写入方（put/bulkPut）保证。
      return (cache[store] || []).map((x) => ({ ...x })) as unknown as T[]
    },
    get: async <T,>(store: string, key: string): Promise<T | undefined> => {
      await ensureInit()
      const kf = KEY_FIELD[store] ?? 'id'
      return (cache[store] || []).find((x) => x[kf] === key) as unknown as T | undefined
    },
    put: async (store: string, value: unknown) => {
      await ensureInit()
      const arr = cache[store] || (cache[store] = [])
      // StoreOps 的入参在类型上是 unknown（各业务域传进来的是自己的记录类型），
      // 同步层只按主键搬运、不做形状校验 —— 这里断言成 SyncRow 存进通用 cache
      const rec = value as SyncRow
      const k = keyOf(store, rec)
      const i = arr.findIndex((x) => x[KEY_FIELD[store] ?? 'id'] === k)
      if (i >= 0) arr[i] = rec
      else arr.push(rec)
      // 🔴 写回同 key 的记录 → 清掉它的墓碑，允许「删掉之后又重建」（从项目备份导入等）
      clearDeleted(store, [String(k)])
      schedulePush()
    },
    del: async (store: string, key: string) => {
      await ensureInit()
      const kf = KEY_FIELD[store] ?? 'id'
      cache[store] = (cache[store] || []).filter((x) => x[kf] !== key)
      // 🔴 记墓碑：这是「本机明确删过它」的唯一凭据。没有它，云端那份旧记录会在下次启动
      //    合并时被判成「另一端新增」而搬回来（幽灵项目，2026-09-19 实测）。
      //    meta 不记 —— 那是配置/开关，删了就是删了，不需要跨启动的删除记忆。
      if (store !== 'meta') markDeleted(store, [key])
      schedulePush()
    },
    getAllByIndex: async <T,>(store: string, indexName: string, value: unknown): Promise<T[]> => {
      await ensureInit()
      return (cache[store] || [])
        .filter((x) => x[indexName] === value)
        .map((x) => ({ ...x })) as unknown as T[]
    },
    bulkPut: async (store: string, values: SyncRow[]) => {
      await ensureInit()
      const arr = cache[store] || (cache[store] = [])
      const kf = KEY_FIELD[store] ?? 'id'
      for (const v of values) {
        const k = v?.[kf]
        const i = arr.findIndex((x) => x[kf] === k)
        if (i >= 0) arr[i] = v
        else arr.push(v)
      }
      clearDeleted(store, values.map(v => v?.[kf]))
      schedulePush()
    },
    bulkDel: async (store: string, keys: string[]) => {
      await ensureInit()
      const kf = KEY_FIELD[store] ?? 'id'
      // Set 的元素类型用 unknown：x[kf] 是 unknown，若 Set<string> 则 has() 不接受
      const set = new Set<unknown>(keys)
      cache[store] = (cache[store] || []).filter((x) => !set.has(x[kf]))
      if (store !== 'meta') markDeleted(store, keys)
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
      epoch++ // 换目录 → 作废在途 push 的回写（见 epoch 的说明）
      cache = {}
      rev = 0
      remoteVersion = undefined
      initPromise = null
      authFailed = false
      transientUnavailable = false
      rateLimitedUntil = 0
      baseCache = {}
      // 关闭同步（code 传空）→ 忘掉「曾存在过」历史，下次开启视为全新云端；
      // 换目录则**保留** —— 同一批项目的 id 不变，保留才能继续识别「本地删除」。
      // 关闭同步（code 传空）→ 忘掉删除记忆，下次开启视为全新云端；
      // 换目录则**保留** —— 同一批记录的 id 不变，保留才能继续挡住已删记录的复活。
      if (!c) resetTombs()
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
    onLocalSnapshot: (h) => { localSnapshotProvider = h },
    armUnloadFlush,
    flushNow,
    getCacheSnapshot: () => snapshotOf(cache),
  }
}
