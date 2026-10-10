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
import { SAVE_DEBOUNCE_MS } from '@/lib/constants'

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
async function loadFromServer(): Promise<{ text?: string | null; error?: string | null; missing?: boolean; path?: string }> {
  try {
    const res = await fetch(apiBase() + '/api/data', { cache: 'no-store' })
    if (!res.ok) {
      // 404 = 数据文件尚不存在（首次使用），由服务显式返回，不是错误
      if (res.status === 404) return { text: null, missing: true, error: null }
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
  try {
    const r = await loadFromServer()
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
}

function scheduleSave() {
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
  emit()
  try {
    data.savedAt = Date.now()
    const res = await fetch(apiBase() + '/api/data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) {
      lastError = `写入便携数据文件失败：HTTP ${res.status}`
      return false
    }
    dirty = false
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
 * 关页前尽力写盘。浏览器里**没有同步阻塞写**（不像桌面版有 saveSync），
 * 故用 `navigator.sendBeacon`（在 pagehide 时仍能发出、不被取消）走一次 PUT。
 * 返回是否已发出（不代表服务已写完，但比什么都不做强）。
 */
export function flushPortableBeacon(): boolean {
  if (!PORTABLE || !inited || !dirty || writeLocked) return false
  if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return false
  try {
    data.savedAt = Date.now()
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' })
    const ok = navigator.sendBeacon(apiBase() + '/api/data', blob)
    if (ok) dirty = false
    return ok
  } catch {
    return false
  }
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

/**
 * 便携版 StoreOps。与 `desktopStore` 逐条对齐语义：
 *  · 读 = 内存 cache（启动时装载）；写 = 改 cache + 防抖落盘。
 *  · 锁写盘时不接受任何写（读仍可用）。
 */
export const portableStore: StoreOps = {
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
 * 整体替换内存数据（导入便携数据文件用）。
 * 🔴 导入 = 用这份文件替换本机全部数据 ⇒ 一次性解锁（与 `importDesktopData` 同口径）。
 */
export function replacePortableData(parsed: unknown): void {
  data = normalizePortableData(parsed)
  dirty = true
  if (writeLocked) unlockPortableWrite()
  void flushPortable()
}

/** 当前内存数据的 JSON 串（导出用） */
export function portableDataJSON(): string {
  data.savedAt = Date.now()
  return JSON.stringify(data)
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
export function exportPortableData(): { ok: boolean; fileName?: string; error?: string } {
  if (!PORTABLE) return { ok: false, error: '当前版本不支持导出数据文件（仅便携版可用）' }
  if (writeLocked) {
    const msg = '数据文件读取失败期间不导出（内存里是空库/残缺数据）：请先按顶部红条提示备份原文件，或解除锁定后再导出'
    lastError = msg
    emit()
    return { ok: false, error: msg }
  }
  try {
    const text = portableDataJSON()
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
    return { ok: true, fileName }
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
    return { ok: false, error: '这不是有效的小说工坊数据文件（请选择本软件导出的数据文件）' }
  }
  replacePortableData(parsed)
  const ok = await flushPortable()
  return ok ? { ok: true } : { ok: false, error: lastError || '写入便携数据文件失败' }
}

/** 弹原生「打开文件」对话框并读文本（浏览器版）；用户取消返回 null */
export function pickLocalFile(accept = '.json,application/json'): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = accept
      input.style.display = 'none'
      document.body.appendChild(input)
      input.addEventListener('change', () => {
        const f = input.files?.[0]
        input.remove()
        if (!f) { resolve(null); return }
        const fr = new FileReader()
        fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null)
        fr.onerror = () => resolve(null)
        fr.readAsText(f, 'utf-8')
      })
      // 用户关掉对话框不会触发 change ⇒ 无法可靠探测取消，交给调用方按 null 处理（resolve 由 change 或超时兜底）
      input.click()
    } catch {
      resolve(null)
    }
  })
}
