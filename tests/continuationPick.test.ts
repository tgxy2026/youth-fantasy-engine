// ============ 2.9.2 · ③ 续写素材挑选（lib/continuationPick.ts） ============
//
// 覆盖：摘要区间（含本章、旧→新）/ 缺失计数 / 上一章结尾**取尾部** / 前 N 章正文的
//      上限与空章处理 / 焦点章在首章 / 焦点章找不到 / 全关开关 / 纯函数不改入参。
//
// 🔴 为什么值得单独测：这里每一个"差一位"都不会报错，只会让续写**接错地方**——
//    比如把「上一章结尾」取成了开头（整章改写那边踩过一模一样的坑），
//    模型拿到的是上一章的起手而非收尾，续写自然接不上，而界面上一切正常。
import { pickContinuationSources, type ChapLike } from '../src/lib/continuationPick'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ continuationPick')

/** 造一章：正文带明显头尾标记，便于断言"取的是头还是尾" */
const mk = (i: number, over: Partial<ChapLike> = {}): ChapLike => ({
  id: `c${i}`,
  title: `第${i}章`,
  summary: `第${i}章摘要`,
  content: `第${i}章正文`,
  ...over,
})
const FLAT: ChapLike[] = [1, 2, 3, 4, 5, 6].map(i => mk(i))

// ---------- ① 焦点章在中间：三块都按叙事序取对 ----------
{
  const r = pickContinuationSources(FLAT, 'c4', { summaryCount: 3, prevTextCount: 1 })
  ok('found = true', r.found === true)
  ok('摘要 3 章（含本章，旧→新）⇒ 第2/3/4章',
    r.summaries.map(s => s.title).join(',') === '第2章,第3章,第4章',
    r.summaries.map(s => s.title).join(','))
  ok('上一章结尾取自第 3 章', r.prevTail.includes('第3章'), r.prevTail)
  ok('前 1 章正文 ⇒ 第 3 章',
    r.prevTexts.length === 1 && r.prevTexts[0].title === '第3章',
    JSON.stringify(r.prevTexts.map(t => t.title)))
  ok('无缺失、无未带入', r.missingSummaries === 0 && r.droppedPrevTexts === 0)
}

// ---------- ② 🔴「上一章结尾」必须取**尾部** ----------
{
  const long: ChapLike = { id: 'p', title: '长章', summary: '', content: 'START' + '-'.repeat(50) + 'FINISH' }
  const cur: ChapLike = { id: 'q', title: '本章', summary: '摘要', content: '正文' }
  const r = pickContinuationSources([long, cur], 'q', { summaryCount: 0, prevTextCount: 0, tailChars: 6 })
  ok('🔴 取的是末尾 6 字（FINISH），不是开头', r.prevTail === 'FINISH', JSON.stringify(r.prevTail))
  ok('确实不是开头（不含 START）', !r.prevTail.includes('START'))
}

// ---------- ③ 焦点章是首章：没有"上一章 / 前几章"，但不该报错 ----------
{
  const r = pickContinuationSources(FLAT, 'c1', { summaryCount: 3, prevTextCount: 2 })
  ok('首章：prevTail 为空', r.prevTail === '')
  ok('首章：prevTexts 为空', r.prevTexts.length === 0)
  ok('首章：摘要仍含本章', r.summaries.length === 1 && r.summaries[0].title === '第1章')
  ok('首章：found 仍为 true（不是"找不到"）', r.found === true)
}

// ---------- ④ 焦点章找不到 ⇒ 明确报 found:false（调用方必须据此提示，不许当空上下文硬发） ----------
{
  const r = pickContinuationSources(FLAT, 'not-exist', { summaryCount: 3, prevTextCount: 2 })
  ok('找不到焦点章 ⇒ found:false', r.found === false)
  ok('找不到时三块全空', r.summaries.length === 0 && r.prevTail === '' && r.prevTexts.length === 0)
}

// ---------- ⑤ 摘要缺失：只收有摘要的章，缺失要计数（不静默丢） ----------
{
  const flat = [mk(1), mk(2, { summary: '   ' }), mk(3)]
  const r = pickContinuationSources(flat, 'c3', { summaryCount: 3, prevTextCount: 0 })
  ok('只收有摘要的章（2 条）', r.summaries.length === 2, String(r.summaries.length))
  ok('缺失摘要计数 = 1', r.missingSummaries === 1, String(r.missingSummaries))
}

// ---------- ⑥ 前 N 章正文：单章超合计上限 ⇒ 截断保留开头（并注明），不是整章丢弃 ----------
// 依据：前几章正文的作用是「文风语感参照」，取开头几百字就够；
//       整章丢弃等于作者明明勾了却什么都没拿到。截断口径与 `getChapterTexts` 一致。
{
  const huge: ChapLike = { id: 'h', title: '大章', summary: '', content: 'x'.repeat(9000) }
  const r = pickContinuationSources([huge, mk(2)], 'c2', { summaryCount: 0, prevTextCount: 1, prevTextCap: 1000 })
  ok('超上限 ⇒ 截到上限并注明',
    r.prevTexts.length === 1 && r.prevTexts[0].content.includes('因长度限制截断'),
    JSON.stringify(r.prevTexts.map(t => t.content.length)))
  ok('截断后的长度不超过上限太多（截断标记本身占十余字）',
    (r.prevTexts[0]?.content.length ?? 0) <= 1020, String(r.prevTexts[0]?.content.length))
  ok('截断保留不算「未带入」', r.droppedPrevTexts === 0, String(r.droppedPrevTexts))
}

// ---------- ⑥b 额度连半句都放不下 ⇒ 宁可不带 ----------
{
  const huge: ChapLike = { id: 'h', title: '大章', summary: '', content: 'x'.repeat(9000) }
  const r = pickContinuationSources([huge, mk(2)], 'c2', { summaryCount: 0, prevTextCount: 1, prevTextCap: 100 })
  ok('额度只剩 100 字 ⇒ 不带半句', r.prevTexts.length === 0, JSON.stringify(r.prevTexts.map(t => t.title)))
  ok('且计入未带入', r.droppedPrevTexts === 1, String(r.droppedPrevTexts))
}

// ---------- ⑦ 空章（还没写正文）也计入未带入 ----------
{
  const blank: ChapLike = { id: 'b', title: '空章', summary: '', content: '   ' }
  const r = pickContinuationSources([blank, mk(2)], 'c2', { summaryCount: 0, prevTextCount: 1 })
  ok('空章 ⇒ 不进 prevTexts', r.prevTexts.length === 0)
  ok('空章 ⇒ 计入未带入', r.droppedPrevTexts === 1, String(r.droppedPrevTexts))
}

// ---------- ⑧ 只取"紧邻的 N 章"，不许越界取到更早 ----------
{
  const r = pickContinuationSources(FLAT, 'c5', { summaryCount: 0, prevTextCount: 2, prevTextCap: 999999 })
  ok('前 2 章＝第3/4章（按叙事序，不含更早的）',
    r.prevTexts.map(t => t.title).join(',') === '第3章,第4章',
    r.prevTexts.map(t => t.title).join(','))
}

// ---------- ⑨ 开关全关：三块都空，但仍要知道"章找到了" ----------
{
  const r = pickContinuationSources(FLAT, 'c4', { summaryCount: 0, prevTextCount: 0, tailChars: 0 })
  ok('全关 ⇒ 三块都空', r.summaries.length === 0 && r.prevTail === '' && r.prevTexts.length === 0)
  ok('全关 ⇒ found 仍为 true', r.found === true)
}

// ---------- ⑩ 章数超出可用：取到边界为止，不报错 ----------
{
  const r = pickContinuationSources(FLAT, 'c2', { summaryCount: 10, prevTextCount: 10, prevTextCap: 999999 })
  ok('摘要要 10 章但只有 2 章可用 ⇒ 取 2 章', r.summaries.length === 2, String(r.summaries.length))
  ok('正文要 10 章但前面只有 1 章 ⇒ 取 1 章', r.prevTexts.length === 1, String(r.prevTexts.length))
}

// ---------- ⑪ 空列表 / 纯函数不改入参 ----------
{
  ok('空列表 ⇒ found:false', pickContinuationSources([], 'c1', {}).found === false)
  const before = JSON.stringify(FLAT)
  pickContinuationSources(FLAT, 'c4', { summaryCount: 3, prevTextCount: 2 })
  ok('不改动入参（纯函数）', JSON.stringify(FLAT) === before)
}

console.log(`\n  ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
