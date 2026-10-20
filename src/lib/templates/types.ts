/**
 * 3.2.0 · WT0：有效模板（EffectiveTemplate）纯类型
 *
 * 目的（方案 §3.4）：让**页面、AI、搜索、导出、检查读同一份项目结构**，
 * 不再各自去读 `tab.columns` / `tab.modules` / 图鉴配置原文。
 *
 * 🔴 本文件只放类型；解析在 `legacyAdapter.ts`，对外入口在 `resolve.ts`。
 * 🔴 `EffectiveField.id` 是**稳定身份**：改名只动 `label`，`sourceKey` 永远指向存储键。
 *    字段更名/换分组后，历史数据与引用一律跟随 `id`，不得按显示名重新绑定。
 */
import type { AtlasPurpose, AtlasSchemaConfig } from '@/lib/atlas/types'

/**
 * 用途：同一份结构在不同消费面下暴露的字段不同。
 * 与图鉴既有 `AtlasPurpose` 对齐（不新造一套），额外加 `index`（向量索引）。
 */
export type TemplatePurpose = AtlasPurpose | 'index'

export type { AtlasSchemaConfig }

/** 字段来源：内置（schema 列/模块字段）或自定义（图鉴 `cf_*`） */
export type TemplateFieldSource = 'builtin' | 'custom'

/** 值类型：复用图鉴六类型 + 业务专用控件类型（不新造一套） */
export type TemplateFieldType =
  | 'text' | 'textarea' | 'number' | 'select' | 'multiSelect' | 'boolean'
  | 'date' | 'calendar'
  | 'tableRef'    // 上级 / 地理位置：选项来自别的表
  | 'character' | 'characters'  // 角色引用
  | 'other'       // 未知/未识别类型（只读展示，不参与自动写入）

/**
 * 3.2.0 · T3：字段含义是否已被作者确认。
 *
 * · `confirmed`（缺省）：旧字段未改名、内置字段、直接新建的自定义字段 —— 作者声明即确认；
 * · `pending`：从未经确认的旧别名迁移来的改名 —— 名称照常显示，但 AI 不按它理解 / 回写，
 *   等作者在确认清单里选「含义不变」或改写说明后才恢复。
 *
 * 🔴 缺省当 `confirmed` 是兼容要求：没有这个字段的历史数据不能被一律冻结。
 */
export type FieldMeaningStatus = 'confirmed' | 'pending'

/** 字段权限（五种消费面各自独立，不合并成一个开关） */
export interface TemplateFieldPermissions {
  table: boolean
  detail: boolean
  search: boolean
  aiRead: boolean
  aiWrite: boolean
}

/**
 * 有效字段：一份模板里「这一个字段」的全部事实。
 * 🔴 `id` 与 `sourceKey` 的区别：
 *    · 内置字段：`id` = `sourceKey` = 列名 / `模块名::字段名`（既有数据键，不能动）
 *    · 自定义字段：`id` = `sourceKey` = `cf_<uid>`（创建后永不变）
 *    将来若引入「字段拆分/合并」，`id` 才可能与 `sourceKey` 分离。
 */
export interface EffectiveField {
  /** 稳定字段 ID（引用、映射、AI 回填都认它） */
  id: string
  /** 原始存储键：列名 / `模块名::字段名` / `cf_<uid>` */
  sourceKey: string
  /**
   * 字段来源：`builtin`（schema 内置）或 `custom`（图鉴自定义 `cf_*`）。
   * 🔴 写回权限靠它分叉：内置字段走**原执行器通道**（旧 commit 一直在写它们），
   *    自定义字段必须作者放开 `aiWritable` 才许写 —— 两者不能共用一个开关，
   *    否则要么把内置写入全掐死，要么让自定义字段被静默填值。
   */
  source: TemplateFieldSource
  /** 显示名（内置字段取别名，自定义字段取 label）—— 界面与 AI 共用 */
  label: string
  /**
   * 3.2.0 · T3：改名前/未改名时的原始显示名（仅兼容、界面展示与迁移诊断用）。
   * 🔴 不参与语义摘要：它是历史来源，不是模型理解依据（旧含义不得混进事实正文）。
   */
  defaultLabel?: string
  /** 含义确认状态；缺省 = `confirmed`（见 `FieldMeaningStatus`） */
  meaningStatus?: FieldMeaningStatus
  /** 字段含义说明（人看，也发给 AI） */
  description?: string
  /** 填写示例（人看，也发给 AI；不参与值语义） */
  example?: string
  type: TemplateFieldType
  options?: string[]
  /** 分组 ID（展示分组，不参与数据语义） */
  groupId: string
  order: number
  /** 类别适用范围：`'*'` = 不限 */
  appliesTo: '*' | string[]
  /** 归档：字段与内容都留着，只是常规使用时不出现 */
  archived: boolean
  /** 选项固定（封闭枚举，如保密等级）：不允许增改删 */
  fixedOptions?: boolean
  unit?: string
  permissions: TemplateFieldPermissions
}

export interface EffectiveGroup {
  id: string
  label: string
  order: number
}

/** 解析诊断：不阻断解析，但要如实告诉调用方哪里被降级了 */
export interface TemplateDiagnostic {
  code:
    | 'unknown-field-type'      // 字段类型无法识别 ⇒ 该字段只读、不参与自动写入
    | 'unknown-config-version'  // 配置格式版本高于本程序 ⇒ 该页签只读
    | 'config-read-failed'      // 配置读取失败 ⇒ 按内置模板降级
    | 'duplicate-field-id'      // 字段 ID 重复（导入的坏包）
  detail: string
  fieldId?: string
}

/** 有效模板：一个页签在某个用途下解析出的完整结构 */
export interface EffectiveTemplate {
  /** 模板标识：内置页签为 `builtin:<tabId>`，将来项目自定义模板为 `<templateId>` */
  templateId: string
  /** 模板存储格式版本（结构升级用） */
  version: number
  /** 项目修订号（纯布局/显示变化 +1，不改变语义摘要） */
  revision: number
  /**
   * 语义摘要：影响 AI 理解/权限/用途的部分（名称、说明、类型、选项、权限、分组、适用范围）
   * 变化时才变。布局顺序变化**不得**改变它（否则会误判候选过期）。
   */
  semanticDigest: string
  tabId: string
  /** 本次解析对应的用途 */
  purpose: TemplatePurpose
  groups: EffectiveGroup[]
  fields: EffectiveField[]
  diagnostics: TemplateDiagnostic[]
}
