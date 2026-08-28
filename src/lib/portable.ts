// 便携模式存储引擎
// 整个数据库以单个 JSON 数据文件的形式保存在 U 盘上，
// 通过浏览器 File System Access API 直接读写该文件 —— 数据物理上在 U 盘里，
// 换电脑、换浏览器都不影响，插入 U 盘即可继续创作。
//
// 说明：
// - File System Access API 需要 Chromium 内核浏览器（Chrome / Edge），file:// 页面下可用
// - 出于浏览器安全策略，每次启动需要用户手动点一次「打开数据文件」授权（仅一次）
// - 写盘做了 800ms 防抖：连续码字时不会每敲一个字就写一次 U 盘

declare const __PORTABLE__: boolean | undefined

/** 是否为便携（单文件 U 盘）版本，由构建时 define 注入 */
export const PORTABLE: boolean = typeof __PORTABLE__ === 'undefined' ? false : __PORTABLE__

declare const __APP_VERSION__: string | undefined

/** 应用版本号，由构建时 define 注入（取自 package.json）；dev / 未注入时回退到「开发版」 */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'undefined' ? '开发版' : __APP_VERSION__

/** 与 IndexedDB 同构的存储原语（db.ts 内部通过适配层路由到这里或 idb） */
export interface StoreOps {
  getAll<T>(store: string): Promise<T[]>
  get<T>(store: string, key: string): Promise<T | undefined>
  put(store: string, value: unknown): Promise<void>
  del(store: string, key: string): Promise<void>
  /** 按索引取数（IndexedDB 走索引；文件型后端退化为全量过滤） */
  getAllByIndex<T>(store: string, indexName: string, value: unknown): Promise<T[]>
  /** 批量写入（单事务 / 单次写盘） */
  bulkPut(store: string, values: unknown[]): Promise<void>
  /** 批量删除（单事务 / 单次写盘） */
  bulkDel(store: string, keys: (string | number)[]): Promise<void>
}

export interface PortableData {
  app: 'novel-studio'
  kind: 'portable-data'
  fileVersion: number
  savedAt: number
  /** store 名 -> { 主键 -> 记录 } */
  stores: Record<string, Record<string, unknown>>
}

const KEY_PATHS: Record<string, string> = {
  projects: 'id', volumes: 'id', chapters: 'id', tableRows: 'id',
  cardRecords: 'id', snapshots: 'id', trash: 'id',
  formData: 'tabId', meta: 'key', dailyStats: 'key', settingsKV: 'key',
}

// ---- File System Access API 最小结构类型（自声明，避免依赖 lib.dom 版本差异）----
interface FSAWritable {
  write(data: string): Promise<void>
  close(): Promise<void>
}
interface FSAHandle {
  readonly name: string
  getFile(): Promise<File>
  createWritable(opts?: { keepExistingData?: boolean }): Promise<FSAWritable>
}
interface FSAWindow extends Window {
  showOpenFilePicker?(opts?: unknown): Promise<FSAHandle[]>
  showSaveFilePicker?(opts?: unknown): Promise<FSAHandle>
}

export function isFSASupported(): boolean {
  const w = window as FSAWindow
  return typeof w.showOpenFilePicker === 'function' && typeof w.showSaveFilePicker === 'function'
}

export interface PortableState {
  connected: boolean
  fileName: string
  dirty: boolean
  saving: boolean
  lastSavedAt: number
  lastError: string
}

let handle: FSAHandle | null = null
let data: PortableData = emptyData()
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saving = false
let dirty = false
let lastSavedAt = 0
let lastError = ''

const listeners = new Set<() => void>()

/** 订阅状态变化（连接 / 写盘完成 / 出错），返回取消订阅函数 */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function emit() { listeners.forEach(fn => fn()) }

export function getState(): PortableState {
  return { connected: !!handle, fileName: handle?.name ?? '', dirty, saving, lastSavedAt, lastError }
}

function emptyData(): PortableData {
  return { app: 'novel-studio', kind: 'portable-data', fileVersion: 1, savedAt: Date.now(), stores: {} }
}

/** 校验并规整外部读入的数据（便携版 / 桌面版共用，两版数据格式完全一致） */
export function normalizePortableData(parsed: unknown): PortableData {
  const obj = (parsed ?? {}) as Partial<PortableData>
  const stores: Record<string, Record<string, unknown>> = {}
  if (obj.stores && typeof obj.stores === 'object') {
    for (const [name, rows] of Object.entries(obj.stores)) {
      if (rows && typeof rows === 'object') stores[name] = { ...(rows as Record<string, unknown>) }
    }
  }
  return {
    app: 'novel-studio', kind: 'portable-data',
    fileVersion: obj.fileVersion ?? 1, savedAt: obj.savedAt ?? 0, stores,
  }
}

const PICKER_TYPES = [{ description: '小说工坊数据文件', accept: { 'application/json': ['.json'] } }]

function setUserError(e: unknown) {
  // 用户主动取消选择不当作错误
  if (e instanceof DOMException && e.name === 'AbortError') return
  lastError = e instanceof Error ? e.message : String(e)
}

/** 打开 U 盘上已有的数据文件（继续上次的创作） */
export async function openDataFile(): Promise<boolean> {
  const w = window as FSAWindow
  if (!w.showOpenFilePicker) {
    lastError = '当前浏览器不支持直接读写 U 盘文件，请使用 Chrome 或 Edge 浏览器打开本应用'
    emit()
    return false
  }
  try {
    const [h] = await w.showOpenFilePicker({ multiple: false, types: PICKER_TYPES })
    const file = await h.getFile()
    const text = await file.text()
    if (text.trim()) {
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { throw new Error('数据文件已损坏（JSON 解析失败）') }
      const o = parsed as PortableData
      if (o.app !== 'novel-studio' || o.kind !== 'portable-data') {
        throw new Error('这不是有效的小说工坊数据文件（请选择本应用新建的 .json 数据文件）')
      }
      data = normalizePortableData(parsed)
    } else {
      data = emptyData() // 空文件视作新建
    }
    handle = h
    dirty = false
    lastSavedAt = Date.now()
    lastError = ''
    emit()
    return true
  } catch (e) {
    setUserError(e)
    emit()
    return false
  }
}

/** 在 U 盘上新建数据文件（第一次使用） */
export async function createDataFile(): Promise<boolean> {
  const w = window as FSAWindow
  if (!w.showSaveFilePicker) {
    lastError = '当前浏览器不支持直接读写 U 盘文件，请使用 Chrome 或 Edge 浏览器打开本应用'
    emit()
    return false
  }
  try {
    const h = await w.showSaveFilePicker({ suggestedName: '我的小说库.novel.json', types: PICKER_TYPES })
    handle = h
    data = emptyData()
    dirty = true
    await flush()
    lastError = ''
    emit()
    return true
  } catch (e) {
    setUserError(e)
    emit()
    return false
  }
}

/** 数据变更后安排一次防抖写盘（800ms 内的连续修改合并为一次写入） */
export function scheduleSave() {
  if (!handle) return
  dirty = true
  if (saveTimer != null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { saveTimer = null; void flush() }, 800)
}

/** 立即写盘（手动保存 / beforeunload 时调用） */
export async function flush(): Promise<boolean> {
  if (!handle || saving) return false
  saving = true
  emit()
  try {
    data.savedAt = Date.now()
    const writable = await handle.createWritable()
    await writable.write(JSON.stringify(data))
    await writable.close()
    dirty = false
    lastSavedAt = Date.now()
    lastError = ''
    return true
  } catch (e) {
    lastError = '写入数据文件失败：' + (e instanceof Error ? e.message : String(e))
    return false
  } finally {
    saving = false
    emit()
    // 写盘期间又有新变更 → 补一次保存
    if (dirty) scheduleSave()
  }
}

/** 便携模式下的存储原语实现（内存数据 + 防抖写回 U 盘文件） */
export const portableStore: StoreOps = {
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
