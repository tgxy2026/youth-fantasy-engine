/**
 * 剧情候选 · 纯逻辑层（3.6.0 · F 包首期）
 *
 * 依据：规划 §6 / §16 F「范围与安全应用」。
 *
 * F 的安全边界（本文件是它的唯一判据来源）：
 *  1. **只改已有细纲卡的字段**：不建卷/章、不改正文、不改设定、不动作画布。
 *     目标卡不存在 / 字段在有效模板里解析不到 / 映射不唯一 ⇒ **不提供应用**（只存参考）。
 *  2. **确认时重读并比较**：每个字段应用前要求「当前值 === 候选记录的旧值」，
 *     否则判定 `value-changed`（作者或别的流程改过），跳过并展示差异，绝不覆盖。
 *  3. **部分成功如实说明**：逐字段给结果；一次写入只带上 `ok` 的字段，
 *     不在崩溃窗口里留"写了一半还不知道"的状态。
 *  4. **撤销只在可核验时提供**：当前值仍等于应用后的新值才允许回滚，否则给人工差异。
 *
 * 纯逻辑：解析、校验、计划、差异都在这里（可穷举单测），IO 在 `plotCandidateStore`。
 */
import { hashOf } from '@/lib/semantic/chunk'

/** 细纲卡页签 id（与 `outlineCard.OUTLINE_TAB_ID` 一致，这里不 import 以免形成方向依赖） */
export const OUTLINE_TAB = 'chapter-outline'

/** 允许候选改动的语义槽位（作者能看懂的三个） */
export interface OutlineSlotDef {
  /** 给作者看的名字 */
  slot: string
  /** AI 输出里的键（中文，与槽位同名即可） */
  aiKey: string
  /** 有效模板里可能叫的名字（按顺序找，取唯一匹配） */
  candidates: string[]
}

export const OUTLINE_SLOTS: readonly OutlineSlotDef[] = [
  { slot: '本章一句话事件', aiKey: '一句话事件', candidates: ['本章一句话事件', '一句话事件', '核心事件'] },
  { slot: '章末钩子', aiKey: '章末钩子', candidates: ['章末钩子', '章末悬念', '钩子'] },
  { slot: '本章功能', aiKey: '本章功能', candidates: ['本章功能', '章节功能', '功能'] },
]

/** 有效模板字段的最小形状（只取解析需要的两个键） */
export interface TemplateFieldLike {
  sourceKey: string
  label: string
  archived?: boolean
}

/** 解析结果：槽位 → 真实存储键（解析不到/不唯一就不出现） */
export interface ResolvedOutlineFields {
  resolved: { slot: string; key: string; label: string }[]
  /** 解析不到的原因（界面要说明"为什么不能应用"） */
  missing: { slot: string; reason: 'not-found' | 'ambiguous' }[]
}

/**
 * 按**有效模板**解析槽位 → 存储键。
 * 🔴 只认唯一匹配：模板被改名到两个字段都像"钩子"时，宁可不给应用，也不猜。
 */
export function resolveOutlineFields(fields: readonly TemplateFieldLike[]): ResolvedOutlineFields {
  const usable = fields.filter(f => !f.archived)
  const resolved: ResolvedOutlineFields['resolved'] = []
  const missing: ResolvedOutlineFields['missing'] = []
  for (const def of OUTLINE_SLOTS) {
    const hits = usable.filter(f =>
      def.candidates.some(name => f.label === name || f.sourceKey === name || f.sourceKey.endsWith(`::${name}`)))
    if (hits.length === 1) {
      resolved.push({ slot: def.slot, key: hits[0].sourceKey, label: hits[0].label })
    } else {
      missing.push({ slot: def.slot, reason: hits.length ? 'ambiguous' : 'not-found' })
    }
  }
  return { resolved, missing }
}

export interface PlotFieldValue {
  slot: string
  key: string
  label: string
  /** 候选生成时读到的值 */
  before: string
  /** 候选要写的值 */
  after: string
  /** 来源（引用哪条参考/哪条依据；没有就写"模型提议"） */
  source: string
}

export type PlotCandidateStatus = 'pending' | 'applied' | 'partial' | 'discarded' | 'stale'

export interface PlotApplyItem {
  slot: string
  key: string
  label: string
  before: string
  after: string
  current: string
  outcome: 'ok' | 'card-missing' | 'field-missing' | 'value-changed'
}

export interface PlotApplyReport {
  at: number
  items: PlotApplyItem[]
  okCount: number
  skippedCount: number
  /** 写入是否真的成功（整卡一次写入） */
  writeOk: boolean
  error?: string
}

export interface PlotCandidate {
  id: string
  projectId: string
  /** 细纲卡（唯一落点） */
  outlineCardId: string
  chapterNo: number
  chapterTitle: string
  /** 生成时细纲卡指纹（变了 ⇒ 过期，只给差异不给应用） */
  outlineFingerprint: string
  branchPoint: string
  title: string
  rationale: string
  fields: PlotFieldValue[]
  status: PlotCandidateStatus
  createdAt: number
  updatedAt: number
  applyReport?: PlotApplyReport
  /** 放弃理由（作者可见） */
  discardedReason?: string
}

/** 细纲卡指纹：卡名 + 可写字段的当前值 */
export function outlineFingerprintOf(card: { name: string; data: Record<string, string> }, keys: readonly string[]): string {
  const parts = keys.slice().sort().map(k => `${k}=${card.data[k] ?? ''}`)
  return hashOf(`${card.name}\n${parts.join('\n')}`)
}

/** 候选是否还能应用（过期/已放弃/已应用都不行） */
export function applicabilityOf(c: PlotCandidate, currentFingerprint: string): {
  canApply: boolean
  reason?: 'stale' | 'discarded' | 'applied' | 'no-fields'
} {
  if (c.status === 'discarded') return { canApply: false, reason: 'discarded' }
  if (c.status === 'applied') return { canApply: false, reason: 'applied' }
  if (!c.fields.length) return { canApply: false, reason: 'no-fields' }
  if (c.outlineFingerprint !== currentFingerprint) return { canApply: false, reason: 'stale' }
  return { canApply: true }
}

/**
 * 算出逐字段执行计划（**纯函数**，应用前必须调用它）。
 *
 * 🔴 这是"确认时重读并比较"的落点：`current` 来自**刚刚重读**的卡，不是生成时的快照。
 */
export function planPlotApply(
  candidate: PlotCandidate,
  card: { name: string; data: Record<string, string> } | null,
  resolvableKeys: ReadonlySet<string>,
): PlotApplyItem[] {
  return candidate.fields.map(f => {
    if (!card) {
      return { slot: f.slot, key: f.key, label: f.label, before: f.before, after: f.after, current: '', outcome: 'card-missing' }
    }
    const current = card.data[f.key] ?? ''
    if (!resolvableKeys.has(f.key)) {
      return { slot: f.slot, key: f.key, label: f.label, before: f.before, after: f.after, current, outcome: 'field-missing' }
    }
    if (current !== f.before) {
      return { slot: f.slot, key: f.key, label: f.label, before: f.before, after: f.after, current, outcome: 'value-changed' }
    }
    return { slot: f.slot, key: f.key, label: f.label, before: f.before, after: f.after, current, outcome: 'ok' }
  })
}

/**
 * 撤销计划：只有「当前值仍等于应用后的值」才算可回滚。
 * 返回 blocked 明细（当前值 vs 期望值），供界面展示人工差异。
 */
export function planPlotRevert(
  report: PlotApplyReport,
  card: { data: Record<string, string> } | null,
): { revertible: { key: string; to: string }[]; blocked: { key: string; label: string; current: string; expected: string }[] } {
  if (!card) {
    return {
      revertible: [],
      blocked: report.items.filter(i => i.outcome === 'ok')
        .map(i => ({ key: i.key, label: i.label, current: '（细纲卡已不在）', expected: i.after })),
    }
  }
  const revertible: { key: string; to: string }[] = []
  const blocked: { key: string; label: string; current: string; expected: string }[] = []
  for (const it of report.items) {
    if (it.outcome !== 'ok') continue // 当时没写进去的字段无需回滚
    const cur = card.data[it.key] ?? ''
    if (cur === it.after) revertible.push({ key: it.key, to: it.before })
    else blocked.push({ key: it.key, label: it.label, current: cur, expected: it.after })
  }
  return { revertible, blocked }
}

/** AI 输出解析：只保留能落到已解析字段、且新旧不同的条目 */
export function parsePlotCandidates(text: string, ctx: {
  projectId: string
  outlineCardId: string
  chapterNo: number
  chapterTitle: string
  outlineFingerprint: string
  /** 已解析的槽位 → 键 */
  resolved: readonly { slot: string; key: string; label: string }[]
  /** 当前值（用于 before 与"没变化就丢"） */
  current: Record<string, string>
  makeId: () => string
  now: number
  maxCandidates?: number
}): { candidates: PlotCandidate[]; dropped: number } {
  let rows: unknown[] | null = null
  try {
    const parsed: unknown = JSON.parse(extractJsonArray(text))
    rows = Array.isArray(parsed) ? parsed : null
  } catch {
    rows = null
  }
  if (!rows) return { candidates: [], dropped: 0 }

  const slotByAiKey = new Map(OUTLINE_SLOTS.map(d => [d.aiKey, d.slot]))
  const resolvedBySlot = new Map(ctx.resolved.map(r => [r.slot, r]))
  const out: PlotCandidate[] = []
  let dropped = 0
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { dropped++; continue }
    const o = raw as Record<string, unknown>
    const title = typeof o.title === 'string' ? o.title.trim().slice(0, 40) : ''
    const branchPoint = typeof o.branchPoint === 'string' ? o.branchPoint.trim().slice(0, 200) : ''
    const rationale = typeof o.rationale === 'string' ? o.rationale.trim().slice(0, 600) : ''
    if (!title || !branchPoint) { dropped++; continue }
    const fieldsRaw = o.fields && typeof o.fields === 'object' && !Array.isArray(o.fields)
      ? o.fields as Record<string, unknown>
      : {}
    const fields: PlotFieldValue[] = []
    for (const [aiKey, v] of Object.entries(fieldsRaw)) {
      const slot = slotByAiKey.get(aiKey)
      if (!slot) continue
      const r = resolvedBySlot.get(slot)
      if (!r) continue // 字段解析不到 ⇒ 这条字段不可写，直接丢（不是"悄悄写别处"）
      const after = typeof v === 'string' ? v.trim().slice(0, 800) : ''
      if (!after) continue
      const before = ctx.current[r.key] ?? ''
      if (after === before) continue // 没变化不给"应用按钮"
      fields.push({ slot, key: r.key, label: r.label, before, after, source: '模型提议' })
    }
    if (!fields.length) { dropped++; continue }
    out.push({
      id: ctx.makeId(),
      projectId: ctx.projectId,
      outlineCardId: ctx.outlineCardId,
      chapterNo: ctx.chapterNo,
      chapterTitle: ctx.chapterTitle,
      outlineFingerprint: ctx.outlineFingerprint,
      branchPoint,
      title,
      rationale,
      fields,
      status: 'pending',
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    if (out.length >= (ctx.maxCandidates ?? 3)) break
  }
  return { candidates: out, dropped }
}

/** 从模型输出里切出最外层 JSON 数组（容忍 ```json 围栏与前后解释） */
export function extractJsonArray(text: string): string {
  const s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim()
  const start = s.indexOf('[')
  const end = s.lastIndexOf(']')
  return start >= 0 && end > start ? s.slice(start, end + 1) : s
}

/** 逐字段差异的人话（界面直接用） */
export function describeApplyReport(report: PlotApplyReport): string {
  if (report.error) return `写入失败：${report.error}（逐字段结果见下）`
  if (report.okCount === report.items.length) return `已写入 ${report.okCount} 个字段`
  if (report.okCount === 0) return '一个字段都没有写入（原因见下）'
  return `部分写入：成功 ${report.okCount} 个，跳过 ${report.skippedCount} 个（原因见下）`
}

/** 跳过原因的人话 */
export const APPLY_OUTCOME_LABEL: Record<PlotApplyItem['outcome'], string> = {
  ok: '已写入',
  'card-missing': '细纲卡已不在',
  'field-missing': '字段在当前模板里解析不到',
  'value-changed': '生成后该字段已被改动，未覆盖',
}
