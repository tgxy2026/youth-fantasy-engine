/**
 * 3.2.0 · WT0-4：**消费者投影**（有效模板 → 各消费者要的形状）
 *
 * 方案 §3.11 要求「固定字段选择改语义读取；其他分段和裁剪规则复用」。
 * 做法：消费者不再自己去读 `resolveAtlasFields(tab, {...})`，改为读**有效模板**，
 * 再由本模块把模板字段压成消费者真正需要的形状。
 *
 * 🔴 为什么要经过投影而不是让消费者直接用 `EffectiveField`：
 *    渲染层今天只关心 `key / label / kind / unit` 四件事，多给它 `permissions`、
 *    `appliesTo` 之类的信息，它会**顺手用起来**（然后就出现了第二套口径）。
 *    投影是刻意的窄接口：谁要更多，就显式改投影，README 在 diff 里看得见。
 * 🔴 `kind` 只在**自定义字段**上有值：`renderTable` 里的 `formatCustomValue` 只对
 *    自定义字段生效（多选→顿号、布尔→是/否、数字带单位）。给内置列也塞 `kind`
 *    会悄悄改写内置列的渲染（内置列存的是人写的原文，本来就不该被格式化）。
 */
import type { CustomFieldType } from '@/lib/atlas/types'
import type { EffectiveField, EffectiveTemplate, TemplateFieldType } from './types'

/** 渲染层需要的字段投影（`ResolvedAtlasField` 结构上满足它，故老调用方零改动） */
export interface TableFieldProjection {
  /** 存储键（表格=列名，卡片=`模块::字段`） */
  key: string
  label: string
  /** 仅自定义字段：决定单元格格式化口径 */
  kind?: CustomFieldType
  unit?: string
}

/** 模板类型 → 图鉴自定义类型（`typeOf()` 的逆映射；只覆盖六类型，其余给 undefined） */
const TYPE_TO_CUSTOM: Partial<Record<TemplateFieldType, CustomFieldType>> = {
  text: 'text',
  textarea: 'longText',
  number: 'number',
  select: 'select',
  multiSelect: 'multiSelect',
  boolean: 'boolean',
}

/** 单个字段的投影 */
export function toTableFieldProjection(f: EffectiveField): TableFieldProjection {
  const kind = f.source === 'custom' ? TYPE_TO_CUSTOM[f.type] : undefined
  return {
    key: f.sourceKey,
    label: f.label,
    ...(kind ? { kind } : {}),
    ...(f.unit ? { unit: f.unit } : {}),
  }
}

/** 整份模板 → 渲染层字段清单（顺序即模板顺序） */
export function tableFieldsOf(template: EffectiveTemplate): TableFieldProjection[] {
  return template.fields.map(toTableFieldProjection)
}

/**
 * AI 读取用的字段清单（口径见 `ai/atlasContext` 文件头三条）：
 * 按 `aiReadable` 过滤、忽略类别适用范围、归档不参与 —— 这些都由**模板解析**负责。
 * 这里的 `aiRead` 过滤只是**兜底**（防有人传了 `purpose:'detail'` 的模板进来），
 * 不是第二套规则：解析侧已经按用途筛过一遍，两处结论必然一致。
 */
export function aiReadableTableFieldsOf(template: EffectiveTemplate): TableFieldProjection[] {
  return template.fields.filter(f => f.permissions.aiRead).map(toTableFieldProjection)
}
