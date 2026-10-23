// 3.2.0 · WT0-3 语义读写投影（映射方案 / 读取视图 / 写回校验）
//
// 这一层的验收标准不是「能跑」，而是**不该写的时候一定不写**：
// 槽位没绑定、绑定不唯一、字段归档、权限没放开、类型对不上、候选项里没有、
// 两个槽位抢同一栏 —— 每一条都必须拒绝且说清原因，不许「差不多就写进去」。
import { readFileSync } from 'node:fs'
import { TABS } from '@/lib/schema'
import { adaptBuiltinTab, adaptAtlasTab } from '@/lib/templates/legacyAdapter'
import { resolveTemplateForTab } from '@/lib/templates/resolve'
import { slotsForKind, knownSlotIds } from '@/lib/templates/semanticSlots'
import { buildMappingPlan, bindingOf, isAutoWritable } from '@/lib/templates/mappingPlan'
import { readSemanticView, semanticValuesOf, semanticValueOf } from '@/lib/templates/semanticView'
import { resolveSemanticWrite } from '@/lib/templates/semanticWrite'
import type { SemanticSlotDef } from '@/lib/templates/semanticSlots'
import type { EffectiveField, EffectiveTemplate } from '@/lib/templates/types'
import type { AtlasSchemaConfig } from '@/lib/atlas/types'

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

const CHAR_MAIN = tabOf('char-main')
const MASTER = tabOf('master')

// 人物在主要角色卡上的模板（卡片字段键形如「一、基础信息::身份定位」）
const peopleTpl = resolveTemplateForTab(CHAR_MAIN)
const peopleSlots = slotsForKind('人物')

// ────────────────────────── ① 槽位目录派生自 KIND_MAP ──────────────────────────
{
  const ids = peopleSlots.map(d => d.slot)
  ok('① 人物目录含记录级槽位', ['name', 'alias', 'desc', 'firstAppear'].every(s => ids.includes(s)))
  ok('① 人物目录含扩展槽位', ['identity', 'realm', 'skills', 'relations'].every(s => ids.includes(s)))
  ok('① 每个槽位都有非空候选', peopleSlots.every(d => d.targets.length > 0))
  const terms = slotsForKind('术语')
  ok('① 术语表没有别称字段 ⇒ 没有 alias 槽位', !terms.some(d => d.slot === 'alias'))
  ok('① 未知类别 ⇒ 空目录（不拿通用猜测乱写）', slotsForKind('不存在的类别').length === 0)
  ok('① 槽位 ID 全局可枚举', knownSlotIds().includes('identity'))
  ok('① 目录槽位一律默认 single（合成用途由显式声明判定）', peopleSlots.every(d => d.write === 'single'))
}

// ────────────────────────── ② 映射方案 ──────────────────────────
{
  const plan = buildMappingPlan(peopleTpl, peopleSlots)
  const id = bindingOf(plan, 'identity')
  ok('② identity 按存储键精确命中', !!id && id.origin === 'exact' && id.fieldIds.length === 1)
  const f = peopleTpl.fields.find(x => x.id === id?.fieldIds[0])
  ok('② 落点是真实存储键', f?.sourceKey === '一、基础信息::身份定位', String(f?.sourceKey))
  ok('② 名称槽位落到「姓名」', bindingOf(plan, 'name')?.fieldIds[0] === '一、基础信息::姓名')
  ok('② 别名槽位落到「别称」', bindingOf(plan, 'alias')?.fieldIds[0] === '一、基础信息::别称')
  // KIND_MAP 里 人物.descFields 与 slots.identity 都指向「身份定位」——这是既有事实
  const shared = plan.sharedFields.find(s => s.fieldId === '一、基础信息::身份定位')
  ok('② 识别出「身份定位」被 desc 与 identity 共用', !!shared && shared.slots.includes('desc') && shared.slots.includes('identity'))
  ok('② 映射摘要形如 m1:xxxxxxxx', /^m1:[0-9a-f]{8}$/.test(plan.digest), plan.digest)
  ok('② 版本号固定为 1', plan.version === 1)
}

// ────────────────────────── ③ 改名不失配 ──────────────────────────
{
  // 模拟作者把「身份定位」显示名改成「出身定位」（存储键不动）
  const renamed: EffectiveTemplate = {
    ...peopleTpl,
    fields: peopleTpl.fields.map(f => f.sourceKey === '一、基础信息::身份定位' ? { ...f, label: '出身定位' } : f),
  }
  const plan = buildMappingPlan(renamed, peopleSlots)
  const b = bindingOf(plan, 'identity')
  ok('③ 显示名改了，映射仍按存储键命中', !!b && b.origin === 'exact')
  ok('③ 命中后仍指向原存储键', renamed.fields.find(x => x.id === b?.fieldIds[0])?.sourceKey === '一、基础信息::身份定位')
  ok('③ 改名不改变映射摘要（不该作废旧结果）', plan.digest === buildMappingPlan(peopleTpl, peopleSlots).digest)
}

// ────────────────────────── ④ 显示名撞名 ⇒ alias；显式声明 ⇒ declared ──────────────────────────
{
  const base = adaptBuiltinTab(MASTER)
  const withLabel: EffectiveTemplate = {
    ...base,
    fields: base.fields.map((f, i) => i === 0 ? { ...f, label: '身份定位' } : f),
  }
  const plan = buildMappingPlan(withLabel, peopleSlots)
  const b = bindingOf(plan, 'identity')
  ok('④ 只有显示名对上 ⇒ origin=alias', !!b && b.origin === 'alias', JSON.stringify(b))
  ok('④ alias 命中记下了真实字段', !!b && b.fieldIds.length === 1)

  const declaredId = peopleTpl.fields.find(f => f.sourceKey === '二、性格与内心::核心性格')!.id
  const plan2 = buildMappingPlan(peopleTpl, peopleSlots, { identity: declaredId })
  const b2 = bindingOf(plan2, 'identity')
  ok('④ 显式声明优先于精确匹配', !!b2 && b2.origin === 'declared' && b2.fieldIds[0] === declaredId)
  ok('④ 声明改变映射摘要', plan2.digest !== buildMappingPlan(peopleTpl, peopleSlots).digest)
  ok('④ 声明到不存在的字段 ⇒ 忽略，回落到原匹配', (() => {
    const p = buildMappingPlan(peopleTpl, peopleSlots, { identity: 'cf_不存在' })
    return bindingOf(p, 'identity')?.origin === 'exact'
  })())
}

// ────────────────────────── ⑤ 归档字段不进映射 ──────────────────────────
{
  const arch: EffectiveTemplate = {
    ...peopleTpl,
    fields: peopleTpl.fields.map(f => f.sourceKey === '一、基础信息::身份定位' ? { ...f, archived: true } : f),
  }
  const plan = buildMappingPlan(arch, peopleSlots)
  ok('⑤ 归档字段不参与映射', bindingOf(plan, 'identity') === undefined)
  ok('⑤ 如实记为无字段', plan.unmapped.some(u => u.slot === 'identity' && u.reason === 'no-field'))
}

// ────────────────────────── ⑥ 读取视图 ──────────────────────────
{
  const plan = buildMappingPlan(peopleTpl, peopleSlots)
  const rec = {
    id: 'card-1',
    data: {
      '一、基础信息::姓名': '林昭',
      '一、基础信息::身份定位': '主角·杂役弟子',
      '三、能力与成长::实力境界': '',
    },
  }
  const entries = readSemanticView(peopleTpl, rec, plan, peopleSlots)
  const identity = entries.find(e => e.slot === 'identity')!
  ok('⑥ 读到值', identity.value === '主角·杂役弟子')
  ok('⑥ 来源带真实存储键', identity.sources[0]?.fieldKey === '一、基础信息::身份定位')
  ok('⑥ 来源带记录 ID', identity.sources[0]?.recordId === 'card-1')
  ok('⑥ 来源带原文摘录', (identity.sources[0]?.quote ?? '').includes('主角'))
  ok('⑥ mappingId 含映射摘要', identity.mappingId === plan.digest + '#identity', identity.mappingId)
  ok('⑥ transform=identity', identity.transform === 'identity')
  ok('⑥ 有值的槽位给可写目标', identity.writableTarget?.fieldKey === '一、基础信息::身份定位')
  // 有字段但值为空 ⇒ 不是「没有这个字段」
  const realm = entries.find(e => e.slot === 'realm')!
  ok('⑥ 空值如实标 empty-value', realm.value === '' && realm.limitations.some(l => l.code === 'empty-value'))
  ok('⑥ 空值仍给可写目标（能补）', !!realm.writableTarget)
  // 模板里真没有的字段
  const noTarget = readSemanticView(adaptBuiltinTab(MASTER), { id: 'r', data: {} }, buildMappingPlan(adaptBuiltinTab(MASTER), peopleSlots), peopleSlots)
  ok('⑥ 模板没有该字段 ⇒ no-target（≠ 资料缺失）',
    noTarget.find(e => e.slot === 'identity')?.limitations.some(l => l.code === 'no-target') === true)
  ok('⑥ 值字典只含有值的槽位', !('realm' in semanticValuesOf(entries)))
  ok('⑥ 单槽位取值便捷函数', semanticValueOf(entries, 'identity') === '主角·杂役弟子')
  ok('⑥ includeEmpty=false 过滤空值条目',
    readSemanticView(peopleTpl, rec, plan, peopleSlots, { includeEmpty: false }).every(e => e.value !== ''))
}

// ────────────────────────── ⑦ 多来源合并 ──────────────────────────
{
  const defs: SemanticSlotDef[] = [
    { slot: 'mix', label: '混合', targets: ['别称', '身份定位'], read: 'concat', write: 'single' },
  ]
  const rec = { id: 'c', data: { '一、基础信息::别称': '小昭', '一、基础信息::身份定位': '主角' } }
  const e = readSemanticView(peopleTpl, rec, buildMappingPlan(peopleTpl, defs), defs)[0]
  ok('⑬ 多来源 concat 拼接', e.value === '小昭\n主角', JSON.stringify(e.value))
  ok('⑬ 两个来源都留痕', e.sources.length === 2)
  ok('⑬ 多来源 ⇒ 标 ambiguous-target', e.limitations.some(l => l.code === 'ambiguous-target'))
  ok('⑬ 多来源不自动写（无 writableTarget）', e.writableTarget === undefined)
}

// ────────────────────────── ⑧ 读写权限分叉 ──────────────────────────
{
  // 自定义字段：默认不允许语义写；作者放开 aiWritable 后才可写
  const cfg = {
    formatVersion: 1, revision: 1,
    fields: [
      { id: 'cf_1', label: '身份定位', type: 'text', description: '', options: [], appliesTo: '*', groupId: 'g', order: 0, tableVisible: true, detailVisible: true, searchable: true, aiReadable: true, aiWritable: false },
    ],
    groups: [{ id: 'g', label: '扩展', order: 0 }], builtinPresentation: {}, summaryKeys: [],
  } as unknown as AtlasSchemaConfig
  const races = tabOf('races')
  const tpl = adaptAtlasTab(races, { config: cfg })
  const cf = tpl.fields.find(f => f.id === 'cf_1')!
  ok('⑧ 自定义字段默认不可写', !cf.permissions.aiWrite)
  const withCustom: EffectiveTemplate = {
    ...adaptBuiltinTab(MASTER),
    fields: [{ ...adaptBuiltinTab(MASTER).fields[0], id: 'cf_1', sourceKey: 'cf_1', source: 'custom', label: '身份定位', permissions: { table: true, detail: true, search: true, aiRead: true, aiWrite: false } }],
  }
  const view = readSemanticView(withCustom, { id: 'r', data: {} }, buildMappingPlan(withCustom, peopleSlots), peopleSlots)
  ok('⑧ 自定义只读字段标 read-only-target',
    view.find(e => e.slot === 'identity')?.limitations.some(l => l.code === 'read-only-target') === true)
  const wr = resolveSemanticWrite(withCustom, buildMappingPlan(withCustom, peopleSlots), peopleSlots, { identity: '主角' })
  ok('⑧ 自定义只读字段写回被拒', wr.rejected.some(r => r.code === 'not-writable'))
}

// ────────────────────────── ⑨ 写回：正常路径 ──────────────────────────
{
  const plan = buildMappingPlan(peopleTpl, peopleSlots)
  const r = resolveSemanticWrite(peopleTpl, plan, peopleSlots, {
    name: '林昭',
    identity: '主角·青岚宗杂役弟子',
    realm: '淬体一重',
  })
  ok('⑨ 三条全部接受', r.accepted.length === 3 && r.rejected.length === 0, JSON.stringify(r.rejected))
  const name = r.accepted.find(a => a.slot === 'name')!
  ok('⑨ 名称落到真实存储键', name.fieldKey === '一、基础信息::姓名')
  ok('⑨ 值原样（transform=identity）', name.value === '林昭' && name.transform === 'identity')
  ok('⑨ 结果带映射摘要', r.planDigest === plan.digest)
}

// ────────────────────────── ⑩ 写回：全部拒绝路径 ──────────────────────────
{
  const plan = buildMappingPlan(peopleTpl, peopleSlots)

  // 不认识的老槽位（旧抽取器残留）
  let r = resolveSemanticWrite(peopleTpl, plan, peopleSlots, { 从未见过的槽位: 'x' })
  ok('⑩ 未知槽位被拒', r.rejected[0]?.code === 'unknown-slot')

  // 模板里没有的字段
  const masterTpl = adaptBuiltinTab(MASTER)
  r = resolveSemanticWrite(masterTpl, buildMappingPlan(masterTpl, peopleSlots), peopleSlots, { identity: '主角' })
  ok('⑩ 模板无对应字段被拒', r.rejected.some(x => x.code === 'unmapped'))

  // 「多字段合成用途」只来自作者显式声明（自动多命中是 ambiguous，见 ⑪）
  const compTpl = peopleTpl
  const a = compTpl.fields.find(f => f.sourceKey === '一、基础信息::姓名')!.id
  const b = compTpl.fields.find(f => f.sourceKey === '一、基础信息::别称')!.id
  const compPlan = buildMappingPlan(compTpl, peopleSlots, { identity: [a, b] })
  r = resolveSemanticWrite(compTpl, compPlan, peopleSlots, { identity: '主角' })
  ok('⑩ 声明绑定了多个字段 ⇒ needs-manual-target', r.rejected.some(x => x.code === 'needs-manual-target'))

  // 归档：用**陈旧映射方案**直接写（映射建好后字段被归档）—— 这正是「计划过期」的真实场景
  const arch: EffectiveTemplate = {
    ...peopleTpl,
    fields: peopleTpl.fields.map(f => f.sourceKey === '一、基础信息::姓名' ? { ...f, archived: true } : f),
  }
  r = resolveSemanticWrite(arch, plan, peopleSlots, { name: '林昭' })
  ok('⑩ 归档字段被拒（陈旧映射也要拦住）', r.rejected.some(x => x.code === 'archived'))
  // 重新建映射时归档字段根本不会进方案 ⇒ 表现为「没有对应字段」
  r = resolveSemanticWrite(arch, buildMappingPlan(arch, peopleSlots), peopleSlots, { name: '林昭' })
  ok('⑩ 归档字段缺省表现为 unmapped', r.rejected.some(x => x.code === 'unmapped'))

  // 空值
  r = resolveSemanticWrite(peopleTpl, plan, peopleSlots, { name: '   ' })
  ok('⑩ 空值被拒', r.rejected.some(x => x.code === 'empty'))

  // 两个槽位抢同一字段且值不同 ⇒ 后一个被拒
  r = resolveSemanticWrite(peopleTpl, plan, peopleSlots, { desc: '一句话描述', identity: '身份定位' })
  ok('⑩ 同字段冲突被拒（不静默覆盖）', r.rejected.some(x => x.code === 'field-conflict'), JSON.stringify(r.rejected))
  ok('⑩ 冲突时前一个照常写入', r.accepted.some(a => a.slot === 'desc'))

  // 同字段同值 ⇒ 幂等，不重复写也不报错
  r = resolveSemanticWrite(peopleTpl, plan, peopleSlots, { desc: '主角', identity: '主角' })
  ok('⑩ 同字段同值 ⇒ 只写一次', r.accepted.length === 1 && r.rejected.length === 0)
}

// ────────────────────────── ⑪ 类型与候选项校验 ──────────────────────────
{
  // 合成一份最小模板，专测取值归一化
  const f = (p: Partial<EffectiveField> & { id: string }): EffectiveField => ({
    id: p.id, sourceKey: p.sourceKey ?? p.id, source: 'builtin', label: p.label ?? p.id,
    type: p.type ?? 'text', ...(p.options ? { options: p.options } : {}),
    groupId: 'g', order: 0, appliesTo: p.appliesTo ?? '*', archived: p.archived ?? false,
    permissions: p.permissions ?? { table: true, detail: true, search: true, aiRead: true, aiWrite: true },
  })
  const fields: EffectiveField[] = [
    f({ id: 'n_num', type: 'number', label: '数字' }),
    f({ id: 'n_bool', type: 'boolean', label: '是非' }),
    f({ id: 'n_sel', type: 'select', label: '档位', options: ['S', 'A', 'B'] }),
    f({ id: 'n_multi', type: 'multiSelect', label: '多个', options: ['甲', '乙', '丙'] }),
    f({ id: 'n_other', type: 'other', label: '未知' }),
    f({ id: 'n_cat', type: 'text', label: '限类别', appliesTo: ['龙族'] }),
    f({ id: 'n_ref', type: 'character', label: '引用角色' }),
    f({ id: 'dup_a', type: 'text', label: '重复用途' }),
    f({ id: 'dup_b', type: 'text', label: '重复用途2' }),
  ]
  const tpl: EffectiveTemplate = {
    templateId: 'builtin:t', version: 1, revision: 0, semanticDigest: 'd', tabId: 't',
    purpose: 'detail', groups: [{ id: 'g', label: 'g', order: 0 }], fields, diagnostics: [],
  }
  const defs: SemanticSlotDef[] = [
    { slot: 'num', label: '数字', targets: ['n_num'], read: 'first', write: 'single' },
    { slot: 'bool', label: '是非', targets: ['n_bool'], read: 'first', write: 'single' },
    { slot: 'sel', label: '档位', targets: ['n_sel'], read: 'first', write: 'single' },
    { slot: 'multi', label: '多个', targets: ['n_multi'], read: 'first', write: 'single' },
    { slot: 'other', label: '未知', targets: ['n_other'], read: 'first', write: 'single' },
    { slot: 'cat', label: '限类别', targets: ['n_cat'], read: 'first', write: 'single' },
    { slot: 'ref', label: '引用角色', targets: ['n_ref'], read: 'first', write: 'single' },
    { slot: 'dup', label: '重复用途', targets: ['dup_a', 'dup_b'], read: 'first', write: 'single' },
  ]
  const plan = buildMappingPlan(tpl, defs)
  const w = (c: Record<string, unknown>, o?: { category?: string }) => resolveSemanticWrite(tpl, plan, defs, c, o)

  ok('⑪ 数字：接受纯数值', (() => { const r = w({ num: '42' }); return r.accepted[0]?.value === '42' })())
  ok('⑪ 数字：千分位与负号归一', (() => { const r = w({ num: '-1,024' }); return r.accepted[0]?.value === '-1024' && r.accepted[0].transform === 'normalized' })())
  ok('⑪ 数字：文字拒绝（不猜）', w({ num: '三阶' }).rejected.some(x => x.code === 'invalid-value'))
  ok('⑪ 是非：中文/英文都认', (() => {
    return w({ bool: '是' }).accepted[0]?.value === '是' && w({ bool: 'false' }).accepted[0]?.value === '否'
  })())
  ok('⑪ 是非：无法识别拒绝', w({ bool: '也许' }).rejected.some(x => x.code === 'invalid-value'))
  ok('⑪ 下拉：候选内接受', (() => { const r = w({ sel: 'A' }); return r.accepted[0]?.value === 'A' })())
  ok('⑪ 下拉：候选外拒绝', w({ sel: 'Z' }).rejected.some(x => x.code === 'not-in-options'))
  ok('⑪ 多选：中英文分隔归一', (() => { const r = w({ multi: '甲,乙；甲' }); return r.accepted[0]?.value === '甲、乙' })())
  ok('⑪ 多选：候选外拒绝', w({ multi: '甲,丁' }).rejected.some(x => x.code === 'not-in-options'))
  ok('⑪ 未知类型拒绝（不能安全写）', w({ other: 'x' }).rejected.some(x => x.code === 'unknown-type'))
  ok('⑪ 限类别：未给类别 ⇒ 拒绝（不写进看不见的栏位）', w({ cat: 'x' }).rejected.some(x => x.code === 'category-required'))
  ok('⑪ 限类别：类别不符 ⇒ 拒绝', w({ cat: 'x' }, { category: '人族' }).rejected.some(x => x.code === 'category-mismatch'))
  ok('⑪ 限类别：类别相符 ⇒ 接受', (() => { const r = w({ cat: 'x' }, { category: '龙族' }); return r.accepted.length === 1 })())
  ok('⑪ 引用型给未校验警告', w({ ref: '林昭' }).warnings.some(x => x.code === 'reference-unverified'))
  ok('⑪ 绑定不唯一 ⇒ 拒绝（不按第一个蒙）', w({ dup: 'x' }).rejected.some(x => x.code === 'ambiguous-target'))
  ok('⑪ isAutoWritable 对多字段绑定为 false', (() => {
    const d = defs.find(x => x.slot === 'dup')!
    return !isAutoWritable(plan, d)
  })())
}

// ────────────────────────── ⑫ 映射方案不影响模板摘要 ──────────────────────────
{
  const plan = buildMappingPlan(peopleTpl, peopleSlots)
  ok('⑫ 映射摘要与模板语义摘要相互独立', plan.digest !== peopleTpl.semanticDigest)
  ok('⑫ 新增无关注解不影响映射摘要', (() => {
    const extra: EffectiveTemplate = {
      ...peopleTpl,
      fields: [...peopleTpl.fields, {
        ...peopleTpl.fields[0], id: 'cf_new', sourceKey: 'cf_new', source: 'custom', label: '无关字段',
      }],
    }
    return buildMappingPlan(extra, peopleSlots).digest === plan.digest
  })())
}

// ────────────────────────── ⑬ 读取闸：未开放 AI 读取的字段必须跳过并说明 ──────────────────────────
//
// 3.2.2：`semanticView` 的读取闸改走 `canSemanticRead(f)`（原先直接读 `f.permissions.aiRead`）。
// 这两条同时钉住「行为」与「接线」：
//   · 行为：aiRead=false 的字段**不进值**，且如实给出 not-ai-readable 限制（作者知道为什么没读到）；
//   · 接线：源码里那一行必须走 helper —— 否则 helper 又变回零引用，下次审计还会报"该接没接"。
{
  const plan = buildMappingPlan(peopleTpl, peopleSlots)
  const locked: EffectiveTemplate = {
    ...peopleTpl,
    fields: peopleTpl.fields.map(f => (f.sourceKey === '一、基础信息::身份定位'
      ? { ...f, permissions: { ...f.permissions, aiRead: false } }
      : f)),
  }
  const rec = { id: 'card-2', data: { '一、基础信息::身份定位': '主角·杂役弟子' } }
  const entries = readSemanticView(locked, rec, plan, peopleSlots)
  const identity = entries.find(e => e.slot === 'identity')!
  ok('⑬ 未开放读取 ⇒ 值不进视图', identity.value === '', identity.value)
  ok('⑬ 未开放读取 ⇒ 如实标 not-ai-readable',
    identity.limitations.some(l => l.code === 'not-ai-readable'))
  ok('⑬ 限制文案点名是哪个字段（作者能对上号）',
    (identity.limitations.find(l => l.code === 'not-ai-readable')?.detail ?? '').includes('身份定位'))

  // 接线闸：读取闸只许走 canSemanticRead
  const src = readFileSync('src/lib/templates/semanticView.ts', 'utf8')
  ok('🔴 ⑬ 读取闸走 canSemanticRead（不再直接读裸字段）', /if \(!canSemanticRead\(f\)\)/.test(src))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
