/**
 * 3.2.0 · T1：**采用模板 → 页面结构**的映射（纯函数）
 *
 * 数据层已经有 `resolveTemplateForTab()`，但页面今天仍直接读 `tab.columns` /
 * `tab.modules`。本文件补上最后一跳：把模板字段翻译成表格列、卡片模块、图鉴分组，
 * 让「采用模板」在页面上真正生效，而不是只写进 settingsKV。
 *
 * 🔴 存储键只有一个来源：`EffectiveField.sourceKey`。
 *    内置字段的 `sourceKey` 就是原列名 / `模块名::字段名`，自定义字段是 `cf_*`；
 *    改名只改 `label`，这里绝不按显示名去找列。
 *
 * 🔴 内置列仍然不挂 `atlasField`（不走新控件）——只有 `source === 'custom'` 才挂。
 *    这保住 3.1.3 的边界：新控件只服务自定义字段，不改内置列的编辑手感。
 */
import type { TabDef, TableColumn } from '@/lib/types'
import type { AtlasColumn } from '@/lib/atlas/columns'
import { customColumnWidth } from '@/lib/atlas/columns'
import type { ResolvedAtlasField } from '@/lib/atlas/types'
import { customTypeOf } from './consumers'
import type { EffectiveField, EffectiveGroup, EffectiveTemplate, TemplateFieldType } from './types'

/** 模板类型 → 表格列类型（`other` 不映射，沿用原列 / 文本） */
const COL_TYPE_OF: Partial<Record<TemplateFieldType, TableColumn['type']>> = {
  text: 'text',
  textarea: 'textarea',
  number: 'number',
  select: 'select',
  multiSelect: 'text',
  boolean: 'select',
  date: 'date',
  calendar: 'calendar',
  tableRef: 'tableRef',
  character: 'character',
  characters: 'characters',
}

/** 字段 → 图鉴解析结构（图鉴视图 / 卡片自定义控件共用） */
export function atlasFieldOfTemplate(f: EffectiveField): ResolvedAtlasField {
  const customType = customTypeOf(f)
  return {
    key: f.sourceKey,
    label: f.label,
    source: f.source,
    ...(customType ? { customType } : { builtinType: f.type }),
    groupId: f.groupId,
    order: f.order,
    ...(f.unit ? { unit: f.unit } : {}),
    ...(f.description ? { description: f.description } : {}),
    ...(f.options ? { options: f.options } : {}),
    ...(f.fixedOptions ? { fixedOptions: true } : {}),
    tableVisible: f.permissions.table,
    detailVisible: f.permissions.detail,
    searchable: f.permissions.search,
    aiReadable: f.permissions.aiRead,
    aiWritable: f.permissions.aiWrite,
    appliesTo: f.appliesTo,
  }
}

function sortedFields(fields: readonly EffectiveField[]): EffectiveField[] {
  return [...fields].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * 模板 → 表格列。
 *
 * 内置列沿用原列的宽度 / 历法 / 跨表引用等属性，只覆盖显示名与顺序；
 * 自定义列按六类型生成控件类型（真正控件仍由 `atlasField` 决定）。
 */
export function tableColumnsOfTemplate(tab: TabDef, tpl: EffectiveTemplate): AtlasColumn[] {
  const baseByName = new Map((tab.columns ?? []).map(c => [c.name, c]))
  return sortedFields(tpl.fields).map(f => {
    const base = baseByName.get(f.sourceKey)
    const customType = customTypeOf(f)
    const cols: AtlasColumn = {
      ...(base ?? {}),
      name: f.sourceKey,
      templateLabel: f.label,
      type: COL_TYPE_OF[f.type] ?? base?.type ?? 'text',
      ...(f.options ? { options: f.options } : base?.options ? { options: base.options } : {}),
      ...(f.fixedOptions ? { fixedOptions: true } : {}),
      ...(f.description ? { tip: f.description } : base?.tip ? { tip: base.tip } : {}),
    }
    if (customType) {
      cols.type = COL_TYPE_OF[f.type] ?? 'text'
      cols.atlasField = atlasFieldOfTemplate(f)
      cols.width = base?.width ?? `${customColumnWidth(customType)}px`
    }
    return cols
  })
}

// ────────────────────────── 卡片 ──────────────────────────

export interface CardFieldView {
  /** 存储键（`模块名::字段名` / `cf_*`） */
  key: string
  /**
   * 内置字段的**原字段名**（`卡片::所属势力` 的第二段）。
   * 只用于 `CARD_SELECT_FIELDS` / `CARD_TABLE_REF_FIELDS` 这类既有业务映射；
   * 自定义字段为空串。
   */
  name: string
  label: string
  desc?: string
  example?: string
  source: EffectiveField['source']
  type: TemplateFieldType
  /** 下拉候选（模板里把内置字段改成 select 时，页面要按它渲染） */
  options?: string[]
  /** 自定义字段的控件类型（内置字段为 undefined） */
  customType?: ReturnType<typeof customTypeOf>
  /** 自定义字段的图鉴结构（给 `AtlasCellInput` 用） */
  atlasField?: ResolvedAtlasField
}

export interface CardGroupView {
  id: string
  label: string
  order: number
  /** 是否「基础信息」组（立绘列只在这一组渲染） */
  isBasic: boolean
  fields: CardFieldView[]
}

function baseCardFieldOf(tab: TabDef, key: string): { name: string; desc?: string; example?: string } {
  for (const m of tab.modules ?? []) {
    for (const f of m.fields) {
      if (`${m.name}::${f.name}` === key) {
        return { name: f.name, ...(f.desc ? { desc: f.desc } : {}), ...(f.example ? { example: f.example } : {}) }
      }
    }
  }
  return { name: '' }
}

/** 模板 → 卡片分组（按分组排序，组内按字段 order） */
export function cardGroupsOfTemplate(tab: TabDef, tpl: EffectiveTemplate): CardGroupView[] {
  const groups = new Map<string, EffectiveGroup>()
  for (const g of tpl.groups) groups.set(g.id, g)
  const byGroup = new Map<string, EffectiveField[]>()
  for (const f of sortedFields(tpl.fields)) {
    const arr = byGroup.get(f.groupId) ?? []
    arr.push(f)
    byGroup.set(f.groupId, arr)
  }
  // 字段引用了模板里没有的分组时补一个，避免字段凭空消失
  for (const id of byGroup.keys()) {
    if (!groups.has(id)) groups.set(id, { id, label: id, order: Number.MAX_SAFE_INTEGER })
  }

  return [...groups.values()]
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(g => {
      const fields = (byGroup.get(g.id) ?? []).map(f => {
        const base: { name: string; desc?: string; example?: string } =
          f.source === 'builtin' ? baseCardFieldOf(tab, f.sourceKey) : { name: '' }
        const customType = customTypeOf(f)
        return {
          key: f.sourceKey,
          name: base.name,
          label: f.label,
          ...(f.description ?? base.desc ? { desc: f.description ?? base.desc } : {}),
          ...(f.example ?? base.example ? { example: f.example ?? base.example } : {}),
          source: f.source,
          type: f.type,
          ...(f.options ? { options: [...f.options] } : {}),
          ...(customType ? { customType } : {}),
          ...(customType ? { atlasField: atlasFieldOfTemplate(f) } : {}),
        }
      })
      return {
        id: g.id,
        label: g.label,
        order: g.order,
        isBasic: g.label.includes('基础信息'),
        fields,
      }
    })
    .filter(g => g.fields.length > 0)
}

// ────────────────────────── 图鉴视图 ──────────────────────────

/** 模板 → 图鉴字段清单（已按用途筛过；调用方再按条目类别判 `appliesTo`） */
export function atlasFieldsOfTemplate(tpl: EffectiveTemplate): ResolvedAtlasField[] {
  return sortedFields(tpl.fields).map(atlasFieldOfTemplate)
}

/** 模板 → 图鉴详情分组 */
export function atlasSectionsOfTemplate(tpl: EffectiveTemplate): { id: string; label: string; fields: ResolvedAtlasField[] }[] {
  const byGroup = new Map<string, ResolvedAtlasField[]>()
  for (const f of atlasFieldsOfTemplate(tpl)) {
    const arr = byGroup.get(f.groupId) ?? []
    arr.push(f)
    byGroup.set(f.groupId, arr)
  }
  return [...tpl.groups]
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(g => ({ id: g.id, label: g.label, fields: byGroup.get(g.id) ?? [] }))
    .filter(s => s.fields.length > 0)
}
