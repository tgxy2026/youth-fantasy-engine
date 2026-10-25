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
  /**
   * 严格写（**可选能力**）：真实落盘成功才返回，失败抛错。
   * 只有外置层（`withSidecar`）实现；IDB / 内存后端本就会抛，无需单独提供。
   * 用途见 `sidecar.SidecarStoreOps.putStrict` —— 备份载荷这类"不落盘就等于撒谎"的写。
   */
  putStrict?(store: string, value: unknown): Promise<void>
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

/**
 * 各 store 的主键字段 —— 与 `syncCore.KEY_FIELD` / `app/desktop.KEY_PATHS` 同口径（三处一致）。
 *
 * 🔴 真源在**本文件**（数据格式所在地）：`fileBackend` 从这里 re-export，别再各写一份。
 *    2026-10-23（3.2.2 · 审计 D2）从 `fileBackend` 上移 —— 因为 `normalizePortableData`
 *    （同样是数据格式的一部分）需要用它把数组行重建索引，而 storeOps 不能反向 import 后端。
 *
 * 🔴 `vecRows` / `kbDocs` / `kbBodies` 是**便携版专属**（2026-10-10 方案 A）：
 *    桌面版把语义向量与参考资料放在**两个独立 IDB 库**（`-vec` / `-kb`）里，刻意不进整库 JSON；
 *    但便携版是 U 盘自包含、IDB 不跟盘走 ⇒ 这两库的数据必须并入整库 JSON 才能随盘携带。
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
 * 校验并规整外部读入的数据（桌面版 / 便携版数据格式完全一致，容错读取用）。
 *
 * 🔴 3.2.2（审计 D2 · P1）：**必须兼容「记录数组」形态**，并按各 store 的真实主键重建索引。
 *
 *    病根：便携端写盘时保留的是**数组**（`fileBackend.setRows`：`data.stores[store] = rows`），
 *    而这里原先只是 `{ ...rows }` —— 展开数组得到的是 `{"0": 记录A, "1": 记录B}`。
 *    ⇒ 表现：项目列表（`Object.values`）**看得见**这些项目，点「打开项目」按真实 id 查却查不到，
 *    项目永久打不开；而正文其实还在文件里，作者只会以为软件坏了。审计实测就是这个症状。
 *
 * 🔴 没有主键的记录**不能丢**（丢＝静默删数据）：放在 `__nokey_<序号>` 下，
 *    这样 `getAll`（`Object.values`）仍能列出它们，与便携端「行数组里躺着一份」等价。
 *    前缀用双下划线包裹，真实 id 是字母数字 uid，不会撞。
 */
export function normalizePortableData(parsed: unknown): PortableData {
  const obj = (parsed ?? {}) as Partial<PortableData>
  const stores: Record<string, Record<string, unknown>> = {}

  /** 按真实主键重建 `主键 -> 记录`；无主键的放 `__nokey_<序号>`（不丢数据，见上方说明） */
  const reindex = (name: string, list: unknown[]): Record<string, unknown> => {
    const keyed: Record<string, unknown> = {}
    let orphan = 0
    for (const rec of list) {
      const k = keyOfRecord(name, rec)
      if (k) keyed[k] = rec
      else keyed[`__nokey_${orphan++}`] = rec
    }
    return keyed
  }

  if (obj.stores && typeof obj.stores === 'object') {
    for (const [name, rows] of Object.entries(obj.stores)) {
      if (!rows || typeof rows !== 'object') continue
      // ① 数组形态（便携端写盘的原样）：按各 store 真实主键重建
      if (Array.isArray(rows)) { stores[name] = reindex(name, rows); continue }
      const obj2 = rows as Record<string, unknown>
      const keys = Object.keys(obj2)
      /**
       * ② 对象形态：正常是「主键 -> 记录」。
       *    🔴 但被数组展开污染过的文件长这样：`{"0": {id:'p1'}, "1": {id:'p2'}}` ——
       *    键全为纯数字 ⇒ 一定是坏的（本项目真实主键是 uid / `pid::tabId` / 日期串，
       *    没有哪个 store 用 0/1/2 当键）。这种文件已经落在作者盘上过（审计 D2 现场），
       *    顺手按记录里的真实主键重建，等于把已经打不开的库救回来。
       */
      const looksIndexed = keys.length > 0 && keys.every(k => /^\d+$/.test(k))
      stores[name] = looksIndexed ? reindex(name, Object.values(obj2)) : { ...obj2 }
    }
  }
  return {
    app: 'youth-fantasy-engine', kind: 'portable-data',
    fileVersion: obj.fileVersion ?? 1, savedAt: obj.savedAt ?? 0, stores,
  }
}

/**
 * 本版本**能读的最老格式**。
 *
 * 1 = 没有 `fileVersion` 字段的老文件（1.x 写出的整库）。再老的不存在 ——
 * 所以这条下界是「防脏数据」，不是「还要支持更老的格式」。
 */
export const PORTABLE_FILE_MIN_VERSION = 1

/**
 * 数据文件的**格式版本**是否可接受。返回 null = 可读；返回字符串 = 人话原因。
 *
 * 🔴 为什么必须有这道闸（2026-10-25 · 矩阵 `roundtrip/schema-version`）：
 *    此前 `checkDataVersion()`（`lib/revision/faultInjection.ts`）只被单测调用，
 *    **导入路径一处都没用**：`normalizePortableData` 是容错归一化，它把
 *    `fileVersion` 原样搬过来、不认识的新字段直接丢掉。
 *    于是「用新版本软件写的文件，拿到旧版本里导入」会被**静默接受**，
 *    再存一次就把新版本才有的字段整库抹平 —— 属于不可逆丢数据。
 *    反向（文件比当前旧）必须能读：那是正常的重装/换机场景，老文件没有 `fileVersion` 也算 v1。
 */
export function describeFileVersionProblem(parsed: unknown): string | null {
  const raw = (parsed as { fileVersion?: unknown } | null | undefined)?.fileVersion
  // 缺字段 = 1.x 的老文件，按 v1 收（不因历史文件缺字段把作者锁死）
  const version = raw === undefined || raw === null ? 1 : Number(raw)
  if (!Number.isInteger(version) || version < PORTABLE_FILE_MIN_VERSION) {
    return `数据文件的格式版本无法识别（fileVersion=${JSON.stringify(raw) ?? 'undefined'}）`
  }
  if (version > PORTABLE_FILE_VERSION) {
    return `这份数据文件由更新版本的软件导出（格式 v${version}，本版本最高支持 v${PORTABLE_FILE_VERSION}）`
  }
  return null
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
