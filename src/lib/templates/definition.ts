/**
 * 3.2.0 · WT1-1：模板定义（TemplateDef）**纯类型 + 常量**
 *
 * 与 WT0 的 `EffectiveTemplate` 的区别（方案 §3.5）：
 *   · `EffectiveTemplate`＝**解析结果**（某用途下的可见字段视图），每次从 schema / 配置现算；
 *   · `TemplateDef`＝**项目采用的固定快照**，可编辑、可版本化、可随项目备份导出。
 * 关系：项目有快照 ⇒ 从快照解析；没快照 ⇒ 走 WT0 的内置 / 图鉴适配器（兼容老项目）。
 *
 * 🔴 字段形状**刻意与 `EffectiveField` 一致**：这样「解析快照」和「解析内置 schema」
 *    走同一条投影链路，消费者不需要知道来源是哪一个。
 *    `source` 仍然分内置 / 自定义 —— 写回权限的分叉靠它，不能抹平。
 *
 * 🔴 本文件只放类型与常量；读写在 `store.ts`，派生在 `snapshot.ts`。
 */
import type { EffectiveField, EffectiveGroup } from './types'

/** 模板定义的存储格式版本（与 `EffectiveTemplate.version` 是两个概念） */
export const TEMPLATE_DEF_VERSION = 1

// ────────────────────────── 存储键（方案 §3.5 表格，逐字对齐） ──────────────────────────

/**
 * 项目采用模板：`settingsKV` 的 `projectTemplate32:<tabId>`。
 * 🔴 存 settingsKV 而不是 meta ⇒ **随项目正式备份 / 导出 / 同步**一起走；
 *    个人库走 meta 且加云同步排除，两者不能混。
 */
export const PROJECT_TEMPLATE_PREFIX = 'projectTemplate32:'

/** 项目模板目录：`projectTemplate32:index`。🔴 只用于索引，定义仍以每页签快照为准 */
export const PROJECT_TEMPLATE_INDEX = 'projectTemplate32:index'

/**
 * 个人模板库：`meta` 的 `templateLibrary32:<templateId>:v<version>`。
 * 🔴 只含定义，默认本机个人库，加入云同步排除；分享走显式模板包。
 */
export const LIBRARY_PREFIX = 'templateLibrary32:'

export function projectTemplateKeyOf(tabId: string): string {
  return `${PROJECT_TEMPLATE_PREFIX}${tabId}`
}

export function libraryKeyOf(templateId: string, version: number): string {
  return `${LIBRARY_PREFIX}${templateId}:v${version}`
}

// ────────────────────────── 限额（方案 §3.5「初始限制」，逐条对齐） ──────────────────────────

/**
 * 初始限制。🔴 全部**明确拒绝、绝不截断** ——
 * 截断定义等于悄悄改掉作者设计的结构（少几个选项 / 少一段说明），
 * 而且下一次存盘会拿被截断的版本当基准，偏差会累积。
 */
export const TEMPLATE_LIMITS = {
  /** 每页签最多 60 个**未归档**自定义字段 */
  MAX_ACTIVE_CUSTOM_FIELDS: 60,
  /**
   * 每页签全部自定义字段定义最多 200 个（**含归档**）。
   * 🔴 为什么另设这条：只限制活跃字段，作者就会靠「归档」无限积累定义，
   *    字节额度照样被吃满，且归档列表越长界面越难用。
   */
  MAX_TOTAL_CUSTOM_FIELDS: 200,
  /** 每页签最多 20 个分组 */
  MAX_GROUPS: 20,
  /** 名称 1–20 字 */
  NAME_MIN: 1,
  NAME_MAX: 20,
  /** 单字段说明最多 500 字 */
  DESCRIPTION_MAX: 500,
  /** 选项最多 100 项 */
  MAX_OPTIONS: 100,
  /** 模板包序列化上限 2 MiB */
  PACK_MAX_BYTES: 2 * 1024 * 1024,
  /** 单项目模板定义合计上限 8 MiB（含项目模板、T3 轻量覆盖及发布清单；归档定义也计入） */
  PROJECT_MAX_BYTES: 8 * 1024 * 1024,
} as const

// ────────────────────────── 结构 ──────────────────────────

/**
 * 模板定义的**来源**：决定升级 / 差异比对的基准。
 *
 * 🔴 `builtin` 与 `blank` 分开：两者都不来自库，但升级语义不同 ——
 *    从内置派生的项目可以「跟内置新版比对」，从空白建的就是作者自己的东西，
 *    不该被任何内置变更打扰。
 */
export type TemplateOrigin =
  | { kind: 'builtin' }
  | { kind: 'blank' }
  | { kind: 'copy'; fromTemplateId: string; fromName: string }
  | { kind: 'library'; templateId: string; version: number; fromName: string }

/**
 * 项目采用的一份模板定义（固定快照）。
 *
 * 🔴 为什么存**完整定义**而不是「相对内置的改动」：
 *    内置 schema 会随题材包 / 版本变化，存差量意味着每次升级都要重放历史改动序列，
 *    任何一步对不上就是静默错结构。存全量则「所见即所得」，恢复 / 迁移 / 比对都简单。
 */
export interface TemplateDef {
  formatVersion: typeof TEMPLATE_DEF_VERSION
  /** 模板标识：内置派生为 `builtin:<tabId>`；作者自建为 `tpl_<uid>` */
  templateId: string
  /** 作者可见的模板名 */
  name: string
  /** 所属页签 */
  tabId: string
  origin: TemplateOrigin
  groups: EffectiveGroup[]
  /** 🔴 包含**归档**字段 —— 归档定义也计入字节额度，丢了就恢复不了 */
  fields: EffectiveField[]
  /**
   * 名称字段 ID（表格/卡片的记录标题；表单的主名）。
   * 方案：「表格从当前模板中唯一绑定一个名称字段，映射不到时要求作者先指定」。
   */
  nameFieldId: string
  /** 语义摘要：与 `EffectiveTemplate.semanticDigest` 同算法，用于判索引/候选失效 */
  semanticDigest: string
  /** 项目修订号：纯布局变化 +1，不改语义摘要 */
  revision: number
  updatedAt: number
}

/** 项目模板目录（只用于索引） */
export interface TemplateIndexEntry {
  tabId: string
  templateId: string
  name: string
  semanticDigest: string
  revision: number
  updatedAt: number
}

export interface TemplateIndex {
  formatVersion: typeof TEMPLATE_DEF_VERSION
  entries: TemplateIndexEntry[]
}
