// ============ 草稿构建 + 落库的集成用例 ============
//
// 这条链路上有两个"错了也不报错"的高危点：
//   ① 判重口径 —— 抽出的实体若已在项目里登记过却被当成新建，会写出重复条目（作者要手工清理）；
//   ② 冲突策略 —— 「绝不静默覆盖已有数据」是红线，三种策略的语义差别必须钉死：
//        keep-existing 已有条目分毫不动 / fill-empty 只补空字段 / use-incoming 才覆盖。
// 用内存桩把这三条全跑一遍，并顺带验证「表格行铺全列」「编号自动生成」这些容易漏的落库细节。
import { __resetMockStores } from './mock-memory'
import * as db from '../src/lib/db'
import { buildDraftBundle, defaultPicked } from '../src/lib/flow/draft'
import { commitDraftRows, previewCommit } from '../src/lib/flow/commit'
import { resolveSlot } from '../src/lib/flow/fieldMap'
import { TABS } from '../src/lib/schema'
import type { DraftRow } from '../src/lib/flow/types'
import type { ExtractedEntity } from '../src/lib/ai/aiTasks'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

__resetMockStores()
const pid = 'flow-draft-test'
db.setCurrentProject(pid)

// ---------- 预置：项目里已经有「陈渊」（主要角色）与「云州」（地理风物） ----------
const NAME_MAIN = resolveSlot('char-main', '姓名') as string
const DESC_MAIN = resolveSlot('char-main', '身份定位') as string
const APPEAR_MAIN = resolveSlot('char-main', '外貌特征') as string

await db.saveCardRecord({
  id: 'c1', projectId: pid, tabId: 'char-main', name: '陈渊',
  data: { [NAME_MAIN]: '陈渊', [DESC_MAIN]: '主角·青岚宗杂役弟子' }, order: 0,
})
await db.saveTableRow({
  id: 'g1', projectId: pid, tabId: 'geography',
  data: { '名称': '云州', '备注': '边陲小城' }, order: 0, createdAt: Date.now(),
})

// ---------- ① 草稿构建：判重 + 目标表分流 + 字段落点 ----------
const entities: ExtractedEntity[] = [
  { type: '人物', name: '陈渊', desc: '青岚宗杂役', evidence: '陈渊负剑而行', tier: '主要' },
  { type: '势力', name: '青岚宗', desc: '边陲小宗门', evidence: '青岚宗山门隐于雾中' },
  { type: '地点', name: '云州', desc: '边陲城池', evidence: '云州城外' },
  { type: '术语', name: '玄脉', desc: '修行体系', evidence: '玄脉九品' },
]
const raw = '陈渊负剑而行。青岚宗山门隐于雾中。云州城外。玄脉九品。'
const bundle = await buildDraftBundle([{ source: '第1章 风起', index: 1, entities }], { rawText: raw })

ok('草稿总数 4', bundle.stats.total === 4, String(bundle.stats.total))
const byName = (n: string) => bundle.rows.find(r => r.name === n) as DraftRow

ok('🔴 已登记的人物被判为「疑似已有」（不会重复建卡）', byName('陈渊').status === 'duplicate', byName('陈渊').status)
ok('🔴 已登记的地点被判为「疑似已有」', byName('云州').status === 'duplicate', byName('云州').status)
ok('未登记的新实体判为 new', byName('青岚宗').status === 'new' && byName('玄脉').status === 'new')
ok('命中信息带出（供界面显示"已有「陈渊」"）', byName('陈渊').matched?.name === '陈渊', JSON.stringify(byName('陈渊').matched))
ok('tier=主要 → 落到主要角色卡', byName('陈渊').tabId === 'char-main', byName('陈渊').tabId)
ok('势力 → 国家势力表', byName('青岚宗').tabId === 'nations')
ok('术语 → 名词术语表', byName('玄脉').tabId === 'terms')

ok('原文有据 → 置信度 0.8（基础 0.6 + 引用命中 0.2）', Math.abs(byName('青岚宗').confidence - 0.8) < 1e-9,
  String(byName('青岚宗').confidence))
ok('默认勾选只含新建项（疑似已有不默认勾）',
  defaultPicked(byName('青岚宗')) && !defaultPicked(byName('陈渊')))
ok('草稿字段键是目标表真实键（卡片型为 `模块::字段`）',
  byName('陈渊').fields.every(f => f.key.includes('::')), byName('陈渊').fields.map(f => f.key).join(','))
ok('术语草稿不含「别称」键（terms 表没有该列）',
  !byName('玄脉').fields.some(f => f.key === '别称'), byName('玄脉').fields.map(f => f.key).join(','))
ok('首现章写进草稿（术语 → 首次出现章节）',
  byName('玄脉').fields.some(f => f.key === '首次出现章节' && f.value === '第1章 风起'),
  JSON.stringify(byName('玄脉').fields))

// ---------- ② 跨章同名合并 ----------
{
  const b2 = await buildDraftBundle([
    { source: '第1章', index: 1, entities: [{ type: '势力', name: '青岚宗', desc: '小宗', evidence: 'A' }] },
    { source: '第3章', index: 3, entities: [{ type: '势力', name: '青岚宗', desc: '边陲小宗门，掌教玄真子', evidence: 'B' }] },
  ], { rawText: 'A B' })
  const row = b2.rows[0]
  ok('同名跨章合并为一条', b2.rows.length === 1, String(b2.rows.length))
  ok('合并后描述取更完整的那份', (row.fields.find(f => f.label === '备注')?.value ?? '').includes('掌教玄真子'),
    JSON.stringify(row.fields))
  ok('合并后记录多章来源', row.chapters.join(',') === '1,3', row.chapters.join(','))
  ok('多章一致 → 置信度升到 1.0（0.6+0.2引用+0.2多源）', Math.abs(row.confidence - 1) < 1e-9, String(row.confidence))
  ok('合并后仍不误判为已有（青岚宗未登记）', row.status === 'new', row.status)
}

// ---------- ②b 同名但类型不同 → 标 conflict、默认不勾（实机 6 章样本上抓到的真问题） ----------
{
  const b3 = await buildDraftBundle([{
    source: '第1章', index: 1,
    entities: [
      { type: '势力', name: '中州皇朝', desc: '王朝', evidence: 'E1' },
      { type: '地点', name: '中州皇朝', desc: '城池', evidence: 'E2' },
    ],
  }], { rawText: 'E1 E2' })
  ok('同名异类仍产出 2 条（不擅自合并 —— 同名不同类在设定里确实可能出现）',
    b3.rows.length === 2, String(b3.rows.length))
  const first = b3.rows[0]
  const second = b3.rows[1]
  ok('首条保持 new', first.status === 'new', first.status)
  ok('🔴 次条标为 conflict（否则会落成两条重复条目，一条进势力表一条进地理表）',
    second.status === 'conflict', second.status)
  ok('冲突写明两边类型', second.conflicts?.[0]?.field === '实体类型', JSON.stringify(second.conflicts))
  ok('🔴 冲突条默认不勾选（defaultPicked 只认 new）', !defaultPicked(second), String(defaultPicked(second)))
  ok('冲突条置信度被扣到 ≤0.5', second.confidence <= 0.5, String(second.confidence))
  ok('两条确实写入不同表（所以必须让作者取舍）', first.tabId !== second.tabId, `${first.tabId}/${second.tabId}`)
}

// ---------- ③ 落库预览（写入前必须让用户看清将要发生什么） ----------
{
  const pv = await previewCommit(bundle.rows, 'keep-existing')
  ok('预览：将新建 2 条', pv.create === 2, String(pv.create))
  ok('预览：将跳过 2 条（已存在同名）', pv.skip === 2, String(pv.skip))
  ok('预览：keep-existing 下不会更新任何已有条目', pv.update === 0, String(pv.update))
}

// ---------- ④ 落库：新建无冲突项 ----------
{
  const chosen = bundle.rows.filter(r => r.status === 'new')
  const out = await commitDraftRows(chosen, { conflict: 'keep-existing' })
  ok('新建 2 条', out.created === 2, String(out.created))
  ok('无失败项', out.failed.length === 0, out.failed.join(','))

  const nations = await db.getTableRows('nations')
  ok('国家势力表新增 1 行', nations.length === 1, String(nations.length))
  ok('名称写入正确', nations[0].data['名称'] === '青岚宗', nations[0].data['名称'])
  ok('描述落进「备注」列', nations[0].data['备注'] === '边陲小宗门')
  ok('🔴 编号自动生成 N0001', nations[0].data['编号'] === 'N0001', String(nations[0].data['编号']))
  const cols = TABS.find(t => t.id === 'nations')?.columns ?? []
  ok('🔴 表格行铺满所有列（不留 undefined 键，否则导出/对账会缺列）',
    Object.keys(nations[0].data).length === cols.length, `${Object.keys(nations[0].data).length}/${cols.length}`)

  const terms = await db.getTableRows('terms')
  ok('术语表新增 1 行', terms.length === 1, String(terms.length))
  ok('术语描述落进「定义（一句话）」列', terms[0].data['定义（一句话）'] === '修行体系')
  ok('术语首现章落进「首次出现章节」列', terms[0].data['首次出现章节'] === '第1章 风起')
  ok('术语行不含「别称」键', !('别称' in terms[0].data), Object.keys(terms[0].data).join(','))
}

// ---------- ⑤ 红线：keep-existing 绝不改动已有条目 ----------
{
  const ghost: DraftRow = {
    key: 'dup-chen', tabId: 'char-main', tabName: '主要角色', kindLabel: '人物',
    name: '陈渊', aliases: [],
    fields: [{ key: APPEAR_MAIN, label: '外貌特征', value: '不该被写入的值' }],
    nameKey: NAME_MAIN, status: 'duplicate', confidence: 0.9, quotes: [], chapters: [1],
  }
  const out = await commitDraftRows([ghost], { conflict: 'keep-existing' })
  ok('keep-existing：不新建、不更新', out.created === 0 && out.updated === 0, `${out.created}/${out.updated}`)
  const cards = await db.getCardRecords('char-main')
  ok('角色卡仍是 1 张（没被重复建卡）', cards.length === 1, String(cards.length))
  ok('🔴 已有字段分毫未动', cards[0].data[APPEAR_MAIN] === undefined && cards[0].data[DESC_MAIN] === '主角·青岚宗杂役弟子',
    JSON.stringify(cards[0].data))
}

// ---------- ⑥ 红线：fill-empty 只补空字段，不覆盖已有值 ----------
{
  const ghost: DraftRow = {
    key: 'fill-chen', tabId: 'char-main', tabName: '主要角色', kindLabel: '人物',
    name: '陈渊', aliases: [],
    fields: [
      { key: APPEAR_MAIN, label: '外貌特征', value: '瘦削但筋骨匀称' },
      { key: DESC_MAIN, label: '身份定位', value: '这个值不该覆盖已有' },
    ],
    nameKey: NAME_MAIN, status: 'duplicate', confidence: 0.9, quotes: [], chapters: [1],
  }
  const out = await commitDraftRows([ghost], { conflict: 'fill-empty' })
  ok('fill-empty：更新 1 条', out.updated === 1, String(out.updated))
  const cards = await db.getCardRecords('char-main')
  ok('空字段被补上', cards[0].data[APPEAR_MAIN] === '瘦削但筋骨匀称', String(cards[0].data[APPEAR_MAIN]))
  ok('🔴 非空字段未被覆盖（身份定位保持原值）',
    cards[0].data[DESC_MAIN] === '主角·青岚宗杂役弟子', String(cards[0].data[DESC_MAIN]))
  ok('不新建重复卡', (await db.getCardRecords('char-main')).length === 1)
}

// ---------- ⑦ 表格型：已有同名行也不重复建 ----------
{
  const dup: DraftRow = {
    key: 'dup-yun', tabId: 'geography', tabName: '地理风物', kindLabel: '地理',
    name: '云州', aliases: [],
    fields: [{ key: '备注', label: '备注', value: '新描述不该覆盖' }],
    nameKey: '名称', status: 'duplicate', confidence: 0.9, quotes: [], chapters: [1],
  }
  const out = await commitDraftRows([dup], { conflict: 'keep-existing' })
  ok('表格型：已有同名不新建', out.created === 0, String(out.created))
  const geo = await db.getTableRows('geography')
  ok('地理表仍是 1 行', geo.length === 1, String(geo.length))
  ok('已有行备注未被覆盖', geo[0].data['备注'] === '边陲小城', String(geo[0].data['备注']))
}

// ---------- ⑧ 空输入不炸 ----------
{
  const out = await commitDraftRows([])
  ok('空数组 → 全部计数为 0', out.created === 0 && out.updated === 0 && out.failed.length === 0)
}

console.log(`\n—— flowDraft 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
