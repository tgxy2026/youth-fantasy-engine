/**
 * 3.2.0 · WT0：有效模板解析**对外入口**
 *
 * 所有消费者（页面、AI、搜索、导出、检查）今后只认这里的输出，
 * 不再各自去读 `tab.columns` / `tab.modules` / 图鉴配置原文。
 *
 * 🔴 当前阶段（WT0-1）是**纯函数 + 零调用方迁移**：
 *    解析只依赖传入的 `TabDef` 与图鉴配置快照，不读库、不读全局状态。
 *    缓存与失效（按 projectId / tabId / 修订号）在 WT0-2 接入，
 *    届时 `projectId` 才进入缓存键 —— 现在保留参数是为了不改调用方签名。
 */
import type { TabDef } from '@/lib/types'
import type { AtlasSchemaConfig } from '@/lib/atlas/types'
import {
  adaptAtlasTab, adaptBuiltinTab, canAdaptAsAtlas, TEMPLATE_FORMAT_VERSION,
} from './legacyAdapter'
import { adaptTemplateDef } from './defAdapter'
import type { EffectiveTemplate, TemplatePurpose } from './types'
import type { TemplateDef } from './definition'

/** 图鉴配置的**读取**格式版本（与模板格式版本是两个概念） */
const ATLAS_CONFIG_READ_VERSION = 1

export interface ResolveTemplateOptions {
  /** 字段别名单（内置字段显示名覆写，来自 `lib/settings/fieldAlias`） */
  aliases?: Record<string, string>
  /** 图鉴自定义字段配置快照；非图鉴页签忽略 */
  config?: AtlasSchemaConfig | null
  /** 用途：决定哪些字段对本次消费者可见（与图鉴 purpose 同口径，另加 index） */
  purpose?: TemplatePurpose
  /** 条目类别，用于自定义字段的适用范围过滤 */
  category?: string
  /** 忽略类别适用范围（全表视图用） */
  ignoreAppliesTo?: boolean
  /** 项目修订号（纯展示变化 +1；不参与语义摘要） */
  revision?: number
  /**
   * 项目**已采用**的模板快照（WT1）。
   * 🔴 有它 ⇒ 一切以快照为准，内置 schema 再变也不动作者的结构；
   *    没它 ⇒ 走内置 / 图鉴兼容适配器（老项目行为不变）。
   */
  def?: TemplateDef | null
  /**
   * 返回**未过滤的完整结构**（仅派生快照时用，见 `snapshot.ts`）。
   * 🔴 常规解析一律不传 —— 归档字段不参与展示 / AI / 索引；
   *    用途过滤也照常生效（某视图隐藏某列，在该视图里就是不该出现）。
   */
  unfiltered?: boolean
}

/**
 * 解析一个页签的有效模板。
 *
 * 失败/未知格式的处置（方案 §3.4）：
 *   · 配置版本高于本程序可读版本 ⇒ **丢弃该配置**、按内置模板降级，并记 `unknown-config-version`
 *     诊断（受影响页签的自定义字段不出现，但内置字段照常可用，不扩大成全页不可用）；
 *   · 字段类型无法识别 ⇒ 该字段标 `other` + 诊断，只读、不参与自动写入；
 *   · 其他已解析且获授权的资料继续工作。
 */
export function resolveTemplateForTab(tab: TabDef, opts: ResolveTemplateOptions = {}): EffectiveTemplate {
  const purpose = opts.purpose ?? 'detail'
  // 🔴 快照优先：采用过模板的页签，结构由快照决定，与内置 schema 解耦
  if (opts.def) return adaptTemplateDef(opts.def, {
    purpose,
    ...(opts.category ? { category: opts.category } : {}),
    ...(opts.ignoreAppliesTo ? { ignoreAppliesTo: true } : {}),
    ...(opts.revision != null ? { revision: opts.revision } : {}),
  })
  if (canAdaptAsAtlas(tab)) {
    const raw = opts.config ?? null
    const tooNew = raw != null && (raw.formatVersion as number) > ATLAS_CONFIG_READ_VERSION
    const template = adaptAtlasTab(tab, {
      ...(opts.aliases ? { aliases: opts.aliases } : {}),
      config: tooNew ? null : raw,
      purpose,
      ...(opts.category ? { category: opts.category } : {}),
    ...(opts.ignoreAppliesTo ? { ignoreAppliesTo: true } : {}),
    ...(opts.unfiltered ? { unfiltered: true } : {}),
    ...(opts.revision != null ? { revision: opts.revision } : {}),
    })
    if (tooNew) {
      template.diagnostics.push({
        code: 'unknown-config-version',
        detail: `字段配置版本 ${String((raw as { formatVersion?: unknown }).formatVersion)} 高于本程序可读的 ${ATLAS_CONFIG_READ_VERSION}；已按内置模板降级，自定义字段暂不显示`,
      })
    }
    return template
  }
  return adaptBuiltinTab(tab, {
    ...(opts.revision != null ? { revision: opts.revision } : {}),
    ...(opts.aliases ? { aliases: opts.aliases } : {}),
  })
}

/**
 * 便捷封装：按页签 ID 从传入的页签表里解析（不读全局 TABS，便于测试与未来多模板）。
 * 找不到页签 ⇒ null（调用方按「页签不存在」处理，不静默返回空模板）。
 */
export function resolveTemplateById(
  tabs: readonly TabDef[],
  tabId: string,
  opts: ResolveTemplateOptions = {},
): EffectiveTemplate | null {
  const tab = tabs.find(t => t.id === tabId)
  return tab ? resolveTemplateForTab(tab, opts) : null
}

export { TEMPLATE_FORMAT_VERSION }
export type { EffectiveTemplate, TemplatePurpose }
