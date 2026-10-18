/**
 * 图鉴（3.1.3）· **类型契约**。
 *
 * 依据：`docs/3.1.3-图鉴与自定义字段-具体实施方案-2026-10-18.md` §4.2。
 *
 * 🔴 本文件只放类型 —— 不放常量、不 import 任何业务模块。
 *    `schema.ts` 负责默认值与解析，`values.ts` 负责取值与格式化；
 *    三者分开是为了让「类型」能被任意一方引用而不形成环（拆文件三律）。
 */

/** 本版只开放这两个页签（方案 §1.1：其他页签的入口不做） */
/**
 * 有图鉴视图的页签（3.1.3 起四个）。
 * 🔴 加页签要同步三处：本类型、`schema.ts` 的 `ATLAS_TABS`、以及 `GROUP_SPEC`／`DEFAULT_SUMMARY_KEYS`／`BADGE_KEYS`。
 *    漏了分组表不会报错 —— 字段会静默全落进「补充资料」组（靠 tests/atlasFields 闸住）。
 */
export type AtlasTabId = 'races' | 'items' | 'nations' | 'geography'

/**
 * 自定义字段的六种基础类型。
 * 🔴 本版不做公式 / 脚本 / 任意跨表关联 —— 一律按文本数据处理（方案 §4.4）。
 */
export type CustomFieldType = 'text' | 'longText' | 'number' | 'select' | 'multiSelect' | 'boolean'

/** 字段来源：内置语义字段 / 用户自定义字段（决定改名、归档、AI 权限等行为） */
export type AtlasFieldSource = 'builtin' | 'custom'

/** 解析字段的用途：同一份字段定义，在不同用途下可见性与可写性不同 */
export type AtlasPurpose = 'table' | 'detail' | 'search' | 'aiRead' | 'aiWrite' | 'export'

/**
 * 自定义字段定义。
 *
 * 🔴 `id` 形如 `cf_<uid>`，创建后**永不改变**，同时充当 `TableRow.data` 的存储键；
 *    `label` 只是显示名，可随意改名 —— 这正是「改名不动数据」的实现基础（方案 §4.1）。
 */
export interface AtlasFieldDefinition {
  id: string
  label: string
  type: CustomFieldType
  /** 字段含义说明：同时给人看和给 AI 看（≠ 备注） */
  description: string
  /** 单位（如「年」「里」），仅展示用，不参与计算 */
  unit?: string
  /** select / multiSelect 的候选值 */
  options?: string[]
  /** 适用类别：'*' 表示不限；数组表示只在这些类别值下出现 */
  appliesTo: '*' | string[]
  groupId: string
  order: number
  tableVisible: boolean
  detailVisible: boolean
  searchable: boolean
  aiReadable: boolean
  aiWritable: boolean
  /** 归档＝本版推荐的「删除」方式：定义与值都留着，只是不参与常规展示 */
  archived: boolean
}

/** 详情页的分组（自定义字段可挂到这些组上） */
export interface AtlasFieldGroup {
  id: string
  label: string
  order: number
}

/** 内置字段的展示层覆写（只改「怎么显示」，不改存储键与语义） */
export interface AtlasBuiltinPresentation {
  groupId?: string
  order?: number
  tableVisible?: boolean
  detailVisible?: boolean
}

/**
 * 单个页签的图鉴配置，存项目设置 `atlasSchema::<tabId>`。
 * 🔴 通过**显式 projectId** 读写，不许依赖「当前项目」这个全局状态（方案 §4.2）。
 */
export interface AtlasSchemaConfig {
  formatVersion: 1
  /** 每次配置变更 +1，用于拒绝「拿着旧配置算出的结果」直接落库 */
  revision: number
  fields: AtlasFieldDefinition[]
  groups: AtlasFieldGroup[]
  builtinPresentation: Record<string, AtlasBuiltinPresentation>
  /** 卡片上一眼要看的字段（≤3 项），默认见 `schema.ts: ATLAS_SUMMARY_KEYS` */
  summaryKeys: string[]
}

/**
 * 条目主图。
 * 🔴 存 `TableRow` **顶层**（不进 `row.data`、不新建媒体 store）—— 方案 §6.1 的取舍：
 *    以「上限换小改动面」。dataURL 已在写入前压到 ≤200KiB。
 */
export interface AtlasImage {
  dataUrl: string
  mime: 'image/webp' | 'image/png' | 'image/jpeg'
  width: number
  height: number
  bytes: number
}

/**
 * 解析后的字段：组件与 AI 只认这个结构，不再各自去读 `tab.columns` 或配置原文。
 * 「同一份字段定义、单一路径解析」是方案反复强调的防漂移手段。
 */
export interface ResolvedAtlasField {
  /** 存储键：内置字段＝列名（存储键），自定义字段＝cf_<uid> */
  key: string
  /** 显示名：内置字段取别名单（fieldAlias），自定义字段取 label */
  label: string
  source: AtlasFieldSource
  /** 内置字段的语义类型（select / textarea…）；自定义字段为 undefined */
  builtinType?: string
  /** 自定义字段的类型；内置字段为 undefined */
  customType?: CustomFieldType
  groupId: string
  order: number
  unit?: string
  description?: string
  /** 下拉候选（内置列取 schema 选项，自定义字段取定义里的 options） */
  options?: string[]
  tableVisible: boolean
  detailVisible: boolean
  searchable: boolean
  aiReadable: boolean
  aiWritable: boolean
}

/** 详情页的一个分组（已按字段聚合并排好序） */
export interface AtlasResolvedSection {
  id: string
  label: string
  fields: ResolvedAtlasField[]
}
