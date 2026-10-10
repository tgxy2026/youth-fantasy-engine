/**
 * 世界引擎 · 类型定义（3.0 · W4-1）
 *
 * 🔴 为什么单独一个**无依赖**的类型文件：世界包的形状要被两头用 ——
 *   业务层（`worldPack.ts`：抽包 / 指纹 / 序列化）与存储层（`db/worlds.ts`）。
 *   若把形状留在 `worldPack.ts`，存储层 import 它就会成环：
 *   `worldPack → db 门面 → db/worlds → worldPack`。
 *   ⇒ 形状集中在这里，两个方向都只依赖它（同 `aiRunTypes.ts` 的处置）。
 *
 * 维护：`WorldPack` 的字段增删**必须**同步 `worldPack.worldPackFingerprint`（指纹只认内容）。
 */

export type WorldPackKind = 'form' | 'table' | 'card' | 'sub'

/**
 * 抽包时**只保留语义内容** —— `projectId` / `tabId` / `updatedAt` / `createdAt` 一律剥掉。
 * 🔴 不剥的后果是静默的：引入方的世界会带着**源项目的 pid**，删除源项目时被一起清掉，
 *    或跨作品引用后「这条到底属于谁」再也说不清。
 */
export interface WorldPackRow {
  id: string
  /** 卡片的展示名（table / form 行没有） */
  name?: string
  /** 字段字典（模块名::字段名 → 值） */
  data: Record<string, string>
  order: number
}

export interface WorldPackTable {
  tabId: string
  kind: WorldPackKind
  /** `form` → 0 或 1 项；`table` / `card` / `sub` → 行数组（按 order 已排好） */
  rows: WorldPackRow[]
}

export interface WorldPackOrigin {
  projectId: string
  projectName: string
  at: number
}

/** 一份**语义快照**（抽包产物；可封存、可跨作品引用） */
export interface WorldPack {
  schema: 1
  id: string
  name: string
  origin: WorldPackOrigin
  tables: WorldPackTable[]
  /**
   * 多套表（worldbase / power / politics / economy / belief / justice）的**活跃子项 id**。
   * 引入后「哪几个子世界是活跃的」要一并带过去，否则界面显示「已完结」、AI 也不注入它们。
   */
  activeSubs: Record<string, string[]>
  /** 内容指纹：只认 `tables` + `activeSubs`（**不含** id / name / origin）—— 判「这两份是不是同一版内容」 */
  fingerprint: string
}

/** 一次封存产生的**不可变**版本（写入后不再改写 —— 这就是「封存」的全部含义） */
export interface WorldVersion {
  /** 版本号（1 起，单调递增） */
  v: number
  at: number
  fingerprint: string
  /** 封存那一刻的完整快照 */
  tables: WorldPackTable[]
  activeSubs: Record<string, string[]>
  /** 封存备注（可选） */
  note?: string
}

/**
 * 世界库里的一条记录。
 * 上半部（`tables` / `activeSubs` / `fingerprint`）是**可继续编辑的草稿** ——
 * 改了要生效，必须再封一次（方案 §10.3 #8 的「不可变版本」）。
 */
export interface WorldStoredRecord {
  id: string
  name: string
  origin: WorldPackOrigin
  tables: WorldPackTable[]
  activeSubs: Record<string, string[]>
  fingerprint: string
  versions: WorldVersion[]
  createdAt: number
  updatedAt: number
}
