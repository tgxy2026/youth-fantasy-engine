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
import type { Chapter } from './types'
import type {
  AiRun, AiRunBasis, AiRunCall, AiRunCandidateRef, AiRunKind, AiRunOutcome, AiRunStatus,
} from './aiRunTypes'
import { hashOf } from './semantic/chunk'
import { uid } from './id'
import { getAiRun, saveAiRun } from './db/aiRuns'

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

// ============ 二、账本编排（读写 db）============

/** 组装一条新运行记录（未落库）—— `status` 一律从 `running` 起 */
export function newRun(input: {
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

/** 追加一次模型调用账（#6 消耗统计 + §14 拒答感知共用） */
export async function appendRunCall(id: string, call: AiRunCall): Promise<void> {
  const cur = await getAiRun(id)
  if (!cur) return
  await saveAiRun({ ...cur, calls: [...cur.calls, call] })
}

/** 登记一个候选引用（候选产出时调，令中断后也能看到"已有哪些候选"） */
export function makeCandidateRef(
  target: string,
  count: number,
  fingerprint: string,
): AiRunCandidateRef {
  return { target, count, fingerprint, state: 'pending' }
}

/** 收尾：置终态 + 验收回执 */
export async function finishRun(
  id: string,
  patch: { status: Exclude<AiRunStatus, 'running'>; outcome?: AiRunOutcome | null; error?: string; now?: number },
): Promise<void> {
  await patchRun(id, {
    status: patch.status,
    outcome: patch.outcome ?? null,
    error: patch.error ?? '',
    finishedAt: patch.now ?? Date.now(),
  })
}
