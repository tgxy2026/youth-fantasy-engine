// 3.2.0 · WT0-4 写回目标（`loadAtlasAiWriteTargets` 的纯函数核心）等价性
//
// 写回比读取危险得多：读错是少看一段资料，写错是把值塞进不该写的栏位。
// 所以这里的等价性必须覆盖「**不该在集合里的键**」——隐藏列、关掉 AI 填写的字段、
// 归档字段，一个都不能混进来。
import { TABS } from '@/lib/schema'
import { resolveAtlasFields } from '@/lib/atlas/schema'
import { resolveTemplateForTab } from '@/lib/templates/resolve'
import { writeTargetsOf, toWriteFieldProjection } from '@/lib/templates/consumers'
import { coerceAiValue } from '@/lib/atlas/values'
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

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
