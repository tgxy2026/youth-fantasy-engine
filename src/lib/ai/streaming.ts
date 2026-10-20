// ============ WQ6 流式与异常 · 全请求生命周期管理 ============
// 2026-10-20 · 方案 §11 / WQ6
//
// 🔴 本文件是纯业务逻辑，不 import 任何 UI。
//    它负责：
//    ① 全请求生命周期取消
//    ② 首响应/空闲超时
//    ③ 受限重试
//    ④ 部分结果保留
//    ⑤ 截断回执

import { parseLooseObject } from '@/lib/ai/aiParse'

// ============ 请求生命周期状态 ============
export type RequestLifecycleStatus =
  | 'pending'      // 等待发送
  | 'connecting'   // 连接中
  | 'first-byte'   // 首响应已到达
  | 'streaming'    // 流式输出中
  | 'completed'    // 完成
  | 'cancelled'    // 已取消
  | 'failed'       // 失败
  | 'timed-out'    // 超时

// ============ 请求生命周期 ============
export interface RequestLifecycle {
  /** 请求 ID */
  requestId: string
  /** 状态 */
  status: RequestLifecycleStatus
  /** 开始时间 */
  startedAt: number
  /** 首响应时间 */
  firstByteAt?: number
  /** 最后活动时间 */
  lastActivityAt: number
  /** 结束时间 */
  finishedAt?: number
  /** 已接收的 token 数（流式） */
  tokensReceived: number
  /** 已接收的文本（流式） */
  textReceived: string
  /** 错误信息 */
  error?: string
  /** 是否被截断 */
  truncated: boolean
  /** 重试次数 */
  retryCount: number
  /** 最大重试次数 */
  maxRetries: number
}

// ============ 超时配置 ============
export interface TimeoutConfig {
  /** 连接超时（毫秒） */
  connectTimeout: number
  /** 首响应超时（毫秒） */
  firstByteTimeout: number
  /** 空闲超时（毫秒，流式输出中无增量） */
  idleTimeout: number
  /** 总超时（毫秒） */
  totalTimeout: number
}

export const DEFAULT_TIMEOUTS: TimeoutConfig = {
  connectTimeout: 10_000,
  firstByteTimeout: 15_000,
  idleTimeout: 30_000,
  totalTimeout: 120_000,
}

// ============ 创建请求生命周期 ============
export function createLifecycle(requestId: string, maxRetries: number = 2): RequestLifecycle {
  const now = Date.now()
  return {
    requestId,
    status: 'pending',
    startedAt: now,
    lastActivityAt: now,
    tokensReceived: 0,
    textReceived: '',
    truncated: false,
    retryCount: 0,
    maxRetries,
  }
}

// ============ 状态转移 ============
export function transitionLifecycle(
  lifecycle: RequestLifecycle,
  status: RequestLifecycleStatus,
  opts?: {
    firstByteAt?: number
    error?: string
    truncated?: boolean
    text?: string
    tokens?: number
  },
): RequestLifecycle {
  const now = Date.now()
  return {
    ...lifecycle,
    status,
    lastActivityAt: now,
    ...(status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'timed-out'
      ? { finishedAt: now }
      : {}),
    ...(opts?.firstByteAt ? { firstByteAt: opts.firstByteAt } : {}),
    ...(opts?.error ? { error: opts.error } : {}),
    ...(opts?.truncated !== undefined ? { truncated: opts.truncated } : {}),
    ...(opts?.text ? { textReceived: lifecycle.textReceived + opts.text } : {}),
    ...(opts?.tokens ? { tokensReceived: lifecycle.tokensReceived + opts.tokens } : {}),
  }
}

// ============ 超时检查 ============
export interface TimeoutCheckResult {
  timedOut: boolean
  /** 超时类型 */
  timeoutType?: 'connect' | 'first-byte' | 'idle' | 'total'
  /** 剩余时间（毫秒） */
  remainingMs: number
}

export function checkTimeouts(
  lifecycle: RequestLifecycle,
  config: TimeoutConfig = DEFAULT_TIMEOUTS,
): TimeoutCheckResult {
  const now = Date.now()
  const elapsed = now - lifecycle.startedAt
  const idleElapsed = now - lifecycle.lastActivityAt

  // 总超时
  if (elapsed >= config.totalTimeout) {
    return { timedOut: true, timeoutType: 'total', remainingMs: 0 }
  }

  // 连接超时（尚未首响应）
  if (!lifecycle.firstByteAt && elapsed >= config.connectTimeout) {
    return { timedOut: true, timeoutType: 'connect', remainingMs: 0 }
  }

  // 首响应超时
  // 🔴 原先写成 `!lifecycle.status === 'streaming'`：先取反再比字符串，恒为 false，
  //    首响应超时**从来没生效过**。正确写法是 `!==`。
  if (lifecycle.firstByteAt && lifecycle.status !== 'streaming' && elapsed >= config.firstByteTimeout) {
    return { timedOut: true, timeoutType: 'first-byte', remainingMs: 0 }
  }

  // 空闲超时（流式输出中无增量）
  if (lifecycle.status === 'streaming' && idleElapsed >= config.idleTimeout) {
    return { timedOut: true, timeoutType: 'idle', remainingMs: 0 }
  }

  return {
    timedOut: false,
    remainingMs: Math.max(0, config.totalTimeout - elapsed),
  }
}

// ============ 受限重试 ============
export interface RetryDecision {
  /** 是否可重试 */
  canRetry: boolean
  /** 剩余重试次数 */
  remainingRetries: number
  /** 重试延迟（毫秒） */
  retryDelayMs: number
  /** 重试原因 */
  reason?: string
}

/** 判断是否可重试 */
export function decideRetry(lifecycle: RequestLifecycle, error: string): RetryDecision {
  const remaining = lifecycle.maxRetries - lifecycle.retryCount

  if (remaining <= 0) {
    return {
      canRetry: false,
      remainingRetries: 0,
      retryDelayMs: 0,
      reason: '已达最大重试次数',
    }
  }

  // 可重试的错误类型
  const retryableErrors = [
    'timeout',
    'network',
    'connection',
    'abort',
    'busy',
    '502',
    '503',
    '504',
  ]
  const lower = error.toLowerCase()
  const isRetryable = retryableErrors.some(e => lower.includes(e))

  if (!isRetryable) {
    return {
      canRetry: false,
      remainingRetries: remaining,
      retryDelayMs: 0,
      reason: '不可重试的错误类型',
    }
  }

  // 指数退避：1s, 2s, 4s...
  const retryDelayMs = Math.min(1000 * Math.pow(2, lifecycle.retryCount), 10_000)

  return {
    canRetry: true,
    remainingRetries: remaining,
    retryDelayMs,
  }
}

// ============ 部分结果保留 ============
export interface PartialResult<T> {
  /** 已接收的部分数据 */
  partial: T
  /** 是否被截断 */
  truncated: boolean
  /** 截断原因 */
  truncateReason?: string
}

/** 保留部分结果（截断时） */
export function preservePartialResult<T>(
  full: T,
  maxBytes: number,
  serializer: (v: T) => string,
): PartialResult<T> {
  const serialized = serializer(full)
  if (serialized.length <= maxBytes) {
    return { partial: full, truncated: false }
  }

  // 截断到最大字节数
  const truncated = serialized.slice(0, maxBytes)
  // 🔴 不许裸 `JSON.parse`（结构闸 ④）：截断产物正是"少收尾括号"的高发场景，
  //    必须走 aiParse 的修复链（补括号/清杂散标点），否则整段内容白丢。
  const repaired = parseLooseObject(truncated)
  if (repaired) {
    return {
      partial: repaired as T,
      truncated: true,
      truncateReason: `输出被截断到 ${maxBytes} 字符（已按截断规则修补）`,
    }
  }
  return {
    partial: {} as T,
    truncated: true,
    truncateReason: `输出被截断且无法解析到有效 JSON`,
  }
}

// ============ 截断回执 ============
export interface TruncateReceipt {
  /** 是否被截断 */
  truncated: boolean
  /** 截断原因 */
  reason?: string
  /** 原始长度 */
  originalLength: number
  /** 截断后长度 */
  truncatedLength: number
  /** 截断时间 */
  truncatedAt: number
}

/** 生成截断回执 */
export function createTruncateReceipt(
  original: string,
  maxBytes: number,
): TruncateReceipt {
  const truncated = original.length > maxBytes ? original.slice(0, maxBytes) : original
  return {
    truncated: original.length > maxBytes,
    reason: original.length > maxBytes ? `输出被截断到 ${maxBytes} 字符` : undefined,
    originalLength: original.length,
    truncatedLength: truncated.length,
    truncatedAt: Date.now(),
  }
}

// ============ 取消处理 ============
export interface CancelResult {
  /** 是否已取消 */
  cancelled: boolean
  /** 已保留的结果 */
  preservedResult?: unknown
  /** 取消时间 */
  cancelledAt: number
}

/** 处理取消：保留已完成的结果 */
export function handleCancellation<T>(
  lifecycle: RequestLifecycle,
  partialResult?: T,
): CancelResult {
  return {
    cancelled: lifecycle.status === 'cancelled',
    preservedResult: partialResult,
    cancelledAt: lifecycle.finishedAt ?? Date.now(),
  }
}
