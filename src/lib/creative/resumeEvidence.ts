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
import type { CreativeResume } from '@/lib/ai/aiWorkflow'
import type { FlowProgress } from '@/lib/flow/types'

/**
 * 重开时把「上次没跑完」的进度**降级为已中止**（纯函数）。
 *
 * 🔴 为什么必须降级（2026-11-01 实机发现，`b04-kill.mjs` 跑到设定阶段后重开）：
 *   进度快照会被持久化（`status / ratio / stages 摘要`），但**草稿 bag 不落盘**（设计如此）。
 *   原样保留 `status: 'running'` 时，时间线在重开后仍显示「进行中」（`WorkflowTimeline` 在
 *   `running=false` 时退回显示 `FLOW_STATUS_TEXT[progress.status]`），而实际既没有任务在跑、
 *   也没有草稿可确认 —— 作者只能干瞪眼，还以为是卡住了。
 *   降级成 `cancelled`（"已中止"）语义才正确。
 *
 * ⚠️ 只动展示态：**能否续跑看的是 `resume`/`evidence`**（见 `verifyResumeEvidence`），
 *   与本字段无关，因此降级不会让本该可续跑的任务变得不可续。
 */
export function downgradeInterruptedProgress(p: FlowProgress | null | undefined): FlowProgress | null {
  if (!p) return null
  if (p.status !== 'running') return p
  return {
    ...p,
    status: 'cancelled',
    current: null,
    message: '上次没跑完（已中断）：进度只作记录，草稿不在磁盘上，重开后请重新开始。',
    stages: p.stages.map(s => (s.status === 'running' ? { ...s, status: 'cancelled' as const } : s)),
  }
}

export interface CreatedChapterEvidence {
  id: string
  title: string
  /** 章号（展示用；不参与判定） */
  no: number
  /** `textFingerprint(content)` */
  fingerprint: string
}

export type ResumeEvidenceReason = '' | 'legacy' | 'count' | 'invalid' | 'missing' | 'changed' | 'trailing'

export interface ResumeEvidenceVerdict {
  ok: boolean
  reason: ResumeEvidenceReason
  /** 找不到的章 id */
  missing: string[]
  /** 正文已变的章 id */
  changed: string[]
  /** 断点记录之后的后续新章节 id（非致命差异） */
  trailing: string[]
}

/** 3.3.5 · A1 连写恢复三态：健康可直接续跑 / 待确认非致命差异 / 严重冲突已阻断 */
export type ResumeTriState = 'resumable' | 'review-needed' | 'blocked'

export interface ResumeClassification {
  state: ResumeTriState
  headline: string
  detail: string
  canResumeDirectly: boolean
  canResumeFromSafeCheckpoint: boolean
  canRestartFromScratch: boolean
}

/** 断点落盘时只保留可序列化字段（bag 是内存产物，绝不进 meta） */
export function serializeResumeForPersist(r: CreativeResume): CreativeResume {
  return {
    from: r.from,
    doneChapters: r.doneChapters,
    totalChapters: r.totalChapters,
    label: r.label,
    ...(r.evidence ? { evidence: r.evidence } : {}),
  } as CreativeResume
}

/** 旧记录的结构是否至少能被本版读懂（不是"产物有效"，只是"不是坏 JSON 形状"） */
export function isCreativeResumeShape(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return typeof r.from === 'string' && r.from.length > 0
    && typeof r.doneChapters === 'number' && Number.isFinite(r.doneChapters) && r.doneChapters >= 0
    && typeof r.totalChapters === 'number' && Number.isFinite(r.totalChapters) && r.totalChapters > 0
    && typeof r.label === 'string'
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
    return { ok: false, reason: 'legacy', missing: [], changed: [], trailing: [] }
  }
  if (!Array.isArray(evidence)) return { ok: false, reason: 'invalid', missing: [], changed: [], trailing: [] }
  if (doneChapters !== undefined && (!Number.isSafeInteger(doneChapters) || doneChapters <= 0 || doneChapters !== evidence.length)) {
    return { ok: false, reason: 'count', missing: [], changed: [], trailing: [] }
  }
  const ids = new Set<string>()
  for (const e of evidence) {
    if (!e || typeof e.id !== 'string' || !e.id || typeof e.fingerprint !== 'string' || !e.fingerprint || ids.has(e.id)) {
      return { ok: false, reason: 'invalid', missing: [], changed: [], trailing: [] }
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
  if (missing.length) return { ok: false, reason: 'missing', missing, changed, trailing: [] }
  if (changed.length) return { ok: false, reason: 'changed', missing, changed, trailing: [] }

  // 检查断点证据末章之后是否已被新建其他章节（尾部非致命差异）
  const lastEv = evidence[evidence.length - 1]
  const lastIdx = chapters.findIndex(c => c.id === lastEv.id)
  const trailing: string[] = []
  if (lastIdx !== -1 && lastIdx < chapters.length - 1) {
    for (let i = lastIdx + 1; i < chapters.length; i++) {
      trailing.push(chapters[i].id)
    }
  }
  if (trailing.length) return { ok: false, reason: 'trailing', missing: [], changed: [], trailing }
  return { ok: true, reason: '', missing: [], changed: [], trailing: [] }
}

/** 给界面的一句话（只说事实，不编"已恢复"） */
export function describeResumeEvidence(v: ResumeEvidenceVerdict): string {
  switch (v.reason) {
    case 'legacy': return '这份记录来自旧版本，没有可校验的章节信息。'
    case 'count': return '记录里的已完成章数与证据对不上，可能已损坏。'
    case 'invalid': return '记录里的章节证据无效或重复，无法安全续跑。'
    case 'missing': return `有 ${v.missing.length} 章已被删除，无法按原进度续跑。`
    case 'changed': return `有 ${v.changed.length} 章正文已被改动，续跑会按旧进度跳过错误的章。`
    case 'trailing': return `断点之后检测到 ${v.trailing.length} 个新章节，需确认续跑点。`
    default: return ''
  }
}

/** 3.3.5 · A1 连写恢复三态判定分类：健康可续跑 / 待确认非致命差异 / 严重冲突已阻断 */
export function classifyResumeState(
  verdict: ResumeEvidenceVerdict,
  resume: CreativeResume | null | undefined,
  totalChaptersInput?: number,
): ResumeClassification {
  if (!resume) {
    return {
      state: 'resumable',
      headline: '从零开始',
      detail: '当前没有断点记录，将从头开始创作。',
      canResumeDirectly: true,
      canResumeFromSafeCheckpoint: false,
      canRestartFromScratch: true,
    }
  }

  // 1. 致命冲突 (blocked)：正文被改动、章节被删、证据损坏或条数冲突
  if (verdict.reason === 'changed') {
    return {
      state: 'blocked',
      headline: '章节正文已被改动',
      detail: `有 ${verdict.changed.length} 章在断点建立后正文已被改动。为防止剧情冲突与重复建章，已阻止自动续跑。请核对章节或从头重写。`,
      canResumeDirectly: false,
      canResumeFromSafeCheckpoint: false,
      canRestartFromScratch: true,
    }
  }
  if (verdict.reason === 'missing') {
    return {
      state: 'blocked',
      headline: '断点章节已被删除',
      detail: `有 ${verdict.missing.length} 章已被删除，断点记录已失效。已阻止自动续跑，请核对章节或从头重写。`,
      canResumeDirectly: false,
      canResumeFromSafeCheckpoint: false,
      canRestartFromScratch: true,
    }
  }
  if (verdict.reason === 'count' || verdict.reason === 'invalid') {
    return {
      state: 'blocked',
      headline: '断点记录损坏',
      detail: verdict.reason === 'count'
        ? `断点记录中的已完成章数与章节证据条数不符，记录可能已损坏。`
        : `断点中的章节证据格式损坏或包含重复章 ID。`,
      canResumeDirectly: false,
      canResumeFromSafeCheckpoint: false,
      canRestartFromScratch: true,
    }
  }

  // 2. 待确认差异 (review-needed)：旧版本记录、断点后有新章节、目标章数不一致
  if (verdict.reason === 'legacy') {
    return {
      state: 'review-needed',
      headline: '旧版断点缺少校验信息',
      detail: '这份记录来自旧版本，没有可供核验的章节指纹。您可以选择从最近安全记录点继续，或从头重新开始。',
      canResumeDirectly: false,
      canResumeFromSafeCheckpoint: true,
      canRestartFromScratch: true,
    }
  }
  if (verdict.reason === 'trailing') {
    return {
      state: 'review-needed',
      headline: '断点之后存在新章节',
      detail: `检测到断点记录之后书库中已存在 ${verdict.trailing.length} 个后续章节。您可以选择从最近安全断点（已完成 ${resume.doneChapters} 章）继续，或从头重新开始。`,
      canResumeDirectly: false,
      canResumeFromSafeCheckpoint: true,
      canRestartFromScratch: true,
    }
  }
  if (totalChaptersInput !== undefined && resume.totalChapters !== totalChaptersInput) {
    return {
      state: 'review-needed',
      headline: '本次章数与断点不一致',
      detail: `当前设置目标为 ${totalChaptersInput} 章，而断点记录为 ${resume.totalChapters} 章（已完成 ${resume.doneChapters} 章）。请恢复原章数，或选择从头重写。`,
      canResumeDirectly: false,
      canResumeFromSafeCheckpoint: false,
      canRestartFromScratch: true,
    }
  }

  // 3. 正常健康 (resumable)
  return {
    state: 'resumable',
    headline: '断点完整有效',
    detail: `上次中止在：${resume.label}。章节完整、指纹一致，可安全继续。`,
    canResumeDirectly: true,
    canResumeFromSafeCheckpoint: true,
    canRestartFromScratch: true,
  }
}
