// ============ 便携版（U 盘自包含目录）存储引擎 ============
// 与桌面版 `app/desktop.ts` 的 `desktopStore` **同构**：内存 cache + 防抖写盘 + 原子写，
// 数据格式同为 `PortableData`（kind='portable-data'）—— 双端数据契约完全一致、可互导。
//
// 【与桌面版的唯一区别：数据怎么落盘】
//   · 桌面版：preload 注入 `window.electronStore`，走 **IPC** 写本机用户数据目录的 JSON 文件。
//   · 便携版：跑在**系统浏览器**里，没有主进程 ⇒ 浏览器里的 JS **不能直接写应用目录**
//     （IndexedDB 落在浏览器 profile，不跟随 U 盘；File System Access API 需用户手势 + 仅在 Chromium）。
//     故改由**本地 Node 服务**（`scripts/portable-server.mjs`）落盘到应用目录的 `./data`，
//     浏览器通过 HTTP（`/api/data` GET+PUT）读写 —— 这就是「同目录数据」诉求的唯一可行实现。
//
// 【为什么沿用整库 JSON + 防抖 + 原子写】
//   与桌面版同样的理由：U 盘小文件 IO、断电损坏。服务侧写盘一律「先写 .tmp 再 rename」。
//
// 🔴 便携模式判定（`PORTABLE`）由**服务注入的 `window.__YFE_PORTABLE__`** 决定 ——
//    服务在托管 `index.html` 前把这一行注入 <head>（见 portable-server.mjs）。
//    不用 UA / 端口启发式：那些都能被误判，而误判的后果是「读不到数据」或「数据落到别处」。
import type { StoreOps, PortableData } from '@/lib/storage/storeOps'
import { normalizePortableData, isPortableDataFile } from '@/lib/storage/storeOps'
import type { SidecarApi, SidecarSpec } from '@/lib/storage/sidecar'
import { withSidecar, migrateSidecar, collectSidecarForExport, registerSidecarApi } from '@/lib/storage/sidecar'
import { PORTABLE_FILE_VERSION, describeDataFileReject } from '@/lib/storage/storeOps'
import { SAVE_DEBOUNCE_MS } from '@/lib/constants'
// 导出数据文件前剥敏感 meta（AI 密钥 / 检索密钥）—— 与桌面版 exportDesktopData 同口径
import { stripSensitiveMeta } from '@/lib/storage/sensitiveMeta'

/** 服务注入到 window 的便携标记（见 portable-server.mjs 的注入注释） */
declare global {
  interface Window {
    __YFE_PORTABLE__?: { apiBase?: string } | true
  }
}

/**
 * 是否为便携版：由服务注入的标记决定。纯浏览器 dev（无注入）与桌面版都为 false。
 * ⚠️ 与 `desktop.ts` 的 `DESKTOP` 同口径：两个常量**互斥**，不会同时为 true
 * （桌面版 preload 不注入 __YFE_PORTABLE__；便携服务不注入 electronStore）。
 */
export const PORTABLE: boolean =
  typeof window !== 'undefined' && !!window.__YFE_PORTABLE__

/** 数据 API 基址（默认同源；服务注入 apiBase 时用它，便于将来反代） */
function apiBase(): string {
  const m = typeof window !== 'undefined' ? window.__YFE_PORTABLE__ : null
  if (m && typeof m === 'object' && typeof m.apiBase === 'string' && m.apiBase) return m.apiBase
  return ''
}

// ---------- 纯逻辑（可单测，不碰网络） ----------

/**
 * 各 store 的主键字段 —— 与 `syncCore.KEY_FIELD` / `app/desktop.KEY_PATHS` 同口径（三处一致）。
 *
 * 🔴 `vecRows` / `kbDocs` / `kbBodies` 是**便携版专属**（2026-10-10 方案 A）：
 *    桌面版把语义向量与参考资料放在**两个独立 IDB 库**（`-vec` / `-kb`）里，刻意不进整库 JSON；
 *    但便携版是 U 盘自包含、IDB 不跟盘走 ⇒ 这两库的数据必须并入整库 JSON 才能随盘携带。
 *    故便携版在运行时把两库后端**注入**成「读写这三个 store」（见 `storage/portableVecKb.ts`）。
 *    ⚠️ 桌面端的 `syncCore.KEY_FIELD` / `desktop.KEY_PATHS` **不该**加这三项 —— 它们不属于主库。
 */
export const PORTABLE_KEY_FIELDS: Record<string, string> = {
  projects: 'id', volumes: 'id', chapters: 'id', tableRows: 'id',
  cardRecords: 'id', snapshots: 'id', trash: 'id', backups: 'id', backupPayloads: 'id',
  formData: 'tabId', meta: 'key', dailyStats: 'key', settingsKV: 'key',
  tavernReports: 'id', aiRuns: 'id', worlds: 'id',
  // 3.2.0 · W2 修订任务与载荷（与 desktop.KEY_PATHS 逐项一致）
  revisionJobs: 'id', revisionPayloads: 'id',
  // ---- 便携版专属（语义检索 / 知识库并入整库，方案 A）----
  vecRows: 'id', kbDocs: 'id', kbBodies: 'id',
}

/**
 * 取某条记录的主键值（字符串化）。
 * @returns 主键字符串；记录为 null/undefined 或主键缺失时返回 ''（调用方应据此跳过该条）
 */
export function keyOfRecord(store: string, rec: unknown): string {
  if (rec == null) return ''
  const kf = PORTABLE_KEY_FIELDS[store] ?? 'id'
  const v = (rec as Record<string, unknown>)[kf]
  return v == null ? '' : String(v)
}

/**
 * 把一批记录 upsert 进某 store 的行数组（**不改入参**，返回新数组）。
 * 与 `desktopStore` 的 put/bulkPut 语义一致：同主键则替换、否则追加。
 * 🔴 主键缺失（keyOfRecord === ''）的记录**一律跳过**：无法定位主键的记录写进去只会污染数据
 *    （桌面版的 bulkPut 也隐含依赖主键存在，但那边是 store 级 put 不查；便携版显式挡掉更好）。
 */
export function upsertRows(store: string, rows: unknown[], incoming: unknown[]): unknown[] {
  const out = rows.slice()
  for (const rec of incoming) {
    const k = keyOfRecord(store, rec)
    if (!k) continue
    const i = out.findIndex(r => keyOfRecord(store, r) === k)
    if (i >= 0) out[i] = rec
    else out.push(rec)
  }
  return out
}

/** 从某 store 的行数组里删掉一批主键（不改入参，返回新数组）—— 按 store 的主键字段过滤 */
export function deleteRowsOf(store: string, rows: unknown[], keys: (string | number)[]): unknown[] {
  const set = new Set(keys.map(String))
  return rows.filter(r => !set.has(keyOfRecord(store, r)))
}

/** 按索引过滤（文件型后端退化为全量过滤，与 `StoreOps.getAllByIndex` 契约一致） */
export function filterByIndex<T>(rows: T[], indexName: string, value: unknown): T[] {
  return rows.filter(r => (r as Record<string, unknown>)?.[indexName] === value)
}

// ---------- 存储引擎 ----------

let data: PortableData = { app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 1, savedAt: 0, stores: {} }
let inited = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saving = false
let dirty = false
/**
 * 🔴 写入序号（2026-10-17 全量审计 P2，与 desktop.ts 同构）：
 *   PUT 期间作者继续输入时，`scheduleSave` 会把 dirty 置真，但写成功后无条件 `dirty = false`
 *   会把它吞掉（下一次定时器触发时 `saving` 为真、直接返回且不重排）⇒ 内存比磁盘新且无人知道。
 *   落盘只认「写入开始那一刻的版本」，成功后序号又变了就保持 dirty 并续排。
 */
let writeSeq = 0
let savedSeq = 0
let lastSavedAt = 0
let lastError = ''
let dataFilePath = ''
/**
 * 🔴 写盘锁定。与桌面版同一条红线：数据「读不出来」时内存里是空库，磁盘上可能躺着全部心血，
 *    任一次落盘都会不可逆覆盖。锁上之后一个字节都不许写。
 */
let writeLocked = false
let writeLockReason = ''

const listeners = new Set<() => void>()
export function subscribePortable(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
function emit() { listeners.forEach(fn => fn()) }

export interface PortableState {
  connected: boolean
  fileName: string
  dataPath: string
  dirty: boolean
  saving: boolean
  lastSavedAt: number
  lastError: string
  writeLocked: boolean
  writeLockReason: string
}

export function getPortableState(): PortableState {
  return {
    connected: inited, fileName: '便携数据文件', dataPath: dataFilePath, dirty, saving,
    lastSavedAt, lastError, writeLocked, writeLockReason,
  }
}

export function unlockPortableWrite(): void {
  writeLocked = false
  writeLockReason = ''
  lastError = ''
  emit()
}

/** 读一次数据文件（GET /api/data）；返回形状与桌面版 `DataFileLoadResult` 对齐 */
async function loadFromServer(): Promise<{ text?: string | null; error?: string | null; missing?: boolean; path?: string; needReauth?: boolean }> {
  try {
    const res = await fetch(apiBase() + '/api/data', { cache: 'no-store' })
    if (!res.ok) {
      // 404 = 数据文件尚不存在（首次使用），由服务显式返回，不是错误
      if (res.status === 404) return { text: null, missing: true, error: null }
      // 🔴 401 = 会话过期 / 未登录（WEB-08）。**绝不能**当成「读取失败」走 lock 分支：
      //    那会弹出「数据文件读取失败」的红条，把「请重新登录」这件简单的事伪装成数据事故。
      //    此时内存是空库，正确做法是回登录页 —— 重新登录后数据自然从服务端取回。
      if (res.status === 401) return { text: null, error: null, needReauth: true }
      return { text: null, error: `HTTP ${res.status}` }
    }
    const j = (await res.json()) as { text?: string | null; path?: string; missing?: boolean }
    return { text: j.text ?? null, path: j.path, missing: j.missing === true, error: null }
  } catch (e) {
    return { text: null, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 启动时装载数据（与桌面版 `initDesktopStore` 同构）。
 * 🔴 读不出来必须锁写盘（同 `decideDataFileLoad` 三条教训）。
 */
export async function initPortableStore(): Promise<void> {
  if (!PORTABLE || inited) return
  const lock = (why: string, msg: string) => { writeLocked = true; writeLockReason = why; lastError = msg }
  let loaded = false
  try {
    const r = await loadFromServer()
    // 会话过期：不锁写盘（重新登录后还要能存），但内存是空库 ⇒ 直接回登录页。
    // 放在最前面：锁写盘会挂上红条，而这件事只需要重新登录。
    if (r.needReauth) {
      location.replace('/login')
      return
    }
    dataFilePath = r.path ?? './data/youth-fantasy-engine-data.json'
    if (r.error) {
      lock(`数据文件读取失败：${r.error}`, `读取便携数据文件失败：${r.error}。为免用空库覆盖原文件，已暂停写入。`)
    } else if (r.missing) {
      // 首次使用：空库启动属正常，可以写
    } else if (!r.text || !r.text.trim()) {
      lock('数据文件存在但内容为空（可能上次写入被中断）', '便携数据文件为空。为免覆盖原文件，已暂停写入。')
    } else {
      try {
        const parsed: unknown = JSON.parse(r.text)
        if (!isPortableDataFile(parsed)) {
          lock('数据文件缺少本软件的格式标识（kind="portable-data"）',
            '便携数据文件不是本软件写出的（缺少格式标识）。为免覆盖它，已暂停写入。')
        } else {
          data = normalizePortableData(parsed)
          lastSavedAt = data.savedAt || Date.now()
          loaded = true
        }
      } catch {
        lock('数据文件内容不是有效的 JSON（可能被同步截断，或磁盘损坏）',
          '便携数据文件已损坏（JSON 解析失败）。为免覆盖原文件，已暂停写入。')
      }
    }
  } catch (e) {
    lock('读取数据文件时发生异常',
      `读取便携数据文件异常：${e instanceof Error ? e.message : String(e)}。为免覆盖原文件，已暂停写入。`)
  } finally {
    inited = true
    emit()
  }
  // 🔴 老库迁移必须放在 `inited = true` **之后**（2026-10-11 实机抓到）：
  //    `flushPortable` 开头有 `if (!inited || saving) return false` 的守卫，
  //    写在 try 块内时 inited 仍是 false ⇒ 迁出去的数据写了，主 JSON 却**一动不动**
  //    （fileVersion 不升、外置 store 还在），下次启动又迁一遍 —— 白做且看不出异常。
  if (loaded && !writeLocked) await migratePortableSidecar()
}

/**
 * 把主 JSON 里残留的外置数据迁到独立文件（老库升级，**幂等**）。
 *
 * 🔴 锁写盘期间**绝不迁**：那时内存里是空库/残缺数据，迁出去的是空壳，
 *    而老的主 JSON 随后会被覆盖 —— 那就是真丢稿，比不迁移糟得多。
 */
export async function migratePortableSidecar(): Promise<void> {
  if (writeLocked) return
  try {
    const r = await migrateSidecar(data, portableStore, PORTABLE_SIDECAR, async () => {
      data.fileVersion = PORTABLE_FILE_VERSION
      return flushPortable()
    })
    const total = Object.values(r.moved).reduce((a, b) => a + b, 0)
    if (total > 0) {
      console.log(`[portable] 已把 ${total} 条大块数据迁出为独立文件：`, r.moved)
    }
    if (r.failed.length) lastError = `部分大块数据迁移失败（下次启动会重试）：${r.failed.join('；')}`
  } catch (e) {
    lastError = '大块数据迁移失败：' + (e instanceof Error ? e.message : String(e))
  }
}

function scheduleSave() {
  writeSeq++
  dirty = true
  if (saveTimer != null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { saveTimer = null; void flushPortable() }, SAVE_DEBOUNCE_MS)
  emit()
}

/** 立即写盘（PUT /api/data）。锁定期直接返回 false。 */
export async function flushPortable(): Promise<boolean> {
  if (!inited || saving) return false
  if (writeLocked) return false
  saving = true
  // 写盘开始时的版本号：await 期间若又发生修改（writeSeq 递增），成功后不能清 dirty
  const seqAtStart = writeSeq
  emit()
  try {
    data.savedAt = Date.now()
    const res = await fetch(apiBase() + '/api/data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) {
      // 🔴 401 单独说清原因（WEB-08 / WEB-02 单会话）：只显示「写入失败 HTTP 401」的话，
      //    作者不知道要去重新登录，还会以为数据存坏了。
      //    服务端用 code 区分两种情形，前端必须说成两句不同的话 ——
      //    混成一句会让用户反复登录反复被踢，却完全看不出原因。
      if (res.status === 401) {
        let code = ''
        try { code = (await res.json() as { code?: string }).code || '' } catch { /* 读不到就按通用过期处理 */ }
        lastError = code === 'SESSION_REPLACED'
          ? '账号已在别处登录，本次会话已失效：未保存的改动有丢失风险，请重新登录'
          : '登录已过期：未保存的改动有丢失风险，请立即重新登录'
        return false
      }
      lastError = `写入便携数据文件失败：HTTP ${res.status}`
      return false
    }
    savedSeq = seqAtStart
    dirty = writeSeq !== savedSeq
    lastSavedAt = Date.now()
    lastError = ''
    return true
  } catch (e) {
    lastError = '写入便携数据文件失败：' + (e instanceof Error ? e.message : String(e))
    return false
  } finally {
    saving = false
    emit()
    if (dirty) scheduleSave()
  }
}

/**
 * 关页前尽力写盘 —— 走一次 PUT。返回**是否已发出**（不代表服务已写完）。
 *
 * 🔴 两条路都要有（2026-10-11 审计修复）：原先只有 `sendBeacon` 一条，而它**有载荷上限**
 *    （浏览器实现各不相同，几十 KB 起就可能直接返回 false）。便携版写的是**整库 JSON**，
 *    含正文、向量、备份载荷 —— 真实体量下 beacon 被拒不是"万一"，而是常态。
 *    ⇒ 失败时降级到**同步 XHR**：它在 `beforeunload` / `pagehide` 里仍能完成（浏览器会等它返回），
 *    且没有 beacon 的载荷限制。这是关闭页面前**最后也是唯一**的落盘机会。
 */
export function flushPortableBeacon(): boolean {
  if (!PORTABLE || !inited || !dirty || writeLocked) return false
  data.savedAt = Date.now()
  const text = JSON.stringify(data)

  // ① 首选：sendBeacon（pagehide 时仍被允许发出，不像普通 fetch 会被取消）
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      const ok = navigator.sendBeacon(apiBase() + '/api/data', new Blob([text], { type: 'application/json' }))
      if (ok) { savedSeq = writeSeq; dirty = writeSeq !== savedSeq; return true }
    } catch { /* 落到 ② */ }
  }

  // ② 兜底：同步 XHR（会阻塞到写完为止 —— 关页前夕这点阻塞是值得的）
  try {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', apiBase() + '/api/data', false) // false = 同步
    xhr.setRequestHeader('Content-Type', 'application/json')
    xhr.send(text)
    if (xhr.status >= 200 && xhr.status < 300) { savedSeq = writeSeq; dirty = writeSeq !== savedSeq; return true }
  } catch { /* 真写不出去，返回 false 交给调用方拦一道 */ }
  return false
}

/**
 * 关页钩子里该用的那个 —— 返回 **true 表示「可以安全离开」**。
 *
 * 🔴 为什么不直接用 `flushPortableBeacon`：它的返回值在「没有未保存内容」时也是 false
 *    （`!dirty` 提前返回），如果拿它去决定是否弹「确定要离开吗」，会**每次关页都误弹**。
 *    这里把三种情况归成"能走 / 不能走"：
 *      · 没有未保存内容 ⇒ 能走（true）
 *      · 写盘锁定期 ⇒ 能走（true）—— 作者已被顶部红条明确告知，不该再被浏览器弹窗拦一次
 *      · 有未保存内容且**两种手段都没写出去** ⇒ 不能走（false），让浏览器弹原生确认拦一道
 *
 * ⚠️ 调用方（`App.tsx`）只在 `beforeunload` 里用它决定是否 `preventDefault`；
 *    `pagehide` 里没法拦（页面已经在走了），只能尽力写。
 */
export function flushPortableOnLeave(): boolean {
  if (!PORTABLE || !inited) return true
  if (writeLocked) return true
  if (!dirty) return true
  return flushPortableBeacon()
}

// ---------- StoreOps 实现（镜像 desktopStore 的六个原语） ----------

/** 取某 store 的行数组（副本，避免外部直接改内存） */
function rowsOf(store: string): unknown[] {
  const s = data.stores[store]
  if (!s) return []
  return Array.isArray(s) ? s.slice() : Object.values(s)
}

/** 把行数组写回 store（**保持数组形态**，与 IDB getAll 的返回一致） */
function setRows(store: string, rows: unknown[]) {
  data.stores[store] = rows as never
  scheduleSave()
}

// ---------- 外置大块数据（sidecar）----------
//
// 【为什么挪出去】备份载荷每份是一个项目的整包正文，**写完就再也不变**，却躺在整库 JSON 里
//  ⇒ 作者每敲一个字都要重传上百 MB 没动过的历史（撞 512 MiB 上限 / 每次写盘都卡）。
//    向量与知识库同理：体量大、随编辑变化少。
//    挪出后主 JSON 只剩「真正在动的东西」，写盘体积降一个数量级。
//
// 🔴 布局选择（详见 storage/sidecar.ts 的注释）：
//     · backupPayloads → per-id：一份一个文件，写新备份不必重写全部历史
//     · vecRows / kbDocs / kbBodies → whole：整表一个文件。它们本来就是一次性全量加载，
//       若按条分片，一次 `getAllByIndex(projectId)` 就是数千次 HTTP —— 必然卡死。
export const PORTABLE_SIDECAR: SidecarSpec = {
  backupPayloads: { layout: 'per-id', keyField: 'id' },
  vecRows: { layout: 'whole', keyField: 'id' },
  kbDocs: { layout: 'whole', keyField: 'id' },
  kbBodies: { layout: 'whole', keyField: 'id' },
}

/** 外置通道的 HTTP 实现（对 `/api/blob`，见 portable-server.mjs） */
const httpSidecarApi: SidecarApi = {
  async read(store, id) {
    const res = await fetch(
      `${apiBase()}/api/blob?store=${encodeURIComponent(store)}&id=${encodeURIComponent(id)}`,
      { cache: 'no-store' },
    )
    if (res.status === 404) return undefined
    if (!res.ok) throw new Error(`外置载荷读取失败：HTTP ${res.status}`)
    const j = (await res.json()) as { value?: unknown }
    return j.value
  },
  async write(store, id, value) {
    try {
      const res = await fetch(
        `${apiBase()}/api/blob?store=${encodeURIComponent(store)}&id=${encodeURIComponent(id)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(value),
        },
      )
      return res.ok
    } catch {
      return false
    }
  },
  async remove(store, id) {
    try {
      const res = await fetch(
        `${apiBase()}/api/blob?store=${encodeURIComponent(store)}&id=${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      )
      return res.ok
    } catch {
      return false
    }
  },
  async listIds(store) {
    const res = await fetch(
      `${apiBase()}/api/blob/list?store=${encodeURIComponent(store)}`,
      { cache: 'no-store' },
    )
    if (!res.ok) throw new Error(`外置载荷目录读取失败：HTTP ${res.status}`)
    const j = (await res.json()) as { ids?: string[] }
    if (!Array.isArray(j.ids)) throw new Error('外置载荷目录响应无效')
    return j.ids
  },
}

let activeSidecarApi: SidecarApi = httpSidecarApi

/**
 * 测试注入点：把外置通道换成内存实现。
 *
 * 🔴 为什么要有它：Node 单测里**没有便携服务**，`httpSidecarApi` 的 fetch 必然失败
 *    ⇒ 所有走外置的 store 读出来全是空，测试会一片红却与真实逻辑无关。
 *    这里沿用项目既有的「后端注入」套路（`setVecBackend` / `setKbBackend` 就是这么做的），
 *    让单测能在不伪造 `PORTABLE`（const 绑定改不了）的前提下跑通全链路。
 */
export function setPortableSidecarApi(api: SidecarApi): void { activeSidecarApi = api }
/** 复位回 HTTP 实现（测试收尾用） */
export function resetPortableSidecarApi(): void { activeSidecarApi = httpSidecarApi }

/**
 * 🔴 必须是**代理**而不是直接把 `httpSidecarApi` 传进 `withSidecar`：
 *    `withSidecar` 只在模块级调用一次，直接传会把实现**固化**进闭包，
 *    之后 `setPortableSidecarApi` 就再也换不动了（这类"捕获了可变状态"的坑很隐蔽）。
 */
const sidecarProxy: SidecarApi = {
  read: (s, i) => activeSidecarApi.read(s, i),
  write: (s, i, v) => activeSidecarApi.write(s, i, v),
  remove: (s, i) => activeSidecarApi.remove(s, i),
  listIds: (s) => activeSidecarApi.listIds(s),
}

/** 原生的（未外置）便携 StoreOps：只管内存 cache + 防抖落盘 */
const basePortableStore: StoreOps = {
  async getAll<T>(store: string): Promise<T[]> {
    return rowsOf(store) as T[]
  },
  async get<T>(store: string, key: string): Promise<T | undefined> {
    const k = String(key)
    return rowsOf(store).find(r => keyOfRecord(store, r) === k) as T | undefined
  },
  async put(store: string, value: unknown) {
    if (writeLocked) return
    setRows(store, upsertRows(store, rowsOf(store), [value]))
  },
  async del(store: string, key: string) {
    if (writeLocked) return
    setRows(store, deleteRowsOf(store, rowsOf(store), [key]))
  },
  async getAllByIndex<T>(store: string, indexName: string, value: unknown): Promise<T[]> {
    return filterByIndex(rowsOf(store) as T[], indexName, value)
  },
  async bulkPut(store: string, values: unknown[]) {
    if (writeLocked || !values.length) return
    setRows(store, upsertRows(store, rowsOf(store), values))
  },
  async bulkDel(store: string, keys: (string | number)[]) {
    if (writeLocked || !keys.length) return
    setRows(store, deleteRowsOf(store, rowsOf(store), keys))
  },
}

/**
 * 便携版 StoreOps = 原生后端 + 外置路由。
 *  · 读 = 内存 cache（启动时装载）／外置文件；写 = 改 cache + 防抖落盘／写外置文件
 *  · 锁写盘时不接受任何写（读仍可用）
 *
 * 🔴 外置写失败要**看得见**：静默失败会让「备份列表在、恢复时说载荷缺失」，
 *    作者无从判断是没存还是丢了 ⇒ 接到 lastError + emit，与写盘失败同一条反馈通道。
 */
export const portableStore: StoreOps = withSidecar(
  basePortableStore,
  sidecarProxy,
  PORTABLE_SIDECAR,
  (msg) => { lastError = msg; emit() },
)
// 登记通道：业务层要「列外置 id」做孤儿对账（StoreOps 没有这个能力，且不该为拿 id 读全部内容）。
// 🔴 必须**只在便携模式下登记**：桌面版模块也会执行同一句，谁后加载谁生效 ——
//    无条件登记会让桌面端被便携端的通道顶掉（Node 单测里两个模块都会 import，实测已复现）。
if (PORTABLE) registerSidecarApi(sidecarProxy)

/**
 * 整体替换内存数据（导入便携数据文件用）。
 * 🔴 导入 = 用这份文件替换本机全部数据 ⇒ 一次性解锁（与 `importDesktopData` 同口径）。
 */
export function replacePortableData(parsed: unknown): void {
  data = normalizePortableData(parsed)
  dirty = true
  if (writeLocked) unlockPortableWrite()
  void flushPortable()
}

/**
 * 当前内存数据的 JSON 串（导出用）。
 *
 * 🔴 不改动内存里的 `data.savedAt`（2026-10-11 审计）：原先这里直接 `data.savedAt = Date.now()`，
 *    于是**一次纯读操作把「最后保存时间」改掉了** —— 导出的文件声称"保存于此刻"，
 *    但磁盘上并没有发生这一刻的写入（既没 `dirty=true` 也没触发写盘）。作者据此误以为
 *    「已经存好了」，实际那份数据只在浏览器下载目录里。
 *    ⇒ 时间戳写进**导出副本**，内存状态保持真实（= 上次真正落盘的时间）。
 */
export async function portableDataJSON(): Promise<string> {
  // 🔴 外置数据必须**内联回来**：否则导出的文件会静默丢掉全部备份载荷
  //    （列表还在、看起来正常，等要恢复时才说"载荷缺失"—— 最危险的失败形态）
  const inline = await collectSidecarForExport(portableStore, PORTABLE_SIDECAR)
  // 🔴 2026-10-13（社区反馈）：导出前剥掉敏感 meta（AI 密钥 / 检索密钥）——
  //    这份 JSON 就是给作者拷走 / 丢云盘的，与桌面版 exportDesktopData 同一取舍。
  //    ⚠️ stripSensitiveMeta 返回**新对象**，不会动内存里的 data。
  const { stores } = stripSensitiveMeta({ ...data.stores, ...inline })
  return JSON.stringify({
    ...data,
    savedAt: Date.now(),
    stores,
  })
}

// ---------- 便携版专属动作（导出 / 导入 / 打开数据文件夹） ----------
//
// 【为什么这些不能复用桌面版的同名函数】
//   桌面版靠 preload 的 `window.electronStore` 调**主进程**弹原生「保存 / 打开」对话框；
//   便携版跑在普通浏览器里，没有主进程 ⇒ 改用 Web 等价实现：
//     · 导出 = Blob + <a download>（浏览器下载，落到用户下载目录）
//     · 导入 = <input type="file">（浏览器选文件，读文本）
//     · 打开文件夹 = 浏览器做不到 ⇒ 退化为「把路径显示给用户，让他自己开」
//   🔴 这条正是 §9.5「依赖系统级安装的能力 → 便携版用 Web 等价实现或禁用」的落地。

/** 便携版数据文件的**目录**（拼给用户看；打不开就用它手动进） */
export function portableDataDir(): string {
  return dataFilePath ? dataFilePath.replace(/[\\/][^\\/]*$/, '') : './data'
}

/** 便携版数据文件完整路径 */
export function portableDataPath(): string {
  return dataFilePath
}

/**
 * 导出全部数据为一个 `.json` 文件（走浏览器下载）。
 * 🔴 锁写盘期间不导出：内存里是空库/残缺数据，导出的会是**看起来正常**的空备份，
 *    用户拿它当保险反而把真数据的位置占了（与 `exportDesktopData` 同口径）。
 */
export async function exportPortableData(): Promise<{
  ok: boolean
  fileName?: string
  error?: string
  /** 被剥掉的敏感 meta 键名（供 UI 如实告知作者）；空数组 = 本机没有需要剥的 */
  strippedSecrets?: string[]
}> {
  if (!PORTABLE) return { ok: false, error: '当前版本不支持导出数据文件（仅便携版可用）' }
  if (writeLocked) {
    const msg = '数据文件读取失败期间不导出（内存里是空库/残缺数据）：请先按顶部红条提示备份原文件，或解除锁定后再导出'
    lastError = msg
    emit()
    return { ok: false, error: msg }
  }
  try {
    // await：外置数据要一份份读回来内联（见 portableDataJSON 的注释）
    const text = await portableDataJSON()
    const d = new Date()
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
    const fileName = `youth-fantasy-engine-data-${stamp}.json`
    const blob = new Blob([text], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    // 稍后回收（立即 revoke 在部分浏览器会中断下载）
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    // 剥了哪些键：只读 `data.stores`（敏感 meta 全在这里，与 portableDataJSON 的剥离同源），
    // 不重复读外置载荷 —— 只为给界面一句如实提示，不值当再跑一次全量收集。
    const { removed } = stripSensitiveMeta(data.stores)
    return { ok: true, fileName, strippedSecrets: removed }
  } catch (e) {
    const msg = '导出失败：' + (e instanceof Error ? e.message : String(e))
    lastError = msg
    emit()
    return { ok: false, error: msg }
  }
}

/**
 * 从用户选择的文件导入（替换本机全部数据）。成功后调用方应刷新页面。
 * 校验口径与 `importDesktopData` 一致：空文件 / JSON 损坏 / 缺格式标识 都要挡。
 */
export async function importPortableData(
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!PORTABLE || !inited) return { ok: false, error: '便携存储未就绪' }
  if (!text.trim()) return { ok: false, error: '所选文件是空文件' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: '数据文件已损坏（JSON 解析失败）' }
  }
  if (!isPortableDataFile(parsed)) {
    // OPT-011：同桌面口径 —— 拿错文件（单本书备份）时给指路
    const guide = describeDataFileReject(parsed)
    return { ok: false, error: guide ?? '这不是有效的小说工坊数据文件（请选择本软件导出的数据文件）' }
  }
  replacePortableData(parsed)
  // 导入的文件里外置数据是**内联**的 ⇒ 拆开落盘（与老库升级同一条路径，幂等）
  await migratePortableSidecar()
  const ok = await flushPortable()
  return ok ? { ok: true } : { ok: false, error: lastError || '写入便携数据文件失败' }
}

/**
 * 🔴 选文件对话框的**兜底超时**：超过这个时长仍无结果就按「取消」处理。
 *    它不是"正常路径"，而是防「Promise 永远不 resolve」的保险丝 —— 详见 `pickLocalFile`。
 *    取 10 分钟：足够作者翻遍文件夹找备份，又不至于让界面无限期卡着。
 */
const PICK_FILE_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 弹原生「打开文件」对话框并读文本（浏览器版）；用户取消 / 读失败 / 超时都返回 null。
 *
 * 🔴 为什么必须显式处理「取消」（2026-10-11 审计修复）：
 *    原先只监听 `change` —— 用户**关掉**对话框不触发它，于是 Promise 永远 pending，
 *    `await pickLocalFile()` 永不返回。调用方 `Portable.tsx` 的 `doImport` 把 `setBusy(null)`
 *    写在 `finally` 里，await 不返回 ⇒ finally 永不执行 ⇒ 「导入」按钮**永久禁用**，
 *    作者只能刷新页面。原注释还写着「交给调用方按 null 处理（resolve 由 change 或超时兜底）」，
 *    但那份"超时兜底"根本不存在 —— 又是注释承诺 ≠ 实现。
 *
 *    修法两步：
 *    ① 监听 `cancel` 事件（现代浏览器在用户关闭文件对话框时触发，可靠且即时）；
 *    ② 加超时保险丝，覆盖「cancel 事件不支持 / 对话框被系统吞掉」的残余情况。
 *    两条都保证 `input.remove()`（不留隐藏 DOM）。
 */
export function pickLocalFile(accept = '.json,application/json'): Promise<string | null> {
  return new Promise((resolve) => {
    let input: HTMLInputElement | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let settled = false

    // 所有出口都走这里：保证只 resolve 一次、且一定把隐藏 input 摘掉
    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      if (timer != null) clearTimeout(timer)
      input?.remove()
      resolve(value)
    }

    try {
      input = document.createElement('input')
      input.type = 'file'
      input.accept = accept
      input.style.display = 'none'
      document.body.appendChild(input)

      input.addEventListener('change', () => {
        const f = input?.files?.[0]
        if (!f) { finish(null); return }
        const fr = new FileReader()
        fr.onload = () => finish(typeof fr.result === 'string' ? fr.result : null)
        fr.onerror = () => finish(null)
        fr.readAsText(f, 'utf-8')
      })
      // ① 用户关闭对话框：现代浏览器会发 cancel（不挂 change）
      input.addEventListener('cancel', () => finish(null))

      // ② 保险丝：任何原因导致上面两条都没触发时，也不能让 Promise 永远悬着
      timer = setTimeout(() => finish(null), PICK_FILE_TIMEOUT_MS)

      input.click()
    } catch {
      finish(null)
    }
  })
}
