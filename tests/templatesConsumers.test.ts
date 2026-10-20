// 3.2.0 · WT0-4 消费者投影等价性
//
// 迁移消费者最容易出事的地方：**看着一样、实际少了一列或多格式化了一次**。
// 本文件做两件事：
//   ① 投影结果与旧的 `resolveAtlasFields(...)` 逐字段对齐（key/label/kind/unit）；
//   ② `renderTable` 用投影字段渲染出的文本与用旧字段渲染的**逐字相同**。
import { TABS } from '@/lib/schema'
import { resolveAtlasFields } from '@/lib/atlas/schema'
import { resolveTemplateForTab } from '@/lib/templates/resolve'
import { tableFieldsOf, toTableFieldProjection, aiReadableTableFieldsOf, indexRulesOf, pickValuesOfKeys } from '@/lib/templates/consumers'
import { renderTable } from '@/lib/ai/tableRender'
import { adaptBuiltinTab } from '@/lib/templates/legacyAdapter'
import { loadAtlasFieldsForAI, loadAtlasAiWriteTargets } from '@/lib/ai/atlasContext'
import { saveAtlasSchema } from '@/lib/atlas/persistence'
import { projectTemplateKeyOf, TEMPLATE_DEF_VERSION, type TemplateDef } from '@/lib/templates/definition'
import { __resetTemplateCacheForTests } from '@/lib/templates/cache'
import * as db from '@/lib/db'
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
    // Q2：规则同时覆盖内置字段，这里只拿自定义部分与旧口径逐项对齐
    const gotCustom: typeof legacyMap = {}
    for (const [k, r] of Object.entries(got)) {
      if (r.source === 'custom') gotCustom[k] = { label: r.label, aiReadable: r.aiReadable, appliesTo: r.appliesTo }
    }
    const same = JSON.stringify(legacyMap) === JSON.stringify(gotCustom)
    ok(`⑩ ${id} 自定义字段规则与旧口径逐项一致`, same,
      same ? '' : `\n legacy=${JSON.stringify(legacyMap)}\n got   =${JSON.stringify(gotCustom)}`)
    ok(`⑩ ${id} 对照组有效（确实有自定义字段）`, Object.keys(legacyMap).length > 0)
    // 🔴 Q2：内置字段也纳入规则（此前只收 custom，内置禁读将来没有对应项）
    const builtinKeys = tpl.fields.filter(f => f.source === 'builtin').map(f => f.sourceKey)
    ok(`⑩ ${id} 内置字段纳入索引规则（Q2）`,
      builtinKeys.length > 0 && builtinKeys.every(k => got[k]?.source === 'builtin'))
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

  // 🔴 Q2：内置字段也在规则里（"缺席即不可读"必须对内置同样成立）
  const onlyBuiltin = mk([field({ id: '名称', sourceKey: '名称', source: 'builtin', label: '名称' })])
  const builtinOnly = indexRulesOf(onlyBuiltin)
  ok('⑪ 只有内置字段 ⇒ 仍给出规则', Object.keys(builtinOnly).join(',') === '名称' && builtinOnly['名称'].source === 'builtin')

  // 一条规则都没有 ⇒ **权威空集**（不是 undefined；undefined 会被理解成"不过滤"）
  ok('⑪ 无字段 ⇒ 权威空集 {}', Object.keys(indexRulesOf(mk([]))).length === 0)

  // aiRead 开关照常透传（模板侧已过滤 false，这里钉住"缺席即不可读"的契约）
  const withRule = mk([field({ id: 'cf_b', sourceKey: 'cf_b', label: '备注', appliesTo: ['角色'] })])
  const r = indexRulesOf(withRule)!
  ok('⑪ 规则以存储键为键', Object.keys(r).join(',') === 'cf_b')
  ok('⑪ 带上当前显示名', r.cf_b.label === '备注')
  ok('⑪ aiReadable 透传', r.cf_b.aiReadable === true)
  ok('⑪ appliesTo 透传（类别逐行判，规则不预先砍）', JSON.stringify(r.cf_b.appliesTo) === JSON.stringify(['角色']))
}

// ────────────────────────── ⑬ AI 直接上下文与索引/召回同源（Q2）──────────────────────────
{
  const RACES = tabOf('races')
  const pid = (await db.createProject('Q2 同源测试', '', '')).id
  db.setCurrentProject(pid)

  // 旧图鉴配置：两个自定义字段都「可读可写」—— 若直接上下文只读配置，它们会漏给模型
  const ctxConfig = {
    formatVersion: 1,
    revision: 1,
    fields: [
      { id: 'cf_secret', label: '密文', type: 'text', description: '', options: [], appliesTo: '*', groupId: 'g1', order: 0, tableVisible: true, detailVisible: true, searchable: true, aiReadable: true, aiWritable: true },
      { id: 'cf_legacy', label: '旧字段', type: 'text', description: '', options: [], appliesTo: '*', groupId: 'g1', order: 1, tableVisible: true, detailVisible: true, searchable: true, aiReadable: true, aiWritable: true },
    ],
    groups: [{ id: 'g1', label: '扩展', order: 0 }],
    builtinPresentation: {},
    summaryKeys: [],
  } as unknown as AtlasSchemaConfig
  await saveAtlasSchema(pid, 'races', ctxConfig)

  // 项目采用的快照：cf_secret 禁读；cf_fill 只写不读；cf_legacy 已被移除
  const def: TemplateDef = {
    formatVersion: TEMPLATE_DEF_VERSION,
    templateId: 'tpl_q2_ctx',
    name: 'Q2 上下文模板',
    tabId: 'races',
    origin: { kind: 'builtin' },
    groups: [{ id: 'g1', label: '基础', order: 0 }],
    fields: [
      {
        id: '名称', sourceKey: '名称', source: 'builtin', label: '名称', type: 'text',
        groupId: 'g1', order: 0, appliesTo: '*', archived: false,
        permissions: { table: true, detail: true, search: true, aiRead: true, aiWrite: true },
      },
      {
        id: 'cf_secret', sourceKey: 'cf_secret', source: 'custom', label: '密文', type: 'text',
        groupId: 'g1', order: 1, appliesTo: '*', archived: false,
        permissions: { table: true, detail: true, search: true, aiRead: false, aiWrite: false },
      },
      {
        id: 'cf_fill', sourceKey: 'cf_fill', source: 'custom', label: '待补全', type: 'text',
        groupId: 'g1', order: 2, appliesTo: '*', archived: false,
        permissions: { table: true, detail: true, search: true, aiRead: false, aiWrite: true },
      },
    ],
    nameFieldId: '名称',
    semanticDigest: 'f1:q2ctx',
    revision: 1,
    updatedAt: 0,
  }
  await db.setSettingFor(pid, projectTemplateKeyOf('races'), def)
  __resetTemplateCacheForTests()

  const readFields = (await loadAtlasFieldsForAI(RACES)) ?? []
  const readKeys = readFields.map(f => f.key)
  ok('⑬ 采用快照后 AI 读取不再从旧配置漏出已禁读字段', !readKeys.includes('cf_secret'), readKeys.join(','))
  ok('⑬ 快照已移除的字段不会从旧配置复活', !readKeys.includes('cf_legacy'))
  ok('⑬ 快照内的内置字段照常可读', readKeys.includes('名称'))
  ok('⑬ 可读 / 可写独立：可写但禁读的空字段不进读取清单', !readKeys.includes('cf_fill'))

  const write = await loadAtlasAiWriteTargets(RACES, pid)
  ok('⑬ 可写但禁读的空字段仍可补全', write.allowedKeys.has('cf_fill') && !write.lockedReason)
  ok('⑬ 快照里禁写的字段不可写', !write.allowedKeys.has('cf_secret'))
  ok('⑬ 旧配置有、快照里没有的字段不可写', !write.allowedKeys.has('cf_legacy'))
  ok('⑬ 内置可写列仍在', write.allowedKeys.has('名称'))

  // ── ⑭ 生成期基准：用 aiWrite 语义摘要，而不是 configuration revision ──
  const expectDigest = resolveTemplateForTab(RACES, { def, purpose: 'aiWrite', ignoreAppliesTo: true }).semanticDigest
  ok('⑭ 快照路径给出非空基准', write.basis.length > 0)
  ok('⑭ 基准 = aiWrite 用途过滤后的语义摘要', write.basis === expectDigest,
    `basis=${write.basis} expect=${expectDigest}`)

  // 只改字段顺序（纯布局）⇒ 基准不变：生成中的结果不该因此作废
  const reordered: TemplateDef = {
    ...def,
    fields: [...def.fields].reverse().map((f, i) => ({ ...f, order: i })),
  }
  await db.setSettingFor(pid, projectTemplateKeyOf('races'), reordered)
  __resetTemplateCacheForTests()
  const layoutWrite = await loadAtlasAiWriteTargets(RACES, pid)
  ok('⑭ 只改字段顺序不算语义变化（基准不变）', layoutWrite.basis === write.basis,
    `before=${write.basis} after=${layoutWrite.basis}`)

  // 生成期间关掉「AI 可填写」⇒ 基准变化，旧结果应整体作废
  const tightened: TemplateDef = {
    ...def,
    revision: 2,
    semanticDigest: 'f1:q2ctx2',
    fields: def.fields.map(f => f.id === 'cf_fill'
      ? { ...f, permissions: { ...f.permissions, aiWrite: false } }
      : f),
  }
  await db.setSettingFor(pid, projectTemplateKeyOf('races'), tightened)
  __resetTemplateCacheForTests()
  const tightenedWrite = await loadAtlasAiWriteTargets(RACES, pid)
  ok('⑭ 生成期间关掉 AI 可填写 ⇒ 基准变化', tightenedWrite.basis !== write.basis,
    `before=${write.basis} after=${tightenedWrite.basis}`)
  ok('⑭ 收紧后该字段退出可写目标', !tightenedWrite.allowedKeys.has('cf_fill'))

  // 负控：拿掉快照后旧配置字段重新可见（证明上面的差异来自快照，不是配置里本来就没有）
  await db.delSettingFor(pid, projectTemplateKeyOf('races'))
  __resetTemplateCacheForTests()
  const legacyKeys = ((await loadAtlasFieldsForAI(RACES)) ?? []).map(f => f.key)
  ok('⑬ 负控：未采用快照时旧配置字段照常可见', legacyKeys.includes('cf_secret') && legacyKeys.includes('cf_legacy'))
  ok('⑭ 未采用快照时同样给出基准（配置路径）', (await loadAtlasAiWriteTargets(RACES, pid)).basis.length > 0)
}

// ── ⑮ 角色卡 AI 写回：只接受当前模板可写键（防幽灵字段） ──
{
  const r = pickValuesOfKeys({
    '基础信息::姓名': '叶昭',
    '基础信息::年龄': '17',
    '旧模块::已删字段': '不该写进去',
  }, ['基础信息::姓名', '基础信息::年龄'])
  ok('⑮ 只保留当前可写字段', Object.keys(r.picked).length === 2 && r.picked['基础信息::姓名'] === '叶昭')
  ok('⑮ 幽灵字段被丢弃并计数', r.dropped === 1 && !('旧模块::已删字段' in r.picked))
  ok('⑮ 全部合法时 dropped=0', pickValuesOfKeys({ a: '1' }, ['a']).dropped === 0)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
