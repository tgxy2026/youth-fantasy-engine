// ============ 2.9.2 · ③ 续写素材挑选（lib/continuationPick.ts） ============
//
// 覆盖：摘要区间（含本章、旧→新）/ 缺失计数 / 前文章节**取每章末尾** / 上限与空章处理 /
//      焦点章在首章 / 焦点章找不到 / 全关开关 / 纯函数不改入参。
//
// 🔴 为什么值得单独测：这里每一个"差一位"都不会报错，只会让续写**接错地方**——
//    比如把「前文章节」取成了开头（它同时是衔接参照；整章改写那边踩过一模一样的坑），
//    模型拿到的是上一章的起手而非收尾，续写自然接不上，而界面上一切正常。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pickContinuationSources, type ChapLike } from '../src/lib/continuationPick'

const readSrc = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8')

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
  ok('前 1 章正文 ⇒ 第 3 章',
    r.prevTexts.length === 1 && r.prevTexts[0].title === '第3章',
    JSON.stringify(r.prevTexts.map(t => t.title)))
  ok('无缺失、无未带入', r.missingSummaries === 0 && r.droppedPrevTexts === 0)
}

// ---------- ② 🔴「前文章节」必须取每章的**末尾** ----------
// 为什么是末尾而不是开头：这一项**兼作衔接参照** —— 2026-10-09 起独立的「上一章结尾」
// 选项已并入本项，紧邻上一章的末尾就靠它带进来。取开头会变成「让模型从上一章的起手接续」
// （整章改写那边踩过同一个坑）。
{
  // 正文 511 字（头尾带标记）；额度给 250 ⇒ 触发截断，且剩余额度 > 200 不会被判「放不下」
  const long: ChapLike = { id: 'p', title: '长章', summary: '', content: 'START' + '-'.repeat(500) + 'FINISH' }
  const cur: ChapLike = { id: 'q', title: '本章', summary: '摘要', content: '正文' }
  const r = pickContinuationSources([long, cur], 'q', { summaryCount: 0, prevTextCount: 1, prevTextCap: 250 })
  ok('🔴 截断后留下的是**末尾**（含 FINISH）', !!r.prevTexts[0]?.content.includes('FINISH'),
    JSON.stringify(r.prevTexts[0]?.content.slice(-20)))
  ok('🔴 开头的 START 已被略过（不是取开头）', !r.prevTexts[0]?.content.includes('START'),
    JSON.stringify(r.prevTexts[0]?.content.slice(0, 40)))
  ok('截断处有注明（不静默截）', !!r.prevTexts[0]?.content.includes('前部因长度限制略过'))
}

// ---------- ③ 焦点章是首章：没有"上一章 / 前几章"，但不该报错 ----------
{
  const r = pickContinuationSources(FLAT, 'c1', { summaryCount: 3, prevTextCount: 2 })
  ok('首章：prevTexts 为空', r.prevTexts.length === 0)
  ok('首章：摘要仍含本章', r.summaries.length === 1 && r.summaries[0].title === '第1章')
  ok('首章：found 仍为 true（不是"找不到"）', r.found === true)
}

// ---------- ④ 焦点章找不到 ⇒ 明确报 found:false（调用方必须据此提示，不许当空上下文硬发） ----------
{
  const r = pickContinuationSources(FLAT, 'not-exist', { summaryCount: 3, prevTextCount: 2 })
  ok('找不到焦点章 ⇒ found:false', r.found === false)
  ok('找不到时两块全空', r.summaries.length === 0 && r.prevTexts.length === 0)
}

// ---------- ⑤ 摘要缺失：只收有摘要的章，缺失要计数（不静默丢） ----------
{
  const flat = [mk(1), mk(2, { summary: '   ' }), mk(3)]
  const r = pickContinuationSources(flat, 'c3', { summaryCount: 3, prevTextCount: 0 })
  ok('只收有摘要的章（2 条）', r.summaries.length === 2, String(r.summaries.length))
  ok('缺失摘要计数 = 1', r.missingSummaries === 1, String(r.missingSummaries))
}

// ---------- ⑥ 前文章节：单章超合计上限 ⇒ 截断保留**末尾**（并注明），不是整章丢弃 ----------
// 依据：本项兼作衔接参照，末尾最关键；整章丢弃等于作者明明勾了却什么都没拿到。
{
  const huge: ChapLike = { id: 'h', title: '大章', summary: '', content: 'x'.repeat(9000) }
  const r = pickContinuationSources([huge, mk(2)], 'c2', { summaryCount: 0, prevTextCount: 1, prevTextCap: 1000 })
  ok('超上限 ⇒ 截到上限并注明',
    r.prevTexts.length === 1 && r.prevTexts[0].content.includes('前部因长度限制略过'),
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

// ---------- ⑧b 🔴 额度不够时，**紧邻的那一章优先**（它同时是衔接参照） ----------
// 若按「旧→新」分配额度，章数一多时先吃满的是**最老**的章，紧邻的上一章反被丢掉 ——
// 衔接直接失效，而 UI 只笼统报「前文章节 N 章」，作者看不出丢的是最要命的那一章。
{
  const mkLong = (i: number): ChapLike => ({ id: `L${i}`, title: `第${i}章`, summary: '', content: 'x'.repeat(400) })
  const flat = [mkLong(1), mkLong(2), mkLong(3), { id: 'cur', title: '本章', summary: '', content: '正文' }]
  const r = pickContinuationSources(flat, 'cur', { summaryCount: 0, prevTextCount: 3, prevTextCap: 500 })
  ok('🔴 额度紧张时先保**紧邻**的上一章（第 3 章）',
    r.prevTexts.map(t => t.title).join(',') === '第3章', r.prevTexts.map(t => t.title).join(','))
  ok('更早的两章被计入未带入', r.droppedPrevTexts === 2, String(r.droppedPrevTexts))
  ok('保下来的那章内容是**末尾**（衔接参照）',
    (r.prevTexts[0]?.content.length ?? 0) === 400, String(r.prevTexts[0]?.content.length))
}

// ---------- ⑨ 开关全关：两块都空，但仍要知道"章找到了" ----------
{
  const r = pickContinuationSources(FLAT, 'c4', { summaryCount: 0, prevTextCount: 0 })
  ok('全关 ⇒ 两块都空', r.summaries.length === 0 && r.prevTexts.length === 0)
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

// ---------- ⑫ 源码断言：两处「口径必须一致」的地方（2026-10-09 六维审计修的） ----------
{
  // ① 预算预览必须把「写作文风」的长度也算进去 —— 实际发请求时会多推一个块，
  //    漏算会让「预计占用」偏小（勾了文风档却显示未超预算，到真跑时才超＝预估骗人）。
  const model = readSrc('src/components/useJieWenJiModel.ts')
  ok('🔴 预算预览把「写作文风」也算进去（fpLen）',
    model.includes('const fpLen = contPicks.has(\'fingerprint\')'),
    '预览与真跑的取数口径必须逐块一致')
  ok('🔴 真跑时的块名与 UI 一致（【写作文风】，不是旧名【文风档】）',
    model.includes('【写作文风】') && !model.includes('【文风档】'))
  // ② 提示词里引用的块名必须**真实存在**：以前写着「遵守【写作规范】」，
  //    而实际拼出的块是【项目资料】（写作规范作为 〖写作规范〗 子段在里面）——
  //    模型按名字找不到该块，规则约束力被削弱（承诺↔实现不一致）。
  const task = readSrc('src/lib/aiTasks/jieWenJi.ts')
  ok('🔴 续写提示词不再引用不存在的【写作规范】块',
    !task.includes('遵守【写作规范】'))
  ok('🔴 改成指向实际存在的 〖写作规范〗 子段',
    task.includes('〖写作规范〗'))
}

console.log(`\n  ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
