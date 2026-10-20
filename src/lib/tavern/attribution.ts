/**
 * 3.2.0 · WQ7 酒馆归属（独立调用）
 *
 * 方案 §13.2 / §16.7：**没有父任务**的模型调用要如实标 `scope:'independent'`，
 * 不能靠「当时恰好只有唯一在跑的任务」去猜 —— 那会把酒馆的额度记到创意写作/改写头上，
 * 统计与重试次数一起失真，而且作者完全看不出来。
 *
 * 🔴 为什么用包装而不是在 16 处调用点各写一遍：
 *   酒馆每个入口都是 `const runChat = deps.chatFn ?? chat`（注入点用于测试/复用），
 *   逐个加参既容易漏，又会让 16 处各有一份"归属口径"。包在注入点上是**唯一真源**。
 *
 * 🔴 为什么不改提示词/预算/层序：酒馆红线（`docs/归档/酒馆模式/酒馆模式-工程红线.md`
 *   §18.4 / §18.10）对注入层序、预算与输出协议另有硬约束；本包装**只动 `request` 字段**，
 *   其余选项原样透传，行为零变化。
 */
import type { ChatFn } from './provider'

/** 酒馆调用的归属常量（独立调用：不属于任何项目任务） */
export const TAVERN_INDEPENDENT_REQUEST = { scope: 'independent' } as const

/**
 * 给一个 chat 实现套上「独立归属」。
 *
 * 口径：
 *  · 调用方**没给** `request` ⇒ 补 `{ scope:'independent' }`；
 *  · 调用方**给了** ⇒ 原样尊重（万一将来酒馆要挂到某个任务上，不用改这里）。
 */
export function withIndependentAttribution(fn: ChatFn): ChatFn {
  const wrapped = (async (...args: Parameters<ChatFn>) => {
    const [cfg, msgs, opts] = args
    return fn(cfg, msgs, {
      ...(opts ?? {}),
      request: opts?.request ?? TAVERN_INDEPENDENT_REQUEST,
    })
  }) as ChatFn
  return wrapped
}
