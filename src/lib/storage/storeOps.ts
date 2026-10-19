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

/**
 * OPT-011（2026-10-19 社区反馈复现）：整库导入被拒时，识别"这其实是另一种合法文件"，
 * 返回**指路文案**；不是本软件任何已知格式则返回 null（走通用拒绝语）。
 *
 * 背景：网页版「项目中心 → 导出」产出的是**单本书备份包**（`db.exportProject`：
 * 有 `project` 对象、无 `kind`/`stores`），而桌面「数据坞 → 导入数据文件」只收**整库**
 * （`kind='portable-data'`）。用户拿错文件时只看到一句"请选择便携版创建的数据文件"，
 * 不知道还能去哪导入 —— 复现证明整库主链路本身是通的（8/8），卡住的是入口混淆。
 *
 * 🔴 只做识别与提示，**不**替用户改走导入路径（两种包语义不同：整库=替换全部数据，
 *    项目包=追加一本书），避免"以为在导整库、实际只加了一本书"的误解。
 */
export function describeDataFileReject(parsed: unknown): string | null {
  const o = (parsed ?? {}) as Record<string, unknown>
  if (isPortableDataFile(parsed)) return null
  const looksProjectBundle =
    !!o.project && typeof o.project === 'object'
    && !('stores' in o) && !('kind' in o)
    && (Array.isArray(o.chapters) || Array.isArray(o.volumes) || Array.isArray(o.tableRows))
  if (looksProjectBundle) {
    const name = (o.project as { name?: unknown }).name
    return `这是单本书的备份文件${typeof name === 'string' && name ? `（《${name}》）` : ''}，不是整库数据。\n`
      + '请到「项目中心」对应该书卡片上的「导入项目」打开它；\n'
      + '若想整体搬迁（全部项目 + 设定），请在原设备的左下角数据坞用「导出全部数据」。'
  }
  return null
}
