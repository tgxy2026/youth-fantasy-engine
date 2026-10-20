/**
 * 3.2.0 · T1：模板草稿的**纯编辑操作**
 *
 * 编辑器只改内存里的 `TemplateDef`，点「采用」后才走迁移写库。
 * 所有操作返回新对象（不原地改），这样「还原改动」＝回到上一份草稿引用即可。
 *
 * 🔴 删除一律做成**归档**：方案 §3.6「默认归档，不删除旧值」。
 *    归档字段留在 `def.fields` 里（计入额度），只是常规解析不展示；恢复时原样回来。
 * 🔴 字段 ID / `sourceKey` 创建后永不变；改名只动 `label`。
 */
import { uid } from '@/lib/app/id'
import { nameFieldOf } from './snapshot'
import { semanticDigestOf } from './legacyAdapter'
import type { TemplateDef } from './definition'
import type {
  EffectiveField, EffectiveGroup, TemplateFieldPermissions, TemplateFieldType,
} from './types'

export const NEW_GROUP_PREFIX = 'g_'

export function orderedGroups(def: TemplateDef): EffectiveGroup[] {
  return [...def.groups].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function fieldsOfGroup(def: TemplateDef, groupId: string): EffectiveField[] {
  return def.fields
    .filter(f => f.groupId === groupId)
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** 当前最大 order（新增字段/分组追加在末尾） */
function nextOrderOf(items: readonly { order: number }[]): number {
  return items.reduce((max, x) => Math.max(max, x.order), -1) + 1
}

/** 重算摘要、名称字段与修订号；每次「采用」前都要过这一道 */
export function finalizeTemplateDef(
  def: TemplateDef,
  opts: { revision?: number; updatedAt?: number } = {},
): TemplateDef {
  const validName = def.fields.some(f => f.id === def.nameFieldId && !f.archived)
  const nameFieldId = validName ? def.nameFieldId : nameFieldOf(def.fields)
  return {
    ...def,
    nameFieldId,
    semanticDigest: semanticDigestOf(def.fields),
    revision: opts.revision ?? def.revision,
    updatedAt: opts.updatedAt ?? Date.now(),
  }
}

export function renameTemplate(def: TemplateDef, name: string): TemplateDef {
  return { ...def, name }
}

export function setNameField(def: TemplateDef, fieldId: string): TemplateDef {
  return { ...def, nameFieldId: fieldId }
}

// ────────────────────────── 字段 ──────────────────────────

export interface NewFieldInput {
  label: string
  type: TemplateFieldType
  groupId: string
  /** 测试可固定 ID；生产不传 */
  id?: string
}

/** 新建一个自定义字段（ID 创建后不变，同时是存储键） */
export function addCustomField(def: TemplateDef, input: NewFieldInput): { def: TemplateDef; field: EffectiveField } {
  const id = input.id ?? `cf_${uid()}`
  const field: EffectiveField = {
    id,
    sourceKey: id,
    source: 'custom',
    label: input.label,
    type: input.type,
    groupId: input.groupId,
    order: nextOrderOf(fieldsOfGroup(def, input.groupId)),
    appliesTo: '*',
    archived: false,
    permissions: { table: true, detail: true, search: true, aiRead: true, aiWrite: false },
  }
  return { def: { ...def, fields: [...def.fields, field] }, field }
}

export type EditableFieldPatch = Partial<Pick<
  EffectiveField,
  'label' | 'description' | 'example' | 'unit' | 'type' | 'options' | 'appliesTo' | 'fixedOptions' | 'groupId'
>>

/** 改一个字段（只合并给出键；`undefined` 表示"删掉该可选键"） */
export function patchField(def: TemplateDef, fieldId: string, patch: EditableFieldPatch): TemplateDef {
  return {
    ...def,
    fields: def.fields.map(f => {
      if (f.id !== fieldId) return f
      const next: EffectiveField = { ...f, ...patch }
      if ('description' in patch && !patch.description) delete next.description
      if ('example' in patch && !patch.example) delete next.example
      if ('unit' in patch && !patch.unit) delete next.unit
      if ('options' in patch && !patch.options) delete next.options
      if ('fixedOptions' in patch && !patch.fixedOptions) delete next.fixedOptions
      return next
    }),
  }
}

export function setFieldPermissions(
  def: TemplateDef,
  fieldId: string,
  patch: Partial<TemplateFieldPermissions>,
): TemplateDef {
  return {
    ...def,
    fields: def.fields.map(f => (
      f.id === fieldId ? { ...f, permissions: { ...f.permissions, ...patch } } : f
    )),
  }
}

/** 归档（＝作者口中的"删除"；字段与值都留着） */
export function archiveField(def: TemplateDef, fieldId: string): TemplateDef {
  return {
    ...def,
    fields: def.fields.map(f => (f.id === fieldId ? { ...f, archived: true } : f)),
  }
}

export function restoreField(def: TemplateDef, fieldId: string): TemplateDef {
  return {
    ...def,
    fields: def.fields.map(f => (f.id === fieldId ? { ...f, archived: false } : f)),
  }
}

/** 组内上移 / 下移（只换 order，不碰 ID / 分组） */
export function moveField(def: TemplateDef, fieldId: string, delta: -1 | 1): TemplateDef {
  const field = def.fields.find(f => f.id === fieldId)
  if (!field) return def
  const list = fieldsOfGroup(def, field.groupId)
  const at = list.findIndex(f => f.id === fieldId)
  const to = at + delta
  if (at < 0 || to < 0 || to >= list.length) return def
  const a = list[at]
  const b = list[to]
  const orderA = a.order
  const orderB = b.order
  return {
    ...def,
    fields: def.fields.map(f => (
      f.id === a.id ? { ...f, order: orderB } : f.id === b.id ? { ...f, order: orderA } : f
    )),
  }
}

/** 换分组（追加到目标组末尾） */
export function moveFieldToGroup(def: TemplateDef, fieldId: string, groupId: string): TemplateDef {
  if (!def.groups.some(g => g.id === groupId)) return def
  const order = nextOrderOf(fieldsOfGroup(def, groupId))
  return {
    ...def,
    fields: def.fields.map(f => (f.id === fieldId ? { ...f, groupId, order } : f)),
  }
}

// ────────────────────────── 分组 ──────────────────────────

export function addGroup(def: TemplateDef, label: string, id?: string): TemplateDef {
  const group: EffectiveGroup = {
    id: id ?? `${NEW_GROUP_PREFIX}${uid()}`,
    label,
    order: nextOrderOf(def.groups),
  }
  return { ...def, groups: [...def.groups, group] }
}

export function renameGroup(def: TemplateDef, groupId: string, label: string): TemplateDef {
  return {
    ...def,
    groups: def.groups.map(g => (g.id === groupId ? { ...g, label } : g)),
  }
}

/**
 * 删分组：**不删字段**，把它们挪到第一个剩下的分组。
 * 🔴 没有分组可挪时拒绝删除（返回原对象），否则字段会引用一个不存在的分组，
 *    计划层会以 `group-missing` 阻断，作者却看不出是自己刚删掉了它。
 */
export function removeGroup(def: TemplateDef, groupId: string): TemplateDef {
  const rest = def.groups.filter(g => g.id !== groupId)
  if (rest.length === 0 || def.groups.length <= 1) return def
  const target = rest[0]
  const base = nextOrderOf(fieldsOfGroup(def, target.id))
  let i = 0
  return {
    ...def,
    groups: rest,
    fields: def.fields.map(f => (
      f.groupId === groupId ? { ...f, groupId: target.id, order: base + i++ } : f
    )),
  }
}

export function moveGroup(def: TemplateDef, groupId: string, delta: -1 | 1): TemplateDef {
  const list = orderedGroups(def)
  const at = list.findIndex(g => g.id === groupId)
  const to = at + delta
  if (at < 0 || to < 0 || to >= list.length) return def
  const a = list[at]
  const b = list[to]
  return {
    ...def,
    groups: def.groups.map(g => (
      g.id === a.id ? { ...g, order: b.order } : g.id === b.id ? { ...g, order: a.order } : g
    )),
  }
}
