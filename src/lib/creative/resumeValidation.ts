import * as db from '@/lib/db'
import type { CreativeResume, CreativeTarget } from '@/lib/ai/aiWorkflow'
import { MAX_CHAPTERS } from '@/lib/outline/writingPace'
import { describeResumeEvidence, verifyResumeEvidence } from '@/lib/creative/resumeEvidence'
import type { OwnedOperation } from '@/lib/storage/ownedOperation'

/** Revalidate immediately before starting, since chapters and inputs can change after hydration. */
export async function validateResumeForStart(resume: CreativeResume, chaptersInput: number, owner: OwnedOperation, target: CreativeTarget): Promise<{ reason: string; parameters: boolean }> {
  const total = Math.max(1, Math.min(MAX_CHAPTERS, Math.round(chaptersInput ?? 10) || 1))
  if (target === 'outline') return { reason: '正文断点不能用于仅规划大纲，请恢复正文目标或主动从头开始。', parameters: true }
  if (resume.from !== 'draft') return { reason: '断点阶段无效，请核对已保存章节后再操作。', parameters: false }
  if (!Number.isSafeInteger(resume.totalChapters) || resume.totalChapters !== total
    || !Number.isSafeInteger(resume.doneChapters) || resume.doneChapters <= 0
    || resume.doneChapters > resume.totalChapters) {
    return { reason: '本次章数与断点不一致或断点无效，请核对原章数后重试。', parameters: true }
  }
  const chapters = await db.getAllChapters(owner).catch(() => null)
  if (!chapters) return { reason: '暂时读不到书库里的章节，无法核对断点。', parameters: false }
  const verdict = verifyResumeEvidence(resume.evidence, chapters, resume.doneChapters)
  return { reason: verdict.ok ? '' : describeResumeEvidence(verdict), parameters: false }
}
