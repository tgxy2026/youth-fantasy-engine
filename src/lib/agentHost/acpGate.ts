/**
 * 3.5.5 · ACP 发送闸门（确认 → 代次/归属校验 → 发送 → 落地前复核）。
 *
 * 3.5.4 的纯文本报告与 3.5.5 的结构化任务共用同一条路径：
 * 差异只在**任务标识**与**外发范围文案**，门禁顺序必须逐字一致 ——
 * 顺序一旦分叉，「取消后迟到结果写库」和「切项目串结果」就会只在其中一条路径上复发。
 *
 * 🔴 本文件属 lib 层：确认弹窗由调用方注入，不反向依赖 components/。
 */
import { acpWrite, assertAcpWritingCurrent, type AcpTask } from './acpBridge'

/** 与界面确认弹窗同形的最小契约（由调用方传 confirmDialog）。 */
export interface AcpGateConfirmOptions {
  title: string
  message: string
  confirmText: string
}

export interface AcpGateInput {
  task: AcpTask
  generation: string
  /** 确认弹窗标题，例如「发送章节资料至 ACP Agent」 */
  title: string
  /** 确认弹窗正文，必须如实写明接收方与本次外发范围 */
  message: string
  signal?: AbortSignal
  /** 项目 / 账号 / 章节归属校验（发送前与结果落地前各一次） */
  assertCurrent?: () => void
  /** 应用内确认弹窗（生产传 confirmDialog；测试可注入假确认） */
  ask: (options: AcpGateConfirmOptions) => Promise<boolean>
}

/**
 * 生成传给 `ai*` 任务的 `acpText`：确认 → 代次/归属校验 → 发送 → 落地前再校验。
 * 取消时抛「已取消发送。」；调用方的任务中心据此显示取消而不是失败。
 */
export function acpGatedText(input: AcpGateInput): (prompt: string) => Promise<string> {
  return async prompt => {
    const ok = await input.ask({ title: input.title, message: input.message, confirmText: '确认发送' })
    if (!ok) throw new Error('已取消发送。')
    await assertAcpWritingCurrent(input.generation)
    input.assertCurrent?.()
    const text = await acpWrite(input.task, input.generation, prompt, { signal: input.signal })
    await assertAcpWritingCurrent(input.generation)
    input.assertCurrent?.()
    return text
  }
}

/** 外发确认正文的统一句式：接收方 + 本次发送范围 + 只用于什么。 */
export function acpGateMessage(agentName: string, scopeText: string, purpose: string): string {
  return `接收方为 ${agentName}。本次发送${scopeText}，只用于${purpose}。`
}
