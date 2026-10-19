// 3.2.0 · WT0-4 消费者投影等价性
//
// 迁移消费者最容易出事的地方：**看着一样、实际少了一列或多格式化了一次**。
// 本文件做两件事：
//   ① 投影结果与旧的 `resolveAtlasFields(...)` 逐字段对齐（key/label/kind/unit）；
//   ② `renderTable` 用投影字段渲染出的文本与用旧字段渲染的**逐字相同**。
import { TABS } from '@/lib/schema'
import { resolveAtlasFields } from '@/lib/atlas/schema'
import { resolveTemplateForTab } from '@/lib/templates/resolve'
import { tableFieldsOf, toTableFieldProjection, aiReadableTableFieldsOf, indexRulesOf } from '@/lib/templates/consumers'
import { renderTable } from '@/lib/ai/tableRender'
import { adaptBuiltinTab } from '@/lib/templates/legacyAdapter'
import type { AtlasSchemaConfig, ResolvedAtlasField } from '@/lib/atlas/types'
import type { EffectiveField, EffectiveTemplate } from '@/lib/templates/types'

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

/** 自定义字段覆盖六类型 + 单位 + 别名要用的字段 */
function mkConfig(): AtlasSchemaConfig {
  return {
    formatVersion: 1,
    revision: 2,
    fields: [
      { id: 'cf_long', label: '长描述', type: 'longText', description: '', options: [], appliesTo: '*', groupId: 'g1', order: 0, tableVisible: true, detailVisible: true, searchable: true, aiReadable: true, aiWritable: false },
      { id: 'cf_num', label: '数量', type: 'number', description: '', unit: '只', options: [], appliesTo: '*', groupId: 'g1', order: 1, tableVisible: true, detailVisible: true, searchable: true, aiReadable: true, aiWritable: false },
      { id: 'cf_multi', label: '标签', type: 'multiSelect', description: '', options: ['甲', '乙'], appliesTo: '*', groupId: 'g1', order: 2, tableVisible: true, detailVisible: true, searchable: true, aiReadable: true, aiWritable: false },
    ],
    groups: [{ id: 'g1', label: '扩展', order: 0 }],
    builtinPresentation: {},
    summaryKeys: [],
  } as unknown as AtlasSchemaConfig
}

/** 旧口径下消费者真正拿到的四件事 */
function legacyProj(f: ResolvedAtlasField) {
  return {
    key: f.key,
    label: f.label,
    ...(f.source === 'custom' && f.customType ? { kind: f.customType } : {}),
    ...(f.unit ? { unit: f.unit } : {}),
  }
}

const cfg = mkConfig()

// ────────────────────────── ① 四页签逐字段等价 ──────────────────────────
{
  for (const id of ATLAS_TAB_IDS) {
    const tab = tabOf(id)
    const legacy = resolveAtlasFields(tab, { config: cfg, purpose: 'aiRead', ignoreAppliesTo: true }).map(legacyProj)
    const tpl = resolveTemplateForTab(tab, { config: cfg, purpose: 'aiRead', ignoreAppliesTo: true })
    const proj = aiReadableTableFieldsOf(tpl)
    const same = JSON.stringify(legacy) === JSON.stringify(proj)
    ok(`① ${id} 投影与旧字段逐项一致（含顺序）`, same,
      same ? '' : `\n legacy=${JSON.stringify(legacy)}\n proj  =${JSON.stringify(proj)}`)
  }
}

// ────────────────────────── ② 内置列不能被"格式化" ──────────────────────────
{
  const tab = tabOf('races')
  const tpl = resolveTemplateForTab(tab, { config: cfg, purpose: 'aiRead', ignoreAppliesTo: true })
  const builtin = tpl.fields.filter(f => f.source === 'builtin')
  ok('② 内置字段存在（对照组有效）', builtin.length > 0)
  ok('② 内置列一律没有 kind（渲染层不会格式化它们）', builtin.every(f => toTableFieldProjection(f).kind === undefined))
  const custom = tpl.fields.filter(f => f.source === 'custom')
  ok('② 自定义字段全部带 kind', custom.length === 3 && custom.every(f => !!toTableFieldProjection(f).kind))
}

// ────────────────────────── ③ 类型逆映射 ──────────────────────────
{
  const tpl = resolveTemplateForTab(tabOf('races'), { config: cfg, purpose: 'aiRead', ignoreAppliesTo: true })
  const byId = (id: string) => toTableFieldProjection(tpl.fields.find(f => f.id === id)!)
  ok('③ longText 往返一致', byId('cf_long').kind === 'longText')
  ok('③ multiSelect 往返一致', byId('cf_multi').kind === 'multiSelect')
  ok('③ 单位透传', byId('cf_num').unit === '只')
  ok('③ key 用存储键而不是字段 id', (() => {
    const f = tpl.fields.find(x => x.id === 'cf_num')!
    return toTableFieldProjection(f).key === f.sourceKey
  })())
}

// ────────────────────────── ④ 投影是窄接口（不多给信息）──────────────────────────
{
  const builtin: EffectiveField = {
    id: '名称', sourceKey: '名称', source: 'builtin', label: '名称', type: 'text',
    groupId: 'g', order: 0, appliesTo: '*', archived: false,
    permissions: { table: true, detail: true, search: true, aiRead: true, aiWrite: false },
  }
  const keys = Object.keys(toTableFieldProjection(builtin)).sort()
  ok('④ 投影只留 key/label（权限/类别不外泄）', JSON.stringify(keys) === JSON.stringify(['key', 'label']), JSON.stringify(keys))
  const custom = { ...builtin, source: 'custom' as const, id: 'cf_x', sourceKey: 'cf_x', type: 'textarea' as const }
  const ck = Object.keys(toTableFieldProjection(custom)).sort()
  ok('④ 自定义字段额外带 kind', JSON.stringify(ck) === JSON.stringify(['key', 'kind', 'label']), JSON.stringify(ck))
}

// ────────────────────────── ⑤ renderTable 输出逐字一致 ──────────────────────────
{
  for (const id of ATLAS_TAB_IDS) {
    const tab = tabOf(id)
    const legacy = resolveAtlasFields(tab, { config: cfg, purpose: 'aiRead', ignoreAppliesTo: true })
    const tpl = resolveTemplateForTab(tab, { config: cfg, purpose: 'aiRead', ignoreAppliesTo: true })
    const proj = aiReadableTableFieldsOf(tpl)
    // 每列都填值：多选填「甲、乙」、数字填纯数字，走各自的格式化分支
    const data: Record<string, string> = {}
    legacy.forEach((f, i) => { data[f.key] = f.customType === 'multiSelect' ? '甲、乙' : String(i + 1) })
    const rows = [{ data }]
    // 旧形状先用 legacyProj 转成投影（旧调用方必须转换，不再有 customType 兼容支）
    const legacyAsProjection = legacy.map(legacyProj)
    const a = renderTable(tab, rows, {}, legacyAsProjection)
    const b = renderTable(tab, rows, {}, proj)
    ok(`⑤ ${id} 渲染文本逐字一致`, a === b, a === b ? '' : `\n legacy=${a}\n proj  =${b}`)
    ok(`⑤ ${id} 渲染非空（对照组有效）`, b.length > 0)
  }
}

// ────────────────────────── ⑥ 不传字段时的旧行为不变 ──────────────────────────
{
  const tab = tabOf('races')
  const rows = [{ data: { 名称: '灰狼', 类别: '魔兽' } }]
  ok('⑥ 传 undefined 与传 null 行为一致',
    renderTable(tab, rows) === renderTable(tab, rows, {}, null))
  ok('⑥ 走 tab.columns 时能渲染出名称', renderTable(tab, rows).includes('灰狼'))
}

// ────────────────────────── ⑦ aiRead 兜底过滤 ──────────────────────────
{
  const mk = (read: boolean): EffectiveTemplate => ({
    templateId: 'builtin:x', version: 1, revision: 0, semanticDigest: 'd', tabId: 'races',
    purpose: 'detail', groups: [],
    fields: [{
      id: 'cf_r', sourceKey: 'cf_r', source: 'custom', label: '禁读', type: 'text',
      groupId: 'g', order: 0, appliesTo: '*', archived: false,
      permissions: { table: true, detail: true, search: true, aiRead: read, aiWrite: false },
    }],
    diagnostics: [],
  })
  ok('⑦ aiRead=false 的字段被兜底挡住', aiReadableTableFieldsOf(mk(false)).length === 0)
  ok('⑦ aiRead=true 的字段照常给出', aiReadableTableFieldsOf(mk(true)).length === 1)
}

// ────────────────────────── ⑧ 别名走 label，存储键不动 ──────────────────────────
{
  const tab = tabOf('races')
  const tpl = resolveTemplateForTab(tab, { config: cfg, purpose: 'aiRead', ignoreAppliesTo: true, aliases: { 名称: '物种名' } })
  const nameField = tpl.fields.find(f => f.sourceKey === '名称')!
  const p = toTableFieldProjection(nameField)
  ok('⑧ 别名进 label', p.label === '物种名', p.label)
  ok('⑧ 存储键不变', p.key === '名称')
  const legacy = resolveAtlasFields(tab, { config: cfg, purpose: 'aiRead', ignoreAppliesTo: true, aliases: { 名称: '物种名' } })
  ok('⑧ 与旧口径的别名结果一致',
    JSON.stringify(legacy.map(legacyProj)) === JSON.stringify(aiReadableTableFieldsOf(tpl)))
}

// ────────────────────────── ⑨ 非图鉴页签的投影 ──────────────────────────
{
  const tab = tabOf('terms')
  const tpl = adaptBuiltinTab(tab)
  const proj = tableFieldsOf(tpl)
  const expected = (tab.columns ?? []).filter(c => !c.hidden).map(c => c.name)
  ok('⑨ 非图鉴页签投影 = 非隐藏列', JSON.stringify(proj.map(p => p.key)) === JSON.stringify(expected))
  ok('⑨ 内置列没有 kind', proj.every(p => p.kind === undefined))
}

// ────────────────────────── ⑩ 语义索引规则（indexRulesOf）──────────────────────────
{
  // ① 与旧口径（`resolveAtlasFields` 手搓 map）逐项对齐 —— 索引是"提示词绕行通道"的高发区
  for (const id of ATLAS_TAB_IDS) {
    const tab = tabOf(id)
    const legacyMap: Record<string, { label: string; aiReadable: boolean; appliesTo: '*' | string[] }> = {}
    for (const f of resolveAtlasFields(tab, { config: cfg, purpose: 'aiRead', ignoreAppliesTo: true })) {
      if (f.source !== 'custom') continue
      legacyMap[f.key] = { label: f.label, aiReadable: f.aiReadable, appliesTo: f.appliesTo }
    }
    const tpl = resolveTemplateForTab(tab, { config: cfg, purpose: 'aiRead', ignoreAppliesTo: true })
    const got = indexRulesOf(tpl)
    const same = JSON.stringify(legacyMap) === JSON.stringify(got)
    ok(`⑩ ${id} 索引规则与旧口径逐项一致`, same,
      same ? '' : `\n legacy=${JSON.stringify(legacyMap)}\n got   =${JSON.stringify(got)}`)
    ok(`⑩ ${id} 对照组有效（确实有自定义字段）`, Object.keys(legacyMap).length > 0)
  }
}

// ────────────────────────── ⑪ 索引规则的边界 ──────────────────────────
{
  const mk = (fields: EffectiveField[]): EffectiveTemplate => ({
    templateId: 'builtin:x', version: 1, revision: 0, semanticDigest: 'd', tabId: 'races',
    purpose: 'aiRead', groups: [], fields, diagnostics: [],
  })
  const field = (over: Partial<EffectiveField>): EffectiveField => ({
    id: 'cf_a', sourceKey: 'cf_a', source: 'custom', label: '自定义', type: 'text',
    groupId: 'g', order: 0, appliesTo: '*', archived: false,
    permissions: { table: true, detail: true, search: true, aiRead: true, aiWrite: false },
    ...over,
  })

  // 🔴 内置字段不进规则：内置列没有「关掉 AI 参考」的开关，名字就是存储键，交给原逻辑处理
  const onlyBuiltin = mk([field({ id: '名称', sourceKey: '名称', source: 'builtin', label: '名称' })])
  ok('⑪ 只有内置字段 ⇒ undefined（走降级）', indexRulesOf(onlyBuiltin) === undefined)

  // 一条规则都没有 ⇒ undefined（保持旧口径，让调用方降级把 cf_* 叫「自定义字段」）
  ok('⑪ 无字段 ⇒ undefined', indexRulesOf(mk([])) === undefined)

  // aiRead 开关照常透传（模板侧已过滤 false，这里钉住"缺席即不可读"的契约）
  const withRule = mk([field({ id: 'cf_b', sourceKey: 'cf_b', label: '备注', appliesTo: ['角色'] })])
  const r = indexRulesOf(withRule)!
  ok('⑪ 规则以存储键为键', Object.keys(r).join(',') === 'cf_b')
  ok('⑪ 带上当前显示名', r.cf_b.label === '备注')
  ok('⑪ aiReadable 透传', r.cf_b.aiReadable === true)
  ok('⑪ appliesTo 透传（类别逐行判，规则不预先砍）', JSON.stringify(r.cf_b.appliesTo) === JSON.stringify(['角色']))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
