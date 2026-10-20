// ============ A2 细纲与实际正文对照 · 计划比较 ============
// 2026-10-20 · 方案 §5.2 / A2 (P1)
//
// 🔴 本文件是纯业务逻辑，不 import 任何 UI。
//    它负责：
//    ① 计划字段存在性校验
//    ② 正文引文定位
//    ③ 完成情况判定
//    ④ 额外变化检测

// ============ 完成情况 ============
export type PlanCompletionStatus =
  | 'completed'      // 已体现
  | 'partial'        // 部分体现
  | 'not-found'      // 未找到体现
  | 'different'      // 与计划不同
  | 'insufficient'   // 证据不足

// ============ 计划比较结果 ============
export interface PlanCompareResult {
  /** 计划字段 ID */
  planFieldId: string
  /** 模板版本 */
  templateVersion: string
  /** 计划原文 */
  planQuote: string
  /** 完成情况 */
  status: PlanCompletionStatus
  /** 正文引文列表 */
  bodyQuotes: string[]
  /** 原因 */
  reason: string
  /** 建议 */
  suggestion?: string
  /** 段号列表 */
  paragraphIndices: number[]
}

// ============ 计划比较汇总 ============
export interface PlanCompareSummary {
  /** 总计划项 */
  total: number
  /** 已完成 */
  completed: number
  /** 部分完成 */
  partial: number
  /** 未找到 */
  notFound: number
  /** 与计划不同 */
  different: number
  /** 证据不足 */
  insufficient: number
  /** 额外变化 */
  extraChanges: string[]
}

/** 校验计划字段存在性 */
export function validatePlanField(
  planFieldId: string,
  templateFields: string[],
  allowedToRead: boolean,
): { ok: boolean; error?: string } {
  if (!templateFields.includes(planFieldId)) {
    return { ok: false, error: `计划字段 ${planFieldId} 不在当前模板中` }
  }
  if (!allowedToRead) {
    return { ok: false, error: `计划字段 ${planFieldId} 不允许参考` }
  }
  return { ok: true }
}

/** 在正文中定位引文（逐字命中，返回段号） */
export function locatePlanQuote(quote: string, bodyText: string): { located: boolean; paragraphIndices: number[] } {
  if (!quote || !bodyText) {
    return { located: false, paragraphIndices: [] }
  }

  const indices: number[] = []
  let searchFrom = 0
  let idx = bodyText.indexOf(quote, searchFrom)

  while (idx >= 0) {
    const before = bodyText.slice(0, idx)
    const paragraphIndex = before.split('\n').length - 1
    indices.push(paragraphIndex)
    searchFrom = idx + quote.length
    idx = bodyText.indexOf(quote, searchFrom)
  }

  return {
    located: indices.length > 0,
    paragraphIndices: indices,
  }
}

/** 判定完成情况 */
export function determineCompletionStatus(
  planQuote: string,
  bodyQuotes: string[],
  partialThreshold: number = 0.5,
): PlanCompletionStatus {
  if (bodyQuotes.length === 0) {
    return 'not-found'
  }

  // 检查是否与计划不同
  const exactMatch = bodyQuotes.some(q => q === planQuote)
  if (!exactMatch) {
    return 'different'
  }

  // 检查是否部分体现
  const matchRatio = bodyQuotes.length / Math.max(1, planQuote.length)
  if (matchRatio < partialThreshold) {
    return 'partial'
  }

  return 'completed'
}

/** 执行计划比较 */
export function comparePlanWithBody(
  planFieldId: string,
  templateVersion: string,
  planQuote: string,
  bodyText: string,
  allowedToRead: boolean,
  templateFields: string[],
): PlanCompareResult {
  // 校验计划字段
  const fieldCheck = validatePlanField(planFieldId, templateFields, allowedToRead)
  if (!fieldCheck.ok) {
    return {
      planFieldId,
      templateVersion,
      planQuote,
      status: 'insufficient',
      bodyQuotes: [],
      reason: fieldCheck.error ?? '字段校验失败',
      paragraphIndices: [],
    }
  }

  // 定位正文引文
  const locate = locatePlanQuote(planQuote, bodyText)
  const bodyQuotes = locate.located ? [planQuote] : []

  // 判定完成情况
  const status = determineCompletionStatus(planQuote, bodyQuotes)

  // 生成建议
  let suggestion: string | undefined
  switch (status) {
    case 'completed':
      suggestion = '计划已体现，无需修改'
      break
    case 'partial':
      suggestion = '计划部分体现，建议补充'
      break
    case 'not-found':
      suggestion = '计划未体现，建议添加或调整'
      break
    case 'different':
      suggestion = '正文与计划不同，需确认是否保留原计划'
      break
    case 'insufficient':
      suggestion = '证据不足，需人工确认'
      break
  }

  return {
    planFieldId,
    templateVersion,
    planQuote,
    status,
    bodyQuotes,
    reason: status === 'completed' ? '计划已体现' : '计划未完全体现',
    suggestion,
    paragraphIndices: locate.paragraphIndices,
  }
}

/** 检测正文新增但计划未列出的关键变化 */
export function detectExtraChanges(
  bodyText: string,
  planQuotes: string[],
  minLength: number = 10,
): string[] {
  const extra: string[] = []
  const sentences = bodyText.split(/[。！？\n]/).filter(s => s.trim().length >= minLength)

  for (const s of sentences) {
    const isPlanned = planQuotes.some(p => p.includes(s) || s.includes(p))
    if (!isPlanned) {
      extra.push(s.trim().slice(0, 50))
    }
  }

  return extra.slice(0, 10) // 最多 10 条
}

/** 生成计划比较汇总 */
export function summarizePlanCompare(results: PlanCompareResult[], extraChanges: string[]): PlanCompareSummary {
  return {
    total: results.length,
    completed: results.filter(r => r.status === 'completed').length,
    partial: results.filter(r => r.status === 'partial').length,
    notFound: results.filter(r => r.status === 'not-found').length,
    different: results.filter(r => r.status === 'different').length,
    insufficient: results.filter(r => r.status === 'insufficient').length,
    extraChanges,
  }
}
