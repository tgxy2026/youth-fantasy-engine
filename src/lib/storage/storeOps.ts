// 存储原语与数据文件格式 —— 三端共用的基础设施。
//
// ⚠️ 历史沿革：本文件的内容原先住在 `portable.ts`（便携 U 盘版），但 `StoreOps` 是
// IndexedDB / 文件型后端的统一抽象，`PortableData` 是**桌面版与便携版共用的数据文件格式**，
// 两者从来都不是便携版专属。2026-09-15 决定下线网页版与便携版后，把它们独立到此文件，
// 避免桌面版继续依赖一个已删除的模块。
//
// ⚠️ 名字里的 "Portable" **不要改**：`PortableData.kind = 'portable-data'` 是写进
// 用户数据文件的字面量，改名会让老数据文件无法被识别（`openDataFile` 里有硬校验）。

/** 与 IndexedDB 同构的存储原语（db.ts 内部通过适配层路由到各后端实现） */
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

/**
 * 当前数据文件格式版本。
 *   · v1 —— 所有 store 都在整库 JSON 里
 *   · v2 —— 大块数据（备份载荷 / 向量 / 知识库）**外置**为独立文件（2026-10-11）
 * 🔴 升版本必须由迁移逻辑把关（见 sidecar.migrateSidecar），且**老程序读到更高的版本要提示升级**，
 *    不能静默当成"载荷缺失" —— 那会让作者以为备份丢了。
 */
export const PORTABLE_FILE_VERSION = 2

/** 整库单文件的数据格式（桌面版 JSON 数据文件） */
export interface PortableData {
  app: 'youth-fantasy-engine'
  kind: 'portable-data'
  fileVersion: number
  savedAt: number
  /** store 名 -> { 主键 -> 记录 } */
  stores: Record<string, Record<string, unknown>>
}

/** 校验并规整外部读入的数据（桌面版 / 便携版数据格式完全一致，容错读取用） */
export function normalizePortableData(parsed: unknown): PortableData {
  const obj = (parsed ?? {}) as Partial<PortableData>
  const stores: Record<string, Record<string, unknown>> = {}
  if (obj.stores && typeof obj.stores === 'object') {
    for (const [name, rows] of Object.entries(obj.stores)) {
      if (rows && typeof rows === 'object') stores[name] = { ...(rows as Record<string, unknown>) }
    }
  }
  return {
    app: 'youth-fantasy-engine', kind: 'portable-data',
    fileVersion: obj.fileVersion ?? 1, savedAt: obj.savedAt ?? 0, stores,
  }
}

/**
 * 这份 JSON 是不是**本软件写出的**数据文件（只看身份标识，不看内容）。
 *
 * 🔴 为什么必须有这一步（2026-09-20 六维审计 P1-2）：`normalizePortableData` 是**容错**归一化 ——
 *    它无条件把 app/kind 写成合法值，并把任意对象的 `stores` 字段粘过来（没有就是空库）。
 *    于是"用户误放进来的任意合法 JSON"会被当成**首次使用的空库**放行、**且不锁写盘**，
 *    随后第一次防抖写盘就把真实数据文件覆盖掉（磁盘级不可逆）。
 *    `importDesktopData` 一直有这道校验（app + kind 都查），`initDesktopStore` 漏了。
 *
 * 判据：`kind` 必查（格式标识，见 desktop.ts 头部「名字不要改」）；`app` 若存在则也必须匹配 ——
 * 不因历史文件缺 `app` 就把用户锁死（宁可放行，也不能让老数据文件用不了）。
 */
export function isPortableDataFile(parsed: unknown): boolean {
  const o = (parsed ?? {}) as { app?: unknown; kind?: unknown }
  if (o.kind !== 'portable-data') return false
  return o.app === undefined || o.app === 'youth-fantasy-engine'
}
