// ============ A2 细纲与正文对照 · 章节级编排（3.2.1 · T-09） ============
// 2026-10-22
//
// 【它串起来的东西】
//   《章节细纲》本章卡（CardRecord.data） → `PlanItemInput[]` → AI 语义对照
//   → 本地证据闸（`reviewPlanCompare`）→ 检查报告落档（`persistCheckReports`）
//   → 工单页「生成工单」时自动带进来（`intakeFromReports` 读全部报告）。
//
// 🔴 为什么落成**检查报告**而不是另建存储：
//   报告已经有留档 / 回看（`CheckReportPanel`）/ 加入工单 / 配额淘汰四套机制。
//   另起一套等于把「问题从哪来、后来怎么处理」拆成两个真相源。
//
// 🔴 只把「未找到体现 / 与计划不同」变成问题条目：
//   「部分体现」「证据不足」留在报告里给作者看，但**不进工单** ——
//   验收集规范里写得很清楚：没有正文证据的判定不许自动生成执行指令。
import { aiComparePlanWithBody, MAX_PLAN_COMPARE_ITEMS, type PlanItemInput, type PlanCompareReview } from '@/lib/aiTasks/planCompareAi'
import { persistCheckReports, type CheckFindingLike, type CheckRunLike } from '@/lib/revision/checkReports'

/** 细纲卡里「不是正文计划」的字段：它们是登记/衔接信息，拿去对照只会刷噪音 */
const NON_PLAN_HINTS = ['章节号', '出场人物', '时间地点', '新增设定登记', '伏笔操作', '下章预告', '承接上章', '情绪曲线']

/**
 * 从本章细纲卡取计划项（作者已填的非空字段，最多 20 条）。
 *
 * 🔴 只取**作者填过的**：空字段不算"计划"，否则报告里会出现一堆"未体现"。
 */
export function collectPlanItems(rec: { data?: Record<string, string> } | null, max = MAX_PLAN_COMPARE_ITEMS): PlanItemInput[] {
  const data = rec?.data ?? {}
  const out: PlanItemInput[] = []
  for (const [key, raw] of Object.entries(data)) {
    const value = String(raw ?? '').trim()
    if (!value) continue
    if (NON_PLAN_HINTS.some(h => key.includes(h))) continue
    out.push({ planFieldId: key, planQuote: value, templateVersion: 'chapter-outline' })
    if (out.length >= max) break
  }
  return out
}

/** 计划原文太长时截一句进标题（工单标题要能一眼看出是哪条计划） */
function brief(text: string, n = 24): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/**
 * 把对照结论转成检查报告里的问题条目。
 *
 * | 判定 | 是否进问题清单 | 理由 |
 * |---|---|---|
 * | not-found（未找到体现） | ✅ 中等 | 计划写了、正文没有，这是作者要处置的 |
 * | different（与计划不同） | ✅ 中等 | 偏离计划，需作者确认保留哪种 |
 * | partial / insufficient / completed | ❌ | 有证据或没证据都不该自动变成指令 |
 */
export function planFindingsFromReview(review: PlanCompareReview): CheckFindingLike[] {
  const out: CheckFindingLike[] = []
  for (const it of review.items) {
    if (it.status !== 'not-found' && it.status !== 'different') continue
    const label = it.status === 'not-found' ? '计划未体现' : '与计划不同'
    const where = it.paragraphIndices.length ? `第 ${it.paragraphIndices.map(i => i + 1).join('、')} 段` : undefined
    out.push({
      level: '中等',
      title: `${label}：${brief(it.planQuote)}`,
      detail: it.reason + (it.suggestion ? `（建议：${it.suggestion}）` : ''),
      ...(where ? { where } : {}),
    })
  }
  return out
}

export interface PlanCompareRunInput {
  projectId: string
  chapterId: string
  chapterNo?: number
  chapterTitle?: string
  bodyText: string
  outline: { data?: Record<string, string> } | null
  signal?: AbortSignal
}

export interface PlanCompareRunResult {
  /** empty＝细纲没填任何计划项；completed＝有结论；invalid/failed＝如实说没跑成 */
  state: 'empty' | 'completed' | 'invalid' | 'failed'
  review?: PlanCompareReview
  /** 落档份数（0 ＝ 没有"未体现/不同"，或者落档失败） */
  saved: number
  error?: string
}

/**
 * 跑一次「正文与细纲对照」并把结论落成检查报告。
 * 🔴 全程不抛：这是编辑器里的旁路动作，失败只如实返回，不影响正文与保存。
 */
export async function runPlanCompareForChapter(input: PlanCompareRunInput): Promise<PlanCompareRunResult> {
  const items = collectPlanItems(input.outline)
  if (!items.length) return { state: 'empty', saved: 0 }
  const outcome = await aiComparePlanWithBody(items, input.bodyText, input.signal ? { signal: input.signal } : {})
  if (outcome.state !== 'completed' || !outcome.review) {
    return { state: outcome.state === 'invalid' ? 'invalid' : 'failed', saved: 0, ...(outcome.error ? { error: outcome.error } : {}) }
  }
  const review = outcome.review
  const findings = planFindingsFromReview(review)
  if (!findings.length) return { state: 'completed', review, saved: 0 }

  const run: CheckRunLike = { state: 'completed', result: { data: findings } }
  const res = await persistCheckReports({
    projectId: input.projectId,
    jobId: 'local-plan-compare',
    chapterId: input.chapterId,
    ...(input.chapterNo !== undefined ? { chapterNo: input.chapterNo } : {}),
    ...(input.chapterTitle ? { chapterTitle: input.chapterTitle } : {}),
    reports: [{
      checkId: 'plan-compare',
      source: 'plan-compare',
      run,
      chapterId: input.chapterId,
      ...(input.chapterNo !== undefined ? { chapterNo: input.chapterNo } : {}),
      ...(input.chapterTitle ? { chapterTitle: input.chapterTitle } : {}),
    }],
  })
  return { state: 'completed', review, saved: res.saved, ...(res.error ? { error: res.error } : {}) }
}

/** 一句话结果（界面 toast 用，避免各处各写一套措辞） */
export function describePlanCompareRun(r: PlanCompareRunResult): string {
  if (r.state === 'empty') return '本章细纲还没填计划项 —— 先把细纲写出来再核对'
  if (r.state === 'invalid') return '对照失败：模型没有返回可解析的结果（可重试或换模型）'
  if (r.state === 'failed') return '对照失败：' + (r.error || '未知原因')
  const v = r.review!
  const need = v.summary.notFound + v.summary.different
  const head = `对照完成：${v.summary.total} 条计划`
  const tail = need > 0
    ? `，${v.summary.notFound} 条未体现 / ${v.summary.different} 条与计划不同${r.saved ? '（已留档，可在「检查报告」里加入工单）' : ''}`
    : '，没有需要处置的偏离'
  const warn = v.unlocated > 0 ? `；模型给的 ${v.unlocated} 句引文在正文里找不到，已丢弃` : ''
  return head + tail + warn
}
