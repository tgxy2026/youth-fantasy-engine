/**
 * 连写自检（3.6.0 · D 从 `autoContinue` 抽出）
 *
 * 抽出原因：`autoContinue.ts` 已到 1263 行，超过「单文件 1200 行」硬闸（`structureGates`）。
 * 自检是**独立一环**（三项审校 → 修正 → 运行摘要 → 报告），抽出来既过闸也让 D 包的边界更清楚。
 *
 * 三条语义（与规划 §16 D 一致）：
 *  · 三项审校是必选项：失败 / 取消 / 部分完成 ⇒ `selfCheck.state !== 'completed'`，调用方暂停连写；
 *  · **资料不足（上下文空、正文过短）⇒ `skipped`**，不是「审过了没问题」；
 *  · 每次自检都留一条运行摘要（含全绿与失败），供报告页回答「这次到底查没查」。
 */
import { uid } from '@/lib/app/id'
import { countWords } from '@/lib/editor/textStats'
import { stripThink } from '@/lib/ai'
import type { CallRequestContext } from '@/lib/ai/callTracking'
import type { AttemptBudget } from '@/lib/ai/requestLedger'
import type { ProjectContextResult } from '@/lib/ai/aiContext'
import {
  aiContinuityAuditWithStatus, aiOocCheckWithStatus, aiForeshadowReviewWithStatus, aiRewritePassage,
} from '@/lib/ai/aiTasks'
import { persistCheckReports, type CheckRunLike } from '@/lib/revision/checkReports'
import { buildReviewSummary } from '@/lib/revision/reviewSummary'
import { appendReviewSummary } from '@/lib/revision/reviewSummaryStore'
import type { Coverage, StepExecutionResult } from '@/lib/revision/revisionTypes'
import { hashOf } from '@/lib/semantic/chunk'

/**
 * 连写自检的返回形状。
 *
 * 🔴 `selfCheck.state !== 'completed'` 时调用方**必须暂停后续自动应用**：
 *    三项审校是「本次已启用且承诺执行的必选项」，请求失败 / 解析失败 /
 *    取消都不是"审了没问题"。草稿保留在编辑器，由作者重试或明确跳过。
 */
export interface SelfRefineResult {
  body: string
  selfCheck: StepExecutionResult<RefineFinding[]>
  /**
   * 3.6.0 · D：本次运行摘要 id（无账本场景 / 写入失败时为 undefined）。
   * 调用方在 `createChapterAfter` 拿到真实 chapterId 后用它补绑，**不按章号猜归属**。
   */
  summaryId?: string
}

/** 自检三项的共同 Finding 形状（只按 level 过滤，其余字段原样带过） */
export type RefineFinding = { level?: string }

/**
 * WQ1-2 纯汇总：把三项审校的运行结果压成一条（可单测，无 IO）。
 *
 * 规则（§16.2 + 3.6.0 D）：
 *   · 全部 completed（**含合法空 findings**）⇒ completed —— 空也是"审了没问题"；
 *   · 任一 cancelled ⇒ cancelled（作者取消立即传播，不当成通过）；
 *   · 全部 failed ⇒ failed；部分失败 ⇒ partial —— 都不得显示"自检通过"；
 *   · 全部 skipped ⇒ **skipped**（一项都没检，不能算通过）。
 */
export function summarizeSelfCheck(
  runs: readonly StepExecutionResult<RefineFinding[]>[],
): StepExecutionResult<RefineFinding[]> {
  const requested = runs.length
  const completed = runs.filter(r => r.state === 'completed').length
  const failed = runs.filter(r => r.state === 'failed').length
  const cancelled = runs.filter(r => r.state === 'cancelled').length
  /**
   * 🔴 3.6.0 · D：`skipped` / `incomplete` 必须单独统计。
   *    旧写法 `coverage.skipped` 恒为 0，并且用 `failed === 0` 判"完成" ——
   *    只要三项里有任何一项是"没检"，就会被算成"审过了、没问题"。
   */
  const skipped = runs.filter(r => r.state === 'skipped').length
  const incomplete = runs.filter(r => r.state === 'incomplete').length
  const partialCount = runs.filter(r => r.state === 'partial').length
  const coverage: Coverage = {
    requested, completed, failed,
    skipped: skipped + incomplete + partialCount,
    ...(skipped + incomplete > 0
      ? { uninspected: runs.filter(r => r.state === 'skipped' || r.state === 'incomplete').map(r => r.sourceId ?? '检查') }
      : {}),
  }
  const bad = runs.filter(r => r.state !== 'completed')
  const issues = bad.map(r => `${r.sourceId ?? '检查'}:${r.errorCode ?? r.state}`)
  if (cancelled > 0) {
    return { state: 'cancelled', coverage, issues, errorCode: 'cancelled' }
  }
  // 一项都没检 ≠ 通过：既没有产物，也没有"查过没问题"这件事
  if (skipped === requested) {
    return { state: 'skipped', coverage, issues, errorCode: 'all-checks-skipped' }
  }
  if (completed === requested) {
    return { state: 'completed', coverage, sourceId: 'self-refine' }
  }
  if (failed === requested) {
    return { state: 'failed', coverage, issues, errorCode: runs[0]?.errorCode ?? 'all-checks-failed', retryable: true }
  }
  if (failed + skipped + incomplete + partialCount === 0) {
    return { state: 'completed', coverage, sourceId: 'self-refine' }
  }
  return { state: 'partial', coverage, issues, errorCode: 'some-checks-failed', retryable: true }
}

/** 单项检查 → 摘要条目的公共字段（state / 原因码 / 发现条数） */
const reviewRunFields = (r: StepExecutionResult<RefineFinding[]>) => ({
  state: r.state,
  ...(r.errorCode ? { errorCode: r.errorCode } : {}),
  findings: r.result?.data?.length ?? 0,
})

/** 3.6.0 · D：把「本章没做自检」也留一条痕（否则报告页只有 0 份，分不清没查还是没问题） */
async function recordSkippedSelfCheck(input: {
  body: string
  request?: CallRequestContext
  chapterNo?: number
  reason: string
}): Promise<string | undefined> {
  if (!input.request?.taskId || !input.request.projectId) return undefined
  const summary = buildReviewSummary({
    id: uid(),
    at: Date.now(),
    fingerprint: hashOf(input.body),
    runs: [
      { checkId: 'continuity', source: '章节自检 · 连续性', state: 'skipped', errorCode: 'context-insufficient', findings: 0 },
      { checkId: 'ooc', source: '章节自检 · 人设', state: 'skipped', errorCode: 'context-insufficient', findings: 0 },
      { checkId: 'foreshadow', source: '章节自检 · 伏笔', state: 'skipped', errorCode: 'context-insufficient', findings: 0 },
    ],
    taskId: input.request.taskId,
    ...(input.chapterNo !== undefined ? { chapterNo: input.chapterNo } : {}),
    reason: input.reason,
  })
  const r = await appendReviewSummary(String(input.request.projectId), summary).catch(() => ({ ok: false as const }))
  return r.ok ? summary.id : undefined
}

export async function selfRefine(
  body: string, ctx: ProjectContextResult, signal?: AbortSignal,
  onPhase?: (p: string) => void, request?: CallRequestContext,
  budget?: AttemptBudget,
  /**
   * 计划章号（W4：检查报告要按章挂在工单上）。
   * 🔴 用章号而不是章 id：自检发生在 `createChapterAfter` **之前**，那时新章还没有 id。
   */
  chapterNo?: number,
  /** 3.5.5 · ACP 通道：自检后的单轮改写走 Agent */
  acpText?: (prompt: string) => Promise<string>,
): Promise<SelfRefineResult> {
  /**
   * 🔴 3.6.0 · D：资料不足 ⇒ **skipped**，不再是 `completed + requested:0`。
   *    旧写法让「一项都没检」在账本与报告页上看起来像「审过了、没问题」，
   *    与「查了没发现」完全分不开（规划 §16 D / §14 第 3 条）。
   */
  if (!ctx.text.trim() || countWords(body) < 200) {
    const words = countWords(body)
    const reason = !ctx.text.trim()
      ? '上下文为空（还没有可参照的设定与正文），本章未做自检'
      : `正文过短（${words} 字，少于 200 字），本章未做自检`
    const summaryId = await recordSkippedSelfCheck({ body, request, chapterNo, reason })
    return {
      body,
      selfCheck: {
        state: 'skipped',
        coverage: { requested: 3, completed: 0, failed: 0, skipped: 3, uninspected: ['continuity', 'ooc', 'foreshadow'] },
        issues: [reason],
        errorCode: 'context-insufficient',
        sourceId: 'self-refine-skipped',
      },
      ...(summaryId ? { summaryId } : {}),
    }
  }
  // 3.2.0 · WQ6：三项自检 = 三次逻辑调用，先记账再发（预算耗尽时这里就该被上层拦住）
  budget?.consume(3)
  onPhase?.('AI 编辑自检（连续性 / 人设 / 伏笔）')
  const findings: RefineFinding[] = []
  const push = (arr: readonly RefineFinding[]) => {
    for (const f of arr) if (f && (f.level === '严重' || f.level === '中等')) findings.push(f)
  }
  // WQ1-2：三项都走**带状态**版本 —— 旧写法 `.catch(() => [])` 把请求失败
  // 吞成"无问题"，是 Q1 登记病灶（自检失败却显示通过）的直接成因。
  const runs = await Promise.all([
    aiContinuityAuditWithStatus(ctx.text, body, { signal, ...(request ? { request } : {}) }),
    aiOocCheckWithStatus(ctx.text, body, { signal, ...(request ? { request } : {}) }),
    aiForeshadowReviewWithStatus(ctx.text, { signal, ...(request ? { request } : {}) }),
  ])
  const selfCheck = summarizeSelfCheck(runs)
  // 3.2.0 · W4：检查报告落库（A 策略）—— 只存有「严重 / 中等」发现的；
  // 没有 taskId/projectId 时（老调用、无账本场景）**不硬塞**：挂不到任务上的报告没人看得到。
  // 🔴 旁路，绝不打断创作：`persistCheckReports` 内部不抛，这里再兜一层。
  let reportIds: string[] | undefined
  if (request?.taskId && request.projectId) {
    const saved = await persistCheckReports({
      projectId: String(request.projectId),
      jobId: request.taskId,
      ...(chapterNo !== undefined ? { chapterNo } : {}),
      reports: [
        { checkId: 'continuity', source: '章节自检 · 连续性', run: runs[0] as unknown as CheckRunLike },
        { checkId: 'ooc', source: '章节自检 · 人设', run: runs[1] as unknown as CheckRunLike },
        { checkId: 'foreshadow', source: '章节自检 · 伏笔', run: runs[2] as unknown as CheckRunLike },
      ],
    }).catch(() => null)
    if (saved?.ids?.length) reportIds = saved.ids
  }
  /**
   * 3.6.0 · D：每次自检都留一条**运行摘要**（含全绿与失败 —— 那正是报告页分不清的部分）。
   * 摘要针对的是**自检时的正文**（指纹取 `body`），发生自动修正时标 `corrected`，
   * 作者回看时不会把旧意见当成新正文的结论。
   */
  const writeSummary = async (extra: { corrected?: boolean; reason?: string } = {}) => {
    if (!request?.taskId || !request.projectId) return undefined
    const summary = buildReviewSummary({
      id: uid(),
      at: Date.now(),
      fingerprint: hashOf(body),
      runs: [
        { checkId: 'continuity', source: '章节自检 · 连续性', ...reviewRunFields(runs[0]) },
        { checkId: 'ooc', source: '章节自检 · 人设', ...reviewRunFields(runs[1]) },
        { checkId: 'foreshadow', source: '章节自检 · 伏笔', ...reviewRunFields(runs[2]) },
      ],
      taskId: request.taskId,
      ...(chapterNo !== undefined ? { chapterNo } : {}),
      ...(reportIds ? { reportIds } : {}),
      ...(extra.reason ? { reason: extra.reason } : {}),
      ...(extra.corrected ? { corrected: true } : {}),
    })
    const r = await appendReviewSummary(String(request.projectId), summary).catch(() => ({ ok: false as const }))
    return r.ok ? summary.id : undefined
  }
  if (selfCheck.state !== 'completed') {
    // 必选项失败/取消：不当成通过、不进入改写分支；调用方据此暂停连写
    onPhase?.(`编辑自检未完成（${selfCheck.issues?.join('；') || selfCheck.state}），本章不自动修正`)
    const summaryId = await writeSummary()
    return { body, selfCheck, ...(summaryId ? { summaryId } : {}) }
  }
  for (const r of runs) push(r.result?.data ?? [])
  if (!findings.length) {
    onPhase?.('编辑自检通过，未发现严重问题')
    const summaryId = await writeSummary()
    return { body, selfCheck, ...(summaryId ? { summaryId } : {}) }
  }
  onPhase?.(`根据 ${findings.length} 条审读问题改写修正`)
  const instr = findings.map(f => `- ${(f as { title?: string }).title || '问题'}：${(f as { detail?: string }).detail || ''}`).join('\n')
  // 2.9.2 · ②：`aiRewritePassage` 收 `RewriteAsk` 对象（编辑区传 5 个动作词，这里传自由文本）
  const res = await aiRewritePassage(body, { instruction: `修正以下审读问题，保持剧情与文风一致，不要改变原意：\n${instr}` }, '', {
    signal, ...(acpText ? { acpText } : {}),
  }).catch(() => null)
  const rw = res?.rewritten ? stripThink(res.rewritten).trim() : ''
  // 安全阀：改写结果显著缩水（不足原文 60%）视为模型偷懒或被截断，保留原文
  if (!rw || countWords(rw) < countWords(body) * 0.6) {
    const summaryId = await writeSummary({ reason: '发现了审读问题，但自动修正结果不可用（过短或为空），已保留原文' })
    return { body, selfCheck, ...(summaryId ? { summaryId } : {}) }
  }
  const summaryId = await writeSummary({ corrected: true })
  return { body: rw, selfCheck, ...(summaryId ? { summaryId } : {}) }
}
