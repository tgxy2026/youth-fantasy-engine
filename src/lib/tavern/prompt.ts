/**
 * 酒馆模式 · 提示词组装（每轮重装）
 *
 * 【层序：遵循手册的实测配置，而非方案 §4.1 的设想】
 *
 * 《本地模型角色扮演完全手册》「注入顺序（都在同一条 system 消息里）」一节写的是：
 *     角色卡（身份锁定）→ 长期记忆（她记得的事）→ 协议技能（格式与禁令收尾）
 * 并注明「记忆插在角色卡和技能之间是刻意的：身份先锁定、记忆居中、格式规则收尾」。
 *
 * 方案 §4.1 设想的顺序是「协议钉开头、格式提醒钉末尾」。两者并不矛盾，取交集即可：
 * 因为**协议自身就是「任务定义在前、最后提醒在后」的结构**（v1.1 的两处改动，
 * 见手册「v1.1 相对 v1.0 的四处改动」），所以把整份协议放在**最末**，
 * 它的「最后提醒」正好紧贴生成点 —— 既满足方案「格式钉末尾」的意图，
 * 又符合手册的实测配置。本文件按此实现。
 *
 * 【为什么拼成一整条 system】
 * 多条 system 在各 OpenAI 兼容端点的支持参差。
 *
 * 【每轮重新组装】
 * 不是只在开头发一次 —— 这样中途改设定、记忆更新都能立刻生效。
 *
 * 本文件是纯逻辑，不含 React。
 */
import { PROTOCOL_CORE } from './protocol'
import type { TavernTone, TavernMessage, CastSetting } from './types'

export type PromptLayers = {
  /** 档位：叙事向（剧情默认，即协议默认） / 聊天向（自由默认，追加一句风格提示） */
  tone: TavernTone
  /** 世界与角色设定：剧情模式为项目资料；自由模式为角色卡四章拼接 */
  setting?: string
  /** 长期记忆（六栏压缩后的文本） */
  memory?: string
  /** 你在戏里的身份与知识边界 */
  self?: string
  /**
   * 扮演设定（方案 §6.4）：给 AI 演「像」用的 —— **塞行为，不塞设定**。
   * 由 renderCastSetting 渲染好传入；空串则整层跳过。
   */
  cast?: string
  /**
   * 被预算丢弃的段落名。必须如实声明：
   * 否则模型会把自己没看到的资料当成不存在（沿用 buildProjectContext 的既有设计）。
   */
  dropped?: string[]
}

/**
 * 档位追加提示。
 * 协议 O1/O2 已规定通用格式（动作全角括号、对白不加引号、一次一个回合、60–160 字），
 * 所以这里只补「叙事向不追加（就是协议默认）」，聊天向补一句场景化倾向。
 * ⚠️ 档位的真正差异应主要由**角色卡**承担（手册实践：陆青梧走动作+对白、苏念走消息体）。
 */
const TONE_HINT: Record<TavernTone, string> = {
  narrative: '',
  chat: '【本场风格】现代日常场景，以即时聊天的方式说话：短句为主，最多连发 2 条，不要长篇叙述。',
}

/** 按「设定 → 记忆 → 身份 → 未带入声明 → 协议（钉末尾）」拼出整条 system。空层自动跳过。 */
export function buildSystemPrompt(layers: PromptLayers): string {
  const parts: string[] = []

  // ① 世界与角色设定（身份锁定）
  if (layers.setting?.trim()) parts.push(`【世界与角色设定】\n${layers.setting.trim()}`)

  // ② 长期记忆（居中）
  if (layers.memory?.trim()) parts.push(`【长期记忆】\n${layers.memory.trim()}`)

  // ③ 你在戏里的身份与知识边界
  if (layers.self?.trim()) parts.push(`【你在戏里的身份与知识边界】\n${layers.self.trim()}`)

  // ③b 扮演设定（紧跟身份之后：先知道「你是谁」，再知道「该怎么演」）
  if (layers.cast?.trim()) parts.push(layers.cast.trim())

  // ④ 档位追加（叙事向为空，不产生噪音）
  const hint = TONE_HINT[layers.tone]
  if (hint) parts.push(hint)

  // ⑤ 未带入的资料：如实声明（放在协议之前，免得打断协议末尾的提醒）
  if (layers.dropped?.length) {
    parts.push(
      `【未带入的资料】\n以下资料因篇幅限制未带入本次上下文，请当作你的角色不知道，也不要凭空推测：\n` +
      layers.dropped.map(d => `· ${d}`).join('\n')
    )
  }

  // ⑥ 协议（格式与禁令收尾）—— 钉在绝对末尾
  parts.push(PROTOCOL_CORE)

  return parts.join('\n\n')
}

/** 扮演设定六个字段的展示名（顺序即渲染顺序） */
const CAST_FIELDS: [keyof CastSetting, string][] = [
  ['voice', '口吻'],
  ['address', '称呼你的方式'],
  ['unknown', '知识边界（不知道的事）'],
  ['taboo', '禁忌与底线'],
  ['care', '在意的事'],
  ['never', '绝不会做的事'],
]

/**
 * 把扮演设定渲染成一块提示词（方案 §6.4）。
 * 两个要点：
 *   · 只输出填过的字段 —— 空字段不产生「（未填）」这类噪音，免得模型去猜
 *   · 作者角色的设定明确标注**不要代写** —— 否则 AI 会顺手把作者的角色也演了
 */
export function renderCastSetting(name: string, cs: CastSetting, kind: 'ai' | 'user'): string {
  const lines = CAST_FIELDS
    .filter(([k]) => typeof cs[k] === 'string' && cs[k].trim())
    .map(([k, label]) => `- ${label}：${cs[k].trim()}`)
  if (lines.length === 0) return ''
  const head = kind === 'ai'
    ? `【扮演设定 · ${name}】你要演成这样的人（这些是行为倾向，落到具体言行上，不要复述本段）`
    : `【对方的扮演设定 · ${name}】作者自己演的角色，仅供你理解对方的风格；**不要代写他的言行**`
  return `${head}\n${lines.join('\n')}`
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
 * 只在自由模式 `charIds.length > 1` 时追加到设定层末尾。
 * ⚠️ 协议 O1 禁止在**输出**里写角色名前缀，但**输入**侧必须能分清谁在说话，
 * 两者不冲突：这里管的是模型如何组织发言，不改变它的输出格式。
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
      // 多角色同场：只在**输入历史**上标注说话人，方便模型分清谁在说
      content: opts.withSpeaker && m.role === 'assistant' && m.speakerId
        ? `${opts.withSpeaker(m.speakerId)}${m.content}`
        : m.content,
    }))
}
