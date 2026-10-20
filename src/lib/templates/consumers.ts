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

/** 自定义字段的图鉴类型；内置字段恒为 undefined（内置列不走新控件） */
export function customTypeOf(f: EffectiveField): CustomFieldType | undefined {
  return f.source === 'custom' ? TYPE_TO_CUSTOM[f.type] : undefined
}

/** 单个字段的投影 */
export function toTableFieldProjection(f: EffectiveField): TableFieldProjection {
  const kind = customTypeOf(f)
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
 * **写回目标**的字段投影（AI 回填 / 补全本行 / 整理共用）。
 *
 * 比渲染投影多两件事：`type`（决定值怎么归一化）和 `options`（决定哪些值算合法）。
 * 🔴 字段名刻意叫 `type` 而不是 `kind`：`coerceAiValue` 收的就是 `{label, customType|type, options}`，
 *    叫 `type` 可以直接把投影喂进去，调用方不必再拼一次对象（拼一次就多一处漂移）。
 */
export interface WriteFieldProjection {
  key: string
  label: string
  /** 自定义字段的类型（内置列为 undefined ⇒ 按普通文本处理） */
  type?: CustomFieldType
  options?: string[]
  unit?: string
  /** 作者写的字段说明（一并交给模型，否则它只能瞎编） */
  description?: string
  /** 作者写的填写示例（同样是给模型的参考） */
  example?: string
  /** 类别适用范围（只对某些类别有意义的字段要告诉模型） */
  appliesTo?: '*' | string[]
}

/** 单个字段的写回投影 */
export function toWriteFieldProjection(f: EffectiveField): WriteFieldProjection {
  const type = customTypeOf(f)
  return {
    key: f.sourceKey,
    label: f.label,
    ...(type ? { type } : {}),
    ...(f.options?.length ? { options: f.options } : {}),
    ...(f.unit ? { unit: f.unit } : {}),
    ...(f.description?.trim() ? { description: f.description.trim() } : {}),
    ...(f.example?.trim() ? { example: f.example.trim() } : {}),
    ...(f.appliesTo !== '*' ? { appliesTo: f.appliesTo } : {}),
  }
}

/** 六类型的人话名（给模型看，别给 `cf_` 键） */
const TYPE_HINT: Partial<Record<CustomFieldType, string>> = {
  text: '短文本',
  longText: '长文本',
  number: '数字',
  select: '单选',
  multiSelect: '多选',
  boolean: '是/否',
}

/**
 * 把一个字段投影说成**一句模型能懂的话**（3.1.3 · R12 的通用版）。
 *
 * 🔴 为什么必须带类型/单位/候选/说明：只给 `key / label` 时模型不知道这是数字还是多选、
 *    不知道单位、不知道候选里有哪些值 ⇒ 只能瞎编（"18岁"填进数字列、"大概"填进单选列），
 *    然后被 `coerceAiValue` 拒掉，作者看到的是"AI 又跳过了一堆字段"。
 * 🔴 这是**唯一实现**：旧入口 `atlasFieldHintForAI` 已改为委托到本函数，
 *    不要再在别处复制一份（复制品必然漂移）。
 */
export function fieldHintForAI(p: WriteFieldProjection): string {
  const parts: string[] = [TYPE_HINT[p.type ?? 'text'] ?? '文本']
  if (p.unit) parts.push(`单位：${p.unit}`)
  if (p.options?.length) parts.push(`候选：${p.options.join(' / ')}`)
  if (p.description?.trim()) parts.push(p.description.trim())
  if (p.example?.trim()) parts.push(`示例：${p.example.trim()}`)
  if (p.appliesTo && p.appliesTo !== '*' && (p.appliesTo as string[]).length) {
    parts.push(`只对类别「${(p.appliesTo as string[]).join('、')}」有意义`)
  }
  return parts.join('；')
}

export interface WriteTargets {
  /** 允许写入的存储键（内置非隐藏列 + 作者放开 AI 填写的自定义字段） */
  keys: string[]
  /** 自定义字段投影（按存储键）；内置列不在里面 */
  custom: Map<string, WriteFieldProjection>
}

/**
 * 从模板取写回目标。
 *
 * 🔴 谁负责过滤：模板解析。**这里不再判断权限** ——
 *    调用方传入的是 `purpose:'aiWrite'` 的模板，自定义字段已按 `aiWritable` 筛过，
 *    隐藏内置列也已排除（实测四页签与旧口径逐字一致）。再判一次就是第二套规则。
 */
export function writeTargetsOf(template: EffectiveTemplate): WriteTargets {
  const custom = new Map<string, WriteFieldProjection>()
  for (const f of template.fields) {
    if (f.source === 'custom') custom.set(f.sourceKey, toWriteFieldProjection(f))
  }
  return { keys: template.fields.map(f => f.sourceKey), custom }
}

/**
 * 语义索引的**字段规则**（自定义字段进不进索引文本、叫什么名、对哪些类别有效）。
 *
 * 🔴 为什么必须与提示词同源：索引文本会经〖语义召回〗原样注回提示词。
 *    作者在图鉴里关掉「允许 AI 参考」之后，如果索引还能把内容捞出来，
 *    就等于开了一条**绕行通道**（3.1.3 · R04 实测复现过）。
 * 🔴 只有**自定义**字段需要规则：内置列的名字就是存储键，且没有「关掉 AI 参考」的开关。
 */
export interface IndexFieldRule {
  label: string
  aiReadable: boolean
  appliesTo: '*' | string[]
}

/**
 * 从 `purpose:'aiRead'` 的模板取索引规则。
 * 返回 `undefined` 与旧口径一致（**一条规则都没有**时让调用方走降级：把 `cf_*` 叫「自定义字段」）。
 * 🔴 注意：`aiReadable=false` 的字段**根本不会出现在模板里**（解析侧已过滤），
 *    所以这里拿到的规则 `aiReadable` 恒为 true —— 这是刻意的：缺席即不可读。
 */
export function indexRulesOf(template: EffectiveTemplate): Record<string, IndexFieldRule> | undefined {
  const map: Record<string, IndexFieldRule> = {}
  for (const f of template.fields) {
    if (f.source !== 'custom') continue
    map[f.sourceKey] = { label: f.label, aiReadable: f.permissions.aiRead, appliesTo: f.appliesTo }
  }
  return Object.keys(map).length > 0 ? map : undefined
}

/**
 * AI **输出目标**的字段集合（表格页签「AI 新增 / 补全本行 / 整理」共用）。
 *
 * 分两段是因为两者的**来源**不同、界面用法也不同：
 *   · `builtinKeys` —— 内置列（隐藏列已被模板解析排除，不用调用方再 filter）
 *   · `custom`      —— 作者放开 AI 填写的自定义字段（含类型/候选/说明，直接喂提示词与校验）
 */
export interface AiWriteFieldSet {
  builtinKeys: string[]
  custom: WriteFieldProjection[]
}

/** 从模板取 AI 输出目标（内置 + 可写自定义） */
export function aiWriteFieldsOf(template: EffectiveTemplate): AiWriteFieldSet {
  const { custom } = writeTargetsOf(template)
  return {
    builtinKeys: template.fields.filter(f => f.source === 'builtin').map(f => f.sourceKey),
    custom: [...custom.values()],
  }
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
