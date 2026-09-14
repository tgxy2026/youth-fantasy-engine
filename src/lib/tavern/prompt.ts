/**
 * 酒馆模式 · 提示词组装（五层，每轮重装）
 *
 * 设计依据：方案 §4.1。
 *
 * 【为什么拼成一整条 system】
 * 多条 system 在各 OpenAI 兼容端点的支持参差，故合并为一条。
 *
 * 【层级顺序不是随便排的】
 * 注意力在**开头与末尾**权重最高、中间最易被忽略。所以：
 *   · 扮演协议（元规则）钉在开头 —— 必须最先读到
 *   · 输出格式 + 最后提醒钉在末尾 —— 紧贴生成点，等价于酒馆的 post_history_instructions
 *
 * 【每轮重新组装，不是只在开头发一次】
 * 这样中途改设定、记忆更新都能立刻生效。
 *
 * 本文件是纯逻辑，不含 React。
 */
import { PROTOCOL_CORE, protocolFormat } from './protocol'
import type { TavernTone, TavernMessage } from './types'

export type PromptLayers = {
  /** 档位：叙事向（剧情默认）/ 聊天向（自由默认） */
  tone: TavernTone
  /** ②层 · 世界与角色设定（调用方已按信息边界裁剪好） */
  setting?: string
  /** ③层 · 长期记忆（六栏压缩后的文本） */
  memory?: string
  /** ④层 · 你在戏里的身份与知识边界 */
  self?: string
  /**
   * 被预算丢弃的段落名。
   * 必须如实声明：否则模型会把自己没看到的资料当成不存在（沿用 buildProjectContext 的既有设计）。
   */
  dropped?: string[]
}

/** 按五层顺序拼出整条 system 消息。空层自动跳过，不留空标题。 */
export function buildSystemPrompt(layers: PromptLayers): string {
  const parts: string[] = []

  // ① 扮演协议（钉开头）
  parts.push(PROTOCOL_CORE)

  // ② 世界与角色设定
  if (layers.setting?.trim()) parts.push(`【世界与角色设定】\n${layers.setting.trim()}`)

  // ③ 长期记忆
  if (layers.memory?.trim()) parts.push(`【长期记忆】\n${layers.memory.trim()}`)

  // ④ 你在戏里的身份与知识边界
  if (layers.self?.trim()) parts.push(`【你在戏里的身份与知识边界】\n${layers.self.trim()}`)

  // 未带入的资料：如实声明，别让模型把「没看到」当成「不存在」
  if (layers.dropped?.length) {
    parts.push(
      `【未带入的资料】\n以下资料因篇幅限制未带入本次上下文，请当作你的角色不知道，也不要凭空推测：\n` +
      layers.dropped.map(d => `· ${d}`).join('\n')
    )
  }

  // ⑤ 输出格式 + 最后提醒（钉末尾）
  parts.push(protocolFormat(layers.tone))

  return parts.join('\n\n')
}

/**
 * 首轮用户消息：把开场轻表单渲染成一段场景描述，再接上用户的第一句话。
 * （方案 §4.1：首轮 = 轻表单渲染出的场景描述 + 你的第一句话）
 */
export function buildOpeningMessage(
  scene: { place: string; time: string; present: string[]; description: string },
  firstLine?: string,
): string {
  const bits: string[] = []
  const head: string[] = []
  if (scene.place.trim()) head.push(`地点：${scene.place.trim()}`)
  if (scene.time.trim()) head.push(`时间：${scene.time.trim()}`)
  if (scene.present.length) head.push(`在场：${scene.present.join('、')}`)
  if (head.length) bits.push(`【场景】${head.join(' · ')}`)
  if (scene.description.trim()) bits.push(scene.description.trim())
  if (firstLine?.trim()) bits.push(firstLine.trim())
  return bits.join('\n\n')
}

/**
 * 多角色同场的发言规则（方案 §7.3）。
 * 只在自由模式 `charIds.length > 1` 时追加到 ② 层末尾。
 */
export function buildMultiCharRule(names: string[]): string {
  return [
    '【发言规则】',
    `你是下列角色：${names.join('、')}。用户扮演用户自己的角色。`,
    '- 一次只让一个角色说话，不要在同一回合里让多个角色各说一句。',
    '- 轮到谁由语境决定，不要强行轮流。',
    '- 不说话的角色不要替它发言；它就在场，但这一回合没开口。',
    '- 用户点名某个角色时，那个角色必须接话。',
  ].join('\n')
}

/** 把历史消息转成 chat 接口的 messages 结构（跳过 system——协议已单独成 system） */
export function toChatMessages(
  msgs: TavernMessage[],
  opts: { withSpeaker?: (speakerId?: string) => string } = {},
): { role: 'user' | 'assistant'; content: string }[] {
  return msgs
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({
      role: m.role as 'user' | 'assistant',
      // 多角色同场时，把「这句是谁说的」标进内容，否则模型分不清谁在说话
      content: opts.withSpeaker && m.role === 'assistant' && m.speakerId
        ? `${opts.withSpeaker(m.speakerId)}${m.content}`
        : m.content,
    }))
}
