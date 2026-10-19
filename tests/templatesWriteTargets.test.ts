// 3.2.0 · WT0-4 写回目标（`loadAtlasAiWriteTargets` 的纯函数核心）等价性
//
// 写回比读取危险得多：读错是少看一段资料，写错是把值塞进不该写的栏位。
// 所以这里的等价性必须覆盖「**不该在集合里的键**」——隐藏列、关掉 AI 填写的字段、
// 归档字段，一个都不能混进来。
import { TABS } from '@/lib/schema'
import { resolveAtlasFields } from '@/lib/atlas/schema'
import { resolveTemplateForTab } from '@/lib/templates/resolve'
import { writeTargetsOf, toWriteFieldProjection, fieldHintForAI } from '@/lib/templates/consumers'
import { coerceAiValue } from '@/lib/atlas/values'
import { effectiveFieldOfAtlas } from '@/lib/templates/legacyAdapter'
import { atlasFieldHintForAI } from '@/lib/ai/atlasContext'
import type { AtlasSchemaConfig } from '@/lib/atlas/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const ATLAS_TAB_IDS = ['races', 'items', 'nations', 'geography'] as const
const tabOf = (id: string) => {
  const t = TABS.find(x => x.id === id)
  if (!t) throw new Error('找不到页签 ' + id)
  return t
}

/** 旧口径：内置非隐藏列 + 允许 AI 填写的自定义字段 */
function legacyKeys(tab: ReturnType<typeof tabOf>, cfg: AtlasSchemaConfig | null): Set<string> {
  const builtin = (tab.columns ?? []).filter(c => !c.hidden).map(c => c.name)
  const custom = resolveAtlasFields(tab, { config: cfg, purpose: 'aiWrite', ignoreAppliesTo: true })
    .filter(f => f.source === 'custom').map(f => f.key)
  return new Set([...builtin, ...custom])
}

function mkConfig(fields: Array<Record<string, unknown>>): AtlasSchemaConfig {
  return {
    formatVersion: 1, revision: 4,
    fields: fields.map((f, i) => ({
      id: `cf_${i}`, label: String(f.label ?? `f${i}`), type: f.type ?? 'text',
      description: String(f.description ?? ''), unit: f.unit as string | undefined,
      options: (f.options as string[]) ?? [], appliesTo: (f.appliesTo as '*' | string[]) ?? '*',
      groupId: 'g1', order: i, tableVisible: true, detailVisible: true, searchable: true,
      aiReadable: true, aiWritable: f.aiWritable !== false,
      archived: f.archived === true,
    })),
    groups: [{ id: 'g1', label: '扩展', order: 0 }], builtinPresentation: {}, summaryKeys: [],
  } as unknown as AtlasSchemaConfig
}

const cfgFull = mkConfig([
  { label: '食性', type: 'text' },
  { label: '品级', type: 'select', options: ['高', '中', '低'] },
  { label: '体重', type: 'number', unit: 'kg' },
])
const cfgWithLocked = mkConfig([
  { label: '可写', type: 'text' },
  { label: '不许写', type: 'text', aiWritable: false },
  { label: '已归档', type: 'text', archived: true },
])

// ────────────────────────── ① 四页签 × 三种配置的键集合等价 ──────────────────────────
{
  for (const id of ATLAS_TAB_IDS) {
    for (const [name, cfg] of [['无配置', null], ['全可写', cfgFull], ['含禁写/归档', cfgWithLocked]] as const) {
      const tab = tabOf(id)
      const a = legacyKeys(tab, cfg)
      const tpl = resolveTemplateForTab(tab, { config: cfg, purpose: 'aiWrite', ignoreAppliesTo: true })
      const b = new Set(writeTargetsOf(tpl).keys)
      const same = a.size === b.size && [...a].every(k => b.has(k))
      ok(`① ${id} · ${name}：允许键与旧口径一致`, same,
        same ? '' : `\n legacy-only=${JSON.stringify([...a].filter(k => !b.has(k)))}\n new-only=${JSON.stringify([...b].filter(k => !a.has(k)))}`)
    }
  }
}

// ────────────────────────── ② 隐藏内置列不许写（负向）──────────────────────────
{
  const tab = tabOf('geography')
  const hidden = (tab.columns ?? []).filter(c => c.hidden).map(c => c.name)
  ok('② 前置：《地理风物》确实有隐藏列', hidden.length > 0, JSON.stringify(hidden))
  const tpl = resolveTemplateForTab(tab, { config: cfgFull, purpose: 'aiWrite', ignoreAppliesTo: true })
  const keys = new Set(writeTargetsOf(tpl).keys)
  ok('② 隐藏列不在允许键里', hidden.every(h => !keys.has(h)), JSON.stringify(hidden))
}

// ────────────────────────── ③ 禁写 / 归档字段不许写 ──────────────────────────
{
  const tpl = resolveTemplateForTab(tabOf('races'), { config: cfgWithLocked, purpose: 'aiWrite', ignoreAppliesTo: true })
  const t = writeTargetsOf(tpl)
  const keys = new Set(t.keys)
  const byLabel = (lb: string) => tpl.fields.find(f => f.label === lb)
  ok('③ 可写字段在集合里', !!byLabel('可写') && keys.has(byLabel('可写')!.sourceKey))
  ok('③ 关掉 AI 填写的字段不在集合里', !keys.has(byLabel('不许写')?.sourceKey ?? '禁写字段不存在（已被过滤）'))
  ok('③ 归档字段不在集合里', !keys.has(byLabel('已归档')?.sourceKey ?? '归档字段不存在（已被过滤）'))
  ok('③ custom 映射里也没有它', !t.custom.has(byLabel('不许写')?.sourceKey ?? ''))
  ok('③ custom 只含自定义字段（内置列不在里面）', [...t.custom.keys()].every(k => k.startsWith('cf_')))
}

// ────────────────────────── ④ 投影带够类型信息（喂给 coerceAiValue 就能用）──────────────────────────
{
  const tpl = resolveTemplateForTab(tabOf('races'), { config: cfgFull, purpose: 'aiWrite', ignoreAppliesTo: true })
  const t = writeTargetsOf(tpl)
  const grade = [...t.custom.values()].find(p => p.label === '品级')!
  ok('④ 下拉字段带候选', JSON.stringify(grade.options) === JSON.stringify(['高', '中', '低']))
  ok('④ 数值字段带单位', [...t.custom.values()].some(p => p.unit === 'kg'))
  // 真跑一次 coerceAiValue（不再只是类型层面）
  ok('④ 候选内的值被接受', coerceAiValue(grade, '高').ok === true)
  ok('④ 候选外的值被拒（不让模型瞎编）', coerceAiValue(grade, '超高').ok === false)
  const weight = [...t.custom.values()].find(p => p.unit === 'kg')!
  ok('④ 数字字段：非数字被拒', coerceAiValue(weight, '很重').ok === false)
  const numResult = coerceAiValue(weight, '3.50')
  ok('④ 数字字段：数字被接受且保留原写法', numResult.ok === true && 'value' in numResult && numResult.value === '3.50')
}

// ────────────────────────── ⑤ 内置列不带 type（不触发类型校验）──────────────────────────
{
  const tpl = resolveTemplateForTab(tabOf('races'), { config: cfgFull, purpose: 'aiWrite', ignoreAppliesTo: true })
  const builtin = tpl.fields.filter(f => f.source === 'builtin')
  ok('⑤ 内置列投影没有 type', builtin.every(f => toWriteFieldProjection(f).type === undefined))
  ok('⑤ 内置列不进 custom 映射', (() => {
    const t = writeTargetsOf(tpl)
    return builtin.every(f => !t.custom.has(f.sourceKey))
  })())
}

// ────────────────────────── ⑥ 非图鉴页签 ──────────────────────────
{
  const tab = tabOf('terms')
  const tpl = resolveTemplateForTab(tab)
  const t = writeTargetsOf(tpl)
  const expected = (tab.columns ?? []).filter(c => !c.hidden).map(c => c.name)
  ok('⑥ 非图鉴页签允许键 = 非隐藏列', JSON.stringify(t.keys) === JSON.stringify(expected))
  ok('⑥ 非图鉴页签没有自定义字段', t.custom.size === 0)
}

// ────────────────────────── ⑦ 提示文本与旧实现逐字一致 ──────────────────────────
//
// `atlasFieldHintForAI` 已改为委托到 `fieldHintForAI`。这里用**旧实现的一份副本**做对照，
// 保证"换个地方写"没有写歪 —— 提示词少一个候选值，模型就会开始瞎编。
{
  const LEGACY_TYPE_HINT: Record<string, string> = {
    text: '短文本', longText: '长文本', number: '数字', select: '单选', multiSelect: '多选', boolean: '是/否',
  }
  const legacyHint = (f: {
    customType?: string; unit?: string; options?: string[]; description?: string; appliesTo?: '*' | string[]
  }): string => {
    const parts: string[] = [LEGACY_TYPE_HINT[f.customType ?? 'text'] ?? '文本']
    if (f.unit) parts.push(`单位：${f.unit}`)
    if (f.options?.length) parts.push(`候选：${f.options.join(' / ')}`)
    if (f.description?.trim()) parts.push(f.description.trim())
    if (f.appliesTo && f.appliesTo !== '*' && f.appliesTo.length) {
      parts.push(`只对类别「${f.appliesTo.join('、')}」有意义`)
    }
    return parts.join('；')
  }

  const variants = [
    { label: '纯文本', type: 'text' },
    { label: '长文本', type: 'longText' },
    { label: '数字带单位', type: 'number', unit: '级', description: '大致战力' },
    { label: '单选带候选', type: 'select', options: ['高', '中', '低'] },
    { label: '多选带候选', type: 'multiSelect', options: ['甲', '乙'] },
    { label: '是非', type: 'boolean' },
    { label: '限类别', type: 'text', appliesTo: ['魔兽'] },
    { label: '全都有', type: 'number', unit: 'kg', options: ['1', '2'], description: '体重', appliesTo: ['魔兽', '灵族'] },
  ]
  const cfg = mkConfig(variants)
  const legacy = resolveAtlasFields(tabOf('races'), { config: cfg, purpose: 'aiWrite', ignoreAppliesTo: true })
    .filter(f => f.source === 'custom')
  ok('⑦ 前置：八个变体都解析出来了', legacy.length === variants.length, String(legacy.length))
  for (const f of legacy) {
    const proj = toWriteFieldProjection(effectiveFieldOfAtlas(f))
    const a = legacyHint(f)
    const b = fieldHintForAI(proj)
    ok(`⑦ ${f.label}：提示与旧实现逐字一致`, a === b, `\n 旧=${a}\n 新=${b}`)
    ok(`⑦ ${f.label}：旧入口也一致（已委托）`, atlasFieldHintForAI(f) === a)
  }
  // 内置列：旧实现走 customType ?? 'text' ⇒ 短文本
  const builtin = resolveAtlasFields(tabOf('races'), { config: cfg, purpose: 'aiWrite', ignoreAppliesTo: true })
    .find(f => f.source === 'builtin')!
  ok('⑦ 内置列的提示是「短文本」（不因无 customType 变「文本」）',
    fieldHintForAI(toWriteFieldProjection(effectiveFieldOfAtlas(builtin))) === '短文本')
  // 提示里不许出现 cf_ 内部键
  for (const f of legacy) ok(`⑦ ${f.label}：提示不含内部键`, !fieldHintForAI(toWriteFieldProjection(effectiveFieldOfAtlas(f))).includes('cf_'))
}

// ────────────────────────── ⑧ 投影带说明与类别范围（供提示词用）──────────────────────────
{
  const cfg = mkConfig([
    { label: '带说明', type: 'text', description: '这是什么' },
    { label: '限类别', type: 'text', appliesTo: ['魔兽'] },
  ])
  const tpl = resolveTemplateForTab(tabOf('races'), { config: cfg, purpose: 'aiWrite', ignoreAppliesTo: true })
  const custom = [...writeTargetsOf(tpl).custom.values()]
  ok('⑧ 说明透传', custom.some(p => p.description === '这是什么'))
  ok('⑧ 类别范围透传', custom.some(p => Array.isArray(p.appliesTo) && p.appliesTo.includes('魔兽')))
  ok('⑧ 不限类别的字段不写 appliesTo（不制造噪音）', custom.some(p => p.appliesTo === undefined))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
