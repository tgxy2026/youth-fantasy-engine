// ============ WQ7 调用与提示词追踪 · 请求归属与账本 ============
// 2026-10-20 · 方案 §11 / WQ7
//
// 🔴 本文件是纯业务逻辑，不 import 任何 UI。
//    它负责：
//    ① 并行归属（任务/项目/上下文）
//    ② 真实 usage 记录
//    ③ 任务上下文快照
//    ④ 提示词摘要与可选复盘材料

// ============ 请求归属 ============
export interface RequestAttribution {
  /** 请求 ID */
  requestId: string
  /** 任务 ID */
  jobId?: string
  /** 项目 ID */
  projectId: string
  /** 上下文 ID（如章节 ID、检查项 ID） */
  contextId?: string
  /** 任务类型 */
  taskType?: string
  /** 窗口 ID（多窗口并行） */
  windowId?: string
  /** 开始时间 */
  startedAt: number
  /** 结束时间 */
  finishedAt?: number
}

// ============ Usage 记录 ============
export interface UsageRecord {
  /** 请求 ID */
  requestId: string
  /** 模型 ID */
  modelId: string
  /** 输入 token 数 */
  inputTokens: number
  /** 输出 token 数 */
  outputTokens: number
  /** 总 token 数 */
  totalTokens: number
  /** 输入字符数 */
  inputChars: number
  /** 输出字符数 */
  outputChars: number
  /** 耗时（毫秒） */
  durationMs: number
  /** 记录时间 */
  recordedAt: number
}

// ============ 任务上下文快照 ============
export interface TaskContextSnapshot {
  /** 快照 ID */
  snapshotId: string
  /** 请求 ID */
  requestId: string
  /** 任务 ID */
  jobId?: string
  /** 上下文摘要（截断到 500 字符） */
  contextSummary: string
  /** 提示词摘要（截断到 200 字符） */
  promptSummary: string
  /** 材料清单 */
  materials: string[]
  /** 权限快照 */
  permissions: {
    canRead: boolean
    canWrite: boolean
    fields: string[]
  }
  /** 快照时间 */
  snapshotAt: number
}

// ============ 提示词摘要 ============
export interface PromptSummary {
  /** 系统提示词摘要 */
  systemSummary: string
  /** 用户提示词摘要 */
  userSummary: string
  /** 工具调用摘要 */
  toolCalls: string[]
  /** 总 token 数（估算） */
  estimatedTokens: number
}

/** 生成提示词摘要 */
export function summarizePrompt(
  systemPrompt: string,
  userPrompt: string,
  toolCalls: string[] = [],
): PromptSummary {
  const truncate = (s: string, max: number) =>
    s.length > max ? s.slice(0, max) + '…' : s

  // 简单 token 估算：中文 1 token/1.5 字符，英文 1 token/4 字符
  const estimateTokens = (s: string): number => {
    const chinese = (s.match(/[\u4e00-\u9fff]/g) || []).length
    const english = s.replace(/[\u4e00-\u9fff]/g, '').length
    return Math.round(chinese / 1.5 + english / 4)
  }

  return {
    systemSummary: truncate(systemPrompt, 200),
    userSummary: truncate(userPrompt, 200),
    toolCalls,
    estimatedTokens: estimateTokens(systemPrompt) + estimateTokens(userPrompt),
  }
}

// ============ 并行归属检查 ============
export interface ParallelCheckResult {
  /** 是否可并行 */
  canParallel: boolean
  /** 冲突项 */
  conflicts: string[]
  /** 建议 */
  suggestion?: string
}

/** 检查是否可并行（同一任务/项目/窗口的冲突） */
export function checkParallelAttribution(
  existing: RequestAttribution[],
  newRequest: Omit<RequestAttribution, 'startedAt'>,
): ParallelCheckResult {
  const conflicts: string[] = []

  for (const e of existing) {
    // 同一任务不能并行
    if (e.jobId && newRequest.jobId && e.jobId === newRequest.jobId) {
      conflicts.push(`同一任务 ${e.jobId} 不能并行`)
    }
    // 同一窗口不能并行
    if (e.windowId && newRequest.windowId && e.windowId === newRequest.windowId) {
      conflicts.push(`同一窗口 ${e.windowId} 不能并行`)
    }
    // 同一上下文（如章节）不能并行
    if (e.contextId && newRequest.contextId && e.contextId === newRequest.contextId) {
      conflicts.push(`同一上下文 ${e.contextId} 不能并行`)
    }
  }

  return {
    canParallel: conflicts.length === 0,
    conflicts,
    suggestion: conflicts.length > 0 ? '请等待当前请求完成或使用不同窗口' : undefined,
  }
}

// ============ Usage 聚合 ============
export interface UsageAggregate {
  /** 总输入 token */
  totalInputTokens: number
  /** 总输出 token */
  totalOutputTokens: number
  /** 总 token */
  totalTokens: number
  /** 总耗时（毫秒） */
  totalDurationMs: number
  /** 请求数 */
  requestCount: number
  /** 模型分布 */
  modelDistribution: Record<string, number>
}

/** 聚合 usage 记录 */
export function aggregateUsage(records: UsageRecord[]): UsageAggregate {
  const modelDistribution: Record<string, number> = {}

  for (const r of records) {
    modelDistribution[r.modelId] = (modelDistribution[r.modelId] || 0) + 1
  }

  return {
    totalInputTokens: records.reduce((sum, r) => sum + r.inputTokens, 0),
    totalOutputTokens: records.reduce((sum, r) => sum + r.outputTokens, 0),
    totalTokens: records.reduce((sum, r) => sum + r.totalTokens, 0),
    totalDurationMs: records.reduce((sum, r) => sum + r.durationMs, 0),
    requestCount: records.length,
    modelDistribution,
  }
}

// ============ 复盘材料 ============
export interface ReviewMaterial {
  /** 材料 ID */
  materialId: string
  /** 类型 */
  type: 'prompt' | 'response' | 'context' | 'usage' | 'error'
  /** 内容摘要 */
  summary: string
  /** 完整内容（可选） */
  content?: string
  /** 创建时间 */
  createdAt: number
}

/** 生成复盘材料 */
export function generateReviewMaterials(
  requestId: string,
  promptSummary: PromptSummary,
  usage: UsageRecord,
  response: string,
  error?: string,
): ReviewMaterial[] {
  const materials: ReviewMaterial[] = []
  const now = Date.now()

  materials.push({
    materialId: `${requestId}-prompt`,
    type: 'prompt',
    summary: `系统: ${promptSummary.systemSummary} | 用户: ${promptSummary.userSummary}`,
    createdAt: now,
  })

  materials.push({
    materialId: `${requestId}-usage`,
    type: 'usage',
    summary: `输入 ${usage.inputTokens} tokens, 输出 ${usage.outputTokens} tokens, 耗时 ${usage.durationMs}ms`,
    createdAt: now,
  })

  if (error) {
    materials.push({
      materialId: `${requestId}-error`,
      type: 'error',
      summary: error,
      createdAt: now,
    })
  } else {
    materials.push({
      materialId: `${requestId}-response`,
      type: 'response',
      summary: response.slice(0, 200),
      content: response,
      createdAt: now,
    })
  }

  return materials
}

// ============ 请求去重 ============
export interface DedupKeyResult {
  /** 去重键 */
  dedupKey: string
  /** 是否可去重 */
  canDeduplicate: boolean
  /** 过期时间 */
  expiresAt: number
}

/** 生成请求去重键 */
export function generateDedupKey(
  jobId: string | undefined,
  taskType: string | undefined,
  contextId: string | undefined,
  promptHash: string,
  ttlMs: number = 5 * 60 * 1000,
): DedupKeyResult {
  const keyParts = [
    jobId ?? 'no-job',
    taskType ?? 'no-type',
    contextId ?? 'no-context',
    promptHash,
  ]
  const dedupKey = keyParts.join('|')

  return {
    dedupKey,
    canDeduplicate: !!(jobId && taskType),
    expiresAt: Date.now() + ttlMs,
  }
}
