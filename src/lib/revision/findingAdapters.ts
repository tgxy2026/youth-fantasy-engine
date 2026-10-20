// ============ W4 AI 工单接线 · 证据适配 ============
// 2026-10-20 · 方案 §7.2 / §9.1
//
// 🔴 本文件是纯业务逻辑，不 import 任何 UI。
//    它负责：
//    ① 将现有 AI 结果归一到工单扩展结构
//    ② 保留原报告来源
//    ③ 证据定位与摘要
//    ④ 去重键生成

import type { TicketItem, TicketSource } from '@/lib/app/optimizeTicket'
import type { RevisionSubmitReceipt } from './jobTypes'
import type { RevisionCandidate } from './revisionCandidate'
import type { ContinuityFinding } from '@/lib/aiTasks/audit'
import type { IssueSeverity } from '@/lib/audit/audit'

/**
 * 模型 severity 词表 → 审计统一词表。
 *
 * 🔴 模型吐的是「严重/中等/提示」，审计侧统一用 `IssueSeverity`（error/warn/info）。
 *    这里做**唯一一次**映射：两套词表各活各的，下游徽标/筛选就会漏判
 *    （原先自造 'medium' 就是这么漏的）。
 */
function severityOf(level: unknown): IssueSeverity {
  const s = typeof level === 'string' ? level.trim().toLowerCase() : ''
  if (s === '严重' || s === 'high' || s === 'error') return 'error'
  if (s === '中等' || s === 'medium' || s === 'warn') return 'warn'
  return 'info'
}

// ============ 扩展工单条目（W4 新增字段） ============
export interface TicketEvidence {
  /** 引文内容（必须在本次正文快照内逐字命中） */
  quote: string
  /** 段号（由本地计算） */
  paragraphIndex?: number
  /** 来源字段 ID */
  fieldId?: string
  /** 模板依据 */
  templateBasis?: string
  /** 是否可定位 */
  located: boolean
}

export interface ExtendedTicketItem extends TicketItem {
  /** 原报告 ID（保留来源） */
  originReportId?: string
  /** 证据列表 */
  evidence?: TicketEvidence[]
  /** 依据（模板语义摘要） */
  basis?: string
  /** 能力快照（检查时的模型能力） */
  capabilitySnapshot?: {
    modelId: string
    jsonOutput: boolean
    thinking: boolean
    timestamp: number
  }
  /** 处置状态 */
  disposition?: 'pending' | 'accepted' | 'rejected' | 'needs-review'
  /** 可执行原因 */
  runnableReason?: string
  /** 候选 ID（关联 W3 候选） */
  candidateId?: string
  /** 提交回执（应用后写入） */
  receipt?: RevisionSubmitReceipt
}

// ============ 去重键 ============
/** 去重键：章 ID + 来源 + 定位证据摘要 + 问题类别 */
export function ticketDedupKey(item: ExtendedTicketItem): string {
  if (item.evidence && item.evidence.length > 0) {
    const evidenceSummary = item.evidence
      .filter(e => e.located)
      .map(e => e.quote.slice(0, 20))
      .join('|')
    return `${item.chapterId}|${item.source}|${item.title}|${evidenceSummary}`
  }
  // 无证据文本才退回旧标题规则
  return `${item.chapterId}|${item.source}|${item.title}`
}

// ============ 证据定位 ============
export interface EvidenceLocateResult {
  /** 是否定位成功 */
  located: boolean
  /** 段号 */
  paragraphIndex?: number
  /** 命中的引文 */
  matchedQuote?: string
}

/** 在正文中定位引文（逐字命中） */
export function locateEvidence(quote: string, bodyText: string): EvidenceLocateResult {
  if (!quote || !bodyText) {
    return { located: false }
  }
  const idx = bodyText.indexOf(quote)
  if (idx < 0) {
    return { located: false }
  }
  // 计算段号（按换行符分割）
  const before = bodyText.slice(0, idx)
  const paragraphIndex = before.split('\n').length - 1
  return {
    located: true,
    paragraphIndex,
    matchedQuote: quote,
  }
}

// ============ 从 ContinuityFinding 构建扩展工单条目 ============
export function fromContinuityFinding(
  finding: ContinuityFinding,
  chapterId: string,
  chapterTitle: string,
  chapterNo: number,
  bodyText: string,
  source: TicketSource = 'continuity',
): ExtendedTicketItem {
  const locate = locateEvidence(finding.where, bodyText)
  const evidence: TicketEvidence[] = locate.located
    ? [{
        quote: locate.matchedQuote ?? finding.where,
        paragraphIndex: locate.paragraphIndex,
        located: true,
      }]
    : [{
        quote: finding.where,
        located: false,
      }]

  return {
    id: `${chapterId}|${source}|${finding.title}`,
    chapterId,
    chapterTitle,
    chapterNo,
    source,
    severity: severityOf(finding.level),
    title: finding.title,
    detail: finding.detail,
    action: 'manual',
    status: 'pending',
    evidence,
    basis: finding.where,
    disposition: 'pending',
  }
}

// ============ 从候选构建扩展工单条目 ============
export function fromCandidate(
  candidate: RevisionCandidate,
  chapterId: string,
  chapterTitle: string,
  chapterNo: number,
  bodyText: string,
): ExtendedTicketItem {
  const locate = locateEvidence(candidate.summary, bodyText)
  const evidence: TicketEvidence[] = locate.located
    ? [{
        quote: locate.matchedQuote ?? candidate.summary,
        paragraphIndex: locate.paragraphIndex,
        located: true,
      }]
    : [{
        quote: candidate.summary,
        located: false,
      }]

  return {
    id: `candidate-${candidate.id}`,
    chapterId,
    chapterTitle,
    chapterNo,
    source: 'ai-review',
    // 🔴 用审计那边**已有**的严重度词表（error/warn/info）：
    //    自造 'medium' 不在枚举里，下游徽标/筛选会直接漏判。
    severity: 'warn',
    title: candidate.summary,
    detail: candidate.text.slice(0, 200),
    action: 'polish',
    status: 'pending',
    evidence,
    originReportId: candidate.id,
    candidateId: candidate.id,
    receipt: candidate.receipt,
    disposition: 'pending',
  }
}

// ============ 能力缺项报告 ============
export interface CapabilityGapReport {
  /** 是否缺项 */
  hasGaps: boolean
  /** 缺项列表 */
  gaps: string[]
  /** 建议 */
  suggestions: string[]
}

/** 检查工单条目所需能力是否满足 */
export function reportCapabilityGaps(
  items: ExtendedTicketItem[],
  modelId: string,
  jsonOutput: boolean,
  thinking: boolean,
): CapabilityGapReport {
  const gaps: string[] = []
  const suggestions: string[] = []
  // 🔴 模型能力不足时把模型名写进建议：作者需要知道"换个模型能解决"还是"本模型也能做"
  if (!modelId) gaps.push('未指定模型，无法判定能力缺项')

  // 检查是否需要 JSON 输出
  const needsJson = items.some(i => i.source === 'ai-review' || i.source === 'ai-ooc')
  if (needsJson && !jsonOutput) {
    gaps.push('jsonOutput')
    suggestions.push('当前模型不支持 JSON 输出，将降级为文本+后解析')
  }

  // 检查是否需要思考模式
  const needsThinking = items.some(i => i.source === 'ai-ooc' || i.source === 'ai-pleasure')
  if (needsThinking && !thinking) {
    gaps.push('thinking')
    suggestions.push('当前模型不支持思考模式，将降级为普通模式')
  }

  // 检查是否需要定位证据
  const needsEvidence = items.some(i => i.evidence?.some(e => !e.located))
  if (needsEvidence) {
    gaps.push('evidence-locate')
    suggestions.push('部分引文无法定位，需人工确认或重新生成')
  }

  return {
    hasGaps: gaps.length > 0,
    gaps,
    suggestions,
  }
}

// ============ 去重（跨来源相似问题显示为同一章的一组） ============
export function dedupExtendedItems(items: ExtendedTicketItem[]): ExtendedTicketItem[] {
  const seen = new Set<string>()
  const out: ExtendedTicketItem[] = []

  for (const item of items) {
    const key = ticketDedupKey(item)
    if (!seen.has(key)) {
      seen.add(key)
      out.push(item)
    }
  }

  return out
}

// ============ 按来源、章、严重度筛选 ============
export interface TicketFilter {
  sources?: TicketSource[]
  chapterIds?: string[]
  severities?: IssueSeverity[]
  onlyRunnable?: boolean
}

export function filterItems(items: ExtendedTicketItem[], filter: TicketFilter): ExtendedTicketItem[] {
  return items.filter(item => {
    if (filter.sources && !filter.sources.includes(item.source)) return false
    if (filter.chapterIds && !filter.chapterIds.includes(item.chapterId)) return false
    if (filter.severities && !filter.severities.includes(item.severity)) return false
    if (filter.onlyRunnable) {
      // 可执行：action 不是 manual 且 有已定位证据
      const hasLocatedEvidence = item.evidence?.some(e => e.located) === true
      if (item.action === 'manual' || !hasLocatedEvidence) return false
    }
    return true
  })
}
