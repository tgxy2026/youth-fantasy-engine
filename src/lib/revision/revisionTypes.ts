/**
 * 3.2.0 · MQ0 共用协议纯类型（2026-10-19 冻结）
 *
 * 来源：`docs/3.2.0-版本开发方案-2026-10-18.md` §3.1 / §3.3 / §16.2 / §16.8 / §17.1。
 * 契约文档：`docs/3.2.0-MQ0-共用协议契约-2026-10-19.md`。
 *
 * 🔴 本文件只放**类型与枚举**，禁止出现：
 *    · 运行时逻辑（函数、常量计算、模块级状态）—— 实现按 §12 落在各自业务模块；
 *    · import 业务代码（保持零依赖，任何模块都能安全引用，不成环）；
 *    · `any`（用 `unknown` 收窄，违例会被 structureGates 的 any 账本闸拦下）。
 *
 * 🔴 冻结纪律：类型一经评审冻结，变更只能「新增可选字段 / 新增枚举值」；
 *    改义、删字段、改必填性＝破坏性变更，须同步更新契约文档与所有实现方，
 *    并在提交信息里点名受影响的调用点清单。
 */

// ── 3.1 稳定引用 ──────────────────────────────────────────────

/** 业务引用统一形状：章节、细纲卡、角色卡、表格行、表单、子项 */
export interface RecordRef {
  kind: 'chapter' | 'outline' | 'card' | 'row' | 'form' | 'sub'
  projectId: string
  /** form 用逻辑页签 ID，其他用业务记录 ID */
  tabId: string
  id: string
  /** 有效模板中的稳定字段 ID；新引用使用此项 */
  fieldId?: string
  /** 仅兼容旧引用；由模板适配器解释，不能按显示文字猜 */
  fieldKey?: string
}

// ── 17.1 四个状态域（禁止合并成一个万能状态枚举） ─────────────

/** ① HTTP/流尝试：一次外部请求是否传输完、是否重试。不能直接推出业务完成 */
export type AttemptEndReason =
  | 'completed'      // 协议认可的结束标记 / 已确认 EOF 的兼容端点
  | 'cancelled'      // 作者取消（响应头后也必须中断底层 reader）
  | 'network-error'
  | 'http-error'     // HTTP 200 之后的错误事件也归这里（不当成功）
  | 'length'         // 显式 length / 未完成流
  | 'quota-exhausted'// 429 区分配额耗尽（不自动重试）
  | 'rate-limited'   // 429 暂时限流（可遵 Retry-After 重试）
  | 'unknown'        // 无 usage / 无 finishReason 的旧兼容端点

/** ② Q1 步骤结果：一项检查/生成是否有效、覆盖多少。合法空结果才算「未发现问题」 */
export type StepResultState =
  | 'completed'  // 本项完整跑完且结果有效（含合法空结果）
  | 'partial'    // 有部分有效产物/部分覆盖，缺项已记录
  | 'failed'     // 执行失败（与「检查后未发现问题」是两件事）
  | 'cancelled'  // 作者取消
  | 'skipped'    // 启动前已声明资料不足的精确子检查（始终显示未检）
  | 'incomplete' // 截断/断流/超长等不完整结束

/** ③ 持久化任务：任务能否继续执行、是否等作者处理。执行壳可已停止但仍有待审产物 */
export type TaskRunState =
  | 'running'
  | 'paused'
  | 'interrupted'
  | 'awaiting-review'
  | 'completed'
  | 'abandoned'

/** ④ 候选/提交：是否可应用、是否已持久化。正文已应用不保证问题已修复 */
export type CandidateState =
  | 'pending'
  | 'stale'           // 依赖基准已变，不可直接应用
  | 'applying'
  | 'applied'
  | 'needs-reconcile' // 主记录已写、派生台账未结清
  | 'discarded'

// ── 16.2 Q1：解析结果与执行结果 ──────────────────────────────

/** 解析层三态：合法空数组是「有效空结果」，与解析失败严格分开 */
export type ParseOutcome = 'valid' | 'repaired' | 'invalid'

export interface ParseDiagnostic {
  /** 缺字段 / 类型错误 / 截断 / 无法恢复的文本 */
  code: 'missing-field' | 'type-error' | 'truncated' | 'unrecoverable' | 'unknown-target'
  detail: string
  /** repaired 时被丢弃的条目索引；invalid 时为 undefined */
  droppedIndex?: number
}

/** 模型文本 → 结构化数据的详细结果（aiParse 扩展接口返回此形状） */
export interface TaskResult<T> {
  outcome: ParseOutcome
  data: T
  diagnostics: ParseDiagnostic[]
  /** 是否截断（与数据有效性分别记录） */
  truncated: boolean
}

/** 覆盖统计：按章和检查项记 requested/completed/failed/skipped */
export interface Coverage {
  requested: number
  completed: number
  failed: number
  skipped: number
  /** 未检子项（含资料不足声明过的）—— 摘要必须显示，不得计入完成 */
  uninspected?: string[]
}

/** 一项检查/生成的执行结果。HTTP 200 不直接等于任务完成 */
export interface StepExecutionResult<T = unknown> {
  state: StepResultState
  result?: TaskResult<T>
  coverage?: Coverage
  issues?: unknown[]
  errorCode?: string
  retryable?: boolean
  /** 来源 ID（生成器/检查器），用于跨工具分组与并列展示 */
  sourceId?: string
}

// ── 16.8 Q7：并行归属、真实用量与上下文快照 ──────────────────

/** 每次任务显式传入的关联对象；任务外单次调用也有独立 callId */
export interface RunAssociation {
  projectId: string
  taskId: string
  stepId: string
  callId: string
  attemptId: string
}

/**
 * 一次装配直接返回的快照，由当前调用接收。
 * 🔴 不在生成结束后重新读取最新记录充当「当时依据」；
 *    账本只存摘要与引用，不存完整正文与密钥。
 */
export interface ContextSnapshot {
  association: RunAssociation
  /** 实际来源引用 / 读取修订 */
  sourceRefs: Array<{ ref: RecordRef; revision?: string; summary?: string }>
  /** 包含 / 裁剪 / 遗漏范围 */
  included: string[]
  trimmed: string[]
  omitted: string[]
  /** 检索状态：hit / no-match / disabled / stale-index / unavailable / forbidden */
  retrieval: 'hit' | 'no-match' | 'disabled' | 'stale-index' | 'unavailable' | 'forbidden'
  /** 字段定义及权限依据（只存依据摘要） */
  fieldBasis?: string[]
  /** 实际模型 / 参数 / 提示词版本与用户覆盖摘要 */
  model?: string
  params?: Record<string, unknown>
  promptVersion?: string
  promptOverrideDigest?: string
  /** 输出协议与预算 */
  outputProtocol?: string
  budget?: { window: number; reservedOutput: number; materialAllowance: number }
  capturedAt: number
}

/** usage 记录：不提供的值保存 unknown，禁止填 0 或当成精确费用 */
export interface UsageRecord {
  association: RunAssociation
  service: 'chat' | 'embedding' | 'search' | 'other'
  /** 服务端返回的真实值；拿不到就是 'unknown' */
  inputTokens: number | 'unknown'
  outputTokens: number | 'unknown'
  cachedTokens?: number | 'unknown'
  reasoningTokens?: number | 'unknown'
  durationMs: number
  firstTokenMs?: number | 'unknown'
  endReason: AttemptEndReason
  /** 降级与重试各自独立计数：一次逻辑调用的第几次实际请求 */
  attemptSeq: number
  degraded: boolean
}

// ── 3.3 提交回执（候选应用侧，MQ0 只冻结形状） ─────────────────

/** 条件提交的幂等回执；同文无标记需人工核对 */
export interface CommitReceipt {
  operationId: string
  candidateId: string
  state: CandidateState
  /** 主记录（正文/字数/时间 + AI 来源统计 + 修订标识 + 提交标记）同一持久化生效 */
  mainRecordPersisted: boolean
  /** 派生台账（影响提醒等）是否已结清 */
  derivedSettled: boolean
  /** 派生失败时正文已保存的提示依据 */
  reconcileHint?: string
  committedAt: number
}
