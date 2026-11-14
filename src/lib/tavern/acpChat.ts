// ============ 酒馆 · ACP 通道适配器（3.5.5）============
//
// 【为什么做在 `ChatFn` 这一层】
// 酒馆有 15 处独立的 `deps.chatFn ?? chat` 注入点（对话 / 总结 / 数值 / 起草 /
// 报告 / 导入 / 访谈 / 修订 / 剧本 / 世界观 / 日记…）。若逐个入口加 ACP 分支，就得每处
// 各写一份「怎么拼 prompt、怎么记归属、失败怎么报」—— 那正是当初 18 处漏接的成因
// （见 `provider.ts` 与 `attribution.ts` 的注释）。
// 它们**全都**接受 `chatFn` 注入，所以在这一层给一个符合 `ChatFn` 签名的实现，
// 就等于一次覆盖全部，且以后新加的酒馆 AI 功能自动跟随。
//
// 🔴 三条必须如实承认的能力差异（不要在本文件以外假装它们不存在）：
//   1. **单轮**：ACP 一次只发一段输入。多轮 messages 会被**拼成一段文本**，
//      而不是像 API 那样按 role 分开传。对话一致性可能因此下降 —— 这是降级，不是等价。
//   2. **不认服务端 JSON 模式**：`json` / `output` / `schema` 无法下发，只能把
//      「只输出 JSON」写成文字要求。所以**结构化的严格校验必须留在调用方**
//      （`parseVarsFromText` / `parseMemory…` 等既有解析器原样保留，不放宽）。
//   3. **不认温度与推理档位**：`temperature` / `think` / `timeoutMs` 由 ACP 会话侧的
//      模型与档位决定，这里传什么都不生效。**不要**在这里假装遵守。
//
// 🔴 流式是支持的（`acpWrite` 有 onToken），所以主回复的打字效果可以保留。
import type { ChatFn } from '@/lib/tavern/provider'
import type { AcpTask } from '@/lib/agentHost/acpBridge'
import { acpGatedText, type AcpGateConfirmOptions } from '@/lib/agentHost/acpGate'
import { acpJsonInstruction } from '@/lib/agentHost/acpStructured'
import type { ChatMessage } from '@/lib/ai'

export interface TavernAcpOptions {
  /** ACP 代次（设置一改就换，旧代次的回执一律作废） */
  generation: string
  /** Agent 名（写进确认文案，作者要知道资料发给了谁） */
  agentName: string
  /**
   * 任务标识。酒馆各入口共用一个 `tavern` 会让「谁发的请求」失去区分度，
   * 所以按调用性质分开：`tavern-reply`（主回复）/ `tavern-vars`（数值）/
   * `tavern-summary`（摘要）/ `tavern-aux`（起草、导入、访谈等辅助产出）。
   */
  task: AcpTask
  /** 本次发送范围（如「本场对话与角色设定」） */
  scopeText: string
  /** 本次要产出什么（如「生成本轮剧情回复」） */
  purpose: string
  /** 应用内确认弹窗 */
  ask: (options: AcpGateConfirmOptions) => Promise<boolean>
  /** 项目 / 会话归属校验（发送前与落地前各一次） */
  assertCurrent?: () => void
  /**
   * 一轮对话会连发多次（主回复 → 数值 → 摘要）。逐次弹确认等于毁掉这个功能，
   * 传同一份 `askOnce` 即可整轮只确认一次。
   */
  askOnce?: boolean
}

/** 系统指令在拼好的 prompt 里用这个标记开头（导出供测试断言） */
export const ACP_TAVERN_SYSTEM_HEADER = '【系统指令】'
/** 最后一条用户消息的标记：模型要从这里接着写 */
export const ACP_TAVERN_CURRENT_HEADER = '【当前指令】'
const ROLE_LABEL: Record<'user' | 'assistant', string> = { user: '用户', assistant: '助手' }

/**
 * 把酒馆的多轮 `ChatMessage[]` 压成一段 ACP 输入。
 *
 * 口径（改动前先想清楚会影响哪些入口）：
 *  · 所有 `system` 消息合并到最前，**保持原顺序**（酒馆有的入口会发两条 system：
 *    一条世界书/设定，一条格式协议 —— 合并时不能颠倒）；
 *  · 对话历史按顺序标成「用户：/助手：」；
 *  · 最后一条若是 `user`，用【当前指令】标出来；否则原样收尾。
 *
 * 为什么不用「纯文本直接拼接」：酒馆的提示词里本来就有大量换行与分隔符，
 * 不加角色标记的话，模型分不清哪段是设定、哪段是作者这一轮说的话。
 */
export function renderTavernPrompt(messages: ChatMessage[]): string {
  const systems: string[] = []
  const turns: string[] = []
  for (const m of messages) {
    const content = (m.content ?? '').trim()
    if (!content) continue
    if (m.role === 'system') systems.push(content)
    else turns.push(`${ROLE_LABEL[m.role]}：${content}`)
  }
  const parts: string[] = []
  if (systems.length > 0) parts.push(`${ACP_TAVERN_SYSTEM_HEADER}\n${systems.join('\n\n')}`)
  if (turns.length > 0) {
    const last = messages[messages.length - 1]
    // 只有「最后一条确实是非空的用户消息」才加当前指令标记 —— 空消息在前面已被跳过，
    // 这里要按跳过后的实际末项判断，不能看数组下标。
    if (last && last.role === 'user' && (last.content ?? '').trim()) {
      parts.push(`${turns.slice(0, -1).join('\n\n')}\n\n${ACP_TAVERN_CURRENT_HEADER}\n${turns[turns.length - 1]}`.trim())
    } else {
      parts.push(turns.join('\n\n'))
    }
  }
  return parts.join('\n\n').trim()
}

/**
 * 一轮对话的**共享授权**。
 *
 * 一轮里会连发好几次（主回复 → 数值结算 → 摘要），而它们是**不同的任务标识**，
 * 所以不能只靠 `acpGatedText` 自带的 `askOnce`（那是按单个通道缓存的）。
 * 这里把答复做在更外层：同一个 `consent` 传给本轮所有通道，作者只被问一次。
 *
 * 🔴 每轮必须新建一个 —— 跨轮复用等于「问过一次就永久免确认」，那是错的。
 */
export function createTavernConsent(
  ask: (options: AcpGateConfirmOptions) => Promise<boolean>,
): (options: AcpGateConfirmOptions) => Promise<boolean> {
  let answer: Promise<boolean> | null = null
  return options => (answer ??= ask(options))
}

/**
 * 构造一个走 ACP 的 `ChatFn`。
 *
 * 用法：各入口保持 `deps.chatFn ?? <通道>` 的形状；`<通道>` 在 ACP 就绪时传
 * `makeTavernAcpChat(...)`，否则仍是 `chat`。测试注入的 `deps.chatFn` 仍然优先，既有行为零变化。
 *
 * 🔴 别在本文件里写出完整的 `const runChat =` 赋值语句（注释里也不行）：
 *    `tests/tavernAttribution` 按这一形态扫「注入点是否都套了归属包装」，
 *    注释里的示例会被当成真代码，误判成「有注入点漏接」。
 */
export function makeTavernAcpChat(o: TavernAcpOptions): ChatFn {
  const send = acpGatedText({
    task: o.task,
    generation: o.generation,
    title: '发送酒馆资料至 ACP Agent',
    message: `接收方为 ${o.agentName}。本次发送${o.scopeText}，只用于${o.purpose}。`,
    ...(o.assertCurrent ? { assertCurrent: o.assertCurrent } : {}),
    ...(o.askOnce ? { askOnce: o.askOnce } : {}),
    ask: o.ask,
  })

  const fn = async (
    _config: Parameters<ChatFn>[0],
    messages: ChatMessage[],
    opts?: Parameters<ChatFn>[2],
  ): Promise<string> => {
    const needJson = opts?.json === true || (opts?.output !== undefined && opts.output !== 'text')
    const prompt = renderTavernPrompt(messages)
    if (!prompt) throw new Error('没有可发送的内容。')
    // ACP 不支持服务端 JSON 模式：把「只输出 JSON」写成文字要求，
    // **不因此放宽**调用方的解析校验 —— 解析不出来的仍是失败。
    const full = needJson ? `${prompt}\n\n${acpJsonInstruction('酒馆结构化结果', '{"…":"…"}')}` : prompt
    return send(full, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(opts?.onToken ? { onToken: opts.onToken } : {}),
    })
  }

  // 🔴 签名必须与 `ChatFn`（即 `chat`）一致：酒馆 15 处都按 `runChat(provider, msgs, opts)` 调，
  //    少一个参数就会在某一处静默传错位。
  return fn as unknown as ChatFn
}
