// ============ 3.4.0 · A.3 规划板展示可验证的资料关联 ============
//
// 规划 §三.A.3 的两条硬要求：
//   ① 「关联缺失时显示未绑定，**不根据名称猜测关系**」—— 同名章节 / 重复章号是最容易猜错的场景；
//   ② 「人物、伏笔等信息只有现有数据可可靠关联时才展示」—— 本版只展示有据可查的
//      细纲绑定与固定条数（来源 `chapterContext32:<章>`），其余不编造。
//
// 另一条数据边界：删章后设置里的旧键不会被级联删除，面板必须按**现有章节**过滤，
// 否则索引只增不减；而 `getSettingsByPrefix` 的前缀必须带 `pid::`，否则会读到别的书的绑定。
import fs from 'node:fs'
import path from 'node:path'
import * as db from '../src/lib/db'
import { __resetMockStores, memoryOps } from './mock-memory'
import {
  chapterContextBrief, buildChapterContextIndex, describeChapterContext, EMPTY_CONTEXT_BRIEF,
} from '../src/lib/app/chapterBoardContext'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

// ---------- ① 原始设置 → 展示摘要（畸形输入一律降级，不抛） ----------
{
  ok('null / undefined → 未绑定 0 条', chapterContextBrief(null).outlineId === null && chapterContextBrief(null).pinnedCount === 0)
  ok('数组 / 字符串 → 未绑定（不是崩溃）', chapterContextBrief([1]).outlineId === null && chapterContextBrief('x').pinnedCount === 0)
  ok('outlineId 为空串 → 视为未绑定', chapterContextBrief({ outlineId: '  ' }).outlineId === null)
  ok('outlineId 非字符串 → 视为未绑定', chapterContextBrief({ outlineId: 42 }).outlineId === null)
  ok('固定条数只数结构完整的引用（防脏数据虚高）', chapterContextBrief({
    pinnedRefs: [{ id: 'a', tabId: 'characters' }, { id: 'b' }, null, 'x', { tabId: 'roles' }, { id: 'c', tabId: 'world' }],
  }).pinnedCount === 2)
  ok('pinnedRefs 不是数组 → 0 条', chapterContextBrief({ pinnedRefs: 'nope' }).pinnedCount === 0)
  ok('空摘要常量本身是冻结口径（0/0）', EMPTY_CONTEXT_BRIEF.outlineId === null && EMPTY_CONTEXT_BRIEF.pinnedCount === 0)
}

// ---------- ② 索引：只留现有章节、只留有内容的条目 ----------
{
  const raw = new Map<string, unknown>([
    ['c1', { outlineId: 'o1', pinnedRefs: [] }],
    ['c2', { outlineId: undefined, pinnedRefs: [{ id: 'r1', tabId: 'characters' }] }],
    ['c3', { outlineId: undefined, pinnedRefs: [] }],
    ['deleted', { outlineId: 'o9', pinnedRefs: [] }],
  ])
  const index = buildChapterContextIndex([{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }], raw)
  ok('有绑定的章进索引', index.c1?.outlineId === 'o1')
  ok('只有固定、没有细纲的章也进索引（固定条数本身可验证）', index.c2?.pinnedCount === 1)
  ok('既没绑定也没固定 → 不进索引（等于未绑定，交给展示层兜底）', index.c3 === undefined)
  ok('🔴 已删除章节的旧设置不进索引（避免只增不减 / 串到新章）', index.deleted === undefined)
}

// ---------- ③ 三态文案：未绑定 / 已绑定 / 已失效 ----------
{
  const names = new Map([['o1', '第一章细纲']])

  const unbound = describeChapterContext(undefined, names)
  ok('无记录 → 未绑定', unbound.kind === 'unbound' && unbound.text.includes('未绑定细纲'))
  ok('未绑定时说明去哪里绑定（不逼作者猜）', unbound.title.includes('本章资料'))

  const bound = describeChapterContext({ outlineId: 'o1', pinnedCount: 2 }, names)
  ok('有绑定 → 显示细纲卡名', bound.kind === 'bound' && bound.text === '细纲：第一章细纲 · 固定资料 2 条')
  ok('已绑定说明来源是「本章资料」的记录', bound.title.includes('本章资料'))

  const stale = describeChapterContext({ outlineId: 'o-gone', pinnedCount: 0 }, names)
  ok('🔴 绑定卡已删 → 说「已失效」，不说「未绑定」（后者会让作者以为绑定丢了）',
    stale.kind === 'stale' && stale.text.includes('已失效') && !stale.text.includes('未绑定'))
  ok('失效时给出补救路径', stale.title.includes('重新选择'))

  ok('固定 0 条时不堆字（卡片只有一行）', !describeChapterContext({ outlineId: null, pinnedCount: 0 }, names).text.includes('固定资料'))
  ok('未绑定但有固定资料 → 两件事都说', describeChapterContext({ outlineId: null, pinnedCount: 3 }, names).text.includes('固定资料 3 条'))
}

// ---------- ④ 批量读：前缀必须带 pid，否则会读到别的书 ----------
{
  __resetMockStores()
  await memoryOps.put('settingsKV', { key: 'p1::chapterContext32:c1', value: { outlineId: 'o1', pinnedRefs: [] } })
  await memoryOps.put('settingsKV', { key: 'p2::chapterContext32:c2', value: { outlineId: 'o2', pinnedRefs: [] } })
  await memoryOps.put('settingsKV', { key: 'p1::chapterSets', value: [] })

  const mine = await db.getSettingsByPrefix('p1', 'chapterContext32:')
  ok('只返回本项目的章节绑定', mine.size === 1 && mine.has('c1'))
  ok('Map 的键去掉前缀（直接就是章节 id）', [...mine.keys()][0] === 'c1')
  ok('🔴 不串到其他项目（p2 的绑定读不到）', !mine.has('c2'))
  ok('同项目的其他设置键不会被前缀误收', !mine.has('chapterSets'))

  const none = await db.getSettingsByPrefix('p9', 'chapterContext32:')
  ok('没有记录 → 空 Map（不是异常）', none.size === 0)
}

// ---------- ⑤ 接线核对：面板真的用了这套判据 ----------
{
  const dash = read('src/components/app/Dashboard.tsx')
  ok('写作面板批量读章节绑定（不是逐章 getSettingFor）',
    dash.includes("db.getSettingsByPrefix(projectId, 'chapterContext32:')"))
  ok('索引用 buildChapterContextIndex 建（按现有章节过滤）', dash.includes('buildChapterContextIndex(c, ctxRaw)'))

  const board = read('src/components/app/WritingWorkflow.tsx')
  ok('卡片展示走 describeChapterContext', board.includes('describeChapterContext(chapterContexts[c.id], outlineNames)'))
  ok('🔴 没有按名称猜关联（不出现 title/name 比对分支）',
    !/card\.name\s*===\s*c\.title|c\.title\s*===\s*card\.name/.test(board))
  ok('细纲页签不可用的项目不硬塞「未绑定」', board.includes("visible('chapter-outline') ? describeChapterContext"))
  ok('文案写明来源与「不按名称匹配」', board.includes('不按名称匹配'))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
