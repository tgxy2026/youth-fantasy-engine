// ============ 候选主动过期（3.7.0 · W2）============
//
// 接线对象是 3.2.0 写好的休眠件（规划要求**复用、勿重写**）：
//   `generationInvalidation.isBaselineStale` / `expireCandidate`；
//   本模块只做「从真实库取当前摘要 → 交给它们判 → 变了才落库」。
//
// 🔴 三条纪律：
//   ① 只动 `pending` / `stale`：`applying` 正在写正文、`applied` / `discarded` 是终态 ——
//      在应用中途标过期，会让「写了一半」的核对失去依据；
//   ② 摘要取不到（老候选 / 章已删）⇒ 该维跳过，绝不误判；
//   ③ 任何异常静默：过期提示是旁路，保存与正文永远优先。
import type { OwnedOperation } from '@/lib/storage/ownedOperation'
import { hashOf } from '@/lib/semantic/chunk'
import { listJobCandidates, listProjectCandidates, saveCandidate } from './candidateStore'
import { rewriteJobIdOf } from './candidateIntake'
import { chapterBodyOf, jobForCandidate } from './candidateRunner'
import { expireCandidate, isBaselineStale } from './generationInvalidation'
import { chapterOrderForChapter, outlineDigestForChapter, settingsDigestForChapter } from './baselineDigest'
import type { RevisionCandidate } from './revisionCandidate'

/** 一次判定所需的三份当前摘要（同章多候选共用一次取数） */
interface CurrentBaseline {
  bodyDigest: string
  outlineDigest?: string
  settingsDigest?: string
  chapterOrder?: number
}

async function currentBaselineOf(chapterId: string, owner?: OwnedOperation): Promise<CurrentBaseline> {
  const bodyDigest = hashOf(await chapterBodyOf(chapterId, owner))
  const [outlineDigest, settingsDigest, chapterOrder] = await Promise.all([
    outlineDigestForChapter(chapterId, owner).catch(() => undefined),
    settingsDigestForChapter(chapterId, owner).catch(() => undefined),
    chapterOrderForChapter(chapterId, owner).catch(() => undefined),
  ])
  return { bodyDigest, outlineDigest, settingsDigest, chapterOrder }
}

/** 把「基准已变」的候选落库为 stale，返回实际落库条数 */
async function expireAgainst(
  candidates: RevisionCandidate[],
  chapterId: string,
  current: CurrentBaseline,
  owner?: OwnedOperation,
): Promise<number> {
  let expired = 0
  for (const candidate of candidates) {
    if (candidate.status !== 'pending' && candidate.status !== 'stale') continue
    const job = jobForCandidate(candidate, chapterId)
    const verdict = isBaselineStale(
      job, current.bodyDigest, current.outlineDigest, current.settingsDigest, current.chapterOrder,
    )
    if (!verdict.stale) continue
    const result = expireCandidate(candidate, verdict.reasons)
    if (!result.ok || !result.candidate) continue
    // 已经是 stale 且理由没新增 → 不重复写库
    if (candidate.status === 'stale') {
      const before = (candidate.staleReasons ?? []).join('|')
      const after = (result.candidate.staleReasons ?? []).join('|')
      if (before === after) continue
    }
    const saved = await saveCandidate(result.candidate, owner, candidate)
    if (saved.ok) expired++
  }
  return expired
}

/**
 * 某章的候选主动过期：正文 / 细纲 / 固定设定任一变了 ⇒ 该章 pending 候选 stale。
 * `chapterId` 来自 `db` 变更事实（`saveChapter` / `patchChapter` 的章 id）。
 */
export async function expireRevisionCandidatesForChapter(
  chapterId: string, owner?: OwnedOperation,
): Promise<number> {
  if (!chapterId) return 0
  try {
    const candidates = await listJobCandidates(rewriteJobIdOf(chapterId), owner)
    if (!candidates.length) return 0
    return await expireAgainst(candidates, chapterId, await currentBaselineOf(chapterId, owner), owner)
  } catch {
    return 0
  }
}

/**
 * 设定变更没有「章 id」可指（作者改的是资料条目）⇒ 按项目扫还挂着的候选，
 * 用**同一章的摘要只取一次**的缓存逐章判定。批量写由 changeWatch 的 300ms 防抖合并。
 */
export async function expireRevisionCandidatesForProject(
  projectId: string, owner?: OwnedOperation,
): Promise<number> {
  if (!projectId) return 0
  try {
    const candidates = (await listProjectCandidates(projectId))
      .filter(c => c.status === 'pending' || c.status === 'stale')
    if (!candidates.length) return 0
    const cache = new Map<string, CurrentBaseline>()
    let expired = 0
    for (const chapterId of new Set(candidates.map(c => c.chapterId).filter((id): id is string => !!id))) {
      const current = cache.get(chapterId) ?? await currentBaselineOf(chapterId, owner)
      cache.set(chapterId, current)
      expired += await expireAgainst(candidates.filter(c => c.chapterId === chapterId), chapterId, current, owner)
    }
    return expired
  } catch {
    return 0
  }
}