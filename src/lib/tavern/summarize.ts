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
import { parseMemoryText, memoryToText, emptyMemory } from './memory'
import { resolveTavernProvider, type ChatFn } from './engine'
import { MEMORY_LONGTERM_LIMIT, MEMORY_DIARY_DAYS, type FreeMemory, type TavernMessage } from './types'

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
- 二、关键事实：**只增不改**。已确立的事实一律保留，除非新对话明确推翻它。
- 三、关系状态：**每次重新判断**。写此刻的关系与情绪（情绪写在这一栏）。
- 四、未爆的雷：**只增不改**。只写「埋着还没用上的伏笔 / 秘密 / 未说出口的事」——
  已经点破的、已经发生的都不算。确实没有就写「暂无」，不要写「结果尚不确定」这类空话。
- 五、纪念日与待办：可增可清。
- 六、最近日记：**倒序（新的在上）**，每条一行，格式 \`- MM-DD：一句话\`，最多保留最近 ${diaryDays} 条。

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

export { isCancelled }
