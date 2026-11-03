import * as db from '@/lib/db'
import type { CreativeResume, CreativeTarget } from '@/lib/ai/aiWorkflow'
import { MAX_CHAPTERS } from '@/lib/outline/writingPace'
import {
  classifyResumeState,
  describeResumeEvidence,
  verifyResumeEvidence,
  type ResumeClassification,
  type ResumeEvidenceVerdict,
} from '@/lib/creative/resumeEvidence'
import type { OwnedOperation } from '@/lib/storage/ownedOperation'

export interface ResumeValidationResult {
  reason: string
  parameters: boolean
  classification: ResumeClassification
  verdict?: ResumeEvidenceVerdict
}

/** Revalidate immediately before starting, since chapters and inputs can change after hydration. */
export async function validateResumeForStart(
  resume: CreativeResume,
  chaptersInput: number,
  owner: OwnedOperation,
  target: CreativeTarget,
  opts?: { allowReviewOverride?: boolean },
): Promise<ResumeValidationResult> {
  const total = Math.max(1, Math.min(MAX_CHAPTERS, Math.round(chaptersInput ?? 10) || 1))
  if (target === 'outline') {
    const classification: ResumeClassification = {
      state: 'blocked',
      headline: '目标模式不匹配',
      detail: '正文断点不能用于仅规划大纲，请恢复正文目标或主动从头开始。',
      canResumeDirectly: false,
      canResumeFromSafeCheckpoint: false,
      canRestartFromScratch: true,
    }
    return { reason: classification.detail, parameters: true, classification }
  }
  if (resume.from !== 'draft') {
    const classification: ResumeClassification = {
      state: 'blocked',
      headline: '断点阶段无效',
      detail: '断点阶段无效，请核对已保存章节后再操作。',
      canResumeDirectly: false,
      canResumeFromSafeCheckpoint: false,
      canRestartFromScratch: true,
    }
    return { reason: classification.detail, parameters: false, classification }
  }
  if (!Number.isSafeInteger(resume.totalChapters) || resume.totalChapters !== total
    || !Number.isSafeInteger(resume.doneChapters) || resume.doneChapters <= 0
    || resume.doneChapters > resume.totalChapters) {
    const isParamMismatch = Number.isSafeInteger(resume.totalChapters) && resume.totalChapters !== total
    const classification: ResumeClassification = {
      state: isParamMismatch ? 'review-needed' : 'blocked',
      headline: isParamMismatch ? '本次章数与断点不一致' : '断点元数据损坏',
      detail: isParamMismatch
        ? `本次连写目标（${total}章）与断点原计划（${resume.totalChapters}章）不一致，请恢复原章数后重试。`
        : '断点元数据章数无效或损坏，请核对原章节后重试。',
      canResumeDirectly: false,
      canResumeFromSafeCheckpoint: false,
      canRestartFromScratch: true,
    }
    return { reason: classification.detail, parameters: true, classification }
  }
  const chapters = await db.getAllChapters(owner).catch(() => null)
  if (!chapters) {
    const classification: ResumeClassification = {
      state: 'blocked',
      headline: '暂时无法读取章节',
      detail: '暂时读不到书库里的章节，无法核对断点。',
      canResumeDirectly: false,
      canResumeFromSafeCheckpoint: false,
      canRestartFromScratch: false,
    }
    return { reason: classification.detail, parameters: false, classification }
  }
  const verdict = verifyResumeEvidence(resume.evidence, chapters, resume.doneChapters)
  const classification = classifyResumeState(verdict, resume, total)

  // 3.3.5 · A1：若用户显式选择从最近安全断点恢复，且断点属于 review-needed（非致命差异），允许放行
  if (opts?.allowReviewOverride && classification.state === 'review-needed' && classification.canResumeFromSafeCheckpoint) {
    return { reason: '', parameters: false, classification, verdict }
  }

  return {
    reason: verdict.ok ? '' : (classification.detail || describeResumeEvidence(verdict)),
    parameters: false,
    classification,
    verdict,
  }
}
