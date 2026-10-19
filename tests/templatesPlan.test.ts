/**
 * 3.2.0 · WT1-3：模板变更计划（planTemplateChange）测试
 *
 * 重点钉住三条铁律：
 *   1. 默认归档不删值；删除/合并/类型转换必须出现在计划里（有预览）；
 *   2. 显示名相同只产生建议，绝不自动绑定；
 *   3. 同 ID 改义 ⇒ 旧值标「待整理」，不按新语义读取。
 */
import {
  planTemplateChange, planIsNoop, diffField, isLayoutOnlyChange, valuePlanForTypeChange,
} from '@/lib/templates/plan'
import type { TemplateDef } from '@/lib/templates/definition'
import type { EffectiveField, TemplateFieldPermissions } from '@/lib/templates/types'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

function perms(over: Partial<TemplateFieldPermissions> = {}): TemplateFieldPermissions {
  return { table: true, detail: true, search: true, aiRead: true, aiWrite: false, ...over }
}

function field(over: Partial<EffectiveField> & { id: string }): EffectiveField {
  return {
    sourceKey: over.id,
    source: 'custom',
    label: over.id,
    type: 'text',
    groupId: 'default',
    order: 0,
    appliesTo: '*',
    archived: false,
    permissions: perms(),
    ...over,
  } as EffectiveField
}

function def(fields: EffectiveField[], over: Partial<TemplateDef> = {}): TemplateDef {
  return {
    formatVersion: 1,
    templateId: over.templateId ?? 'builtin:races',
    name: '模板',
    tabId: 'races',
    origin: { kind: 'builtin' },
    groups: [{ id: 'default', label: '默认', order: 0 }],
    fields,
    nameFieldId: fields[0]?.id ?? '',
    semanticDigest: over.semanticDigest ?? 'digest-base',
    revision: 0,
    updatedAt: 0,
    ...over,
  }
}

const NAME_F = field({ id: 'cf_name', label: '名称' })
const DIET_F = field({ id: 'cf_diet', label: '食性', type: 'select', options: ['肉食', '草食', '杂食'] })
const NOTE_F = field({ id: 'cf_note', label: '备注', type: 'textarea' })

// ── ① 无变化 ⇒ no-op（幂等） ──
{
  const from = def([NAME_F, DIET_F])
  const to = def([NAME_F, DIET_F])
  const plan = planTemplateChange(from, to)
  ok('① 完全相同 ⇒ no-op', planIsNoop(plan))
  ok('① 无阻断无提示', plan.blockers.length === 0 && plan.warnings.length === 0)
  ok('① 全部 kept', plan.summary.kept === 2 && plan.summary.archived === 0)
}

// ── ② 只换分组（布局）⇒ no-op，值仍有效 ──
{
  const moved = { ...DIET_F, groupId: 'g2' }
  const from = def([NAME_F, DIET_F])
  const to = def([NAME_F, moved], {
    groups: [
      { id: 'default', label: '默认', order: 0 },
      { id: 'g2', label: '生态', order: 1 },
    ],
  })
  const plan = planTemplateChange(from, to)
  ok('② 仅分组变化 ⇒ no-op', planIsNoop(plan))
  const item = plan.items.find(i => i.fromId === 'cf_diet')
  ok('② 分组变化不致使值失效', item?.valuePlan === 'keep', JSON.stringify(item))
  ok('② isLayoutOnlyChange 认出布局变化', isLayoutOnlyChange(diffField(DIET_F, moved)))
}

// ── ③ 新增字段 ──
{
  const from = def([NAME_F])
  const to = def([NAME_F, DIET_F])
  const plan = planTemplateChange(from, to)
  ok('③ 新增字段计 added', plan.summary.added === 1)
  ok('③ 新增不影响既有值', plan.items.find(i => i.toId === 'cf_diet')?.valuePlan === 'keep')
  ok('③ 有新增 ⇒ 不是 no-op', !planIsNoop(plan))
}

// ── ④ 删除字段 ⇒ 默认归档不删值 ──
{
  const from = def([NAME_F, DIET_F, NOTE_F])
  const to = def([NAME_F])
  const plan = planTemplateChange(from, to)
  const diet = plan.items.find(i => i.fromId === 'cf_diet')
  ok('④ 消失的字段 ⇒ 归档', diet?.disposition === 'archived', JSON.stringify(diet))
  ok('④ 归档 ⇒ 值原地保留', diet?.valuePlan === 'archive-keep')
  ok('④ 归档不产生 blocker（作者无需介入也能执行）', plan.blockers.length === 0)
  ok('④ 归档是预览的一部分（有计划条目）', plan.summary.archived === 2)
}

// ── ⑤ 显示名相同但 ID 不同 ⇒ 只建议，不绑定 ──
{
  const renamed = field({ id: 'cf_diet2', label: '食性', type: 'select', options: ['肉食', '草食'] })
  const from = def([NAME_F, DIET_F])
  const to = def([NAME_F, renamed])
  const plan = planTemplateChange(from, to)
  const diet = plan.items.find(i => i.fromId === 'cf_diet')
  ok('⑤ 同名不同 ID ⇒ suggested-map（不自动合并）', diet?.disposition === 'suggested-map', JSON.stringify(diet))
  ok('⑤ 建议目标已记录', diet?.suggestedTargetId === 'cf_diet2')
  ok('⑤ 建议项的值处置是 manual（须作者确认）', diet?.valuePlan === 'manual')
  ok('⑤ 同名建议进 warnings', plan.warnings.some(w => w.code === 'same-label-suggestion'))
  ok('⑤ 同名建议不阻断执行', plan.blockers.length === 0)
}

// ── ⑥ 多个同名 ⇒ 连建议都给不出，阻断 ──
{
  const a = field({ id: 'cf_diet2', label: '食性' })
  const b = field({ id: 'cf_diet3', label: '食性' })
  const from = def([NAME_F, DIET_F])
  const to = def([NAME_F, a, b])
  const plan = planTemplateChange(from, to)
  const diet = plan.items.find(i => i.fromId === 'cf_diet')
  ok('⑥ 多个同名 ⇒ 按归档处理', diet?.disposition === 'archived', JSON.stringify(diet))
  ok('⑥ 多个同名 ⇒ blocker（歧义必须作者先消除）', plan.blockers.some(x => x.code === 'same-label-ambiguous'))
  ok('⑥ 不给建议目标', diet?.suggestedTargetId === undefined)
}

// ── ⑦ 同 ID 改义 ⇒ 旧值标待整理，不按新语义读 ──
{
  const retyped = { ...DIET_F, type: 'text' as const }
  const from = def([NAME_F, DIET_F])
  // 🔴 桩里刻意给不同摘要：真实数据中类型一变摘要必变，这里显式建模
  const to = def([NAME_F, retyped], { semanticDigest: 'digest-v2' })
  const plan = planTemplateChange(from, to)
  const diet = plan.items.find(i => i.fromId === 'cf_diet')
  ok('⑦ 同 ID 改类型 ⇒ kept-modified', diet?.disposition === 'kept-modified')
  ok('⑦ 单选转文本 ⇒ convert（无损）', diet?.valuePlan === 'convert', JSON.stringify(diet))
  ok('⑦ 类型变化 ⇒ 双重提示（转换 + 改义待整理）',
    plan.warnings.some(w => w.code === 'value-needs-conversion')
    && plan.warnings.some(w => w.code === 'type-changed'))
  ok('⑦ 语义摘要变化 ⇒ 索引/候选失效提示', plan.semanticChanged && plan.warnings.some(w => w.code === 'semantic-digest-changed'))
}

// ── ⑧ 类型转换矩阵 ──
{
  const c = (a: Parameters<typeof valuePlanForTypeChange>[0], b: Parameters<typeof valuePlanForTypeChange>[1]) =>
    valuePlanForTypeChange(a, b).plan
  ok('⑧ 短文本→长文本 convert', c('text', 'textarea') === 'convert')
  ok('⑧ 长文本→短文本 manual（可能截断）', c('textarea', 'text') === 'manual')
  ok('⑧ 数字→文本 convert', c('number', 'text') === 'convert')
  ok('⑧ 文本→数字 convert（逐值校验）', c('text', 'number') === 'convert')
  ok('⑧ 多选↔单选 manual', c('multiSelect', 'select') === 'manual' && c('select', 'multiSelect') === 'manual')
  ok('⑧ 布尔→文本 convert', c('boolean', 'text') === 'convert')
  ok('⑧ 引用类型变化 manual', c('character', 'characters') === 'manual' && c('text', 'tableRef') === 'manual')
  ok('⑧ 日期/历法 manual', c('date', 'text') === 'manual' && c('text', 'calendar') === 'manual')
  ok('⑧ 未识别类型 manual', c('other', 'text') === 'manual' && c('text', 'other') === 'manual')
}

// ── ⑨ 选项收缩 ⇒ 警告 ──
{
  const shrunk = { ...DIET_F, options: ['肉食'] }
  const from = def([NAME_F, DIET_F])
  const to = def([NAME_F, shrunk])
  const plan = planTemplateChange(from, to)
  const w = plan.warnings.find(x => x.code === 'options-shrunk')
  ok('⑨ 选项减少 ⇒ options-shrunk 警告', Boolean(w), JSON.stringify(plan.warnings.map(x => x.code)))
  ok('⑨ 警告列出丢失的选项', Boolean(w?.detail.includes('草食') && w?.detail.includes('杂食')))
}

// ── ⑩ 封闭枚举收紧 ──
{
  const fixed = { ...DIET_F, fixedOptions: true }
  const from = def([NAME_F, DIET_F])
  const to = def([NAME_F, fixed])
  const plan = planTemplateChange(from, to)
  ok('⑩ 改封闭枚举 ⇒ 能力收紧提示', plan.warnings.some(x => x.code === 'capability-tightened'))
  ok('⑩ 封闭枚举变化进 diff 明细',
    diffField(DIET_F, fixed).some(c => c.aspect === 'fixedOptions'))
}

// ── ⑪ AI 权限变化如实上报（不代为judgement） ──
{
  const opened = { ...DIET_F, permissions: perms({ aiWrite: true }) }
  const from = def([NAME_F, DIET_F])
  const to = def([NAME_F, opened])
  const plan = planTemplateChange(from, to)
  ok('⑪ 新开放 AI 填写 ⇒ ai-write-opened', plan.warnings.some(x => x.code === 'ai-write-opened'))

  const closed = { ...DIET_F, permissions: perms({ aiRead: false }) }
  const plan2 = planTemplateChange(def([NAME_F, DIET_F]), def([NAME_F, closed]))
  ok('⑪ 关掉 AI 参考 ⇒ ai-read-tightened（已存值不再进上下文）',
    plan2.warnings.some(x => x.code === 'ai-read-tightened'))

  const noWrite = { ...DIET_F, permissions: perms({ aiWrite: true }) }
  const plan3 = planTemplateChange(def([NAME_F, noWrite]), def([NAME_F, DIET_F]))
  ok('⑪ 收回 AI 填写 ⇒ ai-write-tightened', plan3.warnings.some(x => x.code === 'ai-write-tightened'))
}

// ── ⑫ 阻断项：名称字段缺失 / 重复 ID / 分组缺失 / 未知类型 ──
{
  const plan = planTemplateChange(def([NAME_F]), def([{ ...DIET_F, label: '食性' }], { nameFieldId: 'cf_gone' }))
  ok('⑫ 名称字段丢失 ⇒ blocker', plan.blockers.some(x => x.code === 'name-field-missing'))
  ok('⑫ 名称字段无效标记', !plan.nameFieldValid)

  const dup = def([NAME_F, { ...DIET_F, id: 'cf_name', label: '重名' }])
  ok('⑫ 字段 ID 重复 ⇒ blocker', planTemplateChange(def([NAME_F]), dup).blockers.some(x => x.code === 'duplicate-field-id'))

  const badGroup = def([NAME_F, { ...DIET_F, groupId: 'ghost' }])
  ok('⑫ 引用不存在分组 ⇒ blocker', planTemplateChange(def([NAME_F]), badGroup).blockers.some(x => x.code === 'group-missing'))

  const weird = def([NAME_F, field({ id: 'cf_x', type: 'other' })])
  ok('⑫ 未知类型 ⇒ blocker（只读且不自动写）', planTemplateChange(def([NAME_F]), weird).blockers.some(x => x.code === 'unknown-type'))
}

// ── ⑬ from=null（首次采用模板） ──
{
  const to = def([NAME_F, DIET_F])
  const plan = planTemplateChange(null, to)
  ok('⑬ 首次采用 ⇒ 全部 added', plan.summary.added === 2 && plan.summary.archived === 0)
  ok('⑬ 首次采用 ⇒ 语义变化（索引要重建）', plan.semanticChanged)
  ok('⑬ 首次采用 ⇒ 永远不是 no-op', !planIsNoop(plan))
  ok('⑬ fromTemplateId 记 <none>', plan.fromTemplateId === '<none>')
}

// ── ⑭ 值规模统计 ──
{
  const from = def([NAME_F, DIET_F, NOTE_F])
  const to = def([NAME_F])
  const withCounts = planTemplateChange(from, to, { valueCounts: { cf_name: 10, cf_diet: 7, cf_note: 0 } })
  ok('⑭ 受影响字段数', withCounts.affectedFieldCount === 3, String(withCounts.affectedFieldCount))
  ok('⑭ 受影响条目总数', withCounts.affectedValueCount === 17, String(withCounts.affectedValueCount))
  ok('⑭ 传了 valueCounts ⇒ 规模已知', withCounts.valueScaleKnown)
  const noCounts = planTemplateChange(from, to)
  ok('⑭ 没传 ⇒ 规模未知（不是「无影响」）', !noCounts.valueScaleKnown && noCounts.affectedValueCount === 0)
}

// ── ⑮ 归档字段复活 ──
{
  const archived = { ...DIET_F, archived: true }
  const from = def([NAME_F, archived])
  const to = def([NAME_F, { ...DIET_F, archived: false }])
  const plan = planTemplateChange(from, to)
  const diet = plan.items.find(i => i.fromId === 'cf_diet')
  ok('⑮ 取消归档 ⇒ kept-modified', diet?.disposition === 'kept-modified')
  ok('⑮ 复活记录 archived 变化', Boolean(diet?.changes.some(c => c.aspect === 'archived')))
}

// ── ⑯ 纯布局 + 同名歧义并存时不误判 no-op ──
{
  const from = def([NAME_F, DIET_F])
  const to = def([NAME_F, { ...DIET_F, groupId: 'g2' }], {
    groups: [
      { id: 'default', label: '默认', order: 0 },
      { id: 'g2', label: '生态', order: 1 },
    ],
  })
  ok('⑯ 纯布局变化仍是 no-op', planIsNoop(planTemplateChange(from, to)))

  const ambiguous = planTemplateChange(def([NAME_F, DIET_F]),
    def([NAME_F, field({ id: 'cf_d2', label: '食性' }), field({ id: 'cf_d3', label: '食性' })]))
  ok('⑯ 有 blocker ⇒ 不是 no-op', !planIsNoop(ambiguous))
}

// ── ⑰ diffField 明细 ──
{
  const changes = diffField(NAME_F, { ...NAME_F, label: '称呼', description: '记录主名', unit: '个' })
  ok('⑰ 标签变化入明细', changes.some(c => c.aspect === 'label' && c.to === '称呼'))
  ok('⑰ 说明变化入明细', changes.some(c => c.aspect === 'description'))
  ok('⑰ 单位变化入明细', changes.some(c => c.aspect === 'unit'))
  ok('⑰ 无变化 ⇒ 空数组', diffField(NAME_F, { ...NAME_F }).length === 0)
}

console.log(`\ntemplatesPlan: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
