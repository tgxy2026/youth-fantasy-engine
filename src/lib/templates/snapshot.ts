/**
 * 3.2.0 · WT1-2：模板快照的**三个起点**
 *
 * 方案 §3.5：「支持从空白或预设复制创建」。本文件把「当前实际生效的结构」
 * 固化成一份 `TemplateDef`，之后作者的所有编辑都在这份快照上进行 ——
 * 内置 schema 再变也**不会**悄悄改到作者已采用的结构（这正是「固定快照」的含义）。
 *
 * 三个起点：
 *   · `snapshotOfBuiltin` —— 复制当前生效的内置结构（schema 列 / 模块字段 + 别名）
 *   · `snapshotOfAtlas`   —— 复制图鉴现有结构（内置列 + 作者已建的自定义字段）
 *   · `snapshotOfBlank`   —— 只留记录身份和最小名称入口，其余作者自己设计
 *
 * 🔴 全部**纯函数**：不读库、不读全局状态。配置与别名由调用方传入，
 *    与 WT0 的 `resolveTemplateForTab` 同一口径（便于测试与将来多模板）。
 */
import { uid } from '@/lib/app/id'
import type { TabDef } from '@/lib/types'
import type { EffectiveField, EffectiveTemplate } from './types'
import { resolveTemplateForTab, type ResolveTemplateOptions } from './resolve'
import { semanticDigestOf } from './legacyAdapter'
import { TEMPLATE_DEF_VERSION, type TemplateDef, type TemplateOrigin } from './definition'

/** 作者自建模板的 ID 前缀（内置派生恒为 `builtin:<tabId>`，一眼可分） */
export const CUSTOM_TEMPLATE_ID_PREFIX = 'tpl_'

export function newTemplateId(): string {
  return `${CUSTOM_TEMPLATE_ID_PREFIX}${uid()}`
}

// ────────────────────────── 名称字段 ──────────────────────────

/**
 * 从模板里挑一个**名称字段**（表格/卡片的记录标题；表单的主名）。
 *
 * 优先级：作者显式指定的 `tab.displayCol` → 名字里带「名称/名字」的内置字段 → 第一个字段。
 *
 * 🔴 返回空串的含义是「映射不到」，**不是**「随便挑一个」——
 *    方案要求：「表格从当前模板中唯一绑定一个名称字段，映射不到时要求作者先指定」。
 *    调用方必须把空串当成一个需要作者介入的状态，不能退化成取第一列了事，
 *    否则作者改了模板之后，"这一行是谁"就会静默变成另一列的取值。
 */
export function nameFieldOf(
  fields: readonly EffectiveField[],
  displayCol?: string,
): string {
  const visible = fields.filter(f => !f.archived)
  if (displayCol) {
    const hit = visible.find(f => f.sourceKey === displayCol || f.id === displayCol)
    if (hit) return hit.id
  }
  const named = visible.find(f => /名称|名字|姓名/.test(f.label))
  if (named) return named.id
  return visible[0]?.id ?? ''
}

// ────────────────────────── 派生 ──────────────────────────

export interface SnapshotInput extends ResolveTemplateOptions {
  /** 模板显示名；不传则取页签名 */
  name?: string
}

/**
 * 把一份**解析结果**固化为模板定义。
 *
 * 🔴 `semanticDigest` 直接沿用解析出来的那一份，不在这里重算 ——
 *    同一份结构在两个地方各算一次，任何一处算法微调就会出现"摘要不一致"，
 *    而摘要的用途恰恰是判失效，算歪了就是误杀候选或该杀不杀。
 */
function defOf(
  tpl: EffectiveTemplate,
  origin: TemplateOrigin,
  name: string,
  revision: number,
  aliases?: Record<string, string>,
): TemplateDef {
  return {
    formatVersion: TEMPLATE_DEF_VERSION,
    templateId: tpl.templateId,
    name,
    tabId: tpl.tabId,
    origin,
    groups: tpl.groups.map(g => ({ ...g })),
    // 🔴 归档字段一并带走：归档是"不显示"而不是"删除"，丢了就恢复不了
    fields: tpl.fields.map(f => ({
      ...f,
      // 🔴 别名只改显示名，存储键（`sourceKey`）一个字节都不动。
      //    图鉴页签解析时已叠过别名，这里再叠一次是幂等的（值相同）。
      label: aliases?.[f.sourceKey] ?? f.label,
      permissions: { ...f.permissions },
    })),
    nameFieldId: nameFieldOf(tpl.fields),
    semanticDigest: tpl.semanticDigest,
    revision,
    updatedAt: Date.now(),
  }
}

/** 起点一：复制当前生效的**内置结构**（schema 列 / 模块字段，叠加作者已配的别名） */
export function snapshotOfBuiltin(tab: TabDef, input: SnapshotInput = {}): TemplateDef {
  const { name, ...opts } = input
  const tpl = resolveTemplateForTab(tab, { purpose: 'detail', ...opts })
  return defOf(tpl, { kind: 'builtin' }, name ?? tab.name, opts.revision ?? 0, opts.aliases)
}

/**
 * 起点二：复制**图鉴现有结构**（内置列 + 作者已建的自定义字段）
 *
 * 🔴 这是 3.1.3 老项目升级的主路径：作者已经在图鉴里设计好的东西，
 *    升级后必须原样保留（含归档项与权限），不能因为换了存储位置就重来一遍。
 */
export function snapshotOfAtlas(tab: TabDef, input: SnapshotInput = {}): TemplateDef {
  const { name, ...opts } = input
  // 🔴 快照要的是**完整定义**，不是"某一条目此刻看得见什么" ⇒ 走未过滤视图：
  //    · 归档字段必须带走（丢了就是永久删除，恢复不了）；
  //    · 类别限定字段必须带走（类别是**逐行**判的，"食性只对魔兽有效"
  //      不该让它在模板里整个消失）。
  //    写在 `...opts` 之前 ⇒ 调用方仍可显式覆盖。
  const tpl = resolveTemplateForTab(tab, { purpose: 'detail', unfiltered: true, ...opts })
  return defOf(tpl, { kind: 'builtin' }, name ?? tab.name, opts.revision ?? 0, opts.aliases)
}

/**
 * 起点三：**从空白**创建 —— 只保留记录身份和最小名称入口，其余作者自己设计。
 *
 * 🔴 刻意**不带**任何内置字段：方案说「用户自行设计其余栏目」。
 *    若顺手把内置列也塞进去，作者就得先删一遍才能开始设计，
 *    而且删掉的是"系统字段"这件事本身就会让人不敢动手。
 */
export function snapshotOfBlank(tab: TabDef, input: { name?: string; revision?: number } = {}): TemplateDef {
  const nameFieldId = `${CUSTOM_TEMPLATE_ID_PREFIX}name`
  const field: EffectiveField = {
    id: nameFieldId,
    sourceKey: nameFieldId,
    source: 'custom',
    label: '名称',
    type: 'text',
    groupId: 'default',
    order: 0,
    appliesTo: '*',
    archived: false,
    permissions: { table: true, detail: true, search: true, aiRead: true, aiWrite: false },
  }
  return {
    formatVersion: TEMPLATE_DEF_VERSION,
    templateId: newTemplateId(),
    name: input.name ?? `${tab.name}·自定义`,
    tabId: tab.id,
    origin: { kind: 'blank' },
    groups: [{ id: 'default', label: tab.name, order: 0 }],
    fields: [field],
    nameFieldId,
    // 🔴 用与解析侧**同一个** `semanticDigestOf` 现算（空白模板没有可沿用的解析结果）
    semanticDigest: semanticDigestOf([field]),
    revision: input.revision ?? 0,
    updatedAt: Date.now(),
  }
}
