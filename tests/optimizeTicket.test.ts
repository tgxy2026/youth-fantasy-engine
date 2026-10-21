// ============ 全书优化工单（P4 · 2.8.0 · 台账 #016）============
//
// 🔴 取舍（与 chapterCheck / manuscriptCheck 同一取舍）：
//   `buildTicket` 与 `runTicketChapter` 本体依赖 IndexedDB 与 AI 通道，**不进单测**（真跑要走实机）。
//   这里钉住三块最容易静默出错的东西：
//     ① **纯逻辑**：排序 / 分组 / 去重 / 历史章的动作夹取；
//     ② **源码断言**：执行必须走 `applyChapterRewrite`（不许自己写落库）、
//        历史章不许跑设定同步、中止不许标成 failed —— 这三条破了都不会报错，只会悄悄改坏数据；
//     ③ **与既有 lib 的口径对齐**（`textDiff.diffStats`）。
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import {
  HISTORY_ACTIONS, SOURCE_LABEL, SOURCE_ORDER, actionLabelOf, groupByChapter, groupByIssue,
  pickAction, resolveAction, sortAndDedup, ticketId,
  type TicketItem, type TicketSource,
} from '../src/lib/app/optimizeTicket'
import { CHAPTER_REWRITE_META } from '../src/lib/ai/aiTasks'
import { diffLines, diffStats } from '../src/lib/editor/textDiff'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ optimizeTicket')

interface MkInput {
  id: string
  source: TicketSource
  chapterId: string
  chapterTitle?: string
  chapterNo?: number
  severity?: TicketItem['severity']
  title?: string
  detail?: string
  action?: TicketItem['action']
  status?: TicketItem['status']
}

/** 造一条工单：默认值够用，调用点只写关心的字段 */
function mk(o: MkInput): TicketItem {
  return {
    chapterTitle: '某章', chapterNo: 1, severity: 'warn', title: 't', detail: '',
    action: 'polish', status: 'pending', ...o,
  }
}

// ---------- ① sortAndDedup：去重 + 章序 → 严重度 → 来源 ----------
{
  const items: TicketItem[] = [
    mk({ id: 'd1', chapterId: 'c2', chapterNo: 2, severity: 'info', source: 'style' }),
    mk({ id: 'a1', chapterId: 'c1', chapterNo: 1, severity: 'warn', source: 'style' }),
    mk({ id: 'a2', chapterId: 'c1', chapterNo: 1, severity: 'error', source: 'typo' }),
    mk({ id: 'a3', chapterId: 'c1', chapterNo: 1, severity: 'error', source: 'sensitive' }),
    mk({ id: 'a1', chapterId: 'c1', chapterNo: 1, severity: 'warn', source: 'style' }), // 重复 id
  ]
  const out = sortAndDedup(items)
  ok('去重：同 id 只留一条', out.length === 4, String(out.length))
  ok('章序升序（第 1 章在前）', out[0].chapterNo === 1 && out[out.length - 1].chapterNo === 2)
  ok('同章内：严重度 error → warn → info',
    out[0].severity === 'error' && out[1].severity === 'error' && out[2].severity === 'warn' && out[3].severity === 'info')
  // 同章同严重度：按 SOURCE_ORDER（typo 在 sensitive 之前）
  ok('同章同严重度：按 SOURCE_ORDER 排（typo 先于 sensitive）',
    out[0].source === 'typo' && out[1].source === 'sensitive',
    `${out[0].source}/${out[1].source}`)
}

// ---------- ② groupByChapter：边界 ----------
{
  ok('空数组 ⇒ 空分组', groupByChapter([]).length === 0)

  const single = groupByChapter([mk({ id: 'x', chapterId: 'c1', chapterNo: 1, source: 'style' })])
  ok('单条 ⇒ 一组一条', single.length === 1 && single[0].items.length === 1)

  // 交错输入（c2 → c1 → c2）⇒ 聚成两组，且按章序排
  const inter = groupByChapter([
    mk({ id: 'b1', chapterId: 'c2', chapterNo: 2, source: 'style' }),
    mk({ id: 'a1', chapterId: 'c1', chapterNo: 1, source: 'typo' }),
    mk({ id: 'b2', chapterId: 'c2', chapterNo: 2, source: 'typo' }),
  ])
  ok('多章交错 ⇒ 聚成两组并按章序排', inter.length === 2 && inter[0].chapterId === 'c1' && inter[1].chapterId === 'c2')
  ok('组内保持传入顺序', inter[1].items.map(i => i.id).join(',') === 'b1,b2')
  ok('分组带章名与章号', inter[0].chapterNo === 1 && typeof inter[0].chapterTitle === 'string')
}

// ---------- ③ resolveAction：历史章只放「不改设定」的两档 ----------
{
  ok('HISTORY_ACTIONS 恰为 polish / condense',
    HISTORY_ACTIONS.length === 2 && HISTORY_ACTIONS.includes('polish') && HISTORY_ACTIONS.includes('condense'))

  // 最新章：按来源给默认档
  ok('最新章 · 文风 ⇒ 润色', resolveAction('style', true) === 'polish')
  ok('最新章 · 错别字 ⇒ 润色', resolveAction('typo', true) === 'polish')
  ok('最新章 · 敏感词 ⇒ 改写', resolveAction('sensitive', true) === 'rewrite')
  ok('最新章 · 连续性 ⇒ 需手动（改正文解决不了设定层冲突）', resolveAction('continuity', true) === 'manual')
  ok('最新章 · 伏笔 ⇒ 需手动', resolveAction('foreshadow', true) === 'manual')

  // 历史章：polish/condense 通过，rewrite/expand 一律降级成 manual
  ok('历史章 · 文风 ⇒ 仍可润色', resolveAction('style', false) === 'polish')
  ok('历史章 · 错别字 ⇒ 仍可润色', resolveAction('typo', false) === 'polish')
  ok('🔴 历史章 · 敏感词 ⇒ 降为需手动（rewrite 会改设定，历史章冻结）', resolveAction('sensitive', false) === 'manual')
  ok('🔴 历史章 · AI 人设 ⇒ 降为需手动', resolveAction('ai-ooc', false) === 'manual')
}

// ---------- ④ pickAction：同章多条取最重 + 历史章再夹一次 ----------
{
  const it = (action: TicketItem['action']) => mk({ id: `p-${action}`, chapterId: 'c1', source: 'style', action })

  ok('空池（全 manual）⇒ 兜底润色', pickAction([it('manual')], true) === 'polish')
  ok('最新章：polish + rewrite ⇒ 取 rewrite', pickAction([it('polish'), it('rewrite')], true) === 'rewrite')
  ok('最新章：polish + condense ⇒ 取 condense（2 > 1）', pickAction([it('polish'), it('condense')], true) === 'condense')
  ok('🔴 历史章：含 rewrite 的池 ⇒ 夹掉后取剩下的 polish',
    pickAction([it('polish'), it('rewrite')], false) === 'polish')
  ok('🔴 历史章：池里只剩 rewrite ⇒ 兜底 polish（绝不会真的下发 rewrite）',
    pickAction([it('rewrite')], false) === 'polish')
}

// ---------- ⑤ ticketId：必须稳定 ----------
{
  ok('同输入两次 ⇒ 同 id', ticketId('c1', 'style', '标题') === ticketId('c1', 'style', '标题'))
  ok('不同章节 ⇒ 不同 id', ticketId('c1', 'style', '标题') !== ticketId('c2', 'style', '标题'))
  ok('不同来源 ⇒ 不同 id', ticketId('c1', 'style', '标题') !== ticketId('c1', 'typo', '标题'))
  ok('不同标题 ⇒ 不同 id', ticketId('c1', 'style', 'A') !== ticketId('c1', 'style', 'B'))
  ok('id 是短的非空串', /^[0-9a-z]{1,8}$/.test(ticketId('c1', 'style', '标题')))
}

// ---------- ⑥ 元信息自洽 ----------
{
  ok('SOURCE_ORDER 与 SOURCE_LABEL 同源且顺序一致',
    SOURCE_ORDER.join(',') === Object.keys(SOURCE_LABEL).join(','))
  ok('每个来源都有中文标签', SOURCE_ORDER.every(s => !!SOURCE_LABEL[s] && !/[a-z-]/.test(SOURCE_LABEL[s])))
  ok('manual 的动作标签是「需手动处理」（不是英文 manual）', actionLabelOf('manual') === '需手动处理')
  ok('非 manual 的动作标签取自 CHAPTER_REWRITE_META', actionLabelOf('polish') === CHAPTER_REWRITE_META.polish.label)
}

// ---------- ⑦ diffStats：changed = min(added, deleted) ----------
{
  const lines = diffLines('a\nb\nc', 'a\nB\nc\nd')
  const st = diffStats(lines)
  ok('diffStats.changed === min(added, deleted)', st.changed === Math.min(st.added, st.deleted), JSON.stringify(st))
  const same = diffStats(diffLines('a\nb', 'a\nb'))
  ok('两版一致 ⇒ 全 0', same.added === 0 && same.deleted === 0 && same.changed === 0)
}

// ---------- ⑧ 🔴 源码断言：这三条破了都不会报错，只会悄悄改坏数据 ----------
{
  const src = readFileSync(path.join(process.cwd(), 'src/lib/app/optimizeTicket.ts'), 'utf8')

  ok('🔴 落库只走 applyChapterRewrite（不自己写库）',
    src.includes('applyChapterRewrite(chapterId, text, \'rewritten\')'))
  ok('🔴 不自行调用 db 写章节（那会绕过「先留快照」）',
    !/\bdb\.(saveChapter|createSnapshot)\s*\(/.test(src))

  ok('🔴 只有最新章才跑设定同步（历史章冻结）',
    /if \(isLatest\) \{[\s\S]{0,400}?await extractAndCommitSettings\(/.test(src))
  ok('🔴 设定同步策略降级为 add-only（无交互场景不弹勾选）',
    src.includes("extractAndCommitSettings(text, hit.chapter.title, 'add-only'"))

  // 3.2.0 · WQ7：中止路径多了一步「账本记 aborted」（`settleRewriteLedger`）；
  // 3.2.0 · WQ6：返回值多带一份预算快照。
  // 断言语义不变：中止分支**原样返回 items**（不 markAll failed）。
  ok('🔴 中止 ⇒ 条目保持 pending（原样 return items，不标 failed）',
    /if \(isCancelled\(e\) \|\| opts\.signal\?\.aborted\) \{[\s\S]{0,200}?return \{ chapterId, items(?:, budget: budget\.snapshot\(\))? \}/.test(src)
    && !/if \(isCancelled\(e\) \|\| opts\.signal\?\.aborted\) \{[\s\S]{0,200}?markAll\(/.test(src))
  ok('🔴 manual 条目永远保持 pending（markAll 原样返回它）',
    src.includes('i.action === \'manual\' ? i : { ...i, status, error }'))

  ok('🔴 最新章判据与 creativeSession 同源（listRewriteCandidates 的最后一个）',
    /const isLatest = idx === cands\.length - 1/.test(src))
  ok('🔴 同章多条合并成一次改写（requirement 用整份清单，不是逐条调用）',
    src.includes('requirement: requirementOf(todo)'))
  ok('执行前先过滤掉「已处理过 / 需手动」的条目',
    /const todo = items\.filter\(i => \(i\.status === 'pending' \|\| i\.status === 'failed'\) && i\.action !== 'manual'\)/.test(src))
  ok('历史章动作被 pickAction 再夹一次（防手动改过 action）',
    /\.filter\(a => isLatest \|\| HISTORY_ACTIONS\.includes\(a\)\)/.test(src))

  ok('🔴 本轮不声称有 AI 诊断源（没实现就不许出现在 buildTicket 里）',
    !/aiChapterReview|aiOocCheck|aiPleasureCheck/.test(src))

  // 面板侧：中止后「已改完的章」必须能恢复 ——
  // 🔴 任务中心在中止时会把 result 清空（有意设计：中止＝不留可疑产物），
  //    所以逐章产物要另走 ctx.setResume 回传，面板合并时两个来源都读。
  const panel = readFileSync(path.join(process.cwd(), 'src/components/tools/OptimizeTicketPanel.tsx'), 'utf8')
  ok('🔴 逐章产物经 ctx.setResume 回传（中止 / 切页签后仍可恢复）',
    panel.includes('ctx.setResume({ chapters: [...out] }'))
  ok('🔴 合并时同时读 result 与 resume（只读 result 会让中止后已改章退回待处理）',
    panel.includes('exe.result ?? (exe.task?.resume') && panel.includes('exe.result, exe.task?.resume'))
  ok('🔴 诊断失败不再静默吞（改为 console.warn 上报）', src.includes('一章诊断失败（已跳过）'))
  ok('🔴 最新章设定同步失败不再静默吞',
    src.includes('设定同步失败（正文已落库，可去设定表手动补）'))
}

// ---------- ⑦ groupByIssue：按问题类型聚合（2.9.2）----------
// 它回答的是「哪类问题在全书里最普遍」——与 `groupByChapter`（服务按章执行）是同一批条目的两种视图。
{
  const items: TicketItem[] = [
    mk({ id: 'i1', chapterId: 'c3', chapterNo: 3, source: 'style', title: '句长波动大', severity: 'info' }),
    mk({ id: 'i2', chapterId: 'c1', chapterNo: 1, source: 'style', title: '句长波动大', severity: 'info' }),
    mk({ id: 'i3', chapterId: 'c2', chapterNo: 2, source: 'style', title: '句长波动大', severity: 'info' }),
    mk({ id: 'i4', chapterId: 'c5', chapterNo: 5, source: 'sensitive', title: '命中敏感词', severity: 'error' }),
    mk({ id: 'i5', chapterId: 'c4', chapterNo: 4, source: 'typo', title: '错别字', severity: 'warn' }),
  ]
  const g = groupByIssue(items)
  ok('⑦ 同 source+title 归为一组（5 条 → 3 组）', g.length === 3, String(g.length))
  ok('⑦ count ＝ 出现章数', g.find(x => x.title === '句长波动大')?.count === 3,
    String(g.find(x => x.title === '句长波动大')?.count))
  ok('⑦ chapters 已按章序排好（1→2→3）',
    (g.find(x => x.title === '句长波动大')?.chapters ?? []).map(c => c.no).join(',') === '1,2,3',
    (g.find(x => x.title === '句长波动大')?.chapters ?? []).map(c => c.no).join(','))
  // 🔴 这条是「刻意不引入加权公式」的兑现：严重度分档优先于频次
  ok('🔴 排序：严重度分档优先 —— error 组排最前（即便它只出现 1 章）',
    g[0].severity === 'error' && g[0].count === 1, `${g[0].severity}/${g[0].count}`)
  ok('⑦ 其余按严重度排（warn → info）', g[1].severity === 'warn' && g[2].severity === 'info',
    g.map(x => x.severity).join(','))
  ok('⑦ 每组带上归并键与来源（供界面渲染）',
    g.every(x => x.key === `${x.source}::${x.title}`))

  // 同一类型在不同章被判成不同严重度 ⇒ 取**最重**那档
  const gm = groupByIssue([
    mk({ id: 'm1', chapterId: 'c1', chapterNo: 1, source: 'style', title: '同一问题', severity: 'info' }),
    mk({ id: 'm2', chapterId: 'c2', chapterNo: 2, source: 'style', title: '同一问题', severity: 'error' }),
  ])
  ok('🔴 同类型跨章严重度不一 ⇒ 归并后取最重的那档', gm.length === 1 && gm[0].severity === 'error',
    `${gm.length} 组 / ${gm[0]?.severity}`)

  ok('⑦ 空输入 → 空数组', groupByIssue([]).length === 0)

  // 🔴 同档内按**出现章数降序** —— 这才是「哪类问题最普遍」的排序依据，必须单独钉住
  const gc = groupByIssue([
    mk({ id: 'x1', chapterId: 'c1', chapterNo: 1, source: 'style', title: '只出现 1 章', severity: 'info' }),
    mk({ id: 'x2', chapterId: 'c1', chapterNo: 1, source: 'typo', title: '出现 3 章', severity: 'info' }),
    mk({ id: 'x3', chapterId: 'c2', chapterNo: 2, source: 'typo', title: '出现 3 章', severity: 'info' }),
    mk({ id: 'x4', chapterId: 'c3', chapterNo: 3, source: 'typo', title: '出现 3 章', severity: 'info' }),
  ])
  ok('🔴 同档内按出现章数降序（3 章的排在 1 章前）',
    gc[0].count === 3 && gc[1].count === 1, gc.map(x => x.count).join(','))

  // 章数也相同时，用标题做稳定的最终序（防同一份数据两次渲染顺序漂移）
  const gt = groupByIssue([
    mk({ id: 'y1', chapterId: 'c1', chapterNo: 1, source: 'style', title: 'B 问题', severity: 'info' }),
    mk({ id: 'y2', chapterId: 'c2', chapterNo: 2, source: 'style', title: 'A 问题', severity: 'info' }),
  ])
  ok('⑦ 章数相同 ⇒ 按标题稳定排序（A 在 B 前）', gt[0].title === 'A 问题' && gt[1].title === 'B 问题',
    gt.map(x => x.title).join(','))

  // 两种视图并存、互不干扰
  ok('🔴 groupByChapter 语义未受影响（仍按章序）',
    groupByChapter(items).map(x => x.chapterNo).join(',') === '1,2,3,4,5',
    groupByChapter(items).map(x => x.chapterNo).join(','))
}

console.log(`\n  ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
