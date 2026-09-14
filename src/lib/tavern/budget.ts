/**
 * 酒馆模式 · 上下文预算与裁剪
 *
 * 设计依据：方案 §4.3。
 *
 * 【固定开销】原注释写「协议 ≈1200 + 格式提醒 ≈200 + 记忆 ≤1200 ≈ 2600 字」，
 * ⚠️ 其中「协议 ≈1200」与事实不符：v1.1 协议正文 2729 字，v1.2 已到 3078 字。
 * 但数值**保持不变**：实际算法是 `total − 固定开销 − system 长度`，而 system
 * 本来就含协议与记忆，这 2600 是**额外余量**而非协议补偿。改它等于动历史窗口，
 * 属行为变更，留给老大定。注释先纠正到与事实一致。
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

/**
 * 额外安全余量（字）。**2026-09-14 语义变更（老大选 C 档）**。
 *
 * 旧注释与取值是「协议 ≈1200 + 格式提醒 ≈200 + 记忆 ≤1200 ≈ 2600」，但实际算法是
 * `total − 余量 − len(system) − memory`，而 **system 里本来就含协议与记忆** ——
 * 于是这两样被扣了两遍。实测示范项目：`8000 − 2600 − 8237 − 0` 为负 → 历史额度 0
 * （21 条消息只剩开场一条）。现在只当纯余量：默认 400。
 */
export const FIXED_OVERHEAD_CHARS = 400

export function textLen(s: string | undefined): number {
  return s ? s.length : 0
}

export function messagesLen<T extends { content: string }>(msgs: T[]): number {
  return msgs.reduce((n, m) => n + textLen(m.content), 0)
}

export type TrimResult<T = TavernMessage> = {
  kept: T[]
  /** 被裁掉的条数（用于 UI 提示「这一场已很长」） */
  dropped: number
}

/**
 * 裁剪对话历史到预算之内。
 * 从最早的开始丢，**但首条（开场）始终保留**——否则模型会失去场景起点。
 */
export function trimHistory<T extends { content: string }>(messages: T[], budgetChars: number): TrimResult<T> {
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
 * 算出「留给对话历史」的额度 = 总预算 − 安全余量 − 整条 system − 未含在 system 里的记忆。
 * 结果下限为 0（额度不足时只保留开场）。
 *
 * 🔴 `system` 传的是**整条 system**（buildSystemPrompt 的输出，已含协议与记忆）——
 * 所以第三个参数别再单独传记忆（那会扣两遍）。酒馆两条线现在都传空串。
 */
export function historyBudget(
  total: number,
  system: string,
  /** 未包含在 system 里的记忆；酒馆传空串，留着只为兼容旧调用点 */
  memory: string,
  /** 额外安全余量（控制面板可调）；不传即内置默认 */
  fixedOverhead = FIXED_OVERHEAD_CHARS,
): number {
  return Math.max(0, total - fixedOverhead - textLen(system) - textLen(memory))
}
