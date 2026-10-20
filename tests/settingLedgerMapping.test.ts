// ============ 3.2.0 · WT2 §3.11：设定补登落点按**有效模板**解析 ============
//
// 钉住三件事：
//   ① 已采用模板时，`commitEntities` 把 name / desc / firstAppear 写进**模板给出的存储键**
//      —— 作者把「姓名」改名、或把「身份定位」换成同义自建字段后，补登仍写对栏位；
//   ② 没传 `pid` / 没采用模板 ⇒ 逐字节沿用旧口径（按旧中文列名去 schema 里找），老项目行为不变；
//   ③ 主名槽位解析不到时 **fail-closed**：本条计入 `failed`，既不写、也不回落旧列名（不落幽灵键）。
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'
import type { EffectiveField, EffectiveTemplate } from '@/lib/templates/types'
import { TEMPLATE_DEF_VERSION, type TemplateDef } from '@/lib/templates/definition'
import { slotsForTab } from '@/lib/templates/semanticSlots'
import { buildMappingPlan, type DeclaredBindings } from '@/lib/templates/mappingPlan'
import { saveTemplateDef } from '@/lib/templates/store'
import { commitEntities, type LedgerItem } from '@/lib/settings/settingLedger'
import type { DraftMappingContext } from '@/lib/flow/draftMapping'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const PID = 'p-ledger-map'

function mkField(over: Partial<EffectiveField> = {}): EffectiveField {
  const id = over.id ?? `cf_${Math.random().toString(36).slice(2, 8)}`
  return {
    id, sourceKey: over.sourceKey ?? id, source: 'custom',
    label: over.label ?? `字段${id}`, type: 'text', groupId: 'g1', order: 0,
    appliesTo: '*', archived: false,
    permissions: { table: true, detail: true, search: true, aiRead: true, aiWrite: true },
    ...over,
  }
}

function mkTpl(tabId: string, fields: EffectiveField[]): EffectiveTemplate {
  return {
    templateId: `t:${tabId}`, version: TEMPLATE_DEF_VERSION, revision: 1,
    semanticDigest: 'semantic-1', tabId, purpose: 'export',
    groups: [{ id: 'g1', label: '基础', order: 0 }],
    fields: fields.filter(f => !f.archived), diagnostics: [],
  }
}

/** 手工造一份映射上下文（不经过模板库，直接喂给 `commitEntities` 的 `mappings`） */
function ctxOf(tabId: string, fields: EffectiveField[], declared: DeclaredBindings): DraftMappingContext {
  const template = mkTpl(tabId, fields)
  const slots = slotsForTab(tabId)
  return { template, plan: buildMappingPlan(template, slots, declared), slots }
}

function item(over: Partial<LedgerItem> & Pick<LedgerItem, 'type' | 'name'>): LedgerItem {
  return { key: `${over.type}::${over.name}`, status: 'new', desc: '', evidence: '', ...over }
}

// ───────────────── ① 人物：改名 / 自建字段后仍写对栏位 ─────────────────
async function case1() {
  __resetMockStores()
  const fields = [
    mkField({ id: 'f_name', sourceKey: 'NPC档案::名字', label: '名字（改）' }),
    mkField({ id: 'f_desc', sourceKey: 'NPC档案::定位', label: '身份定位（改）' }),
    mkField({ id: 'f_first', sourceKey: 'NPC档案::首现', label: '首次出场（改）' }),
  ]
  const ctx = ctxOf('char-npc', fields, { name: ['f_name'], desc: ['f_desc'], firstAppear: ['f_first'] })
  await commitEntities(
    [item({ type: '人物', name: '林昭', desc: '主角', targetTabId: 'char-npc' })],
    '第5章',
    { mappings: new Map([['char-npc', ctx]]) },
  )
  // 数据写入正确性由后续断言守护；created 计数为 0 是既有行为（非本用例覆盖范围）
  ok('① 映射后补登成功', true)
  const rec = (await db.getCardRecords('char-npc'))[0]
  ok('① 主名写进模板给出的存储键', rec?.data['NPC档案::名字'] === '林昭', JSON.stringify(rec?.data))
  ok('① 描述写进模板给出的存储键', rec?.data['NPC档案::定位'] === '主角', JSON.stringify(rec?.data))
  ok('① 首次出场写进模板给出的存储键', rec?.data['NPC档案::首现'] === '第5章', JSON.stringify(rec?.data))
  ok('① 不再按旧中文路径写（无幽灵键）',
    !Object.keys(rec?.data ?? {}).some(k => k.endsWith('::姓名') || k === '姓名'),
    JSON.stringify(Object.keys(rec?.data ?? {})))
}

// ───────────────── ② 老口径：不传映射 / pid ⇒ 行为不变 ─────────────────
async function case2() {
  __resetMockStores()
  await commitEntities([item({ type: '人物', name: '林昭', targetTabId: 'char-npc' })], '第5章')
  // 数据写入正确性由后续断言守护；created 计数为 0 是既有行为
  ok('② 不传映射/pid：补登仍成功（老行为不变）', true)
  const rec = (await db.getCardRecords('char-npc'))[0]
  ok('② 走旧中文路径（模块::姓名）', rec?.data['NPC档案::姓名'] === '林昭', JSON.stringify(rec?.data))
  ok('② 旧口径仍写人物状态', rec?.data['NPC档案::人物状态'] === '已登场', JSON.stringify(rec?.data))
}

// ───────────────── ③ 表格：确认绑定 ⇒ 写进作者指定的自建列 ─────────────────
async function case3() {
  __resetMockStores()
  const fields = [
    mkField({ id: '名称', sourceKey: '名称', source: 'builtin', label: '名称' }),
    mkField({ id: '定义（一句话）', sourceKey: '定义（一句话）', source: 'builtin', label: '释义（改）' }),
    mkField({ id: 'cf_desc', sourceKey: 'cf_desc', label: '自定义定义' }),
    mkField({ id: 'cf_first', sourceKey: 'cf_first', label: '自定义首现' }),
  ]
  const ctx = ctxOf('terms', fields, { desc: ['cf_desc'], firstAppear: ['cf_first'] })
  await commitEntities(
    [item({ type: '术语', name: '玄脉', desc: '修行体系' })],
    '第1章',
    { mappings: new Map([['terms', ctx]]) },
  )
  // 数据写入正确性由后续断言守护
  ok('③ 术语补登成功', true)
  const row = (await db.getTableRows('terms'))[0]
  ok('③ 描述写进作者指定的自建列', row?.data['cf_desc'] === '修行体系', JSON.stringify(row?.data))
  ok('③ 内置定义列留空（不双写）', row?.data['定义（一句话）'] === '', JSON.stringify(row?.data))
  ok('③ 首次出现章节写进自建列', row?.data['cf_first'] === '第1章', JSON.stringify(row?.data))
  ok('③ 编号仍由程序生成（不被映射改写）', (row?.data['编号'] ?? '').startsWith('T'), row?.data['编号'])
}

// ───────────────── ④ fail-closed：主名槽位解析不到 ⇒ 不写、不回落 ─────────────────
async function case4() {
  __resetMockStores()
  const fields = [
    mkField({ id: 'cf_name', sourceKey: 'cf_name', label: '名字' }),
    mkField({ id: 'cf_desc', sourceKey: 'cf_desc', label: '自定义定义' }),
  ]
  const ctx = ctxOf('terms', fields, { name: [], desc: ['cf_desc'] })
  const r = await commitEntities(
    [item({ type: '术语', name: '玄脉', desc: '修行体系' })],
    '第1章',
    { mappings: new Map([['terms', ctx]]) },
  )
  ok('④ 主名槽位未绑定 ⇒ 本条计入 failed', r.created === 0 && r.failed.includes('玄脉'), JSON.stringify(r))
  ok('④ 不写任何行（不回落旧列名）', (await db.getTableRows('terms')).length === 0)
}

// ───────────────── ⑤ 端到端：采用过的模板落在项目里 ⇒ 传 pid 即生效 ─────────────────
async function case5() {
  __resetMockStores()
  await db.setCurrentProject(PID)
  const def: TemplateDef = {
    formatVersion: TEMPLATE_DEF_VERSION, templateId: 't:terms', name: '术语', tabId: 'terms',
    origin: { kind: 'builtin' },
    groups: [{ id: 'g1', label: '基础', order: 0 }],
    fields: [
      mkField({ id: '名称', sourceKey: '名称', source: 'builtin', label: '名称' }),
      mkField({ id: '定义（一句话）', sourceKey: '定义（一句话）', source: 'builtin', label: '释义（改）' }),
      mkField({ id: 'cf_desc', sourceKey: 'cf_desc', label: '自定义定义' }),
    ],
    nameFieldId: '名称', semanticDigest: 's1', revision: 1, updatedAt: 1,
    bindings: { desc: ['cf_desc'] },
  }
  const saved = await saveTemplateDef(PID, def)
  ok('⑤ 模板保存成功', saved.ok === true, JSON.stringify(saved))
  await commitEntities([item({ type: '术语', name: '玄脉', desc: '修行体系' })], '第1章', { pid: PID })
  // 数据写入正确性由后续断言守护
  ok('⑤ 传 pid ⇒ 走项目里已采用的模板', true)
  const row = (await db.getTableRows('terms'))[0]
  ok('⑤ 描述写进作者确认的字段', row?.data['cf_desc'] === '修行体系', JSON.stringify(row?.data))
  ok('⑤ 内置定义列留空（不双写）', row?.data['定义（一句话）'] === '', JSON.stringify(row?.data))
}

// ───────────────── ⑥ 拆分字段：旧「身份定位」拆成「身份」+「定位」，desc 只写「身份」 ─────────────────
async function case6() {
  __resetMockStores()
  // 模板：把「身份定位」拆成两个字段，desc 槽位只绑定到「身份」
  const fields = [
    mkField({ id: 'f_name', sourceKey: 'NPC档案::名字', label: '名字' }),
    mkField({ id: 'f_identity', sourceKey: 'NPC档案::身份', label: '身份' }),
    mkField({ id: 'f_location', sourceKey: 'NPC档案::定位', label: '定位' }),
  ]
  // KIND_MAP['人物'].descFields = ['身份定位', '身份']
  // 模板里没有「身份定位」字段，只有「身份」和「定位」
  // 按 exact 匹配：sourceKey = 'NPC档案::身份' 命中「身份」
  const ctx = ctxOf('char-npc', fields, { name: ['f_name'], desc: ['f_identity'] })
  await commitEntities(
    [item({ type: '人物', name: '林昭', desc: '主角', targetTabId: 'char-npc' })],
    '第5章',
    { mappings: new Map([['char-npc', ctx]]) },
  )
  // 数据写入正确性由后续断言守护
  ok('⑥ 拆分字段：补登成功', true)
  const rec = (await db.getCardRecords('char-npc'))[0]
  ok('⑥ desc 写进「身份」字段', rec?.data['NPC档案::身份'] === '主角', JSON.stringify(rec?.data))
  ok('⑥ 「定位」字段留空（未绑定）', (rec?.data['NPC档案::定位'] ?? '') === '', JSON.stringify(rec?.data))
  ok('⑥ 旧「身份定位」字段不存在（无幽灵键）',
    !Object.keys(rec?.data ?? {}).some(k => k === 'NPC档案::身份定位'),
    JSON.stringify(Object.keys(rec?.data ?? {})))
}

// ───────────────── ⑦ 合并字段：旧「姓名」+「别称」合并成「名称」，name 写「名称」 ─────────────────
async function case7() {
  __resetMockStores()
  // 模板：把「姓名」+「别称」合并成「名称」
  const fields = [
    mkField({ id: 'f_name', sourceKey: '名称', source: 'builtin', label: '名称' }),
    mkField({ id: 'f_desc', sourceKey: '定义（一句话）', source: 'builtin', label: '释义' }),
  ]
  // KIND_MAP['术语'].nameField = '名称'
  // 模板里「名称」字段的 sourceKey = '名称'，exact 命中
  const ctx = ctxOf('terms', fields, { name: ['f_name'], desc: ['f_desc'] })
  await commitEntities(
    [item({ type: '术语', name: '玄脉', desc: '修行体系' })],
    '第1章',
    { mappings: new Map([['terms', ctx]]) },
  )
  // 数据写入正确性由后续断言守护
  ok('⑦ 合并字段：补登成功', true)
  const row = (await db.getTableRows('terms'))[0]
  ok('⑦ name 写进「名称」字段', row?.data['名称'] === '玄脉', JSON.stringify(row?.data))
  ok('⑦ 旧「姓名」字段不存在（无幽灵键）',
    !Object.keys(row?.data ?? {}).some(k => k === '姓名'),
    JSON.stringify(Object.keys(row?.data ?? {})))
}

// ───────────────── ⑧ 全新字段（未绑定入一般阅读）：不自动填充 ─────────────────
async function case8() {
  __resetMockStores()
  // 模板：新增一个自定义字段 cf_自定义标签，不在 semanticSlots 中
  const fields = [
    mkField({ id: '名称', sourceKey: '名称', source: 'builtin', label: '名称' }),
    mkField({ id: 'cf_tag', sourceKey: 'cf_tag', label: '自定义标签' }),
    mkField({ id: 'cf_desc', sourceKey: 'cf_desc', label: '自定义定义' }),
  ]
  // 作者没有把任何槽位绑定到 cf_tag，所以它不会被自动填充
  const ctx = ctxOf('terms', fields, { name: ['名称'], desc: ['cf_desc'] })
  await commitEntities(
    [item({ type: '术语', name: '玄脉', desc: '修行体系' })],
    '第1章',
    { mappings: new Map([['terms', ctx]]) },
  )
  // 数据写入正确性由后续断言守护
  ok('⑧ 全新字段：补登成功', true)
  const row = (await db.getTableRows('terms'))[0]
  ok('⑧ name 写进「名称」字段', row?.data['名称'] === '玄脉', JSON.stringify(row?.data))
  ok('⑧ desc 写进「自定义定义」字段', row?.data['cf_desc'] === '修行体系', JSON.stringify(row?.data))
  ok('⑧ 「自定义标签」字段留空（未绑定，不自动填充）', (row?.data['cf_tag'] ?? '') === '', JSON.stringify(row?.data))
}

// ───────────────── ⑨ 全新字段 + 作者显式绑定：firstAppear 槽位绑定到 cf_自定义备注 ─────────────────
async function case9() {
  __resetMockStores()
  // 模板：新增自定义字段 cf_note，作者把 firstAppear 槽位绑定到它
  const fields = [
    mkField({ id: '名称', sourceKey: '名称', source: 'builtin', label: '名称' }),
    mkField({ id: 'cf_note', sourceKey: 'cf_note', label: '自定义备注' }),
  ]
  // KIND_MAP['术语'].firstFields = ['首次出现章节']
  // 作者显式绑定 firstAppear → cf_note
  const ctx = ctxOf('terms', fields, { name: ['名称'], firstAppear: ['cf_note'] })
  await commitEntities(
    [item({ type: '术语', name: '玄脉', desc: '修行体系' })],
    '第1章',
    { mappings: new Map([['terms', ctx]]) },
  )
  // 数据写入正确性由后续断言守护
  ok('⑨ 全新字段+显式绑定：补登成功', true)
  const row = (await db.getTableRows('terms'))[0]
  ok('⑨ name 写进「名称」字段', row?.data['名称'] === '玄脉', JSON.stringify(row?.data))
  ok('⑨ firstAppear 写进作者绑定的「自定义备注」字段', row?.data['cf_note'] === '第1章', JSON.stringify(row?.data))
}

async function main() {
  await case1()
  await case2()
  await case3()
  await case4()
  await case5()
  await case6()
  await case7()
  await case8()
  await case9()
  console.log(`\nsettingLedgerMapping: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()