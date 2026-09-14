/**
 * 酒馆模式 · 上下文预算与裁剪
 *
 * 设计依据：方案 §4.3。
 *
 * 【固定开销】协议 ≈1200 + 格式提醒 ≈200 + 记忆 ≤1200 ≈ 2600 字；
 * 剩余额度给「②层设定 + 对话历史」。
 *
 * 【预算不足时的裁剪顺序（从先裁到后裁）】
 *   1. **对话历史最早的轮次** —— 优先裁这里：早期对话已被记忆吸收，丢掉不心疼
 *   2. ②层里优先级最低的设定段 —— 沿用 buildProjectContext 的 dropped 机制，UI 提示作者
 *   3. ③层记忆的「长期摘要」压缩 —— **绝不裁**「关键事实」与「未爆的雷」
 * ★ 首轮开场**永不裁剪**（它定义了这个场景的起点）。
 *
 * 本文件是纯逻辑，不含 React。
 */
import type { TavernMessage } from './types'

/** 固定开销估算（协议 + 格式提醒 + 记忆上限） */
export const FIXED_OVERHEAD_CHARS = 2600

export function textLen(s: string | undefined): number {
  return s ? s.length : 0
}

export function messagesLen(msgs: TavernMessage[]): number {
  return msgs.reduce((n, m) => n + textLen(m.content), 0)
}

export type TrimResult = {
  kept: TavernMessage[]
  /** 被裁掉的条数（用于 UI 提示「这一场已很长」） */
  dropped: number
}

/**
 * 裁剪对话历史到预算之内。
 * 从最早的开始丢，**但首条（开场）始终保留**——否则模型会失去场景起点。
 */
export function trimHistory(messages: TavernMessage[], budgetChars: number): TrimResult {
  if (messages.length === 0) return { kept: [], dropped: 0 }
  if (budgetChars <= 0) return { kept: [messages[0]], dropped: messages.length - 1 }

  const first = messages[0]
  let rest = messages.slice(1)
  let used = textLen(first.content) + messagesLen(rest)
  let dropped = 0

  while (used > budgetChars && rest.length > 0) {
    used -= textLen(rest[0].content)
    rest = rest.slice(1)
    dropped++
  }

  return { kept: [first, ...rest], dropped }
}

export type BudgetState = { used: number; total: number; pct: number }

/** 供 UI 画占用条 */
export function budgetState(used: number, total: number): BudgetState {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
  return { used, total, pct }
}

/**
 * 算出「留给对话历史」的额度 = 总预算 − 固定开销 − ②层设定 − ③层记忆。
 * 结果下限为 0（额度不足时只保留开场）。
 */
export function historyBudget(total: number, setting: string, memory: string): number {
  return Math.max(0, total - FIXED_OVERHEAD_CHARS - textLen(setting) - textLen(memory))
}
