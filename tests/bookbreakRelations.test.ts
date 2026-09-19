/**
 * 一键拆书 · 末尾「整理关系」阶段（人物关系 / 势力关系）
 *
 * 【为什么必须单独测】
 * 关系行与实体草稿**形状不同**：两张关系表都没有「名称」列，主名是 `A · B` 合成的。
 * 而落库那一层（flow/commit）是「按名称列找同名条目」的 —— 对关系表天然失效。
 * 也就是说这条链上写错任何一处都**不报错**：
 *   · 列名对不上 → 字段静默丢掉（表里那几列永远是空的）
 *   · nameKey 指错列 → 界面上改主名改不动 / 改到别的列
 *   · 置信度低于阈值 → 整理出来却默认不勾，作者以为"什么都没整理出来"
 * 所以这里把「行 → 草稿行 → 真落库」整条链在内存库里跑一遍，而不是只测纯函数形状。
 */
import * as db from '../src/lib/db'
import { TABS } from '../src/lib/schema'
import { rowFingerprint } from '../src/lib/aiTasks'
import { commitDraftRows, previewCommit } from '../src/lib/flow/commit'
import { defaultPicked, pickableAsNew } from '../src/lib/flow/draft'
import { RELATION_TAB_IDS, buildRelationDrafts, evidenceInMaterial, filterRowsByRoster, keyColsOf, relationRowsToDrafts } from '../src/lib/bookbreak/relations'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

__resetMockStores()
db.setCurrentProject('rel-test')

// ---------- ① 前提：这两张表确实没有「名称」列 ----------
{
  const tabs = RELATION_TAB_IDS.map(id => TABS.find(t => t.id === id))
  ok('两张关系表都在 schema 里', tabs.every(Boolean), RELATION_TAB_IDS.join(','))
  const haveNameCol = tabs.map(t => (t?.columns ?? []).some(c => c.name === '名称'))
  ok('🔴 关系表都没有「名称」列（所以 commit 那套按名称判重对它们失效，判重必须在本阶段做）',
    haveNameCol.every(v => !v), String(haveNameCol))
  ok('两张都是表格型（不是卡片 / 表单）', tabs.every(t => t?.type === 'table'),
    tabs.map(t => `${t?.id}=${t?.type}`).join(','))
}

// ---------- ② 行 → 草稿行：形状 ----------
{
  const rel = TABS.find(t => t.id === 'relations')!
  const drafts = relationRowsToDrafts(rel, [
    { 人物A: '萧景行', 人物B: '萧景炎', 关系类型: '竞争', 关系现状: '表面和睦、实则提防' },
    { 人物A: '陈渊', 人物B: '苏念', 关系类型: '师徒' },
  ])
  ok('两张关系行 → 两条草稿', drafts.length === 2)
  ok('目标页签与显示名正确（界面按它分组）',
    drafts[0].tabId === 'relations' && drafts[0].tabName === '人物关系', drafts[0].tabName)
  ok('主名用「A · B」合成', drafts[0].name === '萧景行 · 萧景炎', drafts[0].name)
  ok('🔴 nameKey 指向第一列（界面上改主名改的就是「人物A」）',
    drafts[0].nameKey === '人物A', drafts[0].nameKey)
  const colNames = (rel.columns ?? []).filter(c => c.name !== '编号').map(c => c.name)
  ok('🔴 字段键与表列逐一对应（键写错＝字段静默丢失）',
    drafts[0].fields.map(f => f.key).join('|') === colNames.join('|'),
    drafts[0].fields.map(f => f.key).join('|'))
  ok('字段的 label 也用列名（界面详情里显示的就是它）',
    drafts[0].fields.every(f => f.label === f.key))
  ok('缺的列留空串而不是漏项（否则落库时那一列不会初始化）',
    drafts[1].fields.length === colNames.length && drafts[1].fields.every(f => typeof f.value === 'string'))
  ok('两条草稿 key 不重复（界面勾选状态按 key 记）', drafts[0].key !== drafts[1].key, drafts.map(d => d.key).join(','))
  ok('状态是 new（能产出就已本地判过重）', drafts.every(d => d.status === 'new'))
  ok('🔴 默认会被勾上（置信度必须过默认勾选阈值，否则作者会以为"什么都没整理出来"）',
    drafts.every(d => defaultPicked(d) && pickableAsNew(d)),
    drafts.map(d => d.confidence).join(','))
  ok('kindLabel 是「关系」（界面按它归类显示）', drafts.every(d => d.kindLabel === '关系'))
  ok('没给「依据」时 quotes 为空数组（审阅面板对空 quotes 不显示引用块，不误报缺证据）',
    drafts.every(d => Array.isArray(d.quotes) && d.quotes.length === 0))
  const withEv = relationRowsToDrafts(rel, [{ 人物A: '陈渊', 人物B: '苏念', 依据: '陈渊在城外破庙里遇见了苏念' }])
  ok('模型给的「依据」进 quotes（界面上作为原文引用展示，作者一眼能核对）',
    withEv[0].quotes.length === 1 && withEv[0].quotes[0].includes('破庙'), JSON.stringify(withEv[0].quotes))
}

// ---------- ③ 势力关系同理：第一列是势力A ----------
{
  const fac = TABS.find(t => t.id === 'faction-rels')!
  const d = relationRowsToDrafts(fac, [{ 势力A: '青岚宗', 势力B: '中州萧家', 关系类型: '敌对' }])[0]
  ok('势力关系：nameKey 指向「势力A」', d.nameKey === '势力A', d.nameKey)
  ok('势力关系：主名合成正确', d.name === '青岚宗 · 中州萧家', d.name)
  ok('势力关系：tabId 正确', d.tabId === 'faction-rels')
  // 只填了 A 没填 B（模型可能漏）→ 主名不该出现孤零零的分隔符
  const d2 = relationRowsToDrafts(fac, [{ 势力A: '青岚宗', 势力B: '' }])[0]
  ok('B 列为空时主名是单个名字（不出现裸露的分隔符）', d2.name === '青岚宗', d2.name)
}

// ---------- ④ 真落库：关系草稿写进表 ----------
{
  const rel = TABS.find(t => t.id === 'relations')!
  const cols = (rel.columns ?? []).map(c => c.name)
  const drafts = relationRowsToDrafts(rel, [
    { 人物A: '萧景行', 人物B: '萧景炎', 关系类型: '竞争', 关系现状: '表面和睦' },
    { 人物A: '陈渊', 人物B: '苏念', 关系类型: '师徒' },
  ])
  const out = await commitDraftRows(drafts)
  ok('落库：两条都新建成功（无失败项）', out.created === 2 && out.failed.length === 0,
    JSON.stringify(out))

  const rows = await db.getTableRows('relations')
  ok('落库：表里确实多出 2 行', rows.length === 2, String(rows.length))
  const byA = new Map(rows.map(r => [r.data['人物A'], r.data]))
  ok('落库：「人物A / 人物B」两列都写对了',
    byA.get('萧景行')?.['人物B'] === '萧景炎' && byA.get('陈渊')?.['人物B'] === '苏念',
    rows.map(r => `${r.data['人物A']}→${r.data['人物B']}`).join(','))
  ok('落库：「关系类型」写对（这一列是 select，值必须落在选项里）',
    byA.get('萧景行')?.['关系类型'] === '竞争' && byA.get('陈渊')?.['关系类型'] === '师徒')
  ok('落库：未填的列被初始化为空串（表格渲染不缺列）',
    cols.every(c => typeof byA.get('陈渊')?.[c] === 'string'),
    cols.filter(c => typeof byA.get('陈渊')?.[c] !== 'string').join(','))
  if (cols.includes('编号')) {
    const nos = rows.map(r => r.data['编号'] ?? '').filter(Boolean)
    ok('落库：编号自动生成且两行不同', nos.length === 2 && nos[0] !== nos[1], nos.join(','))
  } else {
    ok('落库：本表无编号列（跳过编号断言）', true)
  }
  ok('落库：行归属当前项目', rows.every(r => r.projectId === 'rel-test'), rows.map(r => r.projectId).join(','))

  // 🔴 二次写入必须被挡住：关系表没有「名称」列，若草稿行不声明 dedupKeys，commit 会**恒判
  //    "不存在"** —— 作者在草稿页点两次「写入项目」就登记两条同样的关系（图谱里多一条重复边）。
  const pv = await previewCommit(drafts)
  ok('二次写入的预览：两条都判为「跳过」（预览与实际一致，不是嘴上说说）',
    pv.skip === 2 && pv.create === 0, JSON.stringify({ create: pv.create, update: pv.update, skip: pv.skip }))
  const again = await commitDraftRows(drafts)
  const rows2 = await db.getTableRows('relations')
  ok('🔴 二次写入被挡住（不重复登记）',
    again.created === 0 && again.updated === 0 && rows2.length === 2,
    `created=${again.created} rows=${rows2.length}`)

  // 反过来：把同一条关系反着写（B-A 对调）也必须认出是同一条
  const reversed = relationRowsToDrafts(rel, [{ 人物A: '萧景炎', 人物B: '萧景行', 关系类型: '竞争' }])
  const out3 = await commitDraftRows(reversed)
  ok('🔴 反向写同一条（B-A 对调）也认出是同一条（无序对判重真的生效）',
    out3.created === 0, `created=${out3.created}`)
}

// ---------- ⑤ 判重口径：A-B 与 B-A 同指纹 ----------
{
  const keys = ['人物A', '人物B']
  const a = rowFingerprint({ 人物A: '萧景行', 人物B: '萧景炎' }, keys, true)
  const b = rowFingerprint({ 人物A: '萧景炎', 人物B: '萧景行' }, keys, true)
  const c = rowFingerprint({ 人物A: '萧景行', 人物B: '陈渊' }, keys, true)
  ok('🔴 无序对：A-B 与 B-A 指纹相同（否则每次整理都会把同一条关系反着再写一遍）', a === b, `${a} vs ${b}`)
  ok('换一个人指纹就不同（判重不是恒真）', a !== c)
  const ordered = rowFingerprint({ 人物A: '萧景行', 人物B: '萧景炎' }, keys, false)
  ok('有序模式下 A-B 与 B-A 指纹不同（证明上一条不是"判重恒真"造成的假象）',
    ordered !== rowFingerprint({ 人物A: '萧景炎', 人物B: '萧景行' }, keys, false))
  ok('空白差异不影响判重（全角空格 / 顿号等标点被归一）',
    rowFingerprint({ 人物A: '萧 景行', 人物B: '萧景炎' }, keys, true) === a)
}

// ---------- ⑥ 短路：没有材料 / 已中止时不调模型 ----------
{
  const empty = await buildRelationDrafts({ batches: [], rawText: '' })
  ok('没有任何材料 → 直接空手而归（不调模型，不会因"未配模型"报错）',
    empty.rows.length === 0 && empty.perTab.length === 0, JSON.stringify(empty.perTab))

  const ctl = new AbortController()
  ctl.abort()
  const aborted = await buildRelationDrafts({
    batches: [{ source: '第1章', index: 1, entities: [{ name: '陈渊', type: '人物', desc: '主角', evidence: 'x' }] }],
    rawText: '开篇一段原文。',
    signal: ctl.signal,
  })
  ok('已中止 → 一条也不产出（且不抛异常，交由状态机收尾）', aborted.rows.length === 0)
}

// ---------- ⑦ 名单校验：把势力 / 地点当人物的一律丢掉 ----------
{
  const rel = TABS.find(t => t.id === 'relations')!
  const keys = keyColsOf(rel)
  ok('关键列是前两列（人物A / 人物B）', keys.join('|') === '人物A|人物B', keys.join('|'))
  const roster = ['陈渊', '苏念', '萧景行']
  const raw = [
    { 人物A: '陈渊', 人物B: '苏念', 关系类型: '盟友' },
    { 人物A: '陈渊', 人物B: '青岚宗', 关系类型: '敌对' },       // 势力被塞进人物列
    { 人物A: '陈渊', 人物B: '青岚宗山门', 关系类型: '竞争' },   // 地点
    { 人物A: '萧景行', 人物B: '苏念', 关系类型: '竞争' },
  ]
  const { kept, dropped } = filterRowsByRoster(raw, keys, roster)
  ok('🔴 名单外的行被丢掉（实测模型会把势力 / 地点写进人物列）',
    kept.length === 2 && dropped === 2, `kept=${kept.length} dropped=${dropped}`)
  ok('留下的都是名单里的人', kept.every(r => roster.includes(r['人物B'])), kept.map(r => r['人物B']).join(','))
  const empty = filterRowsByRoster(raw, keys, [])
  ok('名单为空时**不校验**（新项目既没角色卡也没抽出人物，校验会让功能变哑巴）',
    empty.kept.length === 4 && empty.dropped === 0)
  ok('别称也算名字（名单里带上别称就能通过）',
    filterRowsByRoster([{ 人物A: '阿渊', 人物B: '苏念' }], keys, ['阿渊', '苏念']).kept.length === 1)
  const oneSide = filterRowsByRoster([{ 人物A: '陈渊', 人物B: '' }], keys, roster)
  ok('关键列为空的行也丢掉（判不了重，落库也是半条）', oneSide.kept.length === 0 && oneSide.dropped === 1)
}

// ---------- ⑧ 证据校验：编出来的关系必须被拦住 ----------
{
  const material = '陈渊被逐出青岚宗那天，天上落着细雨。\n三日后，陈渊在城外破庙里遇见了苏念。'
  ok('引文逐字出现在材料里 → 通过', evidenceInMaterial('陈渊在城外破庙里遇见了苏念', material))
  ok('引文带标点 / 引号差异 → 仍通过（先归一化再比）',
    evidenceInMaterial('“陈渊在城外破庙里，遇见了苏念。”', material))
  ok('🔴 引文不在材料里 → 不通过（模型拿项目资料编的「中州皇朝 · 血魔教」就该在这一步被拦住）',
    !evidenceInMaterial('中州皇朝与血魔教在中州边境对峙多年', material))
  ok('太短的引文不通过（只写个人名证明不了关系）', !evidenceInMaterial('陈渊', material))
  ok('空引文不通过', !evidenceInMaterial('', material))
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`)
if (fail) process.exit(1)