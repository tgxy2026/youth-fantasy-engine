// ============ 连写自检 · 运行摘要契约闸（3.6.0 · D）============
//
// 盯四件会让「检查」这件事说不清的事：
//   ① 三项合并语义：全 skipped 必须是 skipped（不能显示成"通过"）；
//   ② 摘要必须记录「没查」与「查了没发现」的差别，并给原因；
//   ③ 自动修正后要标 corrected（旧意见不得误标适用于新正文）；
//   ④ 新章绑定必须核对任务与计划章号，对不上就不绑（不按章号猜归属）。
import { readFileSync } from 'node:fs'
import {
  REVIEW_SUMMARY_KEY, REVIEW_SUMMARY_LIMIT, bindSummaryChapter, buildReviewSummary,
  mergeRunStates, parseReviewSummaries, withAppendedSummary, type ReviewRunSummary,
} from '@/lib/revision/reviewSummary'
import { appendReviewSummary, bindReviewSummaryChapter, loadReviewSummaries } from '@/lib/revision/reviewSummaryStore'
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => readFileSync(p, 'utf8')

const run = (state: string, extra: { errorCode?: string; findings?: number } = {}) => ({
  state, sourceId: `src-${state}`, ...(extra.errorCode ? { errorCode: extra.errorCode } : {}),
  findings: extra.findings ?? 0,
})
const summary = (over: Partial<ReviewRunSummary> = {}): ReviewRunSummary => ({
  id: 's1', at: 1000, fingerprint: 'fp-1', state: 'completed',
  coverage: { requested: 3, completed: 3, failed: 0, skipped: 0 },
  runs: [
    { checkId: 'continuity', source: '章节自检 · 连续性', state: 'completed', findings: 0 },
    { checkId: 'ooc', source: '章节自检 · 人设', state: 'completed', findings: 0 },
    { checkId: 'foreshadow', source: '章节自检 · 伏笔', state: 'completed', findings: 0 },
  ],
  ...over,
})

console.log('—— reviewSummary：运行摘要契约闸（3.6.0 · D）——')

// ---------- ① 合并语义 ----------
{
  ok('① 三项全完成 ⇒ completed（含合法空结果）', mergeRunStates([run('completed'), run('completed'), run('completed')]).state === 'completed')
  ok('🔴 ① 三项全 skipped ⇒ skipped（不能显示成通过）',
    mergeRunStates([run('skipped'), run('skipped'), run('skipped')]).state === 'skipped')
  ok('① 三项全 failed ⇒ failed', mergeRunStates([run('failed'), run('failed'), run('failed')]).state === 'failed')
  ok('① 任一 cancelled ⇒ cancelled（优先于其它）',
    mergeRunStates([run('completed'), run('cancelled'), run('failed')]).state === 'cancelled')
  ok('① 一项失败 + 两项完成 ⇒ partial', mergeRunStates([run('completed'), run('failed'), run('completed')]).state === 'partial')
  ok('① 一项跳过 + 两项完成 ⇒ partial（不是 completed）',
    mergeRunStates([run('completed'), run('skipped'), run('completed')]).state === 'partial')
  ok('① 零项 ⇒ skipped（没有可执行项不等于通过）', mergeRunStates([]).state === 'skipped')
  const cov = mergeRunStates([run('completed'), run('skipped'), run('incomplete')]).coverage
  ok('① 覆盖度把 skipped/incomplete 计入 skipped，并给 uninspected',
    cov.requested === 3 && cov.completed === 1 && cov.skipped === 2 && (cov.uninspected ?? []).length === 2,
    JSON.stringify(cov))
  ok('① issues 带出失败原因（人话给作者看）',
    mergeRunStates([run('failed', { errorCode: 'timeout' })]).issues[0].includes('timeout'))
}

// ---------- ② 摘要内容 ----------
{
  const s = buildReviewSummary({
    id: 'x', at: 2000, fingerprint: 'fp-x',
    runs: [
      { checkId: 'continuity', source: '章节自检 · 连续性', state: 'completed', findings: 2 },
      { checkId: 'ooc', source: '章节自检 · 人设', state: 'completed', findings: 0 },
      { checkId: 'foreshadow', source: '章节自检 · 伏笔', state: 'skipped', errorCode: 'context-insufficient' },
    ],
    taskId: 't1', chapterNo: 5, reportIds: ['r1', 'r2'],
  })
  ok('② 合并状态与条数都记进摘要', s.state === 'partial' && s.runs[0].findings === 2)
  ok('② 未检项带原因码（不是空白的"通过"）', s.runs[2].state === 'skipped' && s.runs[2].errorCode === 'context-insufficient')
  ok('② 计划章号 + 任务 id 落进摘要', s.chapterNo === 5 && s.taskId === 't1')
  ok('② 报告 id 关联（可选）', (s.reportIds ?? []).join('|') === 'r1|r2')
  ok('② reason 由问题清单兜底（失败/跳过都能解释）', typeof s.reason === 'string' && s.reason.length > 0)
  ok('② 全绿摘要也必须能生成（报告页 0 份 ≠ 没问题）',
    buildReviewSummary({ id: 'y', at: 1, fingerprint: 'f', runs: [{ checkId: 'continuity', source: 's', state: 'completed', findings: 0 }] }).state === 'completed')
}

// ---------- ③ corrected 与滚动 ----------
{
  const s = buildReviewSummary({
    id: 'c1', at: 1, fingerprint: 'f', corrected: true,
    runs: [{ checkId: 'continuity', source: 's', state: 'completed', findings: 1 }],
  })
  ok('③ 自动修正后标 corrected（指纹指向修正前正文）', s.corrected === true && s.fingerprint === 'f')
  const list = Array.from({ length: REVIEW_SUMMARY_LIMIT + 5 }, (_, i) => summary({ id: `s${i}`, at: i }))
  const next = withAppendedSummary(list, summary({ id: 'new', at: 9999 }))
  ok('③ 追加后排最前', next[0].id === 'new')
  ok('③ 超出上限截断到 50 条', next.length === REVIEW_SUMMARY_LIMIT)
  const dup = withAppendedSummary(next, summary({ id: 'new', at: 10000 }))
  ok('③ 同 id 覆盖而不是出现两条', dup.filter(x => x.id === 'new').length === 1 && dup.length === REVIEW_SUMMARY_LIMIT)
  ok('③ 解析时坏条目跳过、按时间倒序',
    parseReviewSummaries([summary({ id: 'a', at: 1 }), { bad: true }, summary({ id: 'b', at: 5 })]).map(x => x.id).join('|') === 'b|a')
}

// ---------- ④ 绑定校验 ----------
{
  const list = [summary({ id: 's1', taskId: 't1', chapterNo: 5 })]
  const good = bindSummaryChapter(list, 's1', 'ch-real', { chapterNo: 5, taskId: 't1' })
  ok('④ 任务与章号一致 ⇒ 绑定成功', good.ok && good.list[0].chapterId === 'ch-real')
  const wrongNo = bindSummaryChapter(list, 's1', 'ch-x', { chapterNo: 9 })
  ok('🔴 ④ 章号不一致 ⇒ 不绑定（不按章号猜归属）', !wrongNo.ok && wrongNo.list[0].chapterId === undefined)
  const wrongTask = bindSummaryChapter(list, 's1', 'ch-x', { taskId: 't2' })
  ok('④ 任务不一致 ⇒ 不绑定', !wrongTask.ok && wrongTask.list[0].chapterId === undefined)
  const missing = bindSummaryChapter(list, 'nope', 'ch-x', {})
  ok('④ 找不到摘要 ⇒ 明确失败', !missing.ok && /找不到/.test(missing.reason ?? ''))
}

// ---------- ⑤ 真实存储往返 ----------
{
  __resetMockStores()
  const pid = (await db.createProject('运行摘要往返')).id
  const s1 = buildReviewSummary({
    id: 'sum-1', at: 1000, fingerprint: 'fp-1', taskId: 't1', chapterNo: 1,
    runs: [{ checkId: 'continuity', source: '章节自检 · 连续性', state: 'completed', findings: 1 }],
  })
  const w = await appendReviewSummary(pid, s1)
  ok('⑤ 写入成功', w.ok)

  const loaded = await loadReviewSummaries(pid)
  ok('⑤ 读回一条且内容一致', loaded.list.length === 1 && loaded.list[0].id === 'sum-1' && loaded.list[0].runs[0].findings === 1)

  const bound = await bindReviewSummaryChapter(pid, 'sum-1', 'ch-real-1', { chapterNo: 1, taskId: 't1' })
  ok('⑤ 绑定后 chapterId 落库', bound.ok && (await loadReviewSummaries(pid)).list[0].chapterId === 'ch-real-1')

  const bad = await bindReviewSummaryChapter(pid, 'sum-1', 'ch-wrong', { chapterNo: 7 })
  const after = await loadReviewSummaries(pid)
  ok('⑤ 校验失败不覆盖已绑定的 chapterId', !bad.ok && after.list[0].chapterId === 'ch-real-1')

  // 空项目：读回空列表而不是报错
  const emptyPid = (await db.createProject('空摘要')).id
  const empty = await loadReviewSummaries(emptyPid)
  ok('⑤ 新项目读回空列表（不报错）', empty.list.length === 0 && !empty.error)
  ok('⑤ 键名与 M0 约定一致', REVIEW_SUMMARY_KEY === 'reviewSummaries')
}

// ---------- ⑥ 接线闸 ----------
{
  // 3.6.0 · D：自检逻辑从 autoContinue 抽到 outline/selfRefine.ts（过 1200 行硬闸），
  // 逐条断言分别落在真正实现的那一侧。
  const auto = read('src/lib/outline/autoContinue.ts')
  const self = read('src/lib/outline/selfRefine.ts')
  ok('🔴 ⑥ 资料不足时返回 skipped（不再是 completed + requested:0）',
    /state: 'skipped'/.test(self) && /context-insufficient/.test(self) && !/requested: 0, completed: 0, failed: 0, skipped: 0/.test(self))
  ok('⑥ 自检三项都写运行摘要（含全绿与失败）', /writeSummary/.test(self) && /appendReviewSummary/.test(self))
  ok('⑥ 自动修正后标 corrected', /writeSummary\(\{ corrected: true \}\)/.test(self))
  ok('⑥ 建章后补绑 chapterId，并核对任务/章号',
    /bindReviewSummaryChapter\(/.test(auto) && /chapterNo: plannedNo/.test(auto))
  ok('🔴 ⑥ skipped 不暂停连写（前置不足不是"未完成"）',
    /sc\.state === 'skipped'/.test(auto) && /else if \(sc\.state !== 'completed'\)/.test(auto))
  const panel = read('src/components/revision/CheckReportPanel.tsx')
  ok('⑥ 报告页展示运行摘要', /data-review-summaries/.test(panel) && /loadReviewSummaries/.test(panel))
  ok('⑥ 空态不再说「全绿不在这里留痕」（与运行摘要不矛盾）',
    !/全绿的检查不占空间，也不在这里留痕/.test(panel))
  ok('⑥ 报告落库返回可关联的 id', /ids\?: string\[\]/.test(read('src/lib/revision/checkReports.ts')))
}

console.log(`\n———— reviewSummary：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
