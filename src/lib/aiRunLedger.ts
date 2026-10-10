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
  AiContextSnapshot, AiRun, AiRunBasis, AiRunCall, AiRunKind, AiRunOutcome, AiRunStatus,
} from '@/lib/aiRunTypes'
import { hashOf } from '@/lib/semantic/chunk'
import { uid } from '@/lib/id'
import { setUsageSink } from '@/lib/aiCore/usage'
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

// 3.0 · W1-4：任务内调用用量**内存累积**，收尾时一次写入。
// 🔴 为什么不逐步写：长任务几十次调用，每次读改写一遍全库不值当（桌面版整库是一份 JSON）。
let activeRunId: string | null = null
let activeCalls: AiRunCall[] = []

/** 把用量总线接到当前任务上 —— 任务结束后必须摘掉（见 finishRun） */
function bindUsageSink(): void {
  setUsageSink(u => {
    if (!activeRunId) return
    activeCalls.push({
      model: u.model,
      ms: u.ms,
      ...(u.promptTokens !== undefined ? { promptTokens: u.promptTokens } : {}),
      ...(u.completionTokens !== undefined ? { completionTokens: u.completionTokens } : {}),
      ...(u.finishReason ? { finishReason: u.finishReason } : {}),
      at: u.at,
    })
  })
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
  // 3.0 · W1-4：接上用量总线 —— 本任务期间的每次 chat() 都会累积进 activeCalls
  activeRunId = run.id
  activeCalls = []
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
//    · 候选引用目前只在 `AiRun.candidates` 结构里承载，尚无生产者（等「候选产出」接线时再加构造器）。
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
  // 3.0 · W1-4：把本任务累积的调用账**一次写入**（没有调用就不写这个字段）
  const calls = activeRunId === id ? [...activeCalls] : []
  await patchRun(id, {
    status: patch.status,
    outcome: patch.outcome ?? null,
    error: patch.error ?? '',
    ...(patch.context !== undefined ? { context: patch.context } : {}),
    ...(calls.length ? { calls } : {}),
    finishedAt: patch.now ?? Date.now(),
  })
  // 摘掉总线 —— 否则下一次任务的调用会继续往已结束的任务里塞
  if (activeRunId === id) { activeRunId = null; activeCalls = []; setUsageSink(null) }
}
