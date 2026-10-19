// ============ 3.2.0 · WT1-1/WT1-2：模板定义存储、限额与快照派生 ============
//
// 钉四件事：
//   ① 限额按方案 §3.5「初始限制」逐条生效，且**超限一律拒绝、绝不截断**
//      （截断会让作者存进去的结构和设计的悄悄不一样，且偏差逐次累积）；
//   ② 三个派生起点（内置 / 图鉴 / 空白）产出的快照形状正确；
//   ③ 🔴 归档定义必须随快照带走 —— 丢了等于把作者用过的结构永久删掉；
//   ④ 存储往返 + 限额拒绝时**不写库**（不能留半写状态）。
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'
import { TABS } from '@/lib/schema'
import {
  TEMPLATE_LIMITS, TEMPLATE_DEF_VERSION, PROJECT_TEMPLATE_INDEX,
  projectTemplateKeyOf, libraryKeyOf, type TemplateDef,
} from '@/lib/templates/definition'
import { bytesOf, charLen, checkTemplateDef, checkTemplatePack, checkProjectTemplateDefs } from '@/lib/templates/limits'
import { snapshotOfBuiltin, snapshotOfAtlas, snapshotOfBlank, nameFieldOf, newTemplateId, CUSTOM_TEMPLATE_ID_PREFIX } from '@/lib/templates/snapshot'
import { adaptTemplateDef } from '@/lib/templates/defAdapter'
import { loadTemplateDef, saveTemplateDef, deleteTemplateDef, loadTemplateIndex } from '@/lib/templates/store'
import type { AtlasSchemaConfig } from '@/lib/atlas/types'
import type { EffectiveField } from '@/lib/templates/types'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const tabOf = (id: string) => {
  const t = TABS.find(x => x.id === id)
  if (!t) throw new Error('找不到页签 ' + id)
  return t
}

const PID = 'p-def'

function mkField(over: Partial<EffectiveField> = {}): EffectiveField {
  const id = over.id ?? `cf_${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    sourceKey: id,
    source: 'custom',
    label: '字段' + id,
    type: 'text',
    groupId: 'g1',
    order: 0,
    appliesTo: '*',
    archived: false,
    permissions: { table: true, detail: true, search: true, aiRead: true, aiWrite: false },
    ...over,
  }
}

function mkDef(fields: EffectiveField[], over: Partial<TemplateDef> = {}): TemplateDef {
  return {
    formatVersion: TEMPLATE_DEF_VERSION,
    templateId: 'builtin:races',
    name: '模板',
    tabId: 'races',
    origin: { kind: 'builtin' },
    groups: [{ id: 'g1', label: '扩展', order: 0 }],
    fields,
    nameFieldId: fields[0]?.id ?? '',
    semanticDigest: 'd',
    revision: 0,
    updatedAt: 1,
    ...over,
  }
}

// ────────────────────────── ① 限额：活跃自定义字段 ──────────────────────────
{
  const L = TEMPLATE_LIMITS
  const mk = (n: number, archived = false) =>
    Array.from({ length: n }, (_, i) => mkField({ id: `cf_${i}`, sourceKey: `cf_${i}`, archived }))

  ok('① 60 个未归档自定义字段 ⇒ 通过', checkTemplateDef(mkDef(mk(L.MAX_ACTIVE_CUSTOM_FIELDS))).length === 0)
  const over = checkTemplateDef(mkDef(mk(L.MAX_ACTIVE_CUSTOM_FIELDS + 1)))
  ok('① 61 个 ⇒ 拒绝', over.length === 1 && over[0].code === 'too-many-active-fields', JSON.stringify(over))

  // 🔴 归档不计入「活跃」，但计入「合计 200」
  const mixed = checkTemplateDef(mkDef([...mk(50), ...mk(151, true)]))
  ok('① 归档字段不计入活跃额度', mixed.every(v => v.code !== 'too-many-active-fields'), JSON.stringify(mixed))
  ok('① 但归档计入合计 200（防靠归档无限积累）',
    mixed.some(v => v.code === 'too-many-total-fields'), JSON.stringify(mixed))
  ok('① 合计 200 内 ⇒ 通过', checkTemplateDef(mkDef([...mk(50), ...mk(150, true)])).length === 0)
}

// ────────────────────────── ② 限额：分组 / 名称 / 说明 / 选项 ──────────────────────────
{
  const L = TEMPLATE_LIMITS
  const groups = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `g${i}`, label: '组' + i, order: i }))
  ok('② 20 个分组 ⇒ 通过', checkTemplateDef(mkDef([mkField()], { groups: groups(L.MAX_GROUPS) })).length === 0)
  ok('② 21 个分组 ⇒ 拒绝',
    checkTemplateDef(mkDef([mkField()], { groups: groups(L.MAX_GROUPS + 1) })).some(v => v.code === 'too-many-groups'))

  const len = (n: number) => mkField({ label: 'x'.repeat(n) })
  ok('② 名称 1 字 ⇒ 通过', checkTemplateDef(mkDef([len(L.NAME_MIN)])).length === 0)
  ok('② 名称 20 字 ⇒ 通过', checkTemplateDef(mkDef([len(L.NAME_MAX)])).length === 0)
  ok('② 名称 0 字 ⇒ 拒绝', checkTemplateDef(mkDef([len(0)])).some(v => v.code === 'bad-field-name'))
  ok('② 名称 21 字 ⇒ 拒绝', checkTemplateDef(mkDef([len(L.NAME_MAX + 1)])).some(v => v.code === 'bad-field-name'))

  const desc = (n: number) => mkField({ description: 'y'.repeat(n) })
  ok('② 说明 500 字 ⇒ 通过', checkTemplateDef(mkDef([desc(L.DESCRIPTION_MAX)])).length === 0)
  ok('② 说明 501 字 ⇒ 拒绝', checkTemplateDef(mkDef([desc(L.DESCRIPTION_MAX + 1)])).some(v => v.code === 'description-too-long'))

  const opts = (n: number) => mkField({ type: 'select', options: Array.from({ length: n }, (_, i) => 'o' + i) })
  ok('② 选项 100 项 ⇒ 通过', checkTemplateDef(mkDef([opts(L.MAX_OPTIONS)])).length === 0)
  ok('② 选项 101 项 ⇒ 拒绝', checkTemplateDef(mkDef([opts(L.MAX_OPTIONS + 1)])).some(v => v.code === 'too-many-options'))

  // 🔴 一次性报全部违规：作者改的是一份结构，只报一条就得存一次看一次
  const many = checkTemplateDef(mkDef([len(25), desc(600), opts(120)]))
  ok('② 多条违规一次返回', many.length === 3, JSON.stringify(many.map(v => v.code)))
}

// ────────────────────────── ③ 限额：字节（UTF-8，不是字符数） ──────────────────────────
{
  const L = TEMPLATE_LIMITS
  ok('③ 字节按 UTF-8 算（中文 1 字 = 3 字节）', bytesOf('中文') === 6, String(bytesOf('中文')))
  ok('③ 字长按码点算（代理对不拆成 2）', charLen('𠮷') === 1, String(charLen('𠮷')))

  const at = (n: number) => 'z'.repeat(n)
  ok('③ 包正好 2MiB ⇒ 通过', checkTemplatePack(at(L.PACK_MAX_BYTES)).length === 0)
  ok('③ 包超 1 字节 ⇒ 拒绝',
    checkTemplatePack(at(L.PACK_MAX_BYTES + 1)).some(v => v.code === 'pack-too-large'))

  // 项目合计 8MiB：用「长候选项」把字节撑起来 ——
  // 不能拿"超长说明"造数据，那会先撞上单字段 500 字上限，测的就不是合计额度了。
  const big = (id: string, tabId: string, mb: number) => mkDef(
    [mkField({
      id, sourceKey: id, type: 'select',
      options: Array.from({ length: L.MAX_OPTIONS },
        () => at(Math.ceil(mb * 1024 * 1024 / L.MAX_OPTIONS))),
    })],
    { tabId, templateId: `builtin:${tabId}` },
  )
  const a = big('cf_a', 'races', 5)
  const b = big('cf_b', 'items', 5)
  const v = checkProjectTemplateDefs([a, b])
  ok('③ 项目合计超 8MiB ⇒ 拒绝', v.some(x => x.code === 'project-defs-too-large'), JSON.stringify(v.map(x => x.code)))
  ok('③ 超限时**只有**合计这条（单份结构本身合法）',
    v.length === 1 && v[0].code === 'project-defs-too-large', JSON.stringify(v.map(x => x.code)))

  const smallA = big('cf_a', 'races', 1)
  ok('③ 项目合计在额度内 ⇒ 通过', checkProjectTemplateDefs([smallA, b]).length === 0)
}

// ────────────────────────── ④ 派生起点：内置 / 图鉴 / 空白 ──────────────────────────
{
  const terms = tabOf('terms')
  const snap = snapshotOfBuiltin(terms)
  const want = (terms.columns ?? []).filter(c => !c.hidden).map(c => c.name)
  ok('④ 内置派生：字段 = 非隐藏列', JSON.stringify(snap.fields.map(f => f.sourceKey)) === JSON.stringify(want))
  ok('④ 内置派生：source 全为 builtin', snap.fields.every(f => f.source === 'builtin'))
  ok('④ 内置派生：templateId 带 builtin 前缀', snap.templateId === `builtin:${terms.id}`)
  ok('④ 内置派生：origin = builtin', snap.origin.kind === 'builtin')

  // 空白：只有一个最小名称入口
  const blank = snapshotOfBlank(terms)
  ok('④ 空白派生：只有一个字段', blank.fields.length === 1)
  ok('④ 空白派生：该字段就是名称字段', blank.nameFieldId === blank.fields[0].id)
  ok('④ 空白派生：不带任何内置列', blank.fields.every(f => f.source === 'custom'))
  ok('④ 空白派生：templateId 是作者自建前缀', blank.templateId.startsWith(CUSTOM_TEMPLATE_ID_PREFIX))
  ok('④ 空白派生：origin = blank', blank.origin.kind === 'blank')
  ok('④ newTemplateId 每次不同', newTemplateId() !== newTemplateId())
}

// ────────────────────────── ⑤ 🔴 归档定义随快照带走 ──────────────────────────
{
  const cfg: AtlasSchemaConfig = {
    formatVersion: 1,
    revision: 3,
    fields: [
      { id: 'cf_live', label: '在用的', type: 'text', description: '', options: [], appliesTo: '*', groupId: 'extra', order: 0, tableVisible: true, detailVisible: true, searchable: true, aiReadable: true, aiWritable: false, archived: false },
      { id: 'cf_old', label: '已归档的', type: 'select', description: '', options: ['甲'], appliesTo: ['魔兽'], groupId: 'extra', order: 1, tableVisible: true, detailVisible: true, searchable: true, aiReadable: true, aiWritable: false, archived: true },
    ],
    groups: [{ id: 'extra', label: '扩展', order: 0 }],
    builtinPresentation: {},
    summaryKeys: [],
  } as unknown as AtlasSchemaConfig

  const snap = snapshotOfAtlas(tabOf('races'), { config: cfg })
  ok('⑤ 图鉴派生：自定义字段都在快照里', snap.fields.some(f => f.id === 'cf_live'))
  ok('⑤ 🔴 图鉴派生：归档定义也在快照里（丢了恢复不了）', snap.fields.some(f => f.id === 'cf_old'))
  const old = snap.fields.find(f => f.id === 'cf_old')!
  ok('⑤ 归档字段的 archived 标记被保留', old.archived === true)
  ok('⑤ 归档字段的类型/候选/适用范围都保留',
    old.type === 'select' && JSON.stringify(old.options) === JSON.stringify(['甲'])
    && JSON.stringify(old.appliesTo) === JSON.stringify(['魔兽']))

  // 常规解析归档不可见 ⇒ 快照 ≠ 解析结果，两者不能混为一谈
  const view = adaptTemplateDef(snap, { purpose: 'detail' })
  ok('⑤ 解析视图里看不到归档字段（归档＝不显示）', !view.fields.some(f => f.id === 'cf_old'))
  ok('⑤ 但归档定义仍在快照里（不删除）', snap.fields.some(f => f.id === 'cf_old'))
}

// ────────────────────────── ⑥ 快照解析：用途分面 ──────────────────────────
{
  const cfg: AtlasSchemaConfig = {
    formatVersion: 1,
    revision: 1,
    fields: [
      { id: 'cf_x', label: '只给表格看', type: 'text', description: '', options: [], appliesTo: '*', groupId: 'extra', order: 0, tableVisible: true, detailVisible: false, searchable: false, aiReadable: false, aiWritable: false, archived: false },
    ],
    groups: [{ id: 'extra', label: '扩展', order: 0 }],
    builtinPresentation: {},
    summaryKeys: [],
  } as unknown as AtlasSchemaConfig

  const snap = snapshotOfAtlas(tabOf('races'), { config: cfg })
  const x = snap.fields.find(f => f.id === 'cf_x')!
  ok('⑥ 快照里存的是**完整权限**（不因用途被裁掉）', x.permissions.detail === false && x.permissions.aiRead === false)
  ok('⑥ table 用途 ⇒ 可见', adaptTemplateDef(snap, { purpose: 'table' }).fields.some(f => f.id === 'cf_x'))
  ok('⑥ detail 用途 ⇒ 不可见', !adaptTemplateDef(snap, { purpose: 'detail' }).fields.some(f => f.id === 'cf_x'))
  ok('⑥ aiRead 用途 ⇒ 不可见', !adaptTemplateDef(snap, { purpose: 'aiRead' }).fields.some(f => f.id === 'cf_x'))
  ok('⑥ 🔴 export 用途 ⇒ 不受展示开关限制（作者自己的数据出门）',
    adaptTemplateDef(snap, { purpose: 'export' }).fields.some(f => f.id === 'cf_x'))
  ok('⑥ 🔴 index 用途 ⇒ 按 aiRead 口径',
    !adaptTemplateDef(snap, { purpose: 'index' }).fields.some(f => f.id === 'cf_x'))
}

// ────────────────────────── ⑦ 存储往返与限额拒绝不写库 ──────────────────────────
async function io() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  ok('⑦ 没采用模板 ⇒ null', (await loadTemplateDef(PID, 'races')) === null)

  const def = mkDef([mkField({ id: 'cf_1', sourceKey: 'cf_1', label: '食性' })], { templateId: 'tpl_a', name: '我的模板' })
  const r = await saveTemplateDef(PID, def)
  ok('⑦ 保存成功', r.ok === true, JSON.stringify(r))
  const back = await loadTemplateDef(PID, 'races')
  ok('⑦ 往返后定义等价', JSON.stringify(back) === JSON.stringify(def))

  const idx = await loadTemplateIndex(PID)
  ok('⑦ 目录索引记了一条', idx.entries.length === 1 && idx.entries[0].tabId === 'races')
  ok('⑦ 索引带模板名与摘要', idx.entries[0].name === '我的模板' && idx.entries[0].templateId === 'tpl_a')

  // 同页签再存一次 ⇒ 索引仍是 1 条（更新而不是追加）
  await saveTemplateDef(PID, { ...def, revision: 2, name: '我的模板·改' })
  const idx2 = await loadTemplateIndex(PID)
  ok('⑦ 重复保存同页签 ⇒ 索引不重复', idx2.entries.length === 1, String(idx2.entries.length))
  ok('⑦ 索引跟着更新', idx2.entries[0].revision === 2 && idx2.entries[0].name === '我的模板·改')

  // 另一个项目互不干扰
  await db.setCurrentProject('p-other')
  ok('⑦ 别的项目读不到（pid 隔离）', (await loadTemplateDef('p-other', 'races')) === null)
  ok('⑦ 原项目仍在', (await loadTemplateDef(PID, 'races')) !== null)

  // 🔴 超限 ⇒ 拒绝且不写库
  const bad = mkDef(Array.from({ length: TEMPLATE_LIMITS.MAX_ACTIVE_CUSTOM_FIELDS + 1 },
    (_, i) => mkField({ id: `cf_b${i}`, sourceKey: `cf_b${i}` })), { tabId: 'items', templateId: 'tpl_bad' })
  const rb = await saveTemplateDef(PID, bad)
  ok('⑦ 超限 ⇒ 拒绝', rb.ok === false && (rb as { violations: unknown[] }).violations.length > 0)
  ok('⑦ 🔴 超限 ⇒ 库里没有半写状态', (await loadTemplateDef(PID, 'items')) === null)
  ok('⑦ 🔴 超限 ⇒ 索引也没被污染', (await loadTemplateIndex(PID)).entries.every(e => e.tabId !== 'items'))

  // 放弃自定义
  await deleteTemplateDef(PID, 'races')
  ok('⑦ 放弃自定义 ⇒ null', (await loadTemplateDef(PID, 'races')) === null)
  ok('⑦ 放弃自定义 ⇒ 索引条目也清掉', (await loadTemplateIndex(PID)).entries.length === 0)
}

// ────────────────────────── ⑧ 名称字段挑选 ──────────────────────────
{
  const fields = [
    mkField({ id: 'cf_a', sourceKey: 'cf_a', label: '备注' }),
    mkField({ id: 'cf_b', sourceKey: 'cf_b', label: '姓名' }),
  ]
  ok('⑧ 优先挑名字里带「姓名」的', nameFieldOf(fields) === 'cf_b')
  ok('⑧ 显式指定优先于猜', nameFieldOf(fields, 'cf_a') === 'cf_a')
  ok('⑧ 没有名字字段 ⇒ 取第一个', nameFieldOf([mkField({ id: 'cf_c', sourceKey: 'cf_c', label: '备注' })]) === 'cf_c')
  ok('⑧ 归档字段不会被挑中',
    nameFieldOf([mkField({ id: 'cf_g', sourceKey: 'cf_g', label: '姓名', archived: true }), mkField({ id: 'cf_h', sourceKey: 'cf_h', label: '备注' })]) === 'cf_h')
  ok('⑧ 空表 ⇒ 空串（映射不到，需作者指定）', nameFieldOf([]) === '')
}

// ────────────────────────── ⑨ 存储键与限额常量 = 方案 §3.5 原文 ──────────────────────────
//
// 🔴 为什么要钉常量：存储键一旦漂移，老项目里已采用的结构就读不到了（静默"模板丢失"）；
//    限额一旦漂移，有的机器上能存、换个版本存不进去，作者只会以为软件坏了。
{
  ok('⑨ 项目模板键 = projectTemplate32:<tabId>', projectTemplateKeyOf('races') === 'projectTemplate32:races')
  ok('⑨ 目录索引键 = projectTemplate32:index', PROJECT_TEMPLATE_INDEX === 'projectTemplate32:index')
  ok('⑨ 个人库键 = templateLibrary32:<id>:v<n>',
    libraryKeyOf('tpl_a', 2) === 'templateLibrary32:tpl_a:v2')

  const L = TEMPLATE_LIMITS
  ok('⑨ 活跃自定义字段上限 60', L.MAX_ACTIVE_CUSTOM_FIELDS === 60)
  ok('⑨ 自定义字段合计上限 200', L.MAX_TOTAL_CUSTOM_FIELDS === 200)
  ok('⑨ 分组上限 20', L.MAX_GROUPS === 20)
  ok('⑨ 名称 1–20 字', L.NAME_MIN === 1 && L.NAME_MAX === 20)
  ok('⑨ 说明上限 500 字', L.DESCRIPTION_MAX === 500)
  ok('⑨ 候选项上限 100', L.MAX_OPTIONS === 100)
  ok('⑨ 模板包上限 2 MiB', L.PACK_MAX_BYTES === 2 * 1024 * 1024)
  ok('⑨ 项目模板合计上限 8 MiB', L.PROJECT_MAX_BYTES === 8 * 1024 * 1024)
}

io().then(() => {
  console.log(`\ntemplatesDef: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})
