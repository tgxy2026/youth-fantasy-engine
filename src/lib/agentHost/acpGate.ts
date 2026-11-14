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
  /**
   * 同一个 `acpText` 被多次调用时只确认一次。
   *
   * 校对按块发送（一章可能 8 块），逐块弹确认等于逼作者连点八次同意 ——
   * 多点到手滑就会批准本来不想发的那一块。这里缓存**这一次任务**的答复，
   * 取消后后续各块直接抛「已取消发送」。单次调用的任务开不开都一样。
   */
  askOnce?: boolean
}

/**
 * 生成传给 `ai*` 任务的 `acpText`：确认 → 代次/归属校验 → 发送 → 落地前再校验。
 * 取消时抛「已取消发送。」；调用方的任务中心据此显示取消而不是失败。
 *
 * @param call.signal 单次调用的取消信号。**会覆盖**构造时的 `input.signal`。
 *   酒馆这类"同一个 chatFn 被多次调用、每次带不同 signal"的场景必须走它 ——
 *   只认构造时的那个，作者点停止时正在跑的那次收不到取消。
 * @param call.onToken 单次调用的流式回调（酒馆主回复的打字效果靠它）。
 */
export function acpGatedText(
  input: AcpGateInput,
): (prompt: string, call?: { signal?: AbortSignal; onToken?: (delta: string) => void }) => Promise<string> {
  let consented: Promise<boolean> | null = null
  return async (prompt, call) => {
    const options: AcpGateConfirmOptions = { title: input.title, message: input.message, confirmText: '确认发送' }
    const ok = await (input.askOnce ? (consented ??= input.ask(options)) : input.ask(options))
    if (!ok) throw new Error('已取消发送。')
    const signal = call?.signal ?? input.signal
    await assertAcpWritingCurrent(input.generation)
    input.assertCurrent?.()
    const text = await acpWrite(input.task, input.generation, prompt, {
      ...(signal ? { signal } : {}),
      ...(call?.onToken ? { onToken: call.onToken } : {}),
    })
    await assertAcpWritingCurrent(input.generation)
    input.assertCurrent?.()
    return text
  }
}

/** 外发确认正文的统一句式：接收方 + 本次发送范围 + 只用于什么。 */
export function acpGateMessage(agentName: string, scopeText: string, purpose: string): string {
  return `接收方为 ${agentName}。本次发送${scopeText}，只用于${purpose}。`
}

/**
 * 这次失败是不是「作者主动取消」。
 *
 * 为什么要单独一个判定：`isCancelled` 只认 `AICancelled`（API 传输层），
 * 而 ACP 路径取消有两条来源 —— 确认弹窗点了取消（抛「已取消发送。」）
 * 与 abort 信号（抛 `AbortError`）。不认这两条，取消会被记成失败，
 * 界面就会拿「校对失败」去盖住作者自己按的取消。
 */
export function isAcpCancelled(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || error.message === '已取消发送。'
}
