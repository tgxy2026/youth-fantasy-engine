// 3.2.0 · T1：模板 → 页面结构（render.ts）的映射口径
//
// 这一层是「采用模板」在页面上真正生效的最后一跳。重点证明三件事：
//   · 存储键只认 `sourceKey`（改名只改显示名，不碰值所在的位置）；
//   · 内置字段不挂新控件（`atlasField` 只给 custom），保住 3.1.3 的编辑手感；
//   · 分组 / 顺序 / 基础组判据与模板定义逐项一致，且归档字段不出现在页面结构里。
import { TABS } from '@/lib/schema'
import { snapshotOfBuiltin } from '@/lib/templates/snapshot'
import {
  addCustomField, addGroup, archiveField, finalizeTemplateDef, orderedGroups, patchField,
  setFieldPermissions, setNameField,
} from '@/lib/templates/draftOps'
import { resolveTemplateForTab } from '@/lib/templates/resolve'
import {
  atlasFieldsOfTemplate, atlasSectionsOfTemplate, cardGroupsOfTemplate, tableColumnsOfTemplate,
} from '@/lib/templates/render'
import type { TemplateDef } from '@/lib/templates/definition'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const tabOf = (id: string) => {
  const t = TABS.find(x => x.id === id)
  if (!t) throw new Error('找不到页签 ' + id)
  return t
}

/** 在模板末尾加一个分组 + 一个自定义多选字段（带选项 / 说明 / 示例） */
function withCustom(def: TemplateDef): { def: TemplateDef; fieldId: string; groupId: string } {
  const d1 = addGroup(def, '战斗数据')
  const groupId = orderedGroups(d1)[orderedGroups(d1).length - 1].id
  const r = addCustomField(d1, { label: '弱点', type: 'multiSelect', groupId })
  const fieldId = r.field.id
  const d2 = patchField(r.def, fieldId, {
    description: '受哪些属性克制',
    example: '火、雷',
    options: ['火', '冰', '雷'],
  })
  const d3 = setFieldPermissions(d2, fieldId, { aiWrite: true })
  return { def: d3, fieldId, groupId }
}

// ---------- ① 表格列：sourceKey / templateLabel / 控件 ----------
{
  const tab = tabOf('races')
  const base = snapshotOfBuiltin(tab)
  const { def, fieldId } = withCustom(base)
  const to = finalizeTemplateDef(def, { revision: 1 })
  const tpl = resolveTemplateForTab(tab, { def: to, purpose: 'table', ignoreAppliesTo: true })
  const cols = tableColumnsOfTemplate(tab, tpl)

  const byKey = new Map(cols.map(c => [c.name, c]))
  const sourceKeyOk = tpl.fields.every(f => byKey.has(f.sourceKey))
  ok('① 每一列都按 sourceKey 落位（改名不动存储键）', sourceKeyOk && cols.length === tpl.fields.length)

  const custom = byKey.get(def.fields.find(f => f.id === fieldId)!.sourceKey)
  ok('① 自定义字段挂 atlasField（六类型控件）', !!custom?.atlasField && custom.atlasField.customType === 'multiSelect')
  ok('① 自定义字段的候选值带进列结构', JSON.stringify(custom?.atlasField?.options) === JSON.stringify(['火', '冰', '雷']))
  ok('① 自定义列类型 = text（多选按文本存）', custom?.type === 'text')

  const builtin = cols.find(c => c.name === tab.displayCol)
  ok('① 内置列不挂 atlasField（老编辑手感不变）', !!builtin && !builtin.atlasField)
  ok('① 内置列带 templateLabel（显示名由模板给）',
    !!builtin && builtin.templateLabel === tpl.fields.find(f => f.sourceKey === builtin.name)?.label)

  // 改显示名：存储键不动
  const renamed = patchField(to, tpl.fields.find(f => f.sourceKey === tab.displayCol)!.id, { label: '条目名' })
  const tpl2 = resolveTemplateForTab(tab, { def: renamed, purpose: 'table', ignoreAppliesTo: true })
  const cols2 = tableColumnsOfTemplate(tab, tpl2)
  const renamedCol = cols2.find(c => c.name === tab.displayCol)
  ok('① 改名后列键仍是原列名', !!renamedCol && renamedCol.templateLabel === '条目名')
}

// ---------- ② 卡片分组：基础组 / 自定义控件 / 选项 ----------
{
  const tab = tabOf('char-main')
  const base = snapshotOfBuiltin(tab)
  const { def, fieldId, groupId } = withCustom(base)
  const to = finalizeTemplateDef(def, { revision: 1 })
  const tpl = resolveTemplateForTab(tab, { def: to, purpose: 'detail', ignoreAppliesTo: true })
  const groups = cardGroupsOfTemplate(tab, tpl)

  ok('② 分组数 = 模板分组数（只保留有字段的组）', groups.length === tpl.groups.filter(g => tpl.fields.some(f => f.groupId === g.id)).length)
  const basic = groups.filter(g => g.isBasic)
  ok('② 「基础信息」组被标为 isBasic（立绘列挂在它上面）', basic.length === 1 && basic[0].label.includes('基础信息'))

  const g = groups.find(x => x.id === groupId)
  const f = g?.fields.find(x => x.key === def.fields.find(z => z.id === fieldId)!.sourceKey)
  ok('② 自定义字段落在新分组里', !!f)
  ok('② 自定义字段带 atlasField + 候选值', f?.atlasField?.customType === 'multiSelect' && f?.atlasField?.options?.length === 3)
  ok('② 自定义字段的说明 / 示例传给页面', f?.desc === '受哪些属性克制' && f?.example === '火、雷')
  ok('② 自定义字段 source = custom', f?.source === 'custom')

  const builtinField = groups.flatMap(x => x.fields).find(x => x.source === 'builtin')
  ok('② 内置字段仍能解析出原字段名（特殊控件靠它匹配）', !!builtinField && builtinField.name.length > 0)
  ok('② 内置字段不挂 atlasField', !!builtinField && builtinField.atlasField === undefined)

  // 组内顺序 = 模板 order
  const orderOk = groups.every(gr => gr.fields.every((ff, i, arr) =>
    i === 0 || (tpl.fields.find(x => x.sourceKey === arr[i - 1].key)?.order ?? 0)
      <= (tpl.fields.find(x => x.sourceKey === ff.key)?.order ?? 0)))
  ok('② 组内字段按模板顺序排列', orderOk)
}

// ---------- ③ 归档字段：不进页面结构 ----------
{
  const tab = tabOf('char-main')
  const base = snapshotOfBuiltin(tab)
  const { def, fieldId } = withCustom(base)
  const archived = archiveField(finalizeTemplateDef(def), fieldId)
  const tpl = resolveTemplateForTab(tab, { def: archived, purpose: 'detail', ignoreAppliesTo: true })
  const hiddenKey = archived.fields.find(f => f.id === fieldId)!.sourceKey
  const groups = cardGroupsOfTemplate(tab, tpl)
  ok('③ 归档字段不出现在卡片结构里', groups.every(g => g.fields.every(f => f.key !== hiddenKey)))
  ok('③ 归档定义仍留在模板里（可恢复）', archived.fields.some(f => f.id === fieldId && f.archived))
}

// ---------- ④ 图鉴字段与分区（详情页） ----------
{
  const tab = tabOf('nations')
  const base = snapshotOfBuiltin(tab)
  const { def, fieldId, groupId } = withCustom(base)
  const to = finalizeTemplateDef(def, { revision: 1 })
  const tpl = resolveTemplateForTab(tab, { def: to, purpose: 'detail', ignoreAppliesTo: true })
  const fields = atlasFieldsOfTemplate(tpl)
  const sections = atlasSectionsOfTemplate(tpl)

  const custom = fields.find(f => f.key === to.fields.find(z => z.id === fieldId)!.sourceKey)
  ok('④ 图鉴字段按 sourceKey + 自定义控件输出', !!custom && custom.customType === 'multiSelect')
  ok('④ 图鉴字段保留分组 id', custom?.groupId === groupId)
  ok('④ 分区覆盖所有有字段的分组', sections.length === tpl.groups.filter(g => fields.some(f => f.groupId === g.id)).length)
  const allInSections = fields.every(f => sections.some(s => s.fields.some(x => x.key === f.key)))
  ok('④ 每个字段都能在某个分区里找到', allInSections)
}

// ---------- ⑤ 名称字段可换成自定义字段 ----------
{
  const tab = tabOf('items')
  const base = snapshotOfBuiltin(tab)
  const { def, fieldId } = withCustom(base)
  const to = setNameField(def, fieldId)
  const field = to.fields.find(f => f.id === to.nameFieldId)
  ok('⑤ nameFieldId 指向新字段，且其 sourceKey 可直接作为取值键',
    !!field && field.id === fieldId && field.sourceKey.length > 0)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
