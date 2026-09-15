/**
 * 酒馆模式 · 记忆总结引擎（方案 §4.5 / §4.6）
 *
 * 一次总结 = 「旧档案 + 水位线之后的新对话 → 重写整份完整档案」。
 * **改写而非追加**，所以档案字数在 500~1200 浮动、不会无限长大。
 *
 * 三件必须照做、否则会出问题的事（方案 §4.6 明确点出）：
 *   1. 提示词必须给**当前日期** —— 不给的话日记会写成「XX月XX日」这类占位符
 *   2. 必须写死**「未爆的雷」的定义** —— 不给的话模型会往里塞「结果尚不确定」这类废话
 *   3. 必须讲清**六栏行为不同**（会缩 / 只增 / 重写 / 滚动）—— 否则它会一刀切压缩，把伏笔抹掉
 *
 * 用哪个模型：可单独指定（方案 §4.6：压缩不需要创意，便宜快的就行）。不传则回退全局活动模型。
 *
 * 本文件只负责「调模型 + 解析」；触发时机（阈值 / 补算 / 三层防重）在 memory.ts，
 * 读写落库在 store.ts。
 */
import {
  chat, CHAT_TIMEOUT_MS, JSON_TASK_TEMPERATURE, isCancelled, type ChatMessage,
} from '../ai'
import { parseMemoryText, memoryToText, emptyMemory, isMemoryEmpty } from './memory'
import { resolveTavernProvider, type ChatFn } from './engine'
import { MEMORY_LONGTERM_LIMIT, MEMORY_DIARY_DAYS, type FreeMemory, type TavernMessage, type FreeCharacter, type VarKey, type VarValues, type VarChange } from './types'
import { buildVarExtractSystem, buildVarExtractUser, parseVarsFromText, applyVarOps } from './vars'

/** 把时间戳格式化成「YYYY-MM-DD」（日记用） */
export function formatDate(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 六栏档案的存在意义、各栏行为、以及两条不容违反的规矩（对外导出便于测试与 UI 展示） */
/** 总结提示词里用到的字数约束（来自控制面板；不传即内置默认） */
export type SummaryLimits = { longTermLimit?: number; diaryDays?: number }

export function buildSummarySystem(charName: string, now = Date.now(), limits: SummaryLimits = {}): string {
  const longTermLimit = limits.longTermLimit ?? MEMORY_LONGTERM_LIMIT
  const diaryDays = limits.diaryDays ?? MEMORY_DIARY_DAYS
  return `你是「${charName}」的长期记忆档案员。请把〖旧档案〗与〖新发生的对话〗合并，重写出一份完整的六栏档案。

〖当前日期〗${formatDate(now)}
（日记里凡涉及日期，一律用这个日期换算，不要写「XX月XX日」这类占位符。）

〖六栏各自的规矩 —— 硬要求，不要一刀切〗
- 一、长期摘要：**会缩**。已解决、已过期的旧事压掉，只留仍影响当下的。不超过 ${longTermLimit} 字。
- 二、关键事实：**只增不改**。**已经发生过**的事（Ta 亲历或确认过的）一律保留，除非新对话明确推翻它。
- 三、关系状态：**每次重新判断**。写 Ta 与每个人**此刻**的温度、近况与情绪（情绪写在这一栏）。
- 四、未爆的雷：**只增不改**。只写「埋着还没用上的伏笔 / 秘密 / 未说出口的事」——
  已经点破的、已经发生的都不算。确实没有就写「暂无」，不要写「结果尚不确定」这类空话。
- 五、纪念日与待办：可增可清。
- 六、最近日记：**倒序（新的在上）**，每条一行，格式 \`- MM-DD：一句话\`，最多保留最近 ${diaryDays} 条。

〖边界：这份档案只记「发生过什么」，不写「Ta 是谁」〗
- 记忆与设定是两件事：**记忆 = 发生过什么 + 此刻的温度**；**设定 = 由这些事得出的定义**
  （身份、职业、性格、关系的定称）。定义写在角色卡里、由作者在「更新设定」里逐条裁决 ——
  你**不要**在这份档案里写定称，那只是把角色卡重复一遍，白占篇幅。
- ✅ 该写：「楚楠提了分手，Ta 没答应也没拒绝，在便利店坐到打烊」（事件）
      「此刻对楚楠：说不清，见面会绕开」（温度）
- ❌ 不该写：「与楚楠是前男女朋友关系」这类**关系定称**、「Ta 现在是店长」这类**身份 / 职业定称**、
      「Ta 嘴硬心软」这类**性格定称** —— 角色卡里已经写着，这里再写一遍就是重复。
- 角色卡里的稳定属性（出身、身份、职业、外貌、口癖、性格）**一律不要复述**。
- 唯有一条例外：某件事**改变了** Ta 的处境或对某人的态度 → 照写，但要写成「因为…所以此刻…」
  （带出因果与时间），而不是顺手给出一个新的定称。

〖三条不容违反〗
1. 这份档案是「${charName} 记得什么」，不是全知档案 —— **Ta 不知道的事绝不能进「长期摘要」与「关键事实」**，
   只能放在「未爆的雷」里。
2. **以〖角色背景〗为事实基准**：Ta 叫什么、在哪工作、什么性格，一律以角色背景为准；
   对话里没提到的细节不要臆断补全，更不要把背景里的设定改写成别的（例如把「便利店」写成「咖啡店」）。
3. 只输出档案本身，不要寒暄、不要解释、不要在结尾加总结语。

输出格式（标题一字不差，内容另起一行写在标题下面）：
〖一、长期摘要〗

〖二、关键事实〗

〖三、关系状态〗

〖四、未爆的雷〗

〖五、纪念日与待办〗

〖六、最近日记〗`
}

export type SummarizeArgs = {
  charId: string
  charName: string
  /** 旧档案（首次总结传 null） */
  prev: FreeMemory | null
  /** 需要吸收的对话（水位线之后的） */
  messages: TavernMessage[]
  /**
   * 角色背景（角色卡的世界 + 内核等要点）。
   * 不给的话，模型只能凭对话臆断Ta 是谁、在哪 —— 实测会把「便利店」总结成「咖啡店」，
   * 记忆于是从第一次总结就开始漂移。
   */
  charContext?: string
  /** 单独指定的总结模型；不传则回退全局活动模型 */
  providerId?: string
  chatFn?: ChatFn
  signal?: AbortSignal
  now?: number
  /** 字数约束（控制面板）；不传即内置默认 */
  limits?: SummaryLimits
}

/** 把待总结的对话渲染成提示词片段（用户发言标〖对方〗，角色发言标名字） */
export function renderTranscript(charName: string, messages: TavernMessage[]): string {
  return messages
    .filter(m => m.role !== 'system' && m.content.trim())
    .map(m => `${m.role === 'user' ? '〖对方〗' : `〖${charName}〗`}${m.content.trim()}`)
    .join('\n')
}

/**
 * 跑一次总结。**不落库**（调用方决定何时写回、并推进水位线）。
 * 失败会抛出（调用方据此保留旧档案，绝不写入半截结果）。
 */
export async function summarizeMemory(args: SummarizeArgs): Promise<FreeMemory> {
  const { charId, charName, prev, messages, charContext, providerId, chatFn, signal, now = Date.now(), limits } = args
  if (messages.length === 0) return prev ?? emptyMemory(charId)

  const { provider } = await resolveTavernProvider(providerId ? { providerId } : undefined)
  const runChat = chatFn ?? chat

  const msgs: ChatMessage[] = [
    { role: 'system', content: buildSummarySystem(charName, now, limits) },
    {
      role: 'user',
      content: [
        charContext?.trim() ? '〖角色背景〗\n' + charContext.trim() : '',
        '',
        '〖旧档案〗',
        memoryToText(prev ?? emptyMemory(charId)),
        '',
        '〖新发生的对话〗',
        renderTranscript(charName, messages),
        '',
        '请输出合并后的完整六栏档案。',
      ].join('\n'),
    },
  ]

  const reply = await runChat(provider, msgs, {
    timeoutMs: CHAT_TIMEOUT_MS,
    signal,
    // 总结要的是「忠实」，不是「发挥」—— 与结构化任务同档低温
    temperature: JSON_TASK_TEMPERATURE,
    // 角色扮演关思考是为了「像人说话」；总结是整理活儿，同样不需要思考链
    think: false,
  })

  return parseMemoryText(reply, charId, prev)
}

/**
 * 冷启动用的提示词：在总结提示词之后追加一段「这是第一次建档」的说明。
 *
 * 为什么不能直接用总结提示词：那套说明假定「有旧档案 + 有新对话」，冷启动两者都没有 ——
 * 不换口径的话模型会去编一段"最近发生的事"。这里明确要求**只依据角色背景**，
 * 并把六栏各自的第一个版本该写什么讲清楚。
 */
export function buildColdStartSystem(charName: string, now = Date.now(), limits: SummaryLimits = {}): string {
  const tail = [
    '',
    '〖这一次特殊：这是**第一次建档**（这个角色还没有和任何人聊过）〗',
    '请**只依据〖角色背景〗**写出第一版档案，不要编造没有发生过的事。',
    '注意：**此刻还没有任何事件可记** —— 这一版写的是「起点状态」，不是「发生过什么」。',
    '- 一、长期摘要：Ta 眼下是什么处境（两三句；别把角色卡的身份栏抄一遍）。',
    '- 二、关键事实：**留「（还没有发生过任何事）」** —— 出身 / 身份 / 职业 / 外貌这些**定义性属性**',
    '  留在角色卡里，不在这里复述；等真的发生过什么，再往这一栏里记。',
    '- 三、关系状态：Ta 与背景里出现的每个人此刻的温度（谁亲近、谁生分、谁在回避）。',
    '- 四、未爆的雷：背景里明确写着「Ta 不知道 / 说不出口 / 压着」的事；确实没有就写「暂无」。',
    '- 五、纪念日与待办：背景里提到的固定日子；没有就写「暂无」。',
    '- 六、最近日记：留空 —— 只写一个「-」，不要写任何事件。',
  ].join('\n')
  return buildSummarySystem(charName, now, limits) + tail
}

export type ColdStartArgs = {
  charId: string
  charName: string
  /** 角色卡四章全文（renderFreeCharacter 的输出） */
  charContext: string
  providerId?: string
  chatFn?: ChatFn
  signal?: AbortSignal
  now?: number
  limits?: SummaryLimits
}

/**
 * 冷启动记忆：刚建好 / 刚导入的角色卡，还没有任何对话。
 *
 * **不落库**；六栏解析为空时抛错（调用方据此回落到 draftMemoryFromCard）。
 * 老大 2026-09-14 定：导入的角色卡不该是空记忆 —— 卡片里已经写着 Ta 是谁、跟谁什么关系、
 * 什么说不出口，这些正是第一版档案该有的东西。
 */
export async function coldStartMemory(args: ColdStartArgs): Promise<FreeMemory> {
  const { charId, charName, charContext, providerId, chatFn, signal, now = Date.now(), limits } = args
  const { provider } = await resolveTavernProvider(providerId ? { providerId } : undefined)
  const runChat = chatFn ?? chat

  const msgs: ChatMessage[] = [
    { role: 'system', content: buildColdStartSystem(charName, now, limits) },
    {
      role: 'user',
      content: ['〖角色背景〗', String(charContext ?? '').trim(), '', '请写出第一版六栏档案。'].join('\n'),
    },
  ]

  const reply = await runChat(provider, msgs, {
    timeoutMs: CHAT_TIMEOUT_MS,
    signal,
    temperature: JSON_TASK_TEMPERATURE,
    think: false,
  })

  const parsed = parseMemoryText(reply, charId, null)
  if (isMemoryEmpty(parsed)) throw new Error('冷启动记忆解析为空（模型没按六栏输出）')
  return parsed
}

/** 从卡片文本里取某个「字段名：值」那一行的值（角色卡里各字段就是一行一个前缀） */
function lineOf(text: string, prefix: string): string {
  const lines = String(text ?? '').split('\n')
  const hit = lines.find(l => l.trim().startsWith(prefix))
  if (!hit) return ''
  return hit.trim().slice(prefix.length).replace(/^[：:]\s*/, '').trim()
}

function clip(text: string, n: number): string {
  const t = String(text ?? '').trim()
  return t.length <= n ? t : t.slice(0, n) + '…'
}

/**
 * 确定性兜底：**不调模型**，直接从角色卡映射出一版六栏。
 *
 * 什么时候用：没有可用模型、或冷启动调用失败（额度用尽 / 模型不听话）。
 * 价值是「有总比空着强」—— 处境、既有关系、说不出口的事，本来就能从卡片里直接读到；
 * 而且这份东西**用户在角色卡片页可以手改**。所以第一行明确标注它是初版。
 */
export function draftMemoryFromCard(c: FreeCharacter): FreeMemory {
  const mem = emptyMemory(c.id)
  const p = c.profile ?? ({} as FreeCharacter['profile'])
  const core = String(p.core ?? '')
  return {
    ...mem,
    longTerm: ['（初版 · 直接摘录角色卡，尚未经 AI 整理）', clip(c.world, 600)].filter(Boolean).join('\n'),
    facts: [p.externals, lineOf(core, '出身'), lineOf(core, '想要什么')]
      .map(x => String(x ?? '').trim()).filter(Boolean).join('\n'),
    relation: String(p.relations ?? '').trim()
      ? '（初版：还没有互动记录，下面是角色卡里的既有关系）\n' + String(p.relations).trim()
      : '',
    mines: [lineOf(core, '不肯说出口的事'), lineOf(core, '真正害怕失去什么')]
      .map(x => String(x ?? '').trim()).filter(Boolean).join('\n'),
    anniversaries: '',
    diaries: '',
  }
}

// ==================== 本场数值（与记忆整理同一次触发） ====================

export type ExtractVarsArgs = {
  /** 启用中的变量键。空数组 → 直接返回，不调模型 */
  keys: VarKey[]
  /** 当前值 */
  values: VarValues | undefined
  /** 要吸收的对话（与记忆同一批：水位线之后的） */
  messages: TavernMessage[]
  /** 说话人名字（多角色时给「谁在说」的标注） */
  nameOf?: (id?: string) => string
  /** 这一场的剧本目标（有就带上，进度才有锚） */
  goal?: string
  /** 单次变化幅度上限（控制面板） */
  maxStep?: number
  providerId?: string
  chatFn?: ChatFn
  signal?: AbortSignal
}

/**
 * 读一遍这段对话，算出「本场数值」有没有变。**不落库**（调用方决定写回）。
 *
 * 【为什么单开一次调用，而不是让扮演回复自己带一行记账】
 * 实测（真模型探针，2026-09-15）：把记账要求塞进每轮回复里，遵守率极低
 * ——三次跑分别是 1/6、0/6、0/6，作者只会以为「数值功能坏了」。
 * 而单开一次「只干这一件事」的调用反而干净：它不用跟那 3.5KB 格式协议抢注意力。
 * 代价是多一次轻量调用，所以它与**记忆整理同一次触发**（同一个水位线窗口），
 * 不额外增加触发频率。
 *
 * 失败会抛出 —— 调用方 catch 掉即可：数值算不出来，这一场照样能继续演。
 */
export async function extractSessionVars(args: ExtractVarsArgs): Promise<{ values: VarValues; changes: VarChange[] }> {
  const { keys, values, messages, nameOf, goal, providerId, chatFn, signal, maxStep = 5 } = args
  if (keys.length === 0 || messages.length === 0) return { values: values ?? {}, changes: [] }
  const { provider } = await resolveTavernProvider(providerId ? { providerId } : undefined)
  const runChat = chatFn ?? chat
  const msgs: ChatMessage[] = [
    { role: 'system', content: buildVarExtractSystem(keys, { maxStep }) },
    {
      role: 'user',
      content: buildVarExtractUser({ values, keys, goal, transcript: renderVarsTranscript(messages, nameOf) }),
    },
  ]
  const reply = await runChat(provider, msgs, {
    timeoutMs: CHAT_TIMEOUT_MS,
    signal,
    // 抽取是结构化任务，与总结同档低温
    temperature: JSON_TASK_TEMPERATURE,
    think: false,
  })
  const ops = parseVarsFromText(reply, keys)
  return applyVarOps(values ?? {}, ops, { maxStep })
}

/** 把这一段对话渲染成抽取用的片段（用户发言标〖对方〗，其余标说话人名字） */
export function renderVarsTranscript(messages: TavernMessage[], nameOf?: (id?: string) => string): string {
  return messages
    .filter(m => m.role !== 'system' && m.content.trim())
    .map(m => `${m.role === 'user' ? '〖对方〗' : `〖${nameOf?.(m.speakerId) || '角色'}〗`}${m.content.trim()}`)
    .join('\n')
}

export { isCancelled }

