/**
 * 连写自检 · 运行摘要（3.6.0 · D 包）
 *
 * 依据：3.6.0 规划第 6 节 / 第 16 节 D。
 *
 * 🔴 为什么需要它：检查报告是 **A 策略**（有严重/中等发现才落库），于是「全绿」这件事
 *    在报告页**没有任何痕迹**。作者看到「0 份报告」时无法区分：
 *      · 查过了，没发现问题；
 *      · 根本没查（上下文为空 / 正文过短 / 预算耗尽）；
 *      · 查失败了。
 *    运行摘要就是补这一环：**每次自检都留一条轻量记录**，说明三项各自跑没跑、几条发现、
 *    为什么没跑，并可选关联到落档报告。它不复制问题正文，只存状态与计数。
 *
 * 🔴 为什么不塞进检查报告：报告有双闸配额（每任务 5 份 / 每项目 200 份 32 MiB），
 *    每章一条摘要会迅速把真正的发现挤掉。
 *    ⇒ 摘要走 `settingsKV` 的 `reviewSummaries`，滚动保留最近 50 条，随项目包与备份走。
 */

import type { Coverage } from './revisionTypes'

/** `settingsKV` 键（不含 `<pid>::` 前缀） */
export const REVIEW_SUMMARY_KEY = 'reviewSummaries'

/** 滚动保留条数（运行记录，不是作者成果；超出淘汰最旧的，并在界面注明） */
export const REVIEW_SUMMARY_LIMIT = 50

export type ReviewCheckState = 'completed' | 'partial' | 'failed' | 'cancelled' | 'skipped' | 'incomplete'

export interface ReviewRunEntry {
  /** continuity / ooc / foreshadow（或将来新增的检查 id） */
  checkId: string
  source: string
  state: ReviewCheckState
  /** 本次这项检查报了几条（含提示级；0 表示"查了没发现"） */
  findings: number
  errorCode?: string
}

export interface ReviewRunSummary {
  id: string
  at: number
  taskId?: string
  /** 自检时只有计划章号 —— 真实 chapterId 由 `bindReviewSummaryChapter` 事后补绑 */
  chapterNo?: number
  chapterId?: string
  /** 正文指纹：判「旧意见还敢不敢套到新正文上」 */
  fingerprint: string
  /** 三项合并后的状态（与 `summarizeSelfCheck` 同口径） */
  state: ReviewCheckState
  /** 没跑成时的原因（人话，给作者看） */
  reason?: string
  coverage: Coverage
  runs: ReviewRunEntry[]
  /** 本轮落档的报告 id（`[]` 或缺失都**不能**推断成"无问题"） */
  reportIds?: string[]
  /**
   * 本次是否发生了自动修正（3.6.0 · D：旧意见不得误标适用于新正文）。
   * `true` 表示摘要针对的是**修正前**的正文，作者回看时要以 `fingerprint` 对号。
   */
  corrected?: boolean
  /**
   * 修正前后对照（只存指纹与字数，不复制正文）。
   * 🔴 正文本身在章节快照里；摘要只负责让作者看出「审的是哪一版、改了多少」。
   */
  revision?: {
    beforeFingerprint: string
    afterFingerprint?: string
    beforeWords: number
    afterWords?: number
  }
  /**
   * 本轮报告落档结果（3.6.0 · D：写入失败与被配额清理必须显式，不能假装存住了）。
   * 缺失 ⇒ 本轮没有账本上下文（老调用），不是"存了 0 份"。
   */
  reportWrite?: { saved: number; pruned: number; error?: string }
}

/** 摘要来源的最小形状（与 `StepExecutionResult` 兼容，但不强耦合） */
export interface RunLike {
  state?: string
  sourceId?: string
  errorCode?: string
  coverage?: Coverage
  result?: { data?: readonly unknown[] } | null
  issues?: unknown[]
}

const STATES: readonly ReviewCheckState[] = [
  'completed', 'partial', 'failed', 'cancelled', 'skipped', 'incomplete',
]

function stateOf(r: RunLike): ReviewCheckState {
  return STATES.includes(r.state as ReviewCheckState) ? (r.state as ReviewCheckState) : 'failed'
}

/**
 * 合并多项检查的运行状态（**唯一判据**）。
 *
 * 规则：
 *  · 任一 `cancelled` ⇒ cancelled（作者取消立即传播，不当成通过）；
 *  · 全部 `failed` ⇒ failed；
 *  · 全部 `skipped` ⇒ **skipped**（一项都没检，绝不能显示成"通过"）；
 *  · 有 `incomplete` / `partial` / 单个 `failed` ⇒ partial（部分完成）；
 *  · 全部 `completed`（含合法空发现）⇒ completed。
 */
export function mergeRunStates(runs: readonly RunLike[]): {
  state: ReviewCheckState
  issues: string[]
  coverage: Coverage
} {
  const requested = runs.length
  const count = (s: ReviewCheckState) => runs.filter(r => stateOf(r) === s).length
  const completed = count('completed')
  const failed = count('failed')
  const skipped = count('skipped')
  // `partial` 与 `incomplete` 既不算完成也不算失败，但必须体现在覆盖度里（由 skipped 之外的项承担）
  const incomplete = count('incomplete')
  const partial = count('partial')
  const coverage: Coverage = {
    requested,
    completed,
    failed,
    skipped: skipped + incomplete + partial,
    ...(skipped + incomplete > 0
      ? { uninspected: runs.filter(r => ['skipped', 'incomplete'].includes(stateOf(r))).map(r => r.sourceId ?? '检查') }
      : {}),
  }
  const issues = runs
    .filter(r => stateOf(r) !== 'completed')
    .map(r => `${r.sourceId ?? '检查'}:${r.errorCode ?? stateOf(r)}`)
  if (!requested) return { state: 'skipped', issues: ['没有可执行的自检项'], coverage }
  if (count('cancelled') > 0) return { state: 'cancelled', issues, coverage }
  if (failed === requested) return { state: 'failed', issues, coverage }
  if (skipped === requested) return { state: 'skipped', issues, coverage }
  if (completed === requested) return { state: 'completed', issues, coverage }
  return { state: 'partial', issues, coverage }
}

/** 由三项运行结果 + 元信息构造摘要（纯函数；id 由调用方注入，便于测试稳定） */
export function buildReviewSummary(input: {
  id: string
  at: number
  fingerprint: string
  runs: readonly (RunLike & { checkId: string; source: string; findings?: number })[]
  taskId?: string
  chapterNo?: number
  chapterId?: string
  reason?: string
  reportIds?: string[]
  corrected?: boolean
  revision?: ReviewRunSummary['revision']
  reportWrite?: ReviewRunSummary['reportWrite']
}): ReviewRunSummary {
  const merged = mergeRunStates(input.runs)
  return {
    id: input.id,
    at: input.at,
    fingerprint: input.fingerprint,
    state: merged.state,
    coverage: merged.coverage,
    runs: input.runs.map(r => ({
      checkId: r.checkId,
      source: r.source,
      state: stateOf(r),
      findings: r.findings ?? (Array.isArray(r.result?.data) ? r.result!.data!.length : 0),
      ...(r.errorCode ? { errorCode: r.errorCode } : {}),
    })),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.chapterNo !== undefined ? { chapterNo: input.chapterNo } : {}),
    ...(input.chapterId ? { chapterId: input.chapterId } : {}),
    ...(input.corrected ? { corrected: true } : {}),
    ...(input.revision ? { revision: input.revision } : {}),
    ...(input.reportWrite ? { reportWrite: input.reportWrite } : {}),
    ...((input.reason || merged.issues.length)
      ? { reason: input.reason ?? merged.issues.join('；') }
      : {}),
    ...(input.reportIds?.length ? { reportIds: input.reportIds } : {}),
  }
}

/** 校验一份从存储读回的对象是否可用（坏条目跳过，不毁整份） */
export function isReviewSummary(v: unknown): v is ReviewRunSummary {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id) return false
  if (typeof o.fingerprint !== 'string') return false
  if (typeof o.state !== 'string' || !STATES.includes(o.state as ReviewCheckState)) return false
  if (!Array.isArray(o.runs)) return false
  return true
}

/** 读出可用的摘要列表（新→旧；坏条目跳过） */
export function parseReviewSummaries(raw: unknown): ReviewRunSummary[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(isReviewSummary).sort((a, b) => b.at - a.at)
}

/**
 * 追加一条并滚动截断（纯函数；调用方负责读写存储）。
 * 同 id 覆盖（重放下不会出现两条一样的记录）。
 */
export function withAppendedSummary(
  list: readonly ReviewRunSummary[], next: ReviewRunSummary, limit = REVIEW_SUMMARY_LIMIT,
): ReviewRunSummary[] {
  const kept = list.filter(s => s.id !== next.id)
  return [next, ...kept].slice(0, Math.max(1, limit))
}

/**
 * 绑定真实 chapterId（纯函数）。
 *
 * 🔴 规划 §16 D：自检发生在 `createChapterAfter` **之前**，那时只有计划章号。
 *    所以绑定必须**核对身份**再写：章节号或任务 id 对不上就不绑（保留未绑定状态），
 *    绝不按章号猜测归属 —— 并发插章 / 草稿重写都可能让"第 5 章"换人。
 */
export function bindSummaryChapter(
  list: readonly ReviewRunSummary[], summaryId: string, chapterId: string,
  expect: { chapterNo?: number; taskId?: string },
): { list: ReviewRunSummary[]; ok: boolean; reason?: string } {
  const idx = list.findIndex(s => s.id === summaryId)
  if (idx < 0) return { list: [...list], ok: false, reason: '找不到这条运行摘要' }
  const cur = list[idx]
  if (expect.taskId && cur.taskId && cur.taskId !== expect.taskId) {
    return { list: [...list], ok: false, reason: '任务不一致，未绑定（避免把别的任务的摘要挂到本章）' }
  }
  if (expect.chapterNo !== undefined && cur.chapterNo !== undefined && cur.chapterNo !== expect.chapterNo) {
    return { list: [...list], ok: false, reason: '计划章号不一致，未绑定' }
  }
  const next = list.slice()
  next[idx] = { ...cur, chapterId }
  return { list: next, ok: true }
}
