// ============ 创作轨迹（A4）数据聚合 ============
// 覆盖点：时间线顺序 / 细纲无时间戳 / 来源标签 / 版本上限与截断判定 /
//         字数变化 / 每日分布区间 / 老数据无 source / 全书总览。
// 本用例只跑纯函数，不触碰任何 store。
import { buildChapterTrajectory, buildTrajectoryOverview, findOutlineCard, isAIVersion, outlineTextOf } from '../src/lib/trajectory'
import type { CardRecord, Chapter, Volume } from '../src/lib/types'
import type { Snapshot } from '../src/lib/db'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- 固定时间轴（避免 Date.now() 带来的不稳定） ----------
const D = (s: string) => new Date(s).getTime()
const T0 = D('2026-09-20T10:00:00')   // 建章
const T1 = D('2026-09-20T11:30:00')   // 第一版（AI 改写前旧稿）
const T2 = D('2026-09-20T14:00:00')   // 第二版（自动留档）
const T3 = D('2026-09-21T09:00:00')   // 当前稿

const vol: Volume = { id: 'v1', projectId: 'p', title: '卷一 青云', order: 0, description: '', createdAt: T0 }

function ch(over: Partial<Chapter> = {}): Chapter {
  return {
    id: 'c1', projectId: 'p', volumeId: 'v1', order: 0, title: '废脉',
    content: '当前稿正文内容。'.repeat(20), summary: '', status: '草稿',
    wordCount: 1200, createdAt: T0, updatedAt: T3, ...over,
  }
}

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    id: 's1', projectId: 'p', chapterId: 'c1', chapterTitle: '废脉',
    content: '旧稿正文。', wordCount: 800, createdAt: T1, source: 'ai-rewrite', ...over,
  }
}

const outlineCard: CardRecord = {
  id: 'k1', projectId: 'p', tabId: 'chapter-outline', name: '第1章 废脉', order: 0,
  data: {
    '一、本章定位::本章一句话事件': '测灵大典判定废脉，当夜神体觉醒',
    '一、本章定位::出场人物': '陈渊、陈瑶',
    '二、场景细纲::场景1': '',
  },
}

const dailyStats = [
  { date: '2026-09-19', words: 999 }, // 区间外（早于建章日）
  { date: '2026-09-20', words: 1500 },
  { date: '2026-09-21', words: 0 },
  { date: '2026-09-22', words: 300 }, // 区间外（晚于当前稿日）
]

const chapters = [ch()]

// ---------- ① 时间线顺序：细纲（无时间） → 版本（升序） → 当前稿 ----------
{
  const t = buildChapterTrajectory({
    chapter: ch(), volumes: [vol], chapters,
    snapshots: [snap({ id: 's2', createdAt: T2, source: 'auto', wordCount: 1000 }), snap({ id: 's1', createdAt: T1 })],
    outline: outlineCard, dailyStats,
  })
  const kinds = t.nodes.map(n => n.stage)
  ok('① 节点数 = 1 细纲 + 2 版本 + 1 当前稿', t.nodes.length === 4, kinds.join(','))
  ok('① 首节点是细纲', kinds[0] === 'outline', kinds.join(','))
  ok('① 末节点是当前稿', kinds[kinds.length - 1] === 'current', kinds.join(','))
  ok('① 中间两个都是版本', kinds.slice(1, 3).every(k => k === 'version'), kinds.join(','))
  const versionAts = t.nodes.filter(n => n.stage === 'version').map(n => n.at)
  ok('① 版本按时间升序（最早在前）', versionAts[0] === T1 && versionAts[1] === T2, JSON.stringify(versionAts))
}

// ---------- ② 细纲没有时间戳 → at 必须是 null（不许编时间） ----------
{
  const t = buildChapterTrajectory({ chapter: ch(), volumes: [vol], chapters, snapshots: [], outline: outlineCard, dailyStats })
  const o = t.nodes.find(n => n.stage === 'outline')!
  ok('② 细纲节点 at === null', o.at === null, String(o.at))
  ok('② hasOutline = true', t.hasOutline)
  ok('② 细纲文本含真实值、不含空字段', o.content.includes('测灵大典判定废脉') && !o.content.includes('场景1'), JSON.stringify(o.content))
}
{
  const t = buildChapterTrajectory({ chapter: ch(), volumes: [vol], chapters, snapshots: [], outline: null, dailyStats })
  ok('② 无细纲时不产出细纲节点', !t.nodes.some(n => n.stage === 'outline'))
  ok('② hasOutline = false', !t.hasOutline)
}
{
  // A4 遗留补全：细纲卡自 2.4.0 起带 createdAt ⇒ 节点时间取它（老卡片无该字段时仍为 null，不编时间）
  const t = buildChapterTrajectory({
    chapter: ch(), volumes: [vol], chapters, snapshots: [],
    outline: { ...outlineCard, createdAt: T2 }, dailyStats,
  })
  const o = t.nodes.find(n => n.stage === 'outline')!
  ok('② 细纲卡有创建时间时，节点时间取它（不再一律 null）', o.at === T2, String(o.at))
}

// ---------- ③ 来源 → 标签；AI 版判定 ----------
{
  const t = buildChapterTrajectory({
    chapter: ch(), volumes: [vol], chapters,
    snapshots: [snap({ id: 'a', createdAt: T1, source: 'ai-rewrite' }), snap({ id: 'b', createdAt: T2, source: 'auto' })],
    outline: null, dailyStats,
  })
  const ai = t.nodes.find(n => n.source === 'ai-rewrite')!
  const au = t.nodes.find(n => n.source === 'auto')!
  ok('③ AI 改写前旧稿标签可读', ai.label.includes('AI') && ai.label.includes('旧稿'), ai.label)
  ok('③ 自动留档标签可读', au.label.includes('自动留档'), au.label)
  ok('③ isAIVersion 认 ai-* ', isAIVersion('ai-rewrite') && isAIVersion('ai-generate'))
  ok('③ isAIVersion 不认 auto / manual-restore', !isAIVersion('auto') && !isAIVersion('manual-restore') && !isAIVersion(undefined))
}

// ---------- ④ 老数据无 source → 按 auto 处理（不崩、不显示 undefined） ----------
{
  const noSource = { ...snap({ id: 'old' }), source: undefined } as unknown as Snapshot
  const t = buildChapterTrajectory({ chapter: ch(), volumes: [vol], chapters, snapshots: [noSource], outline: null, dailyStats })
  const node = t.nodes.find(n => n.stage === 'version')!
  ok('④ 老快照按「自动留档」展示', node.source === 'auto' && node.label.includes('自动留档'), String(node.source))
}

// ---------- ⑤ 版本上限与「早期版本可能已被清理」 ----------
{
  // 12 份 = 名额满
  const full = Array.from({ length: 12 }, (_, i) => snap({ id: `f${i}`, createdAt: T1 + i * 60000, source: 'auto' }))
  const tFull = buildChapterTrajectory({ chapter: ch(), volumes: [vol], chapters, snapshots: full, outline: null, dailyStats })
  ok('⑤ 12 份时 retainedVersions = 12', tFull.retainedVersions === 12, String(tFull.retainedVersions))
  ok('⑤ 名额满 → snapshotLimitReached', tFull.snapshotLimitReached)

  // 只有 2 份，但最早那份比建章晚 20 小时 → 早期很可能已被清
  const late = [
    snap({ id: 'l1', createdAt: T0 + 20 * 3600 * 1000, source: 'auto' }),
    snap({ id: 'l2', createdAt: T3, source: 'auto' }),
  ]
  const tLate = buildChapterTrajectory({ chapter: ch(), volumes: [vol], chapters, snapshots: late, outline: null, dailyStats })
  ok('⑤ 未满名额但最早版本远晚于建章 → likelyTruncated', tLate.likelyTruncated)

  // 正常情况：建章后半小时就有第一版 → 不算截断
  const tOk = buildChapterTrajectory({ chapter: ch(), volumes: [vol], chapters, snapshots: [snap({ createdAt: T0 + 1800000 })], outline: null, dailyStats })
  ok('⑤ 首版紧跟建章 → 不判截断', !tOk.likelyTruncated)
}

// ---------- ⑥ 字数变化 ----------
{
  const t = buildChapterTrajectory({
    chapter: ch({ wordCount: 1200 }), volumes: [vol], chapters,
    snapshots: [snap({ createdAt: T1, wordCount: 800 })], outline: null, dailyStats,
  })
  ok('⑥ firstVersionWords = 800', t.firstVersionWords === 800, String(t.firstVersionWords))
  ok('⑥ wordDelta = 1200 - 800 = 400', t.wordDelta === 400, String(t.wordDelta))
}
{
  const t = buildChapterTrajectory({ chapter: ch(), volumes: [vol], chapters, snapshots: [], outline: null, dailyStats })
  ok('⑥ 无版本时 firstVersionWords / wordDelta 均为 null', t.firstVersionWords === null && t.wordDelta === null)
}

// ---------- ⑦ 每日分布：只取跨度内的日期；activeDays 只数有字的 ----------
{
  const t = buildChapterTrajectory({
    chapter: ch({ createdAt: D('2026-09-20T10:00:00'), updatedAt: D('2026-09-21T09:00:00') }),
    volumes: [vol], chapters, snapshots: [], outline: null, dailyStats,
  })
  const dates = t.daily.map(d => d.date)
  ok('⑦ 只保留跨度内两天（09-20 / 09-21）', JSON.stringify(dates) === JSON.stringify(['2026-09-20', '2026-09-21']), JSON.stringify(dates))
  ok('⑦ activeDays 只数有字的天（09-20 有、09-21 是 0）', t.activeDays === 1, String(t.activeDays))
  ok('⑦ spanDays 含首尾 = 2', t.spanDays === 2, String(t.spanDays))
}

// ---------- ⑧ 章号解析 + 细纲卡匹配 ----------
{
  const t = buildChapterTrajectory({ chapter: ch(), volumes: [vol], chapters, snapshots: [], outline: outlineCard, dailyStats })
  ok('⑧ 全局章号 = 1', t.no === 1, String(t.no))
  ok('⑧ findOutlineCard 按章号命中', findOutlineCard(1, [outlineCard])?.id === 'k1')
  ok('⑧ findOutlineCard 章号对不上时返回 null', findOutlineCard(9, [outlineCard]) === null)
  ok('⑧ 章号为 0 时直接返回 null', findOutlineCard(0, [outlineCard]) === null)
}

// ---------- ⑨ outlineTextOf：过滤空值、键取末段、全角冒号 ----------
{
  const text = outlineTextOf(outlineCard)
  ok('⑨ 空字段被滤掉', !text.includes('场景1'))
  ok('⑨ 键取 `::` 末段（无「一、本章定位::」前缀）', text.includes('本章一句话事件：测灵大典判定废脉') && !text.includes('::'), JSON.stringify(text))
  ok('⑨ 用全角冒号', text.includes('：'))
}

// ---------- ⑩ preview：折叠换行并截断 ----------
{
  const long = '第一行\n\n第二行 ' + '字'.repeat(300)
  const t = buildChapterTrajectory({ chapter: ch({ content: long }), volumes: [vol], chapters, snapshots: [], outline: null, dailyStats })
  const cur = t.nodes.find(n => n.stage === 'current')!
  ok('⑩ preview 无换行', !cur.preview.includes('\n'), JSON.stringify(cur.preview.slice(0, 30)))
  ok('⑩ preview 被截断（尾部 …）', cur.preview.endsWith('…') && cur.preview.length <= 121, String(cur.preview.length))
  ok('⑩ content 保留全文（不被截断）', cur.content.length > 300)
}

// ---------- ⑪ 全书总览 ----------
{
  const list = [
    ch({ id: 'c1', volumeId: 'v1', order: 0, wordCount: 1000, createdAt: D('2026-09-20T10:00:00'), updatedAt: D('2026-09-20T12:00:00') }),
    ch({ id: 'c2', volumeId: 'v1', order: 1, wordCount: 0, createdAt: D('2026-09-21T10:00:00'), updatedAt: D('2026-09-21T10:00:00') }),
    ch({ id: 'c3', volumeId: 'v1', order: 2, wordCount: 500, createdAt: D('2026-09-22T10:00:00'), updatedAt: D('2026-09-22T10:00:00') }),
  ]
  const ds = [
    { date: '2026-09-20', words: 1000 },
    { date: '2026-09-21', words: 0 },
    { date: '2026-09-22', words: 400 },
  ]
  const o = buildTrajectoryOverview(list, ds)
  ok('⑪ totalChapters = 3', o.totalChapters === 3, String(o.totalChapters))
  ok('⑪ writtenChapters 只数有正文的（2 章）', o.writtenChapters === 2, String(o.writtenChapters))
  ok('⑪ totalWords = 1500', o.totalWords === 1500, String(o.totalWords))
  ok('⑪ activeDays 只数有字的天（2 天）', o.activeDays === 2, String(o.activeDays))
  ok('⑪ firstAt / lastAt 取自章节时间戳', o.firstAt === D('2026-09-20T10:00:00') && o.lastAt === D('2026-09-22T10:00:00'))
  ok('⑪ spanDays 含首尾 = 3', o.spanDays === 3, String(o.spanDays))
}
{
  const o = buildTrajectoryOverview([], [])
  ok('⑪ 空项目不崩：firstAt / lastAt 为 null、spanDays = 0', o.firstAt === null && o.lastAt === null && o.spanDays === 0)
}

console.log(`\n创作轨迹（A4）：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
