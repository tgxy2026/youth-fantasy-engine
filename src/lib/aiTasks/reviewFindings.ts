// ============ WQ1 结果状态治理 · 检查状态治理 ============
// 2026-10-20 · 方案 §11 / WQ1
//
// 🔴 本文件是纯业务逻辑，不 import 任何 UI。
//    它负责：
//    ① Q1 通用解析回执（统一检查结果状态）
//    ② 检查覆盖率（已检/未检统计）
//    ③ 自检失败处置（解析失败时的降级策略）
//    ④ 检查结果聚合与汇总

import type { TaskResult } from '@/lib/revision/revisionTypes'
import { parseObjectArrayDetailed } from '@/lib/ai/aiParse'

// ============ 检查项状态 ============
export type CheckItemStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

// ============ 检查项结果 ============
export interface CheckItemResult {
  /** 检查项 ID */
  id: string
  /** 检查项名称 */
  name: string
  /** 状态 */
  status: CheckItemStatus
  /** 发现的问题数 */
  findings: number
  /** 严重问题数 */
  critical: number
  /** 错误信息（failed 时） */
  error?: string
  /** 完成时间 */
  finishedAt?: number
}

// ============ 检查汇总 ============
export interface CheckSummary {
  /** 总检查项数 */
  total: number
  /** 已完成 */
  done: number
  /** 失败 */
  failed: number
  /** 跳过 */
  skipped: number
  /** 总问题数 */
  totalFindings: number
  /** 严重问题数 */
  criticalFindings: number
  /** 覆盖率（已完成 / 总项） */
  coverage: number
  /** 是否全部通过 */
  allPassed: boolean
}

// ============ Q1 通用解析回执 ============
/** 统一处理检查结果解析，返回标准化的 CheckItemResult 数组 */
export function processCheckResults(
  raw: string,
  defaultId: string,
): CheckItemResult[] {
  const parsed = parseObjectArrayDetailed(raw)

  if (parsed.outcome === 'invalid') {
    return [
      {
        id: defaultId,
        name: defaultId,
        status: 'failed',
        findings: 0,
        critical: 0,
        error: '解析失败：模型返回无法解析为 JSON',
        finishedAt: Date.now(),
      },
    ]
  }

  // 🔴 `parsed.data` 是 `Record<string, unknown>[]`（模型输出不可信）：
  //    每个字段都得先收窄再用，不能靠泛型假设它是 string。
  return parsed.data.map((item, idx) => {
    const id = typeof item.id === 'string' && item.id ? item.id : `${defaultId}-${idx}`
    const name = typeof item.name === 'string' && item.name ? item.name : id
    const level = typeof item.level === 'string' ? item.level : '提示'
    const findings = typeof item.findings === 'number' ? item.findings : 1
    const critical = typeof item.critical === 'number'
      ? item.critical
      : (level === '严重' ? 1 : 0)
    return {
      id,
      name,
      status: 'done' as const,
      findings,
      critical,
      finishedAt: Date.now(),
    }
  })
}

// ============ 检查覆盖率 ============
/** 计算检查覆盖率 */
export function calculateCoverage(results: CheckItemResult[]): CheckSummary {
  const total = results.length
  const done = results.filter(r => r.status === 'done').length
  const failed = results.filter(r => r.status === 'failed').length
  const skipped = results.filter(r => r.status === 'skipped').length
  const totalFindings = results.reduce((sum, r) => sum + r.findings, 0)
  const criticalFindings = results.reduce((sum, r) => sum + r.critical, 0)
  const coverage = total > 0 ? done / total : 0
  const allPassed = failed === 0 && criticalFindings === 0

  return {
    total,
    done,
    failed,
    skipped,
    totalFindings,
    criticalFindings,
    coverage,
    allPassed,
  }
}

// ============ 自检失败处置 ============
/** 自检失败时的降级策略 */
export interface SelfCheckFallback {
  /** 是否启用降级 */
  enabled: boolean
  /** 降级原因 */
  reason: string
  /** 降级后的结果 */
  fallbackResult: CheckItemResult[]
  /** 是否应重试 */
  shouldRetry: boolean
}

/** 处理解析失败，返回降级策略 */
export function handleParseFailure<T>(
  parsed: TaskResult<T>,
  defaultId: string,
  retryable: boolean = true,
): SelfCheckFallback {
  if (parsed.outcome !== 'invalid') {
    return {
      enabled: false,
      reason: '',
      fallbackResult: [],
      shouldRetry: false,
    }
  }

  const fallback: CheckItemResult[] = [
    {
      id: defaultId,
      name: defaultId,
      status: 'failed',
      findings: 0,
      critical: 0,
      error: '解析失败：模型返回无法解析为 JSON',
      finishedAt: Date.now(),
    },
  ]

  // 判断是否可重试（截断/修复后成功可重试）
  const shouldRetry = retryable && parsed.truncated

  return {
    enabled: true,
    reason: parsed.truncated ? '输出被截断，可重试' : '输出格式错误，不可重试',
    fallbackResult: fallback,
    shouldRetry,
  }
}

// ============ 检查结果聚合 ============
/** 聚合多个检查项的结果 */
export function aggregateCheckResults(
  results: CheckItemResult[],
): { passed: CheckItemResult[]; failed: CheckItemResult[] } {
  const passed = results.filter(r => r.status === 'done' && r.critical === 0)
  const failed = results.filter(r => r.status === 'failed' || r.critical > 0)
  return { passed, failed }
}

// ============ 检查结果格式化 ============
/** 格式化检查结果为人类可读文本 */
export function formatCheckSummary(summary: CheckSummary): string {
  const parts: string[] = [
    `检查完成：${summary.done}/${summary.total} 项`,
    `覆盖率 ${(summary.coverage * 100).toFixed(0)}%`,
  ]

  if (summary.totalFindings > 0) {
    parts.push(`发现 ${summary.totalFindings} 个问题`)
    if (summary.criticalFindings > 0) {
      parts.push(`其中 ${summary.criticalFindings} 个严重`)
    }
  }

  if (summary.failed > 0) {
    parts.push(`${summary.failed} 项失败`)
  }

  if (summary.allPassed) {
    parts.push('✅ 全部通过')
  } else {
    parts.push('❌ 存在需处理项')
  }

  return parts.join('，')
}

// ============ 检查结果持久化准备 ============
/** 将检查结果转换为可持久化的格式 */
export function serializeCheckResults(results: CheckItemResult[]): string {
  return JSON.stringify(results)
}

/** 从持久化格式恢复检查结果 */
export function deserializeCheckResults(json: string): CheckItemResult[] {
  // 🔴 走 aiParse（结构闸 ④）：本地存档同样可能被截断/改坏，修一次比整份丢弃好。
  const parsed = parseObjectArrayDetailed(json)
  if (parsed.outcome === 'invalid') return []
  return parsed.data as unknown as CheckItemResult[]
}
