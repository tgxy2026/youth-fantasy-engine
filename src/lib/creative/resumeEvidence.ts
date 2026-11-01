/**
 * 3.3.3 · B3：创意写作断点的**产物回读校验**（纯函数）。
 *
 * 断点只存"写到第几章"，但章可能已被作者删掉、改写，或来自另一个项目 ——
 * 直接续跑会从错误的 `baseDone` 起算：要么重复建章，要么把后面的章号错位。
 * 规划 §6.2 要求"成功产物可回读校验"、"缺产物/损坏拒绝静默续跑"。
 *
 * 🔴 旧记录没有证据（`evidence` 缺失）⇒ 一律要求人工核对，不假装可续跑。
 * 🔴 只认**章 id + 正文指纹**：标题换字不影响续跑（作者常改标题），正文变了才危险。
 */
import { textFingerprint } from '@/lib/tasks/unitLedger'

export interface CreatedChapterEvidence {
  id: string
  title: string
  /** 章号（展示用；不参与判定） */
  no: number
  /** `textFingerprint(content)` */
  fingerprint: string
}

export type ResumeEvidenceReason = '' | 'legacy' | 'count' | 'invalid' | 'missing' | 'changed'

export interface ResumeEvidenceVerdict {
  ok: boolean
  reason: ResumeEvidenceReason
  /** 找不到的章 id */
  missing: string[]
  /** 正文已变的章 id */
  changed: string[]
}

/**
 * 校验断点证据是否仍与书库一致。
 * @param evidence 断点里记录的已写章节（旧记录 = undefined）
 * @param chapters 书库里现有的章（按 id 查，不看顺序）
 * @param doneChapters 断点记录的已完成章数（可选；与证据条数不一致 ⇒ 记录本身损坏）
 */
export function verifyResumeEvidence(
  evidence: readonly CreatedChapterEvidence[] | undefined | null,
  chapters: readonly { id: string; content: string }[],
  doneChapters?: number,
): ResumeEvidenceVerdict {
  if (!evidence || (Array.isArray(evidence) && evidence.length === 0)) {
    return { ok: false, reason: 'legacy', missing: [], changed: [] }
  }
  if (!Array.isArray(evidence)) return { ok: false, reason: 'invalid', missing: [], changed: [] }
  if (doneChapters !== undefined && (!Number.isSafeInteger(doneChapters) || doneChapters <= 0 || doneChapters !== evidence.length)) {
    return { ok: false, reason: 'count', missing: [], changed: [] }
  }
  const ids = new Set<string>()
  for (const e of evidence) {
    if (!e || typeof e.id !== 'string' || !e.id || typeof e.fingerprint !== 'string' || !e.fingerprint || ids.has(e.id)) {
      return { ok: false, reason: 'invalid', missing: [], changed: [] }
    }
    ids.add(e.id)
  }
  const byId = new Map(chapters.map(c => [c.id, c]))
  const missing: string[] = []
  const changed: string[] = []
  for (const e of evidence) {
    const live = byId.get(e.id)
    if (!live) { missing.push(e.id); continue }
    if (textFingerprint(live.content ?? '') !== e.fingerprint) changed.push(e.id)
  }
  if (missing.length) return { ok: false, reason: 'missing', missing, changed }
  if (changed.length) return { ok: false, reason: 'changed', missing, changed }
  return { ok: true, reason: '', missing: [], changed: [] }
}

/** 给界面的一句话（只说事实，不编"已恢复"） */
export function describeResumeEvidence(v: ResumeEvidenceVerdict): string {
  switch (v.reason) {
    case 'legacy': return '这份记录来自旧版本，没有可校验的章节信息。'
    case 'count': return '记录里的已完成章数与证据对不上，可能已损坏。'
    case 'invalid': return '记录里的章节证据无效或重复，无法安全续跑。'
    case 'missing': return `有 ${v.missing.length} 章已被删除，无法按原进度续跑。`
    case 'changed': return `有 ${v.changed.length} 章正文已被改动，续跑会按旧进度跳过错误的章。`
    default: return ''
  }
}
