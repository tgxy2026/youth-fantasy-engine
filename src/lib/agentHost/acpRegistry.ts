/**
 * 3.5.6 · 检查类任务的 ACP 发送器注册表
 *
 * 为什么需要它：连续性 / 伏笔 / 健康诊断 / 术语去重 / 文风体检 / 读者审问分散在多个组件里，
 * 逐个组件传 `acpText` 既重复又容易漏接。这里由 App 在 ACP 就绪时注册一次，
 * 任务函数按自己的任务标识取发送器；未注册（API 模式 / 未连接）就返回 null，走原路径。
 *
 * 🔴 只放发送器，不放任何确认弹窗实现：确认由 `acpGatedText` 的 ask 完成，
 *    注册表本身不认识 UI，避免 lib → components 的反向依赖。
 */
import type { AcpTask } from './acpBridge'

export type AcpTextFn = (prompt: string, opts?: { signal?: AbortSignal }) => Promise<string>
export type AcpTextFactory = (task: AcpTask, signal?: AbortSignal) => AcpTextFn | null

let factory: AcpTextFactory | null = null

export function setAcpTextFactory(fn: AcpTextFactory | null): void {
  factory = fn
}

/** 取某任务标识的发送器；未注册 / 工厂异常一律返回 null（调用方回退 API）。 */
export function acpTextFor(task: AcpTask, signal?: AbortSignal): AcpTextFn | null {
  try {
    return factory?.(task, signal) ?? null
  } catch {
    return null
  }
}

/** 仅测试用：清掉注册。 */
export function __resetAcpTextFactory(): void {
  factory = null
}
