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

// ============ 显式请求上下文与归属判定（3.2.0 · WQ7）============
//
// 方案 §11（第 118 行）：
//   「Q7 的请求上下文显式携带 `projectId/taskId/stepId/callId`；每次装配直接返回本次
//    `contextSnapshot`，账本按 ID 关联。**弃用全局「最近一次装配/当前运行任务」作为归属依据**；
//    原接口可保留兼容包装，但不能参与新链路的审阅依据判定。」
//
// 本节就是这条规则的**唯一实现**：给定「谁在线」+「这次调用自报的上下文」，
// 判定这次调用的 usage 记到哪个任务账上；判不出来就**如实说判不出来**，绝不猜。

/**
 * 一次调用的请求上下文（由调用方显式携带）。
 *
 * 🔴 `callId` 缺省由 `chat()` 生成 —— 调用方不必为\"每个调用一个唯一 id\"操心，
 *    但**必须**在能拿到 `taskId` 时传上来，否则这次调用只能走兼容归属（或判为未归属）。
 */
export interface CallRequestContext {
  /** 项目 ID；显式 `null` 表示「全局服务调用，不属于任何小说」（§11 第 871 行） */
  projectId?: string | null
  /** 任务 ID ＝ 运行账本的 run id */
  taskId?: string
  /** 步骤 ID（同一任务内的第几步，便于复盘定位） */
  stepId?: string
  /** 本次调用 ID（缺省由 `chat()` 生成） */
  callId?: string
  /** 任务类型（如 `creative` / `rewrite` / `ghost` / `tavern`） */
  taskType?: string
  /**
   * 作用域：
   *  - `project`：属于某个项目（默认）
   *  - `global`：全局服务（连通性测试等），**不塞进当前打开的小说**
   *  - `independent`：无父任务的独立调用（编辑器伴写 / 酒馆自由对话），
   *    **永不**归属到正在运行的任务上（§13.2「一个无父任务调用」）
   */
  scope?: 'project' | 'global' | 'independent'
}

/** 在线任务（账本登记的一条运行记录）在归属判定里的可见信息 */
export interface ActiveRunAttribution {
  runId: string
  projectId: string
  taskType?: string
  contextId?: string
}

/** 归属失败的原因码（界面据此说人话，不显示码本身） */
export type AttributionMissReason =
  | 'no-active-run'
  | 'unknown-task'
  | 'ambiguous-multiple-runs'
  | 'project-mismatch'
  | 'independent-call'

export type CallAttribution =
  | {
    kind: 'run'
    runId: string
    /**
     * 判定途径。
     * 🔴 `legacy-single-run` 是**兼容路径**（调用方还没传 taskId，且当时只有一个任务在跑）。
     *    它计入用量统计没问题，但**不得**作为「候选该归谁」这类审阅依据 —— 与方案第 118 行一致。
     */
    via: 'task-id' | 'legacy-single-run'
  }
  | { kind: 'none'; reason: AttributionMissReason; detail: string }

const MISS_DETAIL: Record<AttributionMissReason, string> = {
  'no-active-run': '没有正在运行的任务，这次调用不计入任何任务账',
  'unknown-task': '调用自报的任务已不在运行（可能刚结束），这次调用不计入任何任务账',
  'ambiguous-multiple-runs': '同时有多个任务在运行，而这次调用没有自报任务 ID，无法判定归属',
  'project-mismatch': '调用所属项目与在跑任务的项目不一致，不并入当前任务的账',
  'independent-call': '这是一次独立调用（无父任务），不计入在跑任务的账',
}

/**
 * 判定一次调用的归属。
 *
 * 判定顺序（每一步都有明确理由，不靠\"最近一个\"）：
 *  ① 自报 `scope: independent/global` ⇒ 永不归属任务；
 *  ② 自报 `taskId` ⇒ 精确匹配；匹配不到就判未归属（**不**退化为\"反正只有一个任务\"）；
 *  ③ 没自报 `taskId`：只有**恰好一个**任务在跑才走兼容归属；多个在跑判歧义（宁缺勿错）；
 *  ④ 任何一条路径都校验 `projectId`：对不上就判未归属（切项目不改归属）。
 */
export function resolveCallAttribution(
  active: readonly ActiveRunAttribution[],
  ctx?: CallRequestContext,
): CallAttribution {
  const scope = ctx?.scope
  if (scope === 'independent' || scope === 'global') {
    return { kind: 'none', reason: 'independent-call', detail: MISS_DETAIL['independent-call'] }
  }

  const wantProject = typeof ctx?.projectId === 'string' && ctx.projectId ? ctx.projectId : null
  const projectOk = (run: ActiveRunAttribution): boolean => wantProject === null || run.projectId === wantProject

  // ② 显式 taskId
  const taskId = ctx?.taskId
  if (taskId) {
    const hit = active.find(r => r.runId === taskId)
    if (!hit) return { kind: 'none', reason: 'unknown-task', detail: MISS_DETAIL['unknown-task'] }
    if (!projectOk(hit)) {
      return { kind: 'none', reason: 'project-mismatch', detail: MISS_DETAIL['project-mismatch'] }
    }
    return { kind: 'run', runId: hit.runId, via: 'task-id' }
  }

  // ③ 没自报：仅唯一任务可兼容归属
  if (active.length === 0) {
    return { kind: 'none', reason: 'no-active-run', detail: MISS_DETAIL['no-active-run'] }
  }
  if (active.length > 1) {
    return {
      kind: 'none', reason: 'ambiguous-multiple-runs',
      detail: MISS_DETAIL['ambiguous-multiple-runs'],
    }
  }
  const only = active[0]
  if (!projectOk(only)) {
    return { kind: 'none', reason: 'project-mismatch', detail: MISS_DETAIL['project-mismatch'] }
  }
  return { kind: 'run', runId: only.runId, via: 'legacy-single-run' }
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
