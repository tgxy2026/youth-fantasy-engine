// 3.2.0 · WT0-1 等价性证明 + 语义摘要
//
// 方案 §3.4 的硬要求：「3.1.3 图鉴配置通过适配器接入通用服务，**先证明当前输入输出一致**
// 再启用新编辑器」。本文件就是那份证明：
//   · 四个图鉴页签 × 用途 下，适配器输出与 resolveAtlasFields **逐字段一致**；
//   · 非图鉴页签的字段 = 非隐藏列 / 模块字段（逐字）；
//   · semanticDigest 只随语义变化，不随 order/分组位置变化（防误杀候选）。
import { TABS } from '@/lib/schema'
import { resolveAtlasFields } from '@/lib/atlas/schema'
import { adaptAtlasTab, adaptBuiltinTab, semanticDigestOf, TEMPLATE_FORMAT_VERSION } from '@/lib/templates/legacyAdapter'
import { resolveTemplateForTab, resolveTemplateById } from '@/lib/templates/resolve'
import type { AtlasSchemaConfig } from '@/lib/atlas/types'
import type { ResolvedAtlasField } from '@/lib/atlas/types'
import type { EffectiveField } from '@/lib/templates/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const ATLAS_TAB_IDS = ['races', 'items', 'nations', 'geography']
const tabOf = (id: string) => {
  const t = TABS.find(x => x.id === id)
  if (!t) throw new Error('找不到页签 ' + id)
  return t
}

/** 一份带自定义字段 + 别名 + 分组的配置（覆盖主要分支） */
function mkConfig(): AtlasSchemaConfig {
  return {
    formatVersion: 1,
    revision: 3,
    fields: [
      { id: 'cf_a1', label: '食性', type: 'text', description: '吃什么', options: [], appliesTo: '*', groupId: 'g1', order: 0, tableVisible: true, detailVisible: true, searchable: true, aiReadable: true, aiWritable: true },
      { id: 'cf_b2', label: '等级', type: 'select', description: '', options: ['低', '高'], appliesTo: '*', groupId: 'g1', order: 1, tableVisible: true, detailVisible: true, searchable: true, aiReadable: true, aiWritable: false },
    ],
    groups: [{ id: 'g1', label: '扩展资料', order: 0 }],
    builtinPresentation: {},
    summaryKeys: [],
  } as unknown as AtlasSchemaConfig
}

/** 把 ResolvedAtlasField 与本适配器的 EffectiveField 逐项对齐 */
function fieldEquals(f: ResolvedAtlasField, e: EffectiveField): boolean {
  const typeMap: Record<string, string> = {
    text: 'text', textarea: 'textarea', number: 'number', select: 'select',
    multiSelect: 'multiSelect', boolean: 'boolean', date: 'date', calendar: 'calendar',
    tableRef: 'tableRef', character: 'character', characters: 'characters',
  }
  const expectType = f.source === 'custom' ? typeMap[f.customType ?? 'text'] : typeMap[f.builtinType ?? 'text']
  return e.id === f.key
    && e.sourceKey === f.key
    && e.label === f.label
    && e.type === expectType
    && e.groupId === f.groupId
    && e.order === f.order
    && JSON.stringify(e.options ?? []) === JSON.stringify(f.options ?? [])
    && JSON.stringify(e.appliesTo) === JSON.stringify(f.appliesTo)
    && (e.fixedOptions === true) === (f.fixedOptions === true)
    && e.permissions.table === f.tableVisible
    && e.permissions.detail === f.detailVisible
    && e.permissions.search === f.searchable
    && e.permissions.aiRead === f.aiReadable
    && e.permissions.aiWrite === f.aiWritable
}

// ---------- ① 图鉴四页签 × 用途：逐字段一致 ----------
{
  const cfg = mkConfig()
  const aliases = { 名称: '名字', 类别: '分类' }
  for (const tabId of ATLAS_TAB_IDS) {
    const tab = tabOf(tabId)
    for (const purpose of ['detail', 'table', 'search', 'aiRead', 'aiWrite', 'index'] as const) {
      const atlasPurpose = purpose === 'index' ? 'aiRead' : purpose
      const old = resolveAtlasFields(tab, { config: cfg, aliases, purpose: atlasPurpose })
      const eff = resolveTemplateForTab(tab, { config: cfg, aliases, purpose })
      const allMatch = old.length === eff.fields.length
        && old.every((f, i) => fieldEquals(f, eff.fields[i]))
      ok(`① ${tabId}/${purpose}：字段逐项一致（${old.length} 个）`, allMatch,
        allMatch ? '' : `old=${old.length} new=${eff.fields.length} diff=${old.find((f, i) => !eff.fields[i] || !fieldEquals(f, eff.fields[i]))?.key}`)
    }
  }
}

// ---------- ② 类别过滤 / 忽略适用范围 ----------
{
  const cfg = mkConfig()
  cfg.fields.push({ ...cfg.fields[0], id: 'cf_onlyelf', label: '精灵特性', appliesTo: ['精灵'], order: 2 } as never)
  const tab = tabOf('races')
  const withCat = resolveTemplateForTab(tab, { config: cfg, category: '魔兽', purpose: 'detail' })
  const oldWithCat = resolveAtlasFields(tab, { config: cfg, category: '魔兽', purpose: 'detail' })
  ok('② 类别过滤：字段集一致', withCat.fields.length === oldWithCat.length)
  ok('② 类别过滤：「精灵特性」不出现在魔兽条目', !withCat.fields.some(f => f.id === 'cf_onlyelf'))

  const ignored = resolveTemplateForTab(tab, { config: cfg, category: '魔兽', purpose: 'detail', ignoreAppliesTo: true })
  ok('② ignoreAppliesTo：全表视图能看到类别专属字段', ignored.fields.some(f => f.id === 'cf_onlyelf'))
}

// ---------- ③ 非图鉴页签 ----------
{
  // 普通表格页签（时间脉络）：字段 = 非隐藏列
  const tableTab = TABS.find(t => t.type === 'table' && !ATLAS_TAB_IDS.includes(t.id))
  ok('③ 存在非图鉴表格页签可测', !!tableTab, String(tableTab?.id))
  if (tableTab) {
    const t = adaptBuiltinTab(tableTab)
    const visible = (tableTab.columns ?? []).filter(c => !c.hidden)
    ok(`③ ${tableTab.id}：字段数 = 非隐藏列数`, t.fields.length === visible.length, `${t.fields.length} vs ${visible.length}`)
    ok(`③ ${tableTab.id}：字段 id 就是列名（不改存储键）`,
      visible.every((c, i) => t.fields[i].id === c.name && t.fields[i].sourceKey === c.name))
    ok(`③ ${tableTab.id}：模板版本 = ${TEMPLATE_FORMAT_VERSION}`, t.version === TEMPLATE_FORMAT_VERSION)
  }

  // 表单页签：字段 id = 模块名::字段名
  const formTab = TABS.find(t => t.type === 'form')
  ok('③ 存在表单页签可测', !!formTab, String(formTab?.id))
  if (formTab) {
    const t = adaptBuiltinTab(formTab)
    const expect = (formTab.modules ?? []).reduce((n, m) => n + m.fields.length, 0)
    ok(`③ ${formTab.id}：表单字段数 = 模块字段总数`, t.fields.length === expect, `${t.fields.length} vs ${expect}`)
    ok(`③ ${formTab.id}：字段 id 形如「模块名::字段名」`, t.fields.every(f => f.id.includes('::')))
  }
}

// ---------- ④ 语义摘要：只随语义变 ----------
{
  const base = resolveTemplateForTab(tabOf('races'), { config: mkConfig(), purpose: 'detail' })
  const digest = base.semanticDigest
  ok('④ 摘要形如 f1:xxxxxxxx', /^f1:[0-9a-f]{8}$/.test(digest))

  // 纯 order 变化（挪位置）⇒ 摘要不变（防误杀候选）
  const moved = base.fields.map((f, i) => ({ ...f, order: 100 - i }))
  ok('④ 只改 order ⇒ 摘要不变', semanticDigestOf(moved) === digest)

  // 改显示名 ⇒ 变（AI 理解变了）
  const renamed = base.fields.map(f => f.id === 'cf_a1' ? { ...f, label: '食谱' } : f)
  ok('④ 改 label ⇒ 摘要变', semanticDigestOf(renamed) !== digest)

  // 改权限 ⇒ 变
  const perm = base.fields.map(f => f.id === 'cf_a1' ? { ...f, permissions: { ...f.permissions, aiRead: false } } : f)
  ok('④ 改 aiRead 权限 ⇒ 摘要变', semanticDigestOf(perm) !== digest)

  // 改候选值 ⇒ 变（影响 AI 可填范围）
  const opts = base.fields.map(f => f.id === 'cf_b2' ? { ...f, options: ['低', '中', '高'] } : f)
  ok('④ 改 options ⇒ 摘要变', semanticDigestOf(opts) !== digest)

  // 改分组 ⇒ 变（会话/检索按分组归属）
  const grp = base.fields.map(f => f.id === 'cf_a1' ? { ...f, groupId: 'g2' } : f)
  ok('④ 改 groupId ⇒ 摘要变', semanticDigestOf(grp) !== digest)

  // 归档：字段从 AI 可见集里消失（resolveAtlasFields 对 archived 直接跳过）⇒
  // 「AI 能看到什么」变了，摘要**必须**变（旧候选才能按依赖失效）。
  const arch = base.fields.map(f => f.id === 'cf_a1' ? { ...f, archived: true } : f)
  ok('④ 归档 ⇒ 摘要变（AI 可见字段集变了）', semanticDigestOf(arch) !== digest)
}

// ---------- ⑤ 未知配置版本 ⇒ 降级 + 诊断，不炸整页 ----------
{
  const tab = tabOf('races')
  const badCfg = { ...mkConfig(), formatVersion: 99 } as unknown as AtlasSchemaConfig
  const t = resolveTemplateForTab(tab, { config: badCfg, purpose: 'detail' })
  ok('⑤ 未知配置版本 ⇒ 有 unknown-config-version 诊断',
    t.diagnostics.some(d => d.code === 'unknown-config-version'))
  ok('⑤ 降级后内置字段仍在（不是整页空）', t.fields.some(f => f.id === '名称'))
  ok('⑤ 降级后自定义字段不出现（不把未知结构当已知读）', !t.fields.some(f => f.id.startsWith('cf_')))
}

// ---------- ⑥ 找不到页签 ⇒ null（不静默返回空模板）----------
{
  ok('⑥ resolveTemplateById 未知页签 ⇒ null', resolveTemplateById(TABS, 'no-such-tab') === null)
  ok('⑥ resolveTemplateById 已知页签 ⇒ 模板', resolveTemplateById(TABS, 'races')?.tabId === 'races')
}

// ---------- ⑦ 适配器可重复调用、结果稳定（无隐藏状态） ----------
{
  const a = adaptAtlasTab(tabOf('races'), { config: mkConfig() })
  const b = adaptAtlasTab(tabOf('races'), { config: mkConfig() })
  ok('⑦ 两次调用摘要一致（纯函数）', a.semanticDigest === b.semanticDigest)
  ok('⑦ 两次调用字段数一致', a.fields.length === b.fields.length)
}

// ---------- ⑧ 自定义字段六类型往返（WT0-4 实测抓到的真缺陷，锁死不再回退） ----------
//
// 自定义字段的类型叫 `longText`，内置列叫 `textarea` —— 用内置词表去查 `longText` 会查不到，
// 于是长文本自定义字段被归成 `other`（只读 + 一条「类型未识别」诊断），
// 作者的长文本字段**全部静默降级**。本条就是那道锁。
{
  const cfg = {
    formatVersion: 1, revision: 1,
    fields: (['text', 'longText', 'number', 'select', 'multiSelect', 'boolean'] as const).map((t, i) => ({
      id: `cf_${t}`, label: t, type: t, description: '', options: t === 'select' || t === 'multiSelect' ? ['甲'] : [],
      appliesTo: '*', groupId: 'g1', order: i, tableVisible: true, detailVisible: true,
      searchable: true, aiReadable: true, aiWritable: false,
    })),
    groups: [{ id: 'g1', label: '扩展', order: 0 }], builtinPresentation: {}, summaryKeys: [],
  } as unknown as AtlasSchemaConfig
  const tpl = adaptAtlasTab(tabOf('races'), { config: cfg })
  const byId = (id: string) => tpl.fields.find(f => f.id === id)!
  const expect: Record<string, string> = {
    cf_text: 'text', cf_longText: 'textarea', cf_number: 'number',
    cf_select: 'select', cf_multiSelect: 'multiSelect', cf_boolean: 'boolean',
  }
  for (const [id, type] of Object.entries(expect)) {
    ok(`⑧ 自定义 ${id} → ${type}`, byId(id).type === type, byId(id).type)
    ok(`⑧ ${id} 不被误判为 other`, byId(id).type !== 'other')
  }
  ok('⑧ 六类型都不产生「类型未识别」诊断',
    !tpl.diagnostics.some(d => d.code === 'unknown-field-type'),
    JSON.stringify(tpl.diagnostics))
}

console.log(`\ntemplatesAdapter: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
