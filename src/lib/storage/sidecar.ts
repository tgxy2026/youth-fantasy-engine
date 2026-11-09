// ============ 外置 store（sidecar）：把大块数据挪出整库 JSON ============
//
// 【要解决的问题】
//   整库单 JSON 的好处是「一个文件带走全部」，代价是**任何一次改动都要重写整个文件**。
//   当数据文件里躺着 60 份备份载荷（每份 = 一个项目的整包正文，**写完就再也不变**）时，
//   作者每敲一个字都要重传上百 MB 完全没动过的历史 —— 便携版会撞上服务 512 MiB 的 PUT 上限，
//   桌面版则表现为每次防抖写盘都明显卡顿。
//
// 【做法：把「几乎不随编辑变化的大块 store」挪到独立文件，主 JSON 只留元数据】
//   两种物理布局：
//     · `per-id` —— 一条记录一个文件（备份载荷：读写单份互不牵连，写一份不必重写全部历史）
//     · `whole`  —— 整个 store 一个文件（向量 / 知识库：本来就是整表一次性加载）
//
// 🔴 为什么 `whole` 不能退化成 `per-id`：向量行按项目可达数千条，
//    若一条一个文件，一次 `getAllByIndex(projectId)` 就是数千次 HTTP / IPC —— 必然卡死。
//    反过来 `per-id` 也不能退化成 `whole`：那会让「写一份 3 MB 备份」变成「重写 180 MB 文件」。
//
// 【对外契约不变】
//   外置只改**磁盘物理布局**；导入 / 导出仍然是单文件（导出时内联回单文件，导入后拆开落盘）。
//   桌面版与便携版互导不受影响。老数据由迁移逻辑自动迁出（见各后端的 migrate 步骤）。
//
// 建立：2026-10-11（3.0 · 便携版审计后的根治项）
import type { StoreOps } from '@/lib/storage/storeOps'

/** 外置 store 的物理布局 */
export type SidecarLayout = 'per-id' | 'whole'

/**
 * `whole` 布局下整表记录的固定键名。
 * 🔴 它必须**不可能**与真实业务主键冲突：真实 id 是 uid（字母数字），此处用双下划线包裹。
 */
export const SIDECAR_WHOLE_KEY = '__all__'

/**
 * 整表条件写的最大合并次数与每次冲突后的短暂退避。
 *
 * 每次冲突都会重新读取整表并重新施加本次修改；正常并发一般 1~2 次即成功。
 * 🔴 为什么不能只给 3~5 次：真实双页同时各写多行时，另一页的写会连续抢先落盘，
 *    5 次仍可能全部撞上（实测 10 个并发写时有一笔连续冲突 5 次后失败）。
 *    这里给足够的重试余量，并在每次冲突后小睡 20~40ms，让对方队列先排空；
 *    上限仍然存在 —— 遇到持续冲突时必须**失败关闭**，不能无限重试把页面卡死。
 */
const WHOLE_MERGE_ATTEMPTS = 12
const WHOLE_MERGE_RETRY_MS = 20
const wholeRetryDelay = () => new Promise<void>((resolve) => {
  setTimeout(resolve, WHOLE_MERGE_RETRY_MS + Math.floor(Math.random() * WHOLE_MERGE_RETRY_MS))
})

/** 单个外置 store 的配置 */
export interface SidecarStoreSpec {
  layout: SidecarLayout
  /** 主键字段名（whole 布局下按它做 upsert 定位） */
  keyField: string
}

/** store 名 -> 配置。不在表里的 store 一律走原后端 */
export type SidecarSpec = Record<string, SidecarStoreSpec>

/**
 * 带版本的读取结果（整表条件写用）。
 * `revision` 由服务端/主进程按内容计算；旧通道不认识版本时返回 null。
 */
export interface SidecarVersionedRead {
  value: unknown | undefined
  revision: string | null
}

/**
 * 条件写结果。
 * · `conflict` 为真 ⇒ 版本前置条件不满足，**本次写入没有发生**，调用方应重读并合并；
 * · `unknown` 为真 ⇒ 传输中断，无法判断是否已落盘（结果不明，不能盲目重试）。
 */
export interface SidecarConditionalWriteResult {
  ok: boolean
  conflict?: boolean
  unknown?: boolean
  revision?: string | null
}

/** 跨整表原子提交的一条：目标 store 的完整新表 + 前置版本 */
export interface SidecarWholeCommitEntry {
  store: string
  value: unknown[]
  expectedRevision: string | null
}

/** 跨整表提交结果；`unsupported` 为真 ⇒ 通道没有原子提交能力，调用方应走旧路径 */
export interface SidecarMultiWriteResult {
  ok: boolean
  conflict?: boolean
  unknown?: boolean
  unsupported?: boolean
  revisions?: Record<string, string | null>
}

/** 通道不支持跨文件原子提交（旧服务 / 旧注入实现）。业务层据此回退旧路径，而不是假装有事务。 */
export class SidecarUnsupportedError extends Error {}

/**
 * 外置记录的读写通道 —— **两个后端各自实现一份**：
 *   · 便携版：HTTP（`/api/blob`）
 *   · 桌面版：IPC（`payload:*`）
 * 本文件只定义契约，不碰任何具体传输方式 ⇒ 可用内存实现做单测。
 */
export interface SidecarApi {
  /** 读一条；不存在返回 undefined，传输/存储失败必须 reject，不能伪装成缺失。 */
  read(store: string, id: string): Promise<unknown | undefined>
  /** 写一条；返回是否成功（失败不抛，由调用方决定是否告警） */
  write(store: string, id: string, value: unknown): Promise<boolean>
  /** 删一条；返回是否成功 */
  remove(store: string, id: string): Promise<boolean>
  /** 列出该 store 当前全部记录 id（whole 布局下返回 `[SIDECAR_WHOLE_KEY]` 或 []）；失败必须 reject。 */
  listIds(store: string): Promise<string[]>
  /**
   * 可选：带版本的读取。whole 布局的「读整表 → 改 → 写整表」必须用它拿到前置版本，
   * 否则两个标签同时改不同行时，后写会静默覆盖先写。缺失或文件不存在时也要给出 revision
   * （服务端/主进程以 `missing` 内容算版本）。
   */
  readVersioned?(store: string, id: string): Promise<SidecarVersionedRead>
  /**
   * 可选：条件写。`expectedRevision` 为 null 时表示「不认识的旧通道」，允许退化为无条件写；
   * 非 null 时传输层必须带 If-Match 语义。**不得把冲突伪装成成功。**
   */
  writeConditional?(
    store: string,
    id: string,
    value: unknown,
    expectedRevision: string | null,
  ): Promise<SidecarConditionalWriteResult>
  /**
   * 可选：多个整表 store 的原子提交（当前为知识库 kbDocs + kbBodies）。
   * 服务端必须在同一把锁下核对全部前置版本、要么全部落盘、要么留下可恢复日志；
   * 通道没有该能力时返回 `unsupported`，**不得用两次独立条件写冒充原子提交**。
   */
  commitWhole?(entries: SidecarWholeCommitEntry[]): Promise<SidecarMultiWriteResult>
}

/** withSidecar 额外提供仅供迁移使用的严格批量写入，避免迁移失败时删掉主库源数据。 */
export type SidecarStoreOps = StoreOps & {
  bulkPutForMigration(store: string, values: unknown[]): Promise<void>
  /**
   * 严格写：**真实落盘成功**才返回，失败抛错。
   *
   * 🔴 3.2.2 · 审计 C1（P1）：常规 `put/write` 失败只走告警出口、随后正常返回 ——
   *    这是**刻意的**（普通写入不该让整条业务链崩掉），但它导致备份链路出现最坏的一种失败：
   *    `createAutoBackup()` 的 `await` 顺利返回 ⇒ 继续登记元数据 ⇒ 列表里多出一份
   *    **既没有载荷、看起来又能恢复**的备份，等作者真去恢复才说"载荷缺失"。
   *    ⇒ 备份载荷这类"不落盘就等于撒谎"的写，必须走这里拿可判断的结果。
   */
  putStrict(store: string, value: unknown): Promise<void>
  delStrict(store: string, key: string): Promise<void>
  putIfAbsentStrict(store: string, value: unknown): Promise<void>
  /**
   * 多个整表 store 的一次性提交（读快照 → 施加修改 → 原子条件写），失败一律抛错。
   * 冲突后重读重放，但目标记录在首次读取后被其他操作修改时拒绝覆盖；
   * 通道不支持时抛 `SidecarUnsupportedError`，由业务层回退旧路径。
   */
  transactWhole(
    stores: string[],
    mutate: (rowsByStore: Record<string, unknown[]>) => Record<string, unknown[]>,
    affectedKeys: Record<string, Set<string>>,
  ): Promise<void>
}

/** 该 store 是否已外置 */
export function isSidecarStore(spec: SidecarSpec, store: string): boolean {
  return Object.prototype.hasOwnProperty.call(spec, store)
}

/**
 * 当前生效的外置通道（两个后端**互斥**，故全局一个槽位足够）。
 * 由 `fileBackend` / `desktop` 在建立自己的通道时登记 —— 供业务层做「列 id」这类
 * StoreOps 没有的能力（孤儿对账要列文件、但不能为拿 id 就把每条内容都读一遍）。
 */
let registeredApi: SidecarApi | null = null
export function registerSidecarApi(api: SidecarApi | null): void { registeredApi = api }
export function currentSidecarApi(): SidecarApi | null { return registeredApi }

/** 取记录的主键值（字符串化）；缺失返回 ''（调用方据此跳过） */
function keyOf(spec: SidecarStoreSpec, rec: unknown): string {
  const v = (rec as Record<string, unknown>)?.[spec.keyField]
  return v == null ? '' : String(v)
}

/** 把一批记录 upsert 进数组（不改入参） */
function upsertInto(spec: SidecarStoreSpec, rows: unknown[], incoming: unknown[]): unknown[] {
  const out = rows.slice()
  for (const rec of incoming) {
    const k = keyOf(spec, rec)
    if (!k) continue
    const i = out.findIndex(r => keyOf(spec, r) === k)
    if (i >= 0) out[i] = rec
    else out.push(rec)
  }
  return out
}

/**
 * 给任意 StoreOps 套一层「外置路由」。
 *
 * 🔴 语义必须与底层后端**逐条对齐**（`fileBackend` 的 upsertRows 等），否则上层
 *    `db/backups.ts` 会在双端表现不一致 —— 那正是本项目最忌讳的「同构被打破」。
 *
 * @param base 原后端（承载未外置的 store）
 * @param api  外置读写通道
 * @param spec 哪些 store 外置、各自什么布局
 * @param onError 日常写失败时的告警出口（默认 console.warn）。常规 StoreOps 写入仍不抛；
 *                只有迁移专用的 `bulkPutForMigration` 会在告警后抛错，以保住主库源数据。
 */
export function withSidecar(
  base: StoreOps,
  api: SidecarApi,
  spec: SidecarSpec,
  onError: (msg: string) => void = (m) => console.warn('[sidecar]', m),
): SidecarStoreOps {
  const specOf = (store: string): SidecarStoreSpec | null =>
    isSidecarStore(spec, store) ? spec[store] : null

  /** 读整表（两种布局统一成"行数组"） */
  async function readAll(store: string, s: SidecarStoreSpec): Promise<unknown[]> {
    if (s.layout === 'whole') {
      const v = await api.read(store, SIDECAR_WHOLE_KEY)
      return Array.isArray(v) ? v : []
    }
    const ids = await api.listIds(store)
    const out: unknown[] = []
    for (const id of ids) {
      const v = await api.read(store, id)
      if (v != null) out.push(v)
    }
    return out
  }

  /**
   * 同页面内按 store 串行化整表「读 → 改 → 写」。
   *
   * 🔴 为什么还需要这一层（服务端已有按文件队列）：同一页面里两处业务代码
   *    （例如向量索引与知识库保存）可能同时发起写；它们各自先读快照再写整表，
   *    即使服务端有 CAS，也会互相冲突并消耗重试次数。这里先在本进程排序，
   *    让绝大多数同页并发直接读到上一笔的结果。
   * 🔴 上一笔失败不能卡死后续写：队列尾部吞掉异常，但调用方仍能拿到自己的异常。
   */
  const wholeQueues = new Map<string, Promise<unknown>>()
  function runSerialWhole<T>(store: string, task: () => Promise<T>): Promise<T> {
    const prev = wholeQueues.get(store) ?? Promise.resolve()
    const run = prev.catch(() => undefined).then(task)
    wholeQueues.set(store, run.then(() => undefined, () => undefined))
    return run
  }

  /** 读整表 + 版本（整表条件写的前置快照） */
  async function readWholeSnapshot(
    store: string,
    s: SidecarStoreSpec,
  ): Promise<{ rows: unknown[]; revision: string | null }> {
    if (api.readVersioned) {
      const r = await api.readVersioned(store, SIDECAR_WHOLE_KEY)
      return { rows: Array.isArray(r.value) ? r.value : [], revision: r.revision }
    }
    return { rows: await readAll(store, s), revision: null }
  }

  /**
   * 整表「读 → 改 → 条件写」，冲突时重读并重新施加本次修改。
   *
   * 只有目标记录在首次读取后未被对方修改时，才可在新快照上重放本次修改。
   * 同一记录发生变化（包括新增、删除）时拒绝覆盖，避免冲突重试吞掉别人的修改。
   * 🔴 结果不明（传输中断）**不重试**：无法判断那次写是否已经落盘，
   *    盲目重放可能把「已成功」当成「没写」。此时保留现场并让作者核对。
   */
  async function mutateWhole(
    store: string,
    s: SidecarStoreSpec,
    mutate: (rows: unknown[]) => unknown[],
    affectedKeys: Set<string>,
    throwOnFailure: boolean,
    requireRevision = false,
  ): Promise<void> {
    await runSerialWhole(store, async () => {
      let baseline: string | undefined
      for (let attempt = 0; attempt < WHOLE_MERGE_ATTEMPTS; attempt++) {
        const snapshot = await readWholeSnapshot(store, s)
        if (requireRevision && (!snapshot.revision || !api.writeConditional)) throw new Error('存储不支持安全的条件恢复')
        const targetRows = JSON.stringify(snapshot.rows.filter(row => affectedKeys.has(keyOf(s, row))))
        if (baseline === undefined) baseline = targetRows
        else if (baseline !== targetRows) {
          const message = `外置 store「${store}」的目标记录已在其他窗口变更，本次修改未保存；请保留输入并核对后重试`
          onError(message)
          throw new Error(message)
        }
        const next = mutate(snapshot.rows)
        if (!api.writeConditional) {
          // 旧通道没有版本语义：保持原行为（无条件写），不假装有保护。
          const ok = await api.write(store, SIDECAR_WHOLE_KEY, next)
          if (ok) return
          const message = `外置 store「${store}」整表写入失败（数据可能未落盘）`
          onError(message)
          if (throwOnFailure) throw new Error(message)
          return
        }
        const r = await api.writeConditional(store, SIDECAR_WHOLE_KEY, next, snapshot.revision)
        if (r.ok) return
        if (r.conflict) {
          // 让对方页面的写队列先排空，再读最新整表；否则双方可能在同一步反复互撞
          if (attempt + 1 < WHOLE_MERGE_ATTEMPTS) await wholeRetryDelay()
          continue
        }
        const message = r.unknown
          ? `外置 store「${store}」整表写入结果不明（可能已落盘，也可能没有）；请重新打开页面核对，勿直接覆盖`
          : `外置 store「${store}」整表写入失败（数据可能未落盘）`
        onError(message)
        if (throwOnFailure) throw new Error(message)
        return
      }
      const message = `外置 store「${store}」连续 ${WHOLE_MERGE_ATTEMPTS} 次因其他窗口同时修改而未能保存；本次修改未落盘，请稍后重试`
      onError(message)
      if (throwOnFailure) throw new Error(message)
    })
  }

  /**
   * 多个整表 store 的一次性提交。与 `mutateWhole` 同一套冲突纪律：
   * 首次快照记录目标行，冲突重读后目标行已变化则拒绝覆盖；结果不明不重试。
   * 页面内按 store 排序依次进入各串行队列，保证与单表写互斥且不会互相死锁。
   */
  async function transactWhole(
    stores: string[],
    mutate: (rowsByStore: Record<string, unknown[]>) => Record<string, unknown[]>,
    affectedKeys: Record<string, Set<string>>,
  ): Promise<void> {
    const sorted = [...new Set(stores)].sort()
    if (sorted.length < 2) throw new Error('跨表提交至少需要两个整表 store')
    const specs = sorted.map(store => {
      const s = specOf(store)
      if (!s || s.layout !== 'whole') throw new Error(`外置 store「${store}」不是整表布局，无法跨表提交`)
      return s
    })
    const run = async (): Promise<void> => {
      if (!api.commitWhole || !api.readVersioned) throw new SidecarUnsupportedError('存储通道不支持跨文件原子提交')
      let baseline: string | undefined
      for (let attempt = 0; attempt < WHOLE_MERGE_ATTEMPTS; attempt++) {
        const snapshots: { rows: unknown[]; revision: string | null }[] = []
        for (let i = 0; i < sorted.length; i++) snapshots.push(await readWholeSnapshot(sorted[i], specs[i]))
        if (snapshots.some(s => !s.revision)) throw new SidecarUnsupportedError('存储通道缺少整表版本，无法安全跨文件提交')
        const targetRows = JSON.stringify(sorted.map((store, i) =>
          snapshots[i].rows.filter(row => (affectedKeys[store] ?? new Set<string>()).has(keyOf(specs[i], row)))))
        if (baseline === undefined) baseline = targetRows
        else if (baseline !== targetRows) {
          const message = `外置 store「${sorted.join('、')}」的目标记录已在其他窗口变更，本次修改未保存；请保留输入并核对后重试`
          onError(message)
          throw new Error(message)
        }
        const rowsByStore: Record<string, unknown[]> = {}
        sorted.forEach((store, i) => { rowsByStore[store] = snapshots[i].rows })
        const next = mutate(rowsByStore)
        const entries: SidecarWholeCommitEntry[] = sorted.map((store, i) => ({
          store, value: next[store] ?? [], expectedRevision: snapshots[i].revision,
        }))
        const r = await api.commitWhole(entries)
        if (r.ok) return
        if (r.unsupported) throw new SidecarUnsupportedError('存储通道不支持跨文件原子提交')
        if (r.conflict) {
          if (attempt + 1 < WHOLE_MERGE_ATTEMPTS) await wholeRetryDelay()
          continue
        }
        const message = r.unknown
          ? `外置 store「${sorted.join('、')}」跨文件提交结果不明（可能已落盘，也可能没有）；请重新打开页面核对，勿直接覆盖`
          : `外置 store「${sorted.join('、')}」跨文件提交失败；服务已保留恢复日志，下次操作或重启会自动完成或提示核对`
        onError(message)
        throw new Error(message)
      }
      const message = `外置 store「${sorted.join('、')}」连续 ${WHOLE_MERGE_ATTEMPTS} 次因其他窗口同时修改而未能保存；本次修改未落盘，请稍后重试`
      onError(message)
      throw new Error(message)
    }
    let chained = run
    for (let i = sorted.length - 1; i >= 0; i--) {
      const store = sorted[i]
      const inner = chained
      chained = () => runSerialWhole(store, inner)
    }
    await chained()
  }

  async function bulkPut(store: string, values: unknown[], throwOnFailure: boolean): Promise<void> {
    const s = specOf(store)
    if (!s) return base.bulkPut(store, values)
    if (!values.length) return
    if (s.layout === 'per-id') {
      for (const v of values) {
        const k = keyOf(s, v)
        if (!k) {
          const message = `外置 store「${store}」写入的记录缺少主键「${s.keyField}」，已跳过`
          onError(message)
          if (throwOnFailure) throw new Error(message)
          continue
        }
        const ok = await api.write(store, k, v)
        if (!ok) {
          const message = `外置 store「${store}」记录 ${k} 写入失败`
          onError(message)
          if (throwOnFailure) throw new Error(message)
        }
      }
      return
    }
    // whole：合并后**只写一次**（整表一个文件，逐条写等于重写 N 遍）
    // 但合并必须带版本前置条件：否则两个标签同时新增不同行时，后写会把先写的整表抹掉。
    await mutateWhole(store, s, (rows) => upsertInto(s, rows, values), new Set(values.map(v => keyOf(s, v)).filter(Boolean)), throwOnFailure)
  }

  /**
   * 单条写入。`throwOnFailure=true` 时任何不落盘都抛错（备份载荷专用）。
   * `put` 与 `putStrict` 共用这一份实现，避免两套语义漂移。
   */
  async function writeOne(store: string, value: unknown, throwOnFailure: boolean): Promise<void> {
    const s = specOf(store)
    if (!s) {
      // 未外置的 store 走底层：IDB / 文件后端的 put 本身就会抛，交给调用方
      return base.put(store, value)
    }
    if (s.layout === 'per-id') {
      const k = keyOf(s, value)
      if (!k) {
        const message = `外置 store「${store}」写入的记录缺少主键「${s.keyField}」`
        onError(message + '，已跳过')
        if (throwOnFailure) throw new Error(message)
        return
      }
      const ok = await api.write(store, k, value)
      if (!ok) {
        const message = `外置 store「${store}」记录 ${k} 写入失败（数据未落盘）`
        onError(message)
        if (throwOnFailure) throw new Error(message)
      }
      return
    }
    await mutateWhole(store, s, (rows) => upsertInto(s, rows, [value]), new Set([keyOf(s, value)]), throwOnFailure)
  }

  async function deleteOne(store: string, key: string, strict: boolean): Promise<void> {
    const s = specOf(store)
    if (!s) return base.del(store, key)
    if (s.layout === 'per-id') {
      const ok = await api.remove(store, String(key))
      if (!ok) {
        const message = `外置 store「${store}」记录 ${String(key)} 删除失败`
        onError(message)
        if (strict) throw new Error(message)
      }
      return
    }
    const k = String(key)
    await mutateWhole(store, s, rows => rows.filter(r => keyOf(s, r) !== k), new Set([k]), strict)
  }

  return {
    async getAll<T>(store: string): Promise<T[]> {
      const s = specOf(store)
      if (!s) return base.getAll<T>(store)
      return (await readAll(store, s)) as T[]
    },

    async get<T>(store: string, key: string): Promise<T | undefined> {
      const s = specOf(store)
      if (!s) return base.get<T>(store, key)
      if (s.layout === 'per-id') return (await api.read(store, String(key))) as T | undefined
      // whole：整表读回再按主键定位（该 store 本就一次性加载，多一次内存查找可忽略）
      const rows = await readAll(store, s)
      return rows.find(r => keyOf(s, r) === String(key)) as T | undefined
    },

    async put(store: string, value: unknown): Promise<void> {
      await writeOne(store, value, false)
    },

    /** 严格写（见类型上的说明）：落盘失败一律抛错，让备份登记方拿到可判断的结果 */
    async putStrict(store: string, value: unknown): Promise<void> {
      await writeOne(store, value, true)
    },

    async putIfAbsentStrict(store: string, value: unknown): Promise<void> {
      const s = specOf(store)
      if (!s || s.layout !== 'whole') throw new Error('该存储不支持条件恢复')
      const k = keyOf(s, value)
      if (!k) throw new Error('条件恢复缺少主键')
      await mutateWhole(store, s, rows => {
        if (rows.some(row => keyOf(s, row) === k)) throw new Error('记录已被其他操作恢复或修改')
        return upsertInto(s, rows, [value])
      }, new Set([k]), true, true)
    },

    async del(store: string, key: string): Promise<void> {
      await deleteOne(store, key, false)
    },

    async delStrict(store: string, key: string): Promise<void> {
      await deleteOne(store, key, true)
    },
    async transactWhole(
      stores: string[],
      mutate: (rowsByStore: Record<string, unknown[]>) => Record<string, unknown[]>,
      affectedKeys: Record<string, Set<string>>,
    ): Promise<void> {
      await transactWhole(stores, mutate, affectedKeys)
    },
    async getAllByIndex<T>(store: string, indexName: string, value: unknown): Promise<T[]> {
      const s = specOf(store)
      if (!s) return base.getAllByIndex<T>(store, indexName, value)
      // 文件型后端本就退化为全量过滤（`filterByIndex`），此处口径一致
      return (await readAll(store, s)).filter(
        (r) => (r as Record<string, unknown>)?.[indexName] === value,
      ) as T[]
    },

    async bulkPut(store: string, values: unknown[]): Promise<void> {
      await bulkPut(store, values, false)
    },

    /** 老库迁移专用：任一写入失败都必须拒绝删除主库中的源数据。 */
    async bulkPutForMigration(store: string, values: unknown[]): Promise<void> {
      await bulkPut(store, values, true)
    },

    async bulkDel(store: string, keys: (string | number)[]): Promise<void> {
      const s = specOf(store)
      if (!s) return base.bulkDel(store, keys)
      if (!keys.length) return
      const set = new Set(keys.map(String))
      if (s.layout === 'per-id') {
        for (const k of set) {
          const ok = await api.remove(store, k)
          if (!ok) onError(`外置 store「${store}」记录 ${k} 删除失败`)
        }
        return
      }
      await mutateWhole(store, s, (rows) => rows.filter(r => !set.has(keyOf(s, r))), set, false)
    },
  }
}

/** 导出时一条外置记录的读取失败（原样交给上层，用来告诉作者"少了什么"） */
export interface SidecarExportIssue {
  store: string
  /** 具体哪一条（per-id 布局时有值；整表布局时为 undefined） */
  id?: string
  error: string
}

/** 导出收集结果：数据 + 缺失清单 + 是否完整 */
export interface SidecarExportResult {
  data: Record<string, unknown[]>
  issues: SidecarExportIssue[]
  /** `issues.length === 0` 才叫完整。部分成功时数据仍可救急，但**必须**告诉作者缺了什么 */
  complete: boolean
}

/**
 * 把外置数据**读回来**，用于导出。
 *
 * 🔴 为什么必须有这一步：外置 store 不在 `data.stores` 里，若直接 `JSON.stringify(data)`，
 *    导出的文件会**静默丢掉全部备份载荷** —— 列表（元数据）还在、看起来一切正常，
 *    等真要恢复时才说"载荷缺失"。这种"看起来成功的失败"比报错更危险。
 *
 *    ⇒ 对外契约保持「单文件带走全部」：导出时内联回来，导入后再拆开（走 migrateSidecar）。
 *
 * 🔴 3.2.2 · 审计 C1（P1）—— **一条坏掉不能带走全部**：
 *    原实现是 `await ops.getAll(name)`，只要一条记录抛错就中断整批读取，
 *    catch 里只 `console.warn` 然后省略整个 store，上层照样返回成功。
 *    审计实测：2 份历史备份里坏 1 份 ⇒ 导出包里**两份都没了**，界面还写"这就是完整副本"。
 *    现在 per-id 布局改为**逐条读**，坏的记进 `issues`，好的照常带走；
 *    上层必须把 `complete:false` 如实呈现给作者（不能只写控制台）。
 */
export async function collectSidecarForExport(
  ops: StoreOps,
  spec: SidecarSpec,
): Promise<SidecarExportResult> {
  const data: Record<string, unknown[]> = {}
  const issues: SidecarExportIssue[] = []
  const api = currentSidecarApi()

  for (const name of Object.keys(spec)) {
    const s = spec[name]
    const rows: unknown[] = []
    // per-id 且有通道 ⇒ 逐条读（一条损坏只丢那一条）
    if (api && s.layout === 'per-id') {
      let ids: string[] = []
      try {
        ids = await api.listIds(name)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        issues.push({ store: name, error: msg })
        console.warn(`[sidecar] 外置 store「${name}」列出记录失败，本次导出不含其数据：`, e)
        continue
      }
      for (const id of ids) {
        try {
          const v = await api.read(name, id)
          if (v != null) rows.push(v)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          issues.push({ store: name, id, error: msg })
          console.warn(`[sidecar] 外置 store「${name}」记录 ${id} 读取失败（本次导出缺这一条）：`, e)
        }
      }
    } else {
      try {
        rows.push(...await ops.getAll(name))
      } catch (e) {
        // 整表布局无法逐条容错：如实记为"整块缺失"。
        // 🔴 留痕是硬要求（2026-10-12 全量审计 P2 / 结构闸 ⑪-a）：静默吞掉会产出
        //    「元数据齐全、载荷全缺」的包，恢复时才暴露 —— 口径同 projects.ts 的 kbInBackupOf。
        const msg = e instanceof Error ? e.message : String(e)
        issues.push({ store: name, error: msg })
        console.warn(`[sidecar] 外置 store「${name}」读取失败，本次导出不含其数据：`, e)
      }
    }
    if (rows.length) data[name] = rows
  }
  return { data, issues, complete: issues.length === 0 }
}

/**
 * 把主 JSON 里残留的外置数据**迁出**到独立文件（升级老库用），并落盘一次。
 *
 * @param data    主库内存数据（会**就地**删掉已迁走的 store）
 * @param ops     **包装过**的 StoreOps（写外置 store 时会自动路由出去）
 * @param spec    外置配置
 * @param persist 落盘主 JSON（迁移删了 store，必须写回去，否则下次又迁一遍）
 *
 * 🔴 幂等三连（作者可能反复启动、中途断电、U 盘拔插）：
 *    · 迁完就把主库里的 store 删掉 ⇒ 再跑时 `extractSidecarRows` 返回空，自然不动；
 *    · 没迁完（写了外置但没删/没落盘）⇒ 下次重跑，`bulkPut` 是 upsert，覆盖同主键 = 同样结果；
 *    · 某条写失败会保留该 store 的主库源数据并记入 `failed`；其它 store 仍继续迁移。
 *      单个 store 内的部分成功可安全重试（upsert），但绝不能把未完整落盘的源数据删除。
 *
 * ⚠️ 调用方必须保证**不在写盘锁定期**调用：锁定期内存里是空库/残缺数据，
 *    迁出去的可能是空壳，而老的主 JSON 已被覆盖 —— 那就真丢了。
 */
export async function migrateSidecar(
  data: { stores: Record<string, unknown>; fileVersion?: number },
  ops: StoreOps,
  spec: SidecarSpec,
  persist: () => Promise<boolean>,
): Promise<{ moved: Record<string, number>; failed: string[]; ok: boolean }> {
  const rows = extractSidecarRows(data.stores, spec)
  const moved: Record<string, number> = {}
  const failed: string[] = []
  let touched = false

  for (const [store, list] of Object.entries(rows)) {
    try {
      const migrationOps = ops as StoreOps & {
        bulkPutForMigration?: (store: string, values: unknown[]) => Promise<void>
      }
      if (migrationOps.bulkPutForMigration) {
        await migrationOps.bulkPutForMigration(store, list)
      } else {
        await ops.bulkPut(store, list)
      }
      moved[store] = list.length
      delete data.stores[store]
      touched = true
    } catch (e) {
      failed.push(`${store}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (touched) {
    const ok = await persist()
    return { moved, failed, ok }
  }
  return { moved, failed, ok: true }
}

/**
 * 从主库数据里**摘出**属于外置 store 的行（迁移用），**不改入参**。
 *
 * @returns `{ store: 行数组 }`；只含 spec 里登记且主库中确实有数据的 store。
 * 🔴 行的形态要兼容两种历史写法：数组（现行）与「主键 -> 记录」对象（老版本）。
 */
export function extractSidecarRows(
  stores: Record<string, unknown>,
  spec: SidecarSpec,
): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {}
  for (const name of Object.keys(spec)) {
    const raw = stores[name]
    if (raw == null) continue
    const rows = Array.isArray(raw) ? raw.slice() : Object.values(raw as Record<string, unknown>)
    if (rows.length) out[name] = rows
  }
  return out
}
