// ============ 3.2.0 · WT2：语义映射的建议 / 确认 / 写回 ============
//
// 钉四件事：
//   ① 槽位目录按页签去重合并（人物的 `firstAppear` 曾出现两次，绑定改了不生效）；
//   ② 作者确认的绑定进映射方案，`[]` 是「明确不绑定」而不是「没确认」；
//   ③ 保存只写 `bindings`：不重算语义摘要、不改字段、失效目标收成空绑定；
//   ④ 拆书写回只在**已采用模板**时走映射，未确认/只读/歧义一律不写（fail-closed）。
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'
import type { ExtractedEntity } from '@/lib/ai/aiTasks'
import type { EffectiveField, EffectiveTemplate } from '@/lib/templates/types'
import { TEMPLATE_DEF_VERSION, type TemplateDef } from '@/lib/templates/definition'
import {
  slotsForKind, slotsForTab, kindsForTab,
} from '@/lib/templates/semanticSlots'
import {
  buildMappingPlan, bindingOf, type DeclaredBindings,
} from '@/lib/templates/mappingPlan'
import {
  canonicalBindingText, normalizeBindingsForDef, normalizeBindingsShape,
  saveDeclaredBindings,
} from '@/lib/templates/mappingConfirm'
import { loadTemplateDef, saveTemplateDef } from '@/lib/templates/store'
import { structureOf, contentDigestOf } from '@/lib/templates/library'
import {
  saveMigrationLog, migrationLogKeyOf, MIGRATION_LOG_VERSION,
} from '@/lib/templates/migrationLog'
import { buildDraftBundle } from '@/lib/flow/draft'
import { draftMappingContextOf } from '@/lib/flow/draftMapping'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const PID = 'p-map'

function mkField(over: Partial<EffectiveField> = {}): EffectiveField {
  const id = over.id ?? `cf_${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    sourceKey: over.sourceKey ?? id,
    source: 'custom',
    label: over.label ?? `字段${id}`,
    type: 'text',
    groupId: 'g1',
    order: 0,
    appliesTo: '*',
    archived: false,
    permissions: { table: true, detail: true, search: true, aiRead: true, aiWrite: true },
    ...over,
  }
}

function mkDef(fields: EffectiveField[], over: Partial<TemplateDef> = {}): TemplateDef {
  return {
    formatVersion: TEMPLATE_DEF_VERSION,
    templateId: 'builtin:terms',
    name: '术语模板',
    tabId: 'terms',
    origin: { kind: 'builtin' },
    groups: [{ id: 'g1', label: '基础', order: 0 }],
    fields,
    nameFieldId: fields[0]?.id ?? '',
    semanticDigest: 'semantic-1',
    revision: 3,
    updatedAt: 1000,
    ...over,
  }
}

/** 术语页签的最小有效模板：名称 / 一句话定义 / 命名备注 + 两个自定义字段 */
function termsFields(): EffectiveField[] {
  return [
    mkField({ id: '名称', sourceKey: '名称', source: 'builtin', label: '名称' }),
    mkField({ id: '定义（一句话）', sourceKey: '定义（一句话）', source: 'builtin', label: '释义' }),
    mkField({ id: '类别', sourceKey: '类别', source: 'builtin', label: '类别' }),
    mkField({ id: '命名备注', sourceKey: '命名备注', source: 'builtin', label: '命名备注' }),
    mkField({ id: 'cf_desc', sourceKey: 'cf_desc', label: '自定义定义' }),
    mkField({
      id: 'cf_readonly', sourceKey: 'cf_readonly', label: '只读定义',
      permissions: { table: true, detail: true, search: true, aiRead: true, aiWrite: false },
    }),
  ]
}

/** 由定义造一份有效模板（与生产同一条投影链路） */
function tplOf(def: TemplateDef): EffectiveTemplate {
  const fields = def.fields.filter(f => !f.archived)
  return {
    templateId: def.templateId,
    version: TEMPLATE_DEF_VERSION,
    revision: def.revision,
    semanticDigest: def.semanticDigest,
    tabId: def.tabId,
    purpose: 'export',
    groups: def.groups,
    fields,
    diagnostics: [],
  }
}

// ────────────────────────── ① 槽位目录 ──────────────────────────
{
  const people = slotsForKind('人物')
  const first = people.filter(s => s.slot === 'firstAppear')
  ok('① 人物 firstAppear 只出现一次（记录级与扩展槽位去重）', first.length === 1, String(first.length))
  ok('① 去重后保留两套候选名',
    JSON.stringify(first[0]?.targets) === JSON.stringify(['首次出场', '关键出场']),
    JSON.stringify(first[0]?.targets))

  ok('① char-main 只属于人物', JSON.stringify(kindsForTab('char-main')) === JSON.stringify(['人物']))
  ok('① 页签槽位 = 该类型槽位', slotsForTab('char-main').length === people.length)
  ok('① 术语页签有命名备注槽位', slotsForTab('terms').some(s => s.slot === 'note'))
  ok('① 不属于六类实体的页签没有槽位', slotsForTab('no-such-tab').length === 0)
}

// ────────────────────────── ② 映射方案：declared / declined / 摘要 ──────────────────────────
{
  const def = mkDef(termsFields())
  const tpl = tplOf(def)
  const slots = slotsForTab('terms')
  const idOf = (key: string) => def.fields.find(f => f.sourceKey === key)?.id as string

  const auto = buildMappingPlan(tpl, slots)
  ok('② 未确认：定义按存储键命中', bindingOf(auto, 'desc')?.origin === 'exact')
  ok('② 未确认：自定义字段不参与（没有同义显示名）', !auto.bindings.some(b => b.fieldIds.includes('cf_desc')))
  ok('② 未确认：摘要不含自定义字段', auto.digest !== '' && auto.declined.length === 0)

  const declared: DeclaredBindings = { desc: [idOf('cf_desc')] }
  const p1 = buildMappingPlan(tpl, slots, declared)
  const d1 = bindingOf(p1, 'desc')
  ok('② 显式确认优先于存储键', !!d1 && d1.origin === 'declared' && d1.fieldIds[0] === 'cf_desc', JSON.stringify(d1))
  ok('② 确认改变映射摘要', p1.digest !== auto.digest)

  const p2 = buildMappingPlan(tpl, slots, { desc: [] })
  ok('② 空数组 = 明确不绑定', bindingOf(p2, 'desc') === undefined)
  ok('② 明确不绑定记入 declined', p2.declined.includes('desc'), JSON.stringify(p2.declined))
  ok('② 明确不绑定也有独立摘要', p2.digest !== auto.digest && p2.digest !== p1.digest)
  ok('② 明确不绑定不回落派生匹配', p2.unmapped.some(u => u.slot === 'desc' && u.reason === 'declined'))

  // 语义重复：两个自定义字段都叫「命名备注」⇒ ambiguous，绝不取第一个
  const dup = mkDef([
    ...termsFields().filter(f => f.id !== '命名备注'),
    mkField({ id: 'cf_note_a', sourceKey: 'cf_note_a', label: '命名备注' }),
    mkField({ id: 'cf_note_b', sourceKey: 'cf_note_b', label: '命名备注' }),
  ])
  const pd = buildMappingPlan(tplOf(dup), slots)
  const nb = bindingOf(pd, 'note')
  ok('② 两个字段同名 ⇒ 绑定为多目标（写作前必须作者指定）', !!nb && nb.fieldIds.length > 1, JSON.stringify(nb))
  ok('② 同时记 ambiguous 候选', pd.unmapped.some(u => u.slot === 'note' && u.reason === 'ambiguous'))
}

// ────────────────────────── ③ 绑定的规整与保存 ──────────────────────────
{
  const shape = normalizeBindingsShape({
    desc: 'cf_1', alias: ['cf_2', 'cf_2', ''], none: [], bad: [1, 'cf_3'], huge: Array.from({ length: 9 }, (_, i) => `f${i}`),
  })
  ok('③ 形状清洗：字符串转数组', JSON.stringify(shape.desc) === JSON.stringify(['cf_1']))
  ok('③ 形状清洗：数组去重去空', JSON.stringify(shape.alias) === JSON.stringify(['cf_2']))
  ok('③ 形状清洗：空数组保留（明确不绑定）', Array.isArray(shape.none) && shape.none.length === 0)
  ok('③ 形状清洗：非字符串丢弃', JSON.stringify(shape.bad) === JSON.stringify(['cf_3']))
  ok('③ 形状清洗：超过 8 个字段整条丢弃（不截断）', !('huge' in shape))
  ok('③ 形状清洗：非对象 ⇒ 空', JSON.stringify(normalizeBindingsShape('x')) === '{}')

  ok('③ 规范化文本与键序无关',
    canonicalBindingText({ a: ['2', '1'], b: [] }) === canonicalBindingText({ b: [], a: ['1', '2'] }))

  const def = mkDef([
    ...termsFields(),
    mkField({ id: 'cf_arch', sourceKey: 'cf_arch', label: '旧定义', archived: true }),
  ])
  const norm = normalizeBindingsForDef(def, slotsForTab('terms'), {
    desc: ['cf_arch'], note: [], bogus: ['x'], category: ['类别'],
  })
  ok('③ 归档字段被剔除，并整条收成「明确不绑定」', JSON.stringify(norm.bindings.desc) === '[]', JSON.stringify(norm.bindings))
  ok('③ 未知槽位丢弃并如实上报', norm.dropped.includes('bogus'), JSON.stringify(norm.dropped))
  ok('③ 有效绑定保留', JSON.stringify(norm.bindings.category) === JSON.stringify(['类别']))
  ok('③ 空数组绑定保留', Array.isArray(norm.bindings.note) && norm.bindings.note.length === 0)
}

async function io() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const def = mkDef(termsFields())
  const saved = await saveTemplateDef(PID, def)
  ok('④ 预置模板保存成功', saved.ok === true, JSON.stringify(saved))

  const r1 = await saveDeclaredBindings(PID, 'terms', { desc: ['cf_desc'], note: [] })
  ok('④ 保存确认成功', r1.ok === true && r1.changed === true, JSON.stringify(r1))
  const back = await loadTemplateDef(PID, 'terms')
  ok('④ 绑定随模板持久化',
    JSON.stringify(back?.bindings) === JSON.stringify({ desc: ['cf_desc'], note: [] }),
    JSON.stringify(back?.bindings))
  ok('④ 修订号 +1', back?.revision === def.revision + 1, String(back?.revision))
  ok('④ 🔴 语义摘要不变（映射不是字段含义）', back?.semanticDigest === def.semanticDigest)
  ok('④ 字段与名称字段不动',
    back?.nameFieldId === def.nameFieldId && back?.fields.length === def.fields.length)

  const r2 = await saveDeclaredBindings(PID, 'terms', { desc: ['cf_desc'], note: [] })
  ok('④ 内容没变 ⇒ 不写库', r2.ok === true && r2.changed === false, JSON.stringify(r2))
  ok('④ 内容没变 ⇒ 修订号不涨', (await loadTemplateDef(PID, 'terms'))?.revision === def.revision + 1)

  const r3 = await saveDeclaredBindings(PID, 'items', { desc: ['cf_x'] })
  ok('④ 没采用模板 ⇒ 拒绝保存', r3.ok === false && r3.code === 'no-template', JSON.stringify(r3))

  const r4 = await saveDeclaredBindings('', 'terms', {})
  ok('④ 缺项目 ID ⇒ 拒绝', r4.ok === false && r4.code === 'invalid')

  // 迁移半途中断 ⇒ 模板与值都可能半切换，禁止确认映射
  await saveMigrationLog({
    formatVersion: MIGRATION_LOG_VERSION,
    pid: PID,
    tabId: 'terms',
    state: 'writing',
    startedAt: 1,
    updatedAt: 2,
    fromTemplateId: 'a',
    toTemplateId: 'b',
    fromRevision: 2,
    toRevision: 3,
    steps: [],
    failures: [],
    manualFields: [],
    writtenValues: 0,
    backupVerified: true,
  })
  const r5 = await saveDeclaredBindings(PID, 'terms', { desc: [] })
  ok('④ 🔴 迁移阻断期间拒绝保存映射', r5.ok === false && r5.code === 'blocked', JSON.stringify(r5))
  await db.setMeta(migrationLogKeyOf(PID, 'terms'), null)
  const r6 = await saveDeclaredBindings(PID, 'terms', { desc: [] })
  ok('④ 阻断解除后可保存', r6.ok === true, JSON.stringify(r6))

  /* ── ⑤ 模板库：确认随版本走 ── */
  const libDef = { ...mkDef(termsFields()), bindings: { desc: ['cf_desc'], note: [] as string[] } }
  const struct = structureOf(libDef)
  ok('⑤ 库结构白名单保留 bindings',
    JSON.stringify(struct.bindings) === JSON.stringify({ desc: ['cf_desc'], note: [] }),
    JSON.stringify(struct.bindings))
  ok('⑤ 没有确认的模板序列化里没有 bindings 键', !('bindings' in structureOf(mkDef(termsFields()))))
  ok('⑤ 同内容不同修订号 ⇒ 内容摘要相同',
    contentDigestOf(libDef) === contentDigestOf({ ...libDef, revision: 99, updatedAt: 123 }))
  ok('⑤ 绑定不同 ⇒ 内容摘要不同（同版本不可原地覆盖）',
    contentDigestOf(libDef) !== contentDigestOf({ ...libDef, bindings: { desc: ['cf_desc'] } }))
  ok('⑤ 有确认 vs 无确认 ⇒ 摘要不同',
    contentDigestOf(libDef) !== contentDigestOf(mkDef(termsFields())))

  /* ── ⑥ 拆书写回：已采用模板才走映射，且 fail-closed ── */
  await db.setCurrentProject('p-map-draft')
  const entities: ExtractedEntity[] = [
    { type: '术语', name: '玄脉', desc: '修行体系', evidence: '玄脉九品', fields: { note: '作者按语' } },
  ]
  const batches = [{ source: '第1章', index: 1, entities }]

  const d0 = mkDef(termsFields())
  const ctx0 = draftMappingContextOf(d0, 'terms')
  ok('⑥ 映射上下文按术语页签生成', !!ctx0 && ctx0.slots.length > 0)

  const rLegacy = await buildDraftBundle(batches, { rawText: '玄脉九品' })
  const legacy = rLegacy.rows[0]
  ok('⑥ 不传映射 ⇒ 旧口径：定义写进内置定义列',
    legacy.fields.some(f => f.key === '定义（一句话）' && f.value === '修行体系'),
    JSON.stringify(legacy.fields))

  const ctxDeclared = draftMappingContextOf(
    { ...d0, bindings: { desc: ['cf_desc'] } }, 'terms',
  )!
  const rDeclared = await buildDraftBundle(batches, {
    rawText: '玄脉九品', mappings: new Map([['terms', ctxDeclared]]),
  })
  const rowD = rDeclared.rows[0]
  ok('⑥ 确认后：描述写进作者指定的字段',
    rowD.fields.some(f => f.key === 'cf_desc' && f.value === '修行体系' && f.label === '自定义定义'),
    JSON.stringify(rowD.fields))
  ok('⑥ 确认后：不再写内置定义列',
    !rowD.fields.some(f => f.key === '定义（一句话）'), JSON.stringify(rowD.fields))
  ok('⑥ 名称仍按映射写', rowD.nameKey === '名称', rowD.nameKey)
  ok('⑥ 主名仍在 fields 里', rowD.fields.some(f => f.key === '名称' && f.value === '玄脉'))

  const ctxOptOut = draftMappingContextOf({ ...d0, bindings: { desc: [] } }, 'terms')!
  const rOptOut = await buildDraftBundle(batches, {
    rawText: '玄脉九品', mappings: new Map([['terms', ctxOptOut]]),
  })
  ok('⑥ 🔴 明确不绑定 ⇒ 两个定义列都不写',
    !rOptOut.rows[0].fields.some(f => f.key === '定义（一句话）' || f.key === 'cf_desc'),
    JSON.stringify(rOptOut.rows[0].fields))
  ok('⑥ 不绑定不影响名称落库', rOptOut.rows[0].nameKey === '名称')

  const ctxReadonly = draftMappingContextOf({ ...d0, bindings: { desc: ['cf_readonly'] } }, 'terms')!
  const rReadonly = await buildDraftBundle(batches, {
    rawText: '玄脉九品', mappings: new Map([['terms', ctxReadonly]]),
  })
  ok('⑥ 🔴 绑定到未开放 AI 写入的字段 ⇒ 不写，也不回落',
    !rReadonly.rows[0].fields.some(f => f.key === 'cf_readonly' || f.key === '定义（一句话）'),
    JSON.stringify(rReadonly.rows[0].fields))

  const dupDef = mkDef([
    ...termsFields().filter(f => f.id !== '命名备注'),
    mkField({ id: 'cf_note_a', sourceKey: 'cf_note_a', label: '命名备注' }),
    mkField({ id: 'cf_note_b', sourceKey: 'cf_note_b', label: '命名备注' }),
  ])
  const ctxDup = draftMappingContextOf(dupDef, 'terms')!
  const rDup = await buildDraftBundle(batches, {
    rawText: '玄脉九品', mappings: new Map([['terms', ctxDup]]),
  })
  ok('⑥ 🔴 语义重复 ⇒ 命名备注不写（不按第一个蒙）',
    !rDup.rows[0].fields.some(f => f.key === 'cf_note_a' || f.key === 'cf_note_b' || f.key === '命名备注'),
    JSON.stringify(rDup.rows[0].fields))
  ok('⑥ 其余字段照常写', rDup.rows[0].nameKey === '名称')
}

io().then(() => {
  console.log(`\ntemplatesMapping: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})
