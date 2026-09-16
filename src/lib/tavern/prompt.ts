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
 * 【标记分域（硬纪律，改任何提示词前先读这一段）】
 *   模型**输出**用：（ ）除对白之外的一切 ／〔〕状态块 ／对白＝纯文本（v1.7 起只有这三种）
 *   我们喂给模型的**输入**用：〖〗结构标题（层名/资料分段/记忆栏） ／〈〉说话人归属
 *   用户对模型的**元指令**：//  #  「」  [OOC: ]
 * 为什么两端必须用不同符号：输入若与输出同形，模型会把它当输出格式照抄进正文 ——
 * 「示例对话」「对话记录」这类最容易被模仿（v1.1 时期就出现过把标记写进回复的苗头）。
 * 音形相近的两套符号（〖〗 vs （ ））在视觉上又足够像，作者读提示词时不会觉得别扭。
 *
 * 本文件是纯逻辑，不含 React。
 */
import { PROTOCOL_CORE } from './protocol'
import type { TavernTone, TavernMessage, CastSetting, SceneDescLevel } from './types'
import { talkBandOf } from './types'

export type PromptLayers = {
  /** 档位：叙事向（剧情默认，即协议默认） / 聊天向（自由默认，追加一句风格提示） */
  tone: TavernTone
  /** 世界与角色设定：剧情模式为项目资料；自由模式为角色卡四章拼接 */
  setting?: string
  /**
   * 本场背景设定（第 5 批）：作者提炼过的世界资料，**按关键词命中决定要不要注入**。
   * 空串 = 整层不出现（与①一样，不留空标题占位置）。
   */
  world?: string
  /**
   * 上面那一层的标题覆盖。不传 = 「本场背景设定」（剧情模式）。
   * 自由模式传「故事的世界设定」—— 同一层装的是故事那份设定，叫「本场」是错的。
   */
  worldTitle?: string
  /**
   * 这一场（剧本，自由对话专用）：情境 / 你的位置 / 这一场的目标 / 不要发生。
   * 排在设定层之后、记忆之前 —— 模型先知道「这是谁的戏」，再知道「此刻是什么处境」。
   * 空串 = 整层不出现（与其它层同一条纪律：不留空标题占位置）。
   */
  scene?: string
  /** 长期记忆（六栏压缩后的文本） */
  memory?: string
  /**
   * 长期记忆层的标题。传 `null` = 正文**自带**标题（自由模式多角色时每块写「〖长期记忆 · 角色名〗」，
   * 再加一层「〖长期记忆〗」纯属重复）。不传即默认「长期记忆」。
   */
  memoryTitle?: string | null
  /** 你在戏里的身份与知识边界 */
  self?: string
  /**
   * 扮演设定（方案 §6.4）：给 AI 演「像」用的 —— **塞行为，不塞设定**。
   * 由 renderCastSetting 渲染好传入；空串则整层跳过。
   */
  cast?: string
  /** 档位追加提示的覆盖（来自控制面板）。不传则用内置 TONE_HINT —— 保证既有调用零变化。 */
  styleHint?: string
  /** 通用补充要求（两种模式都生效，控制面板「通用控制」） */
  commonExtra?: string
  /** 本模式专属补充要求（控制面板「剧情推演 / 自由对话」各自的那栏） */
  modeExtra?: string
  /** 扮演协议全文（控制面板可编辑）。不传则用内置常量 PROTOCOL_CORE —— 保证既有调用零变化 */
  protocol?: string
  /**
   * 被预算丢弃的段落名。必须如实声明：
   * 否则模型会把自己没看到的资料当成不存在（沿用 buildProjectContext 的既有设计）。
   */
  dropped?: string[]
  /**
   * **协议之后**的收尾块（目前是自由模式的「本场数值」当前值）。
   *
   * 🔴 为什么破例排在协议之后：协议末尾那条「最后提醒」是为了格式遵守（近因最强），
   *    排在它前面的内容容易被那 3.5KB 格式规范盖过去（2026-09-15 探针对照实验证实）。
   *    而「此刻的状态」离生成点最近是有实际价值的 —— 它决定这一轮这场戏发生在哪、分寸如何；
   *    地点一错整场戏就会瞬移（实测：宿舍楼道一步跨到食堂）。
   *    剧情模式没有这一层，协议仍是绝对末尾。
   */
  tail?: string
}

/**
 * 档位追加提示。
 * 协议 O1/O2 已规定通用格式（动作全角括号、对白不加引号、一次一个回合、60–160 字），
 * 所以这里只补「叙事向不追加（就是协议默认）」，聊天向补一句场景化倾向。
 * ⚠️ 档位的真正差异应主要由**角色卡**承担（手册实践：陆青梧走动作+对白、阿禾走消息体）。
 */
/** 档位追加提示的内置默认。控制面板可覆盖（settings.free.styleHint），默认值取自这里。 */
export const TONE_HINT: Record<TavernTone, string> = {
  narrative: '',
  chat: '〖本场风格〗现代日常场景，以即时聊天的方式说话：短句为主，最多连发 2 条，不要长篇叙述。',
}

/** 按「设定 → 记忆 → 身份 → 未带入声明 → 协议 →（可选）收尾块」拼出整条 system。空层自动跳过。 */
export function buildSystemPrompt(layers: PromptLayers): string {
  const parts: string[] = []

  // ① 世界与角色设定（身份锁定）
  if (layers.setting?.trim()) parts.push(`〖世界与角色设定〗\n${layers.setting.trim()}`)

  // ①b 本场背景设定（第 5 批）：作者从项目资料**提炼**过的那一份，按关键词决定要不要带。
  //     与①的区别：①是原始资料（可能几千字、每轮都带），这里是精简稿（≤2400 字、可开关）。
  //     自由模式复用这一层装**故事的世界设定**（同一个位置、同一个作用），标题不同 ——
  //     「本场背景设定」对自由模式是错的（那份设定属于整个故事，不属于这一场）。
  if (layers.world?.trim()) {
    parts.push(`〖${layers.worldTitle?.trim() || '本场背景设定'}〗\n${layers.world.trim()}`)
  }

  // ①c 这一场（剧本）：它回答「此刻在哪、为什么在这儿、这一场想干嘛」——
  //     与①/①b 的分工是「人是谁 / 世界如何」vs「**这一场**是什么」。空则整层跳过。
  if (layers.scene?.trim()) parts.push(`〖这一场〗\n${layers.scene.trim()}`)

  // ② 长期记忆（居中）
  const memTitle = layers.memoryTitle === undefined ? '长期记忆' : layers.memoryTitle
  if (layers.memory?.trim()) {
    parts.push(memTitle === null ? layers.memory.trim() : `〖${memTitle}〗\n${layers.memory.trim()}`)
  }

  // ③ 你在戏里的身份与知识边界
  if (layers.self?.trim()) parts.push(`〖你在戏里的身份与知识边界〗\n${layers.self.trim()}`)

  // ③b 扮演设定（紧跟身份之后：先知道「你是谁」，再知道「该怎么演」）
  if (layers.cast?.trim()) parts.push(layers.cast.trim())

  // ④ 档位追加（叙事向默认空，不产生噪音）。控制面板给的值优先于内置默认。
  const hint = layers.styleHint ?? TONE_HINT[layers.tone]
  if (hint?.trim()) parts.push(hint.trim())

  // ④b 通用 / 本模式补充要求（控制面板）—— 都放协议**之前**，
  //     免得打断协议末尾那条「最后提醒」的近因效果（协议钉绝对末尾是既定纪律）。
  //     两者都**带标题**：作者写的规则与系统规则混在同一段里，模型分不清该听谁。
  if (layers.commonExtra?.trim()) parts.push(`〖通用补充要求〗\n${layers.commonExtra.trim()}`)
  if (layers.modeExtra?.trim()) parts.push(layers.modeExtra.trim())

  // ⑤ 未带入的资料：如实声明（放在协议之前，免得打断协议末尾的提醒）
  if (layers.dropped?.length) {
    parts.push(
      `〖未带入的资料〗\n以下资料因篇幅限制未带入本次上下文，请当作你的角色不知道，也不要凭空推测：\n` +
      layers.dropped.map(d => `· ${d}`).join('\n')
    )
  }

  // ⑥ 协议（格式与禁令收尾）—— 钉在绝对末尾。
  //    内容可由控制面板覆盖；为空（用户清空了）则回退内置常量，避免整条 system 尾部空掉。
  parts.push(layers.protocol?.trim() || PROTOCOL_CORE)

  // ⑦ 收尾块 —— **协议之后的最后一件事**（自由模式的「本场数值」当前值）。
  //    它必须排在协议之后才生效（见 `tail` 字段的说明与实测数据）；
  //    剧情模式没有这一层，所以「协议钉绝对末尾」对剧情模式仍然成立。
  if (layers.tail?.trim()) parts.push(layers.tail.trim())

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
    ? `〖扮演设定 · ${name}〗你要演成这样的人（这些是行为倾向，落到具体言行上，不要复述本段）`
    : `〖对方的扮演设定 · ${name}〗作者自己演的角色，仅供你理解对方的风格；**不要代写 Ta 的言行**`
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
  if (head.length) bits.push(head.join(' · '))
  if (scene.description.trim()) bits.push(scene.description.trim())
  if (firstLine?.trim()) bits.push(firstLine.trim())
  return bits.join('\n\n')
}

/**
 * 多角色同场的发言规则（方案 §7.3）。
 * 只在自由模式 `charIds.length > 1` 或剧情模式有多个 AI 角色时追加到设定层末尾。
 * ⚠️ 协议 O1 禁止在**输出**里写角色名前缀，但**输入**侧必须能分清谁在说话，
 * 两者不冲突：这里管的是模型如何组织发言，不改变它的输出格式。
 *
 * `hasUser=false` 必须传：剧情模式允许一个「你演」位置都不设（整场交给 AI，2026-09-14 新增能力）。
 * 那种情况下若还写着「用户扮演用户自己的角色」，模型会去等一个**并不存在**的人开口。
 *
 * `userName`：自由模式里用户可能**扮演某个具体角色**（用户演阿禾、AI 演阿岩）。
 * 写明是谁，模型才知道自己在跟谁对话，也不会顺手把那个人的台词也演了。
 */
export function buildMultiCharRule(
  names: string[],
  opts: {
    hasUser?: boolean
    userName?: string
    /** 静音：在场但这一场不发言的角色名（已从 names 摘掉，这里只作声明，防模型替 Ta 开口） */
    silentNames?: string[]
    /** 健谈度：**只传偏离默认的**（全默认时整段不加，别白占上下文） */
    talkativity?: { name: string; value: number }[]
  } = {},
): string {
  const hasUser = opts.hasUser !== false
  const who = !hasUser
    ? '本场没有你演的角色，全部由你推进。'
    : opts.userName?.trim()
      ? `用户扮演：${opts.userName.trim()}。`
      : '用户扮演用户自己的角色。'
  const lines = [
    '〖发言规则〗',
    `你是下列角色：${names.join('、')}。${who}`,
    '- 一次只让一个角色说话，不要在同一回合里让多个角色各说一句。',
    '- 轮到谁由语境决定，不要强行轮流。',
    '- 不说话的角色不要替它发言；它就在场，但这一回合没开口。',
    '- 用户点名某个角色时，那个角色必须接话。',
  ]
  // 静音：必须写成「人在场、但不开口」—— 只把人从名单里拿掉不说这句的话，
  // 模型可能干脆当 Ta 不存在（连「在场」都演不出来）。
  const silent = (opts.silentNames ?? []).filter(Boolean)
  if (silent.length) {
    lines.push("- 还有 " + silent.length + " 人在场，但**这一场不开口**：" + silent.join("、") +
      " —— 不要替 Ta 们发言，也不要写成 Ta 们已经离开。")
  }
  // 健谈度：写成「发言分量」而不是硬性轮流 —— 平均轮流会让所有人的存在感变得一样。
  const talk = (opts.talkativity ?? []).filter(t => t.name)
  if (talk.length) {
    const rows = [...talk].sort((a, b) => b.value - a.value)
    const text = rows.map(t => { const b = talkBandOf(t.value); return t.name + ' —— ' + b.name + '（' + b.line + '）' }).join('；')
    lines.push('- 发言分量（各角色自己的习惯，不是硬性轮流）：' + text + '。' +
      '多数回合仍由语境决定谁开口，但这些差别要看得出来 —— 安静的人别写成话痨，健谈的人别写成闷葫芦。')
  }
  return lines.join('\n')
}

/**
 * 「我的档案」渲染成一段 —— **用户本人**是谁（全局设置，跨项目）。
 *
 * 【为什么它不是角色卡】
 * 角色卡描述**角色**，档案描述**屏幕后面那个人**；两者可以同时存在
 * （用户演阿禾，而他本人是另一个人）。所以这一段永远只讲用户这一侧。
 *
 * `playing` = 本场 Ta 扮演的角色名。有没有它，对模型的要求正好相反：
 *   · 没演角色 → 档案**就是** Ta 的在场身份，照它称呼；
 *   · 演了角色 → 档案只用来拿捏语气，**不能**拿档案里的名字去替换角色名
 *     （否则会出现「阿禾」被叫成「阿岩」这种串味）。
 *
 * 空档案（三栏全空）返回空串 —— 不留一个空标题白占 context。
 */
export function buildUserProfileBlock(
  p: { name?: string; address?: string; persona?: string } | undefined,
  playing?: string,
): string {
  if (!p) return ''
  const name = (p.name ?? '').trim()
  const address = (p.address ?? '').trim()
  const persona = (p.persona ?? '').trim()
  if (!name && !address && !persona) return ''
  const lines: string[] = []
  if (name) lines.push(`名字：${name}`)
  if (address) lines.push(`希望被这样称呼：${address}`)
  if (persona) lines.push(`自我设定：${persona}`)
  const tail = playing
    ? `（Ta 本场扮演〖${playing}〗。这份档案只说明「屏幕后面是谁」，用来拿捏称呼与语气；不要用档案里的名字去替换 Ta 扮演的角色名。）`
    : '（本场没有指定 Ta 扮演的角色，Ta 就以这个身份在场 —— 照档案来称呼与对待 Ta。）'
  return `〖我的档案 · 用户本人〗\n${lines.join('\n')}\n${tail}`
}

/**
 * 同名角色消歧说明（只在**同一场里出现同名**时才注入）。
 *
 * 【为什么需要】记忆与发言归属在数据层按 `id` 存 —— 两张同名卡永远不会互相串档。
 * 但模型看到的是**文本**：两段都叫「小满」的设定、两块都叫「【长期记忆 · 小满】」的记忆，
 * 它没有任何依据判断谁是谁（顺序也是脆弱的暗示）。这里给它一张对照表。
 *
 * 平时不注入 —— 不同名时多这一段纯属占上下文。
 */
export function buildSameNameNote(items: { name: string; tag: string }[]): string {
  return [
    '〖同名角色〗',
    `本场出现了同名角色：\n${items.map(i => `· ${i.name}（#${i.tag}）`).join('\n')}`,
    '他们是**不同的人**：各自的角色卡与长期记忆彼此独立，不要混用，也不要把一个人的经历安到另一个人身上。',
    '提到其中某一位时，以标签和上下文为准；拿不准就只对当下的对话对象说话，不要替另一位补设定。',
  ].join('\n')
}

/**
 * 「客观描写」规则（自由对话，控制面板可调档）。
 *
 * 起因：只靠角色卡演，对白与动作都对，画面却是空的 —— 她穿什么、屋里什么光、
 * 外面在下雨还是出太阳，全靠用户自己想。约会、初见这类场景，缺的正是这份「看得见」。
 *
 * 【三条纪律都是从既有红线上长出来的，不是新加限制】
 *   ① 只写观察得到的客观事实 —— 与 R2「不替用户决定」同源：写对方的心理活动＝替他演；
 *   ② 具体可感 —— 「穿着衣服」等于没写；
 *   ③ 描写算在协议那 60–160 字里 —— 否则一描写就把篇幅撑爆，把对白挤掉（协议的字数是硬约束）。
 */
export function buildSceneDescriptionRule(level: SceneDescLevel): string {
  if (level === 'off') return ''
  const discipline = [
    '三条纪律：',
    '① 只写**观察得到的客观事实** —— 不写任何人的心理活动，也不替对方决定感受；',
    '② 要具体可感（写「洗到发白的牛仔外套」，不要写「穿着衣服」）；',
    '③ 与协议 O1 是**同一套括号**：这些都写在（ ）里，一件事一个括号、一句一行；',
    '   它们都算在协议的字数里，一两句就够，不要盖过对白。',
  ]
  if (level === 'light') {
    return [
      '〖客观描写〗偶尔补一两句**看得见听得见**的细节（写在（ ）里，与动作同一种括号），别每回合都写：',
      '· 出场：某个角色本场第一次开口前，交代 Ta 此刻的样子（穿着、姿态、手里在做的事）；',
      '· 环境：场景**确实**转移了（有人换了地方）或时间推移时，补一句环境（光线、声音、天气）—— 不要自己主动换场。',
      ...discipline,
    ].join('\n')
  }
  const body = [
    '〖客观描写〗在 Ta 开口之前，先用（ ）写一两句**看得见、听得到**的东西，再进入对白：',
    '· 出场：某个角色本场第一次开口前，交代 Ta 此刻的样子 —— 穿着（颜色、材质、随身物）、姿态、手里正在做的事；',
    '· 环境：场景确实转移（有人换了地方）、时间推移、光线或天气变化时，补一句环境（声音、气味、温度、光）—— 不要自己主动换场；',
    '· 情绪：情绪明显变化时用外在细节表示（手指、呼吸、视线、动作的停顿），不要直接写「Ta 很生气」。',
  ]
  if (level === 'rich') {
    body.push('· 密度：每个回合都至少带一条写环境或身体细节的（ ），写光线、声音、气味、温度、Ta 手边的东西。')
  }
  return [...body, ...discipline].join('\n')
}

/** 把历史消息转成 chat 接口的 messages 结构（跳过 system——协议已单独成 system） */
export function toChatMessages(
  msgs: TavernMessage[],
  opts: { withSpeaker?: (speakerId?: string) => string } = {},
): { role: 'user' | 'assistant'; content: string }[] {
  return msgs
    // 隐藏的消息不进上下文 —— 这是「别让 AI 看见」的**唯一出口**（剧情/自由两条线都走这里）
    .filter(m => (m.role === 'user' || m.role === 'assistant') && !m.hidden)
    .map(m => ({
      role: m.role as 'user' | 'assistant',
      // 多角色同场：只在**输入历史**上标注说话人，方便模型分清谁在说
      content: opts.withSpeaker && m.role === 'assistant' && m.speakerId
        ? `${opts.withSpeaker(m.speakerId)}${m.content}`
        : m.content,
    }))
}
