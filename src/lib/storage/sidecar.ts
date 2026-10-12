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

/** 单个外置 store 的配置 */
export interface SidecarStoreSpec {
  layout: SidecarLayout
  /** 主键字段名（whole 布局下按它做 upsert 定位） */
  keyField: string
}

/** store 名 -> 配置。不在表里的 store 一律走原后端 */
export type SidecarSpec = Record<string, SidecarStoreSpec>

/**
 * 外置记录的读写通道 —— **两个后端各自实现一份**：
 *   · 便携版：HTTP（`/api/blob`）
 *   · 桌面版：IPC（`payload:*`）
 * 本文件只定义契约，不碰任何具体传输方式 ⇒ 可用内存实现做单测。
 */
export interface SidecarApi {
  /** 读一条；不存在返回 undefined */
  read(store: string, id: string): Promise<unknown | undefined>
  /** 写一条；返回是否成功（失败不抛，由调用方决定是否告警） */
  write(store: string, id: string, value: unknown): Promise<boolean>
  /** 删一条；返回是否成功 */
  remove(store: string, id: string): Promise<boolean>
  /** 列出该 store 当前全部记录 id（whole 布局下返回 `[SIDECAR_WHOLE_KEY]` 或 []） */
  listIds(store: string): Promise<string[]>
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
 * @param onError 写失败时的告警出口（默认 console.warn）。**不抛**：StoreOps 的
 *                `put` 契约是 `Promise<void>`，抛异常会让整条备份链路中断，
 *                而「载荷没写进去」本就该由「元数据在、载荷缺失」这条既有路径暴露。
 */
export function withSidecar(
  base: StoreOps,
  api: SidecarApi,
  spec: SidecarSpec,
  onError: (msg: string) => void = (m) => console.warn('[sidecar]', m),
): StoreOps {
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

  /** 写整表（仅 whole 布局用） */
  async function writeAll(store: string, rows: unknown[]): Promise<void> {
    const ok = await api.write(store, SIDECAR_WHOLE_KEY, rows)
    if (!ok) onError(`外置 store「${store}」整表写入失败（数据可能未落盘）`)
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
      const s = specOf(store)
      if (!s) return base.put(store, value)
      if (s.layout === 'per-id') {
        const k = keyOf(s, value)
        if (!k) { onError(`外置 store「${store}」写入的记录缺少主键「${s.keyField}」，已跳过`); return }
        const ok = await api.write(store, k, value)
        if (!ok) onError(`外置 store「${store}」记录 ${k} 写入失败`)
        return
      }
      await writeAll(store, upsertInto(s, await readAll(store, s), [value]))
    },

    async del(store: string, key: string): Promise<void> {
      const s = specOf(store)
      if (!s) return base.del(store, key)
      if (s.layout === 'per-id') {
        const ok = await api.remove(store, String(key))
        if (!ok) onError(`外置 store「${store}」记录 ${String(key)} 删除失败`)
        return
      }
      const k = String(key)
      await writeAll(store, (await readAll(store, s)).filter(r => keyOf(s, r) !== k))
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
      const s = specOf(store)
      if (!s) return base.bulkPut(store, values)
      if (!values.length) return
      if (s.layout === 'per-id') {
        for (const v of values) {
          const k = keyOf(s, v)
          if (!k) continue
          const ok = await api.write(store, k, v)
          if (!ok) onError(`外置 store「${store}」记录 ${k} 写入失败`)
        }
        return
      }
      // whole：合并后**只写一次**（整表一个文件，逐条写等于重写 N 遍）
      await writeAll(store, upsertInto(s, await readAll(store, s), values))
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
      await writeAll(store, (await readAll(store, s)).filter(r => !set.has(keyOf(s, r))))
    },
  }
}

/**
 * 把外置数据**读回来**，用于导出。
 *
 * 🔴 为什么必须有这一步：外置 store 不在 `data.stores` 里，若直接 `JSON.stringify(data)`，
 *    导出的文件会**静默丢掉全部备份载荷** —— 列表（元数据）还在、看起来一切正常，
 *    等真要恢复时才说"载荷缺失"。这种"看起来成功的失败"比报错更危险。
 *
 *    ⇒ 对外契约保持「单文件带走全部」：导出时内联回来，导入后再拆开（走 migrateSidecar）。
 */
export async function collectSidecarForExport(
  ops: StoreOps,
  spec: SidecarSpec,
): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {}
  for (const name of Object.keys(spec)) {
    try {
      const rows = await ops.getAll(name)
      if (rows.length) out[name] = rows
    } catch (e) {
      // 单个 store 读不出来不该让整次导出失败：作者至少还能拿到其余数据。
      // 🔴 但**必须留痕**（2026-10-12 全量审计 P2）：导出/备份外置时静默吞掉读失败，会产出
      //    「元数据齐全、载荷全缺」的包，恢复时才暴露 —— 口径同 projects.ts 的 kbInBackupOf。
      console.warn(`[sidecar] 外置 store「${name}」读取失败，本次导出不含其数据：`, e)
    }
  }
  return out
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
 *    · 单条写失败**不中断整批**（记在 `failed` 里），避免"一份坏备份让其它 59 份永远迁不出去"。
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
      await ops.bulkPut(store, list)
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
