// ============ 语义检索 · 向量存储 ============
//
// 🔴🔴 本模块**刻意不走 `lib/db` 的门面**（`ops` / `SYNC_STORES`），而是自带一个
//     **独立的 IndexedDB 库**（`youth-fantasy-engine-vec`）。三条理由，逐条都是踩过才知道的：
//
//   1. **桌面模式是「整库一 JSON」**（`desktop.ts` 的 `data.stores` + 防抖写回）。向量动辄
//      十几 MB（1000 章 × 数千块 × 4KB），塞进那个 JSON 等于**每存一章就重写一遍十几兆**，
//      作者会直接感到卡顿。这是最硬的一条。
//   2. **云同步是整库载荷加密上传**（`syncCore`）。向量索引**完全可重建**（重新嵌入即可），
//      让它参与同步只会把 `.yfe` 撑大、把同步变慢，收益为零。
//   3. **不进备份**：备份是"用户的稿子与设定"，派生数据不该混进去（同 #017 的取舍口径）。
//
//    副产品：`DB_VERSION` / `KEY_PATHS` / `SYNC_STORES` / `LOCAL_ONLY_STORES` **一律不动** ——
//    少动一处既有机制，就少一处「同一个病要一次找齐所有路径」的风险。
//
// ⚠️ 代价（如实记录）：索引**不随项目走**。换电脑 / 重装后需要重建一次索引（作者手动点）。
//    这是可接受的取舍 —— 重建成本是嵌入调用，而换电脑本来就要重配模型。

import { openDB, type IDBPDatabase } from 'idb'
import { chunkKey, vectorRowId } from './chunk'

/**
 * 向量行的来源类别。
 *
 * 🔴 `'tavern'`（2026-10-05，T2）是**唯一一个不随项目走**的类别 ——
 *   自由对话是全局数据（`db.getMeta`，不绑项目），所以它的索引写在
 *   `lib/tavern/recall.ts` 的固定分区 `TAVERN_VEC_PROJECT` 下，而不是某个 `projectId`。
 */
export type VecKind = 'chapter' | 'summary' | 'setting' | 'kb' | 'tavern'

export interface VecRow {
  /** `${projectId}::${kind}::${refId}::${chunkIdx}`（见 chunk.vectorRowId） */
  id: string
  projectId: string
  /** 索引键 = `${projectId}::${refId}` —— 供 `delByRef` 走索引，不必全表扫 */
  refKey: string
  kind: VecKind
  refId: string
  chunkIdx: number
  /** 原文片段：召回后**直接注入**，省掉二次读库 */
  text: string
  /** 来源标题（章节名 / 条目名）—— 渲染召回段时标注"这条来自哪儿" */
  title: string
  /** 内容哈希（增量判据，见 chunk.hashOf） */
  hash: string
  /** Float32Array 的 buffer（IndexedDB 原生支持，比 number[] 省 4~8 倍空间） */
  vec: ArrayBuffer
  dim: number
  /** 嵌入模型名 —— 换模型必须整库重建（维度多半也不一样） */
  model: string
  /** 来源行在表格里被标为 S 级（绝密）：角色视角召回时必须整行剔除 */
  secret: boolean
  updatedAt: number
}

export interface VecStats {
  /** 已索引的章节数（kind = 'chapter' 的不同 refId 数） */
  chapters: number
  /** 已索引的条目总数（含设定 / 角色卡等非章节来源） */
  docs: number
  /** 块总数 */
  chunks: number
  /** 最近一次写入所用模型；空库为空串 */
  model: string
  /** 最近写入时间；空库为 0 */
  updatedAt: number
}

/** 索引导读（不读 `vec` —— 大库下省掉十几 MB 的内存与拷贝） */
export interface VecIndex {
  /** `chunkKey → hash`：块级增量判据 */
  hashes: Map<string, string>
  /** 现有来源键集合（`kind::refId`）：用来找出"本次不再存在"的来源并清理孤儿 */
  refs: Set<string>
}

/**
 * 存储后端接口。
 *
 * 抽成接口的**唯一理由是可测**：单测不该被迫跑一个真实 IndexedDB
 * （Node 里根本没有 `indexedDB` 全局）。与 `webSearch` 的 transport 注入、`marketRadar`
 * 的 `chatFn` 注入同一思路 —— 生产代码零成本，测试却能覆盖全路径。
 */
export interface VecBackend {
  load(projectId: string): Promise<VecRow[]>
  bulkPut(rows: VecRow[]): Promise<void>
  delByRef(projectId: string, refId: string): Promise<void>
  clearProject(projectId: string): Promise<void>
  stats(projectId: string): Promise<VecStats | null>
  /** 增量判据与来源清单。**不读 vec**（只读轻量字段），大库下差别明显 */
  index(projectId: string): Promise<VecIndex>
}

// ============ 默认后端 · 独立 IndexedDB ============

const VEC_DB_NAME = 'youth-fantasy-engine-vec'
const VEC_DB_VERSION = 1
const VEC_STORE = 'embeddings'

let vecDbPromise: Promise<IDBPDatabase<unknown>> | null = null

function getVecDB(): Promise<IDBPDatabase<unknown>> {
  if (!vecDbPromise) {
    vecDbPromise = openDB(VEC_DB_NAME, VEC_DB_VERSION, {
      upgrade(db) {
        // 与 `db/core.ts` 同款纪律：建表只在这里、只跑一次，版本判断交给 openDB
        const store = db.createObjectStore(VEC_STORE, { keyPath: 'id' })
        // projectId：按项目取全部行（召回 / 统计）
        store.createIndex('projectId', 'projectId', { unique: false })
        // refKey：按来源删除（改一章只删该章的行，不碰其他）
        store.createIndex('refKey', 'refKey', { unique: false })
      },
    }).catch(err => {
      // 失败时重置缓存，避免 rejected promise 被永久缓存（与 db/core.ts 同口径）
      vecDbPromise = null
      throw err
    })
  }
  return vecDbPromise
}

// 抽成具名函数而非对象方法：方法里的 `this` 一旦被解构调用就丢绑定
// （`const { stats } = backend` 是合法写法，`this.load` 会当场炸）。
async function idbLoad(projectId: string): Promise<VecRow[]> {
  const db = await getVecDB()
  return (await db.getAllFromIndex(VEC_STORE, 'projectId', projectId)) as VecRow[]
}

async function idbBulkPut(rows: VecRow[]): Promise<void> {
  if (rows.length === 0) return
  const db = await getVecDB()
  const tx = db.transaction(VEC_STORE, 'readwrite')
  const os = tx.objectStore(VEC_STORE)
  for (const r of rows) await os.put(r)
  await tx.done
}

/** 按索引取 key 再批量删 —— 两个删除入口共用一个实现 */
async function idbDeleteByIndex(indexName: string, value: string): Promise<void> {
  const db = await getVecDB()
  const keys = await db.getAllKeysFromIndex(VEC_STORE, indexName, value)
  if (keys.length === 0) return
  const tx = db.transaction(VEC_STORE, 'readwrite')
  const os = tx.objectStore(VEC_STORE)
  for (const k of keys) await os.delete(k)
  await tx.done
}

const idbVecBackend: VecBackend = {
  load: idbLoad,
  bulkPut: idbBulkPut,
  delByRef: (projectId, refId) => idbDeleteByIndex('refKey', `${projectId}::${refId}`),
  clearProject: (projectId) => idbDeleteByIndex('projectId', projectId),
  stats: async (projectId) => summarize(await idbLoad(projectId)),
  index: async (projectId) => {
    const db = await getVecDB()
    const hashes = new Map<string, string>()
    const refs = new Set<string>()
    const idx = db.transaction(VEC_STORE, 'readonly').objectStore(VEC_STORE).index('projectId')
    let cursor = await idx.openCursor(projectId)
    while (cursor) {
      const r = cursor.value as VecRow
      hashes.set(chunkKey(r.kind, r.refId, r.chunkIdx), r.hash)
      refs.add(refKeyOf(r.kind, r.refId))
      cursor = await cursor.continue()
    }
    return { hashes, refs }
  },
}

/** 来源键：`kind::refId`（refId 里可能含 `::`，故解析时只能从**第一个**分隔符切） */
export function refKeyOf(kind: string, refId: string): string {
  return `${kind}::${refId}`
}

/** `kind::refId` → 两段；kind 不含 `::`，故按第一个分隔符切是安全的 */
export function splitRefKey(key: string): { kind: string; refId: string } {
  const at = key.indexOf('::')
  if (at < 0) return { kind: '', refId: key }
  return { kind: key.slice(0, at), refId: key.slice(at + 2) }
}

/** 由行数组汇总统计（默认后端与内存后端共用，保证两条路口径一致） */
export function summarize(rows: VecRow[]): VecStats | null {
  if (rows.length === 0) return null
  const chapters = new Set<string>()
  let model = ''
  let updatedAt = 0
  for (const r of rows) {
    if (r.kind === 'chapter') chapters.add(r.refId)
    if (r.updatedAt >= updatedAt) {
      updatedAt = r.updatedAt
      model = r.model
    }
  }
  const docs = new Set(rows.map(r => `${r.kind}::${r.refId}`))
  return { chapters: chapters.size, docs: docs.size, chunks: rows.length, model, updatedAt }
}

// ============ 后端注入 ============

let backend: VecBackend = idbVecBackend

/**
 * 替换存储后端。**仅供单测**（Node 无 `indexedDB`）与将来的「内存模式」复用。
 *
 * 与 `db/core.ts` 的 `makeCloudStoreWrapper` 导出理由同构：本函数是纯赋值、无副作用，
 * 但它是一切向量读写唯一的分发点，不导出就无法在不跑浏览器的前提下覆盖存储全路径。
 * 传 `null` 复位回默认 IndexedDB 后端。
 */
export function setVecBackend(b: VecBackend | null): void {
  backend = b ?? idbVecBackend
}

// ============ 对外 API（薄封装，统一 try/catch 口径）============
//
// 🔴 所有读接口**永不抛**：语义检索是"补一层"，索引库坏了不该阻断写作。
//    写接口（bulkPut）**要抛** —— 建索引任务要知道自己失败了，否则会谎报"已索引 N 章"。

export async function loadVectors(projectId: string): Promise<VecRow[]> {
  if (!projectId) return []
  try {
    return await backend.load(projectId)
  } catch {
    return []
  }
}

export async function putVectors(rows: VecRow[]): Promise<void> {
  if (rows.length === 0) return
  await backend.bulkPut(rows)
}

/** 删除某来源的全部块（章节改写 / 条目删除后调用） */
export async function removeByRef(projectId: string, refId: string): Promise<void> {
  if (!projectId || !refId) return
  await backend.delByRef(projectId, refId)
}

export async function clearProjectVectors(projectId: string): Promise<void> {
  if (!projectId) return
  await backend.clearProject(projectId)
}

export async function vectorStats(projectId: string): Promise<VecStats | null> {
  if (!projectId) return null
  try {
    return await backend.stats(projectId)
  } catch {
    return null
  }
}

/**
 * 轻量索引导读（只带 hash / refId 这类游标字段，不碰 vec buffer）。
 * ⚠️ 读失败**吞成空表** —— 适合「索引坏了不影响干活」的场景（如保存后自动索引的守卫）。
 *    但在「增量重建」里这个语义是危险的：空表 = 「没有旧索引」⇒ 全书重新嵌入。
 *    那条路径请用 `vectorIndexStrict`。
 */
export async function vectorIndex(projectId: string): Promise<VecIndex> {
  if (!projectId) return { hashes: new Map(), refs: new Set() }
  try {
    return await backend.index(projectId)
  } catch {
    return { hashes: new Map(), refs: new Set() }
  }
}

/**
 * 严格版索引导读：读失败**抛出**。
 * 🔴 给「增量重建」用 —— 那里必须把「读不到」与「确实没有索引」区分开，
 *    否则一次瞬时读失败会静默退化成全书重新嵌入（白烧额度）。调用方 catch 后如实报错。
 */
export async function vectorIndexStrict(projectId: string): Promise<VecIndex> {
  if (!projectId) return { hashes: new Map(), refs: new Set() }
  return await backend.index(projectId)
}

/** 构造一行（把 id / refKey 这类"派生字段"收在一处，避免调用方各拼一遍拼错） */
export function makeVecRow(input: {
  projectId: string
  kind: VecKind
  refId: string
  chunkIdx: number
  text: string
  title: string
  hash: string
  vec: ArrayBuffer
  dim: number
  model: string
  secret: boolean
  updatedAt?: number
}): VecRow {
  return {
    // 🔴 `...input` 必须放最前：放后面会把 id / refKey 盖成 undefined，
    //    也会让调用方传进来的 `updatedAt: undefined` 覆盖掉这里的兜底值。
    ...input,
    id: vectorRowId(input.projectId, input.kind, input.refId, input.chunkIdx),
    refKey: `${input.projectId}::${input.refId}`,
    updatedAt: input.updatedAt ?? Date.now(),
  }
}
