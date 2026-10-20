/**
 * AI 运行账本 · 编排与版本保护（3.0 · W1-1）
 *
 * 两块职责：
 *   1. **版本基准与失效判定**（纯函数，好测）：`chapterFingerprint` / `computeBasis` / `checkBasisStale`
 *      —— §10.3 #1「正文或上游设定变化后，旧候选不得覆盖作者编辑」的判据就落在这里。
 *   2. **账本编排**（读写 db）：`createRun` / `patchRun` / `finishRun` —— 让接线处（创意写作 /
 *      改写 / 续写）用最少代码把一次 AI 任务记进账本。
 *
 * 🔴 口径（与 §10.3 #1 一致）：
 *    · 候选**不自动落库**，账本只记「它基于什么、有几条、指纹多少」；
 *    · 基准失效 ⇒ 候选标 `stale`，**拒绝静默覆盖**，但**不自动丢弃、不自动重跑**（克制口径）。
 */
import type { Chapter } from '@/lib/types'
import type {
  AiContextSnapshot, AiRun, AiRunBasis, AiRunCall, AiRunCallRequest, AiRunCandidateRef, AiRunKind, AiRunOutcome, AiRunStatus,
} from '@/lib/ai/aiRunTypes'
import { hashOf } from '@/lib/semantic/chunk'
import { uid } from '@/lib/app/id'
import { setUsageSink, type ChatUsage } from '@/lib/aiCore/usage'
import {
  resolveCallAttribution, type CallRequestContext,
} from '@/lib/ai/callTracking'
import { getAiRun, saveAiRun } from '@/lib/db/aiRuns'

// ============ 一、版本基准与失效判定（纯函数）============

/**
 * 章级指纹：标题 / 正文 / 字数 / 最后改动时刻 一起哈希。
 *
 * 🔴 为什么必须含 `updatedAt`（别想着省）：作者把一段改坏又改回原样时，正文快照与原来
 *    **逐字节相同**，只按内容算指纹会判「没变」而放行旧候选 —— 但作者确实动过手，
 *    该走一次确认。宁严勿松。
 */
export function chapterFingerprint(
  ch: Pick<Chapter, 'title' | 'content' | 'wordCount' | 'updatedAt'>,
): string {
  return hashOf([ch.title, ch.content, String(ch.wordCount), String(ch.updatedAt)].join('\u0000'))
}

/** 采集基准：把「当前正文 + 设定戳」固定下来，随候选一起存进账本 */
export function computeBasis(
  chapters: readonly Chapter[],
  settingsRev: number | null,
  now = Date.now(),
): AiRunBasis {
  return {
    chapters: chapters.map(ch => ({ chapterId: ch.id, fingerprint: chapterFingerprint(ch) })),
    settingsRev,
    at: now,
  }
}

/** 失效判定所需的「当前状态」快照 */
export interface BasisCurrent {
  /** chapterId → 当前指纹（缺省表示该章已被删除） */
  chapters?: ReadonlyMap<string, string>
  /** 当前设定版本戳（拿不到传 null / 省略即不比） */
  settingsRev?: number | null
}

export interface BasisCheck {
  stale: boolean
  /** 人话版失配原因，供界面提示（「第 3 章的正文已被改动」这种） */
  reasons: string[]
}

/**
 * 基准是否已失效。
 * 任一命中即 stale：① 涉及章的当前指纹与基准不符；② 涉及章已被删除；③ 设定戳变了。
 *
 * 📌 预留（2026-10-10 轻量审计标注）：改写链路的采纳校验走的是 `chapterFingerprint` 的**单章直接比对**
 *    （更精确、少一层包装）；本函数面向「多渠道基准（章 ＋ 上游设定）」的完整口径，等出现第二个
 *    采纳点（章后整理 / 一致性审计）时接线。**不是死代码** —— 已有单测钉住判据，删掉等于让下一处
 *    采纳点重新发明一遍。
 */
export function checkBasisStale(basis: AiRunBasis, current: BasisCurrent): BasisCheck {
  const reasons: string[] = []
  for (const ref of basis.chapters ?? []) {
    const now = current.chapters?.get(ref.chapterId)
    if (now === undefined) reasons.push('涉及的一章已被删除')
    else if (now !== ref.fingerprint) reasons.push('涉及的章节正文已被改动')
  }
  if (
    basis.settingsRev != null &&
    current.settingsRev != null &&
    basis.settingsRev !== current.settingsRev
  ) {
    reasons.push('上游设定已被改动')
  }
  return { stale: reasons.length > 0, reasons: [...new Set(reasons)] }
}

/**
 * 取「属于本次任务」的上下文快照。
 * 🔴 判据是 `snap.at >= runStartedAt`：快照早于任务开始 ⇒ 那是上一次任务留下的，宁缺勿错
 *    （记错上下文比不记更糟 —— 作者会以为「模型看到了」，其实没有）。
 */
export function pickContextSnapshot(
  snap: AiContextSnapshot | null,
  runStartedAt: number,
): AiContextSnapshot | null {
  if (!snap || snap.at < runStartedAt) return null
  return snap
}

// ============ 二、账本编排（读写 db）============

// ============ 并行归属（3.2.0 · WQ7）============
//
// 🔴 旧实现：单个 `activeRunId` + 单个 `activeCalls`。后果有两个，都是真错：
//    ① 第二个任务一 `createRun` 就把第一个挤掉 ⇒ 第一个任务的调用全记到第二个头上；
//    ② 先结束的任务 `finishRun` 里 `setUsageSink(null)` ⇒ 还在跑的那个从此**不再记账**。
//    方案 §13.2 的验收场景就是「两个并行 AI 任务与一个无父任务调用：各自正确归属；
//    一个结束不截断另一个记账」，所以必须按 runId 分槽。
//
// 🔴 判不出来就不判：调用没自报 taskId 且同时有多个任务在跑时，**不**塞给任意一个，
//    而是给每个在跑任务各记一笔「排除」，收尾时如实写进 `excludedCalls`。

interface ActiveRunSlot {
  runId: string
  projectId: string
  kind: AiRunKind
  calls: AiRunCall[]
  /** 未归属到本任务的调用：原因 → 次数（只计数，不存内容） */
  excludedReasons: Map<string, number>
  /** 走「唯一任务」兼容路径归属的调用数 */
  legacyAttributed: number
  /**
   * 本任务产出的候选引用（3.2.0 · W3 种子）。
   * 🔴 只存「落点 / 条数 / 指纹 / 状态」，不存候选全文 —— 否则账本会跟着正文一起膨胀。
   */
  candidates: AiRunCandidateRef[]
}

const activeRuns = new Map<string, ActiveRunSlot>()
let sinkBound = false

/** 只留归属相关的字段（`scope` 是判定用的，落库没有意义） */
function pickRequest(r: CallRequestContext): AiRunCallRequest {
  return {
    ...(r.callId ? { callId: r.callId } : {}),
    ...(r.projectId !== undefined ? { projectId: r.projectId } : {}),
    ...(r.taskId ? { taskId: r.taskId } : {}),
    ...(r.stepId ? { stepId: r.stepId } : {}),
    ...(r.taskType ? { taskType: r.taskType } : {}),
  }
}

function toRunCall(u: ChatUsage, via: 'task-id' | 'legacy-single-run'): AiRunCall {
  return {
    model: u.model,
    ms: u.ms,
    ...(u.promptTokens !== undefined ? { promptTokens: u.promptTokens } : {}),
    ...(u.completionTokens !== undefined ? { completionTokens: u.completionTokens } : {}),
    ...(u.tokensEstimated ? { tokensEstimated: true } : {}),
    ...(u.firstByteMs !== undefined ? { firstByteMs: u.firstByteMs } : {}),
    ...(u.finishReason ? { finishReason: u.finishReason } : {}),
    ...(u.attempts !== undefined ? { attempts: u.attempts } : {}),
    ...(u.request ? { request: pickRequest(u.request) } : {}),
    ...(u.protocol ? { protocol: u.protocol } : {}),
    attributedBy: via,
    at: u.at,
  }
}

/**
 * 接上用量总线（幂等）。
 * 🔴 全程只挂**一个** sink、按调用逐条分派 —— 每个任务各挂一个会互相覆盖（旧实现的老毛病）。
 */
function bindUsageSink(): void {
  if (sinkBound) return
  sinkBound = true
  setUsageSink(u => {
    const active = [...activeRuns.values()].map(r => ({
      runId: r.runId, projectId: r.projectId, taskType: r.kind,
    }))
    const decision = resolveCallAttribution(active, u.request)
    if (decision.kind === 'run') {
      const slot = activeRuns.get(decision.runId)
      if (!slot) return
      slot.calls.push(toRunCall(u, decision.via))
      if (decision.via === 'legacy-single-run') slot.legacyAttributed += 1
      return
    }
    // 判不出归属：每个在跑任务都「少算了一次」，各自都要说明白 —— 而不是塞给其中一个
    for (const slot of activeRuns.values()) {
      slot.excludedReasons.set(decision.detail, (slot.excludedReasons.get(decision.detail) ?? 0) + 1)
    }
  })
}

/**
 * 记一条**候选引用**（3.2.0 · W3 种子）。
 *
 * 🔴 为什么需要：`AiRun.candidates` 从 3.0 就存在，但**一直没有生产者** ——
 *    「创作轨迹」里的候选条数恒为 0，等于这块界面从来没说过真话。
 *
 * 口径：
 *  · 同一 `target` + 同一 `fingerprint` 重复上报 ⇒ 只更新状态（不重复计数）；
 *  · 同一 `target` 但指纹变了 ⇒ 视为**新一版候选**，追加一条（作者看得出改过几稿）；
 *  · `runId` 不在跑（任务已收尾 / 页面重载）⇒ 静默忽略：账本不是关键路径，绝不因此打断创作。
 */
export function noteCandidate(
  runId: string | undefined,
  ref: { target: string; count?: number; fingerprint: string; state: AiRunCandidateRef['state'] },
): void {
  if (!runId) return
  const slot = activeRuns.get(runId)
  if (!slot) return
  const hit = slot.candidates.find(c => c.target === ref.target && c.fingerprint === ref.fingerprint)
  if (hit) {
    hit.state = ref.state
    if (ref.count !== undefined) hit.count = ref.count
    return
  }
  slot.candidates.push({
    target: ref.target,
    count: Math.max(1, Math.round(ref.count ?? 1)),
    fingerprint: ref.fingerprint,
    state: ref.state,
  })
}

/** 摘掉总线（没有任务在跑时）—— 否则页面空闲期间的调用会一直空转 */
function unbindUsageSinkIfIdle(): void {
  if (activeRuns.size > 0) return
  sinkBound = false
  setUsageSink(null)
}

/** 组装一条新运行记录（未落库）—— `status` 一律从 `running` 起。内部用，不外导（外部一律走 createRun） */
function newRun(input: {
  projectId: string
  kind: AiRunKind
  title: string
  basis: AiRunBasis
  now?: number
}): AiRun {
  const now = input.now ?? Date.now()
  return {
    id: uid(),
    projectId: input.projectId,
    kind: input.kind,
    title: input.title,
    status: 'running',
    startedAt: now,
    finishedAt: 0,
    basis: input.basis,
    candidates: [],
    calls: [],
    outcome: null,
    error: '',
  }
}

/** 新建并落库（任务开跑时调一次）。返回账本 id，后续 patch 都带它。 */
export async function createRun(input: {
  projectId: string
  kind: AiRunKind
  title: string
  basis: AiRunBasis
  now?: number
}): Promise<AiRun> {
  const run = newRun(input)
  await saveAiRun(run)
  // 3.2.0 · WQ7：登记一条在跑槽位（不动别的槽位 —— 并行任务各记各的）
  activeRuns.set(run.id, {
    runId: run.id,
    projectId: run.projectId,
    kind: run.kind,
    calls: [],
    excludedReasons: new Map(),
    legacyAttributed: 0,
    candidates: [],
  })
  bindUsageSink()
  return run
}

/**
 * 读改写（局部更新）。用于运行中更新候选 / 累积调用 / 收尾。
 * ⚠️ 找不到记录时**静默返回 undefined**（账本不是关键路径，绝不因记账失败打断创作）。
 */
export async function patchRun(id: string, patch: Partial<AiRun>): Promise<AiRun | undefined> {
  const cur = await getAiRun(id)
  if (!cur) return undefined
  const next = { ...cur, ...patch }
  await saveAiRun(next)
  return next
}

// 📌 2026-10-10 轻量审计：删掉 `appendRunCall` / `makeCandidateRef` 两个未使用导出 ——
//    · 调用账改由 `setUsageSink` 内存累积、`finishRun` **一次写入**（`appendRunCall` 的逐步读改写被淘汰）；
//    · 候选引用现由 `noteCandidate()` 生产（3.2.0 · W3 种子）；正文链在落库时上报「已采纳」。
/** 收尾：置终态 + 验收回执 */
export async function finishRun(
  id: string,
  patch: {
    status: Exclude<AiRunStatus, 'running'>
    outcome?: AiRunOutcome | null
    error?: string
    /** 本次实际装配的上下文（§10.3 #2 上下文查看） */
    context?: AiContextSnapshot | null
    now?: number
  },
): Promise<void> {
  // 3.2.0 · WQ7：只取**本任务槽位**的账一次写入；并行任务的账互不影响。
  const slot = activeRuns.get(id)
  const calls = slot ? [...slot.calls] : []
  const candidates = slot ? [...slot.candidates] : []
  const excluded = slot && slot.excludedReasons.size > 0
    ? {
      count: [...slot.excludedReasons.values()].reduce((n, c) => n + c, 0),
      reasons: [...slot.excludedReasons.keys()],
    }
    : null
  await patchRun(id, {
    status: patch.status,
    outcome: patch.outcome ?? null,
    error: patch.error ?? '',
    ...(patch.context !== undefined ? { context: patch.context } : {}),
    ...(calls.length ? { calls } : {}),
    ...(candidates.length ? { candidates } : {}),
    ...(excluded ? { excludedCalls: excluded } : {}),
    ...(slot && slot.legacyAttributed > 0 ? { legacyAttributedCalls: slot.legacyAttributed } : {}),
    finishedAt: patch.now ?? Date.now(),
  })
  // 只摘自己这一槽；别的任务还在跑时总线必须留着（旧实现在这里把别人一起摘了）
  activeRuns.delete(id)
  unbindUsageSinkIfIdle()
}
