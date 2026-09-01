// 桌面（Electron 安装版）存储引擎
// 数据以单个 JSON 文件保存在本机用户数据目录
// （Windows: C:\Users\<用户>\AppData\Roaming\青春幻想引擎\novel-studio-data.json），
// 通过 preload 注入的 window.electronStore IPC 读写。
//
// 数据格式与便携（U 盘）版完全一致（PortableData）：
// - 桌面版「导出数据文件」存到 U 盘 → 便携版「打开数据文件」直接继续创作
// - 便携版数据文件 → 桌面版「导入数据文件」替换本机数据
import type { StoreOps, PortableData } from './portable'
import { normalizePortableData } from './portable'

/** preload 注入的 IPC 接口结构（仅桌面版存在） */
export interface ElectronStoreAPI {
  load(): Promise<{ text: string | null; path: string; error: string | null }>
  save(text: string): Promise<{ ok: boolean; error: string | null }>
  saveSync(text: string): unknown
  exportFile(text: string): Promise<string | null>
  importFile(): Promise<string | null>
  revealDataFile(): Promise<void>
  dataPath(): Promise<string>
  /** 数据文件是否已被改到自定义位置 */
  isCustomPath(): Promise<boolean>
  /** 选择数据文件的新存放位置，返回完整文件路径或 null（取消） */
  chooseDataDir(): Promise<string | null>
  /** 迁移数据文件到新位置；adopted=目标已有数据文件、改用那份 */
  setDataPath(target: string, text: string): Promise<{ ok: boolean; path: string; adopted: boolean; error: string | null }>
  /** 恢复默认存放位置 */
  resetDataPath(text: string): Promise<{ ok: boolean; path: string; adopted: boolean; error: string | null }>
}

declare global {
  interface Window {
    electronStore?: ElectronStoreAPI
  }
}

/** 是否为桌面（Electron 安装）版本：由 preload 是否注入 electronStore 决定 */
export const DESKTOP: boolean =
  typeof window !== 'undefined' && typeof window.electronStore === 'object' && window.electronStore !== null

function api(): ElectronStoreAPI {
  return window.electronStore as ElectronStoreAPI
}

// ---- 与便携版一致的主键映射（store 名 -> 记录主键字段名）----
const KEY_PATHS: Record<string, string> = {
  projects: 'id', volumes: 'id', chapters: 'id', tableRows: 'id',
  cardRecords: 'id', snapshots: 'id', trash: 'id',
  formData: 'tabId', meta: 'key', dailyStats: 'key', settingsKV: 'key',
}

export interface DesktopState {
  connected: boolean
  fileName: string
  dirty: boolean
  saving: boolean
  lastSavedAt: number
  lastError: string
  dataPath: string
  /** 数据文件是否已改到自定义位置（区别于默认的 userData 目录） */
  isCustomPath: boolean
}

let data: PortableData = { app: 'novel-studio', kind: 'portable-data', fileVersion: 1, savedAt: 0, stores: {} }
let inited = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saving = false
let dirty = false
let lastSavedAt = 0
let lastError = ''
let dataFilePath = ''
let isCustomPath = false

const listeners = new Set<() => void>()

/** 订阅状态变化（保存完成 / 出错），返回取消订阅函数 */
export function subscribeDesktop(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function emit() { listeners.forEach(fn => fn()) }

export function getDesktopState(): DesktopState {
  return {
    connected: inited, fileName: '本地数据文件', dirty, saving,
    lastSavedAt, lastError, dataPath: dataFilePath, isCustomPath,
  }
}

/** 应用启动时调用：从本地用户数据目录读取数据文件（首次使用时文件不存在，视作空库） */
export async function initDesktopStore(): Promise<void> {
  if (!DESKTOP || inited) return
  try {
    const r = await api().load()
    dataFilePath = r.path
    try {
      isCustomPath = (await api().isCustomPath()) === true
    } catch {
      isCustomPath = false
    }
    if (r.error) {
      lastError = '读取本地数据文件失败：' + r.error
    } else if (r.text && r.text.trim()) {
      try {
        data = normalizePortableData(JSON.parse(r.text))
        lastSavedAt = data.savedAt || Date.now()
      } catch {
        lastError = '本地数据文件已损坏（JSON 解析失败），将以空库启动，原文件不会被覆盖'
      }
    }
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
  } finally {
    inited = true
    emit()
  }
}

/** 数据变更后安排一次防抖写盘（800ms 内的连续修改合并为一次写入） */
function scheduleSave() {
  dirty = true
  if (saveTimer != null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { saveTimer = null; void flushDesktop() }, 800)
  emit()
}

/** 立即写盘（手动保存 / 导入后调用） */
export async function flushDesktop(): Promise<boolean> {
  if (!inited || saving) return false
  saving = true
  emit()
  try {
    data.savedAt = Date.now()
    const r = await api().save(JSON.stringify(data))
    if (!r.ok) {
      lastError = '写入本地数据文件失败：' + (r.error ?? '未知错误')
      return false
    }
    dirty = false
    lastSavedAt = Date.now()
    lastError = ''
    return true
  } finally {
    saving = false
    emit()
    if (dirty) scheduleSave()
  }
}

/** 窗口关闭前同步写盘（beforeunload 中调用，阻塞式保证写入完成） */
export function flushDesktopSync(): void {
  if (!DESKTOP || !inited || (!dirty && !saving)) return
  data.savedAt = Date.now()
  try {
    api().saveSync(JSON.stringify(data))
    dirty = false
  } catch {
    /* 同步写失败时无从提示，保留 dirty 供下次启动补救 */
  }
}

/** 导出全部数据为便携版数据文件（保存到 U 盘等任意位置，便携版可直接打开使用） */
export async function exportDesktopData(): Promise<string | null> {
  if (!DESKTOP || !inited) return null
  data.savedAt = Date.now()
  try {
    return await api().exportFile(JSON.stringify(data))
  } catch (e) {
    lastError = '导出失败：' + (e instanceof Error ? e.message : String(e))
    emit()
    return null
  }
}

/** 从便携版数据文件导入：校验并替换本机全部数据。成功后应刷新页面重新加载 */
export async function importDesktopData(): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> {
  if (!DESKTOP || !inited) return { ok: false, error: '桌面存储未就绪' }
  let text: string | null = null
  try {
    text = await api().importFile()
  } catch (e) {
    return { ok: false, error: '读取所选文件失败：' + (e instanceof Error ? e.message : String(e)) }
  }
  if (text == null) return { ok: false, cancelled: true }
  if (!text.trim()) return { ok: false, error: '所选文件是空文件' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: '数据文件已损坏（JSON 解析失败）' }
  }
  const o = parsed as PortableData
  if (o.app !== 'novel-studio' || o.kind !== 'portable-data') {
    return { ok: false, error: '这不是有效的小说工坊数据文件（请选择便携版创建的 .json 数据文件）' }
  }
  data = normalizePortableData(parsed)
  dirty = true
  const ok = await flushDesktop()
  return ok ? { ok: true } : { ok: false, error: lastError || '写入本地数据失败' }
}

/** 在资源管理器中显示本地数据文件（手动备份用） */
export async function revealDesktopDataFile(): Promise<void> {
  if (DESKTOP) await api().revealDataFile()
}

/** 选择数据文件的新存放位置（返回完整文件路径，取消返回 null） */
export async function chooseDesktopDataDir(): Promise<string | null> {
  if (!DESKTOP) return null
  try {
    return await api().chooseDataDir()
  } catch {
    return null
  }
}

/**
 * 把数据文件迁到新位置并立即生效。
 *
 * 目标已存在数据文件时「改用那份」（adopted=true）——这正是第二台设备的标准用法：
 * 把位置指到同一个云盘目录，直接接管另一台设备同步过来的数据，而不是覆盖它。
 *
 * 调用方在成功后应重新加载应用（location.reload()）让新路径生效。
 */
export async function relocateDesktopDataFile(
  target: string,
): Promise<{ ok: boolean; path: string; adopted: boolean; error?: string }> {
  if (!DESKTOP || !inited) return { ok: false, path: '', adopted: false, error: '桌面存储未就绪' }
  await flushDesktop() // 先把内存数据落盘，避免带着未保存改动换位置
  data.savedAt = Date.now()
  const r = await api().setDataPath(target, JSON.stringify(data))
  if (!r.ok) return { ok: false, path: '', adopted: false, error: r.error ?? '未知错误' }
  dataFilePath = r.path
  isCustomPath = true
  return { ok: true, path: r.path, adopted: r.adopted }
}

/** 恢复默认存放位置（userData 目录）。原位置的数据文件不会被删除。 */
export async function resetDesktopDataPath(): Promise<{ ok: boolean; path: string; adopted: boolean; error?: string }> {
  if (!DESKTOP || !inited) return { ok: false, path: '', adopted: false, error: '桌面存储未就绪' }
  await flushDesktop()
  data.savedAt = Date.now()
  const r = await api().resetDataPath(JSON.stringify(data))
  if (!r.ok) return { ok: false, path: '', adopted: false, error: r.error ?? '未知错误' }
  dataFilePath = r.path
  isCustomPath = false
  return { ok: true, path: r.path, adopted: r.adopted }
}

/** 桌面模式下的存储原语实现（内存数据 + 防抖写回本地数据文件） */
export const desktopStore: StoreOps = {
  async getAll<T>(store: string): Promise<T[]> {
    return Object.values((data.stores[store] ?? {}) as Record<string, T>)
  },
  async get<T>(store: string, key: string): Promise<T | undefined> {
    return (data.stores[store] ?? {})[key] as T | undefined
  },
  async put(store: string, value: unknown): Promise<void> {
    const kp = KEY_PATHS[store] ?? 'id'
    const key = String((value as Record<string, unknown>)[kp])
    const st = data.stores[store] ?? (data.stores[store] = {})
    st[key] = value
    scheduleSave()
  },
  async del(store: string, key: string): Promise<void> {
    const st = data.stores[store]
    if (st && key in st) {
      delete st[key]
      scheduleSave()
    }
  },
  async getAllByIndex<T>(store: string, indexName: string, value: unknown): Promise<T[]> {
    const all = Object.values((data.stores[store] ?? {}) as Record<string, Record<string, unknown>>)
    return all.filter(r => r[indexName] === value) as T[]
  },
  async bulkPut(store: string, values: unknown[]): Promise<void> {
    const kp = KEY_PATHS[store] ?? 'id'
    for (const v of values) {
      const key = String((v as Record<string, unknown>)[kp])
      const st = data.stores[store] ?? (data.stores[store] = {})
      st[key] = v
    }
    scheduleSave()
  },
  async bulkDel(store: string, keys: (string | number)[]): Promise<void> {
    const st = data.stores[store]
    if (!st) return
    let changed = false
    for (const k of keys) {
      if (k in st) { delete st[k]; changed = true }
    }
    if (changed) scheduleSave()
  },
}
