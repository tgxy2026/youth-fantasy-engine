/**
 * 酒馆模式 · 日常状态与主动性（方案 §4.7 / §7.4 / §7.5）
 *
 * 【核心矛盾与解法】
 * 真陪伴类产品靠**常驻进程**每天推进「她今天做了什么」。novel-studio 三端共用一套前端代码、
 * 没有服务端、不能后台跑任何东西 —— 所以改用**时间差推进**：
 *
 *     now - lastActiveAt ≥ 阈值（8 小时）
 *        → 生成一段「这几天的生活」追加进 log[]（只留最近若干天）
 *        → 更新 lastActiveAt = now
 *
 * 效果反而更真：因为她**真的过了几天**，而不是被定时器推着走。
 *
 * 【情绪不新增第七栏】方案已定：情绪并入记忆的「关系状态」（由总结时重判），
 * 同时把原值单独存 `DailyState.mood` 供 UI 直接显示 —— 存一份是为了让界面不必解析长文本。
 *
 * 【主动留言（§7.5）与日常推进同一次做】
 * 一次模型调用同时产出「这几天的生活」+「心情」+「她想说的一句话」：
 * 省一次往返，而且她的话能**承接**这几天发生的事，不会脱节。
 * 留言存 `tavern.free.greeting.<charId>`，展示后清除；**不做系统通知**（会引入平台分支）。
 *
 * 本文件是纯逻辑 + 提示词；读写归 store.ts。
 */
import {
  chat, CHAT_TIMEOUT_MS, isCancelled, type ChatMessage,
} from '../ai'
import { resolveTavernProvider } from './engine'
import { memoryToText, emptyMemory } from './memory'
import type { ChatFn } from './engine'
import {
  DAILY_ADVANCE_MS, type DailyState, type FreeCharacter, type FreeMemory,
} from './types'

/** 生活日志保留条数（按天一条，与日记的「最近五天」对齐） */
export const DAILY_LOG_KEEP = 5

export function emptyDaily(charId: string, now = Date.now()): DailyState {
  return { charId, lastActiveAt: now, log: [], mood: undefined }
}

/** 是否该推进「这几天的生活」（方案 §4.7：间隔 ≥ 8 小时） */
export function shouldAdvanceDaily(
  d: DailyState | null | undefined,
  now = Date.now(),
  advanceMs = DAILY_ADVANCE_MS,
): boolean {
  if (!d) return false
  if (!d.lastActiveAt) return false
  return now - d.lastActiveAt >= advanceMs
}

/** 距上次活跃过了几天（至少 1 —— 只在超过阈值时才会被调用） */
export function daysSince(lastActiveAt: number, now = Date.now()): number {
  return Math.max(1, Math.floor((now - lastActiveAt) / 86_400_000))
}

/** 把时间戳格式化成 MM-DD（日志条目用） */
function mmdd(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 日常推进的系统提示词。
 * 与总结引擎同一个教训：**必须给当前日期**，否则日志会写成「XX月XX日」这类占位符。
 */
export function buildDailySystem(charName: string, now = Date.now()): string {
  const d = new Date(now)
  const today = `${d.getFullYear()}-${mmdd(now)}`
  return `你在为「${charName}」补写她**没见面这段日子里的生活**。

【今天】${today}

【你要输出三段，标题一字不差】
【这几天的生活】
- MM-DD：一句话（只写她自己的日常，具体、生活化、有一两个细节）
（一天一条，最多 ${DAILY_LOG_KEEP} 条，**倒序，最新的在最上面**；日期用上面那个今天往前推算）

【她的心情】
用两到四个字概括她此时的心情（例：平静 / 有点烦 / 隐隐期待）。不要写句子。

【她想说的话】
一句话 —— 很久没见了，她见到对方时会先说什么。
要求：符合她的说话风格（见背景），可以带动作，但**不要写成作文**，
不要问「你这几天去哪了」这类质问（方案要求：温和，不施压）。
如果以她的性格根本不会主动开口，就写「（无）」。

【三条硬要求】
1. 生活内容要**具体**（她做了什么、遇到了什么小麻烦），不要写「像往常一样」这类空话。
2. 严格贴着她的性格与能力边界 —— 她「做不到的事」里写了的，就不要让她做到。
3. 只输出这三段，不要寒暄、不要解释。`
}

export type AdvanceArgs = {
  char: FreeCharacter
  prev: DailyState | null
  memory: FreeMemory | null
  /** 单独指定模型；不传回退全局活动模型 */
  providerId?: string
  chatFn?: ChatFn
  signal?: AbortSignal
  now?: number
}

export type AdvanceResult = {
  /** 追加了这几天日志、刷新了 lastActiveAt 的新状态 */
  state: DailyState
  /** 她想说的话；空串表示这次没有（性格使然或模型给了「（无）」） */
  greeting: string
}

/**
 * 段落标题的匹配规则（整行匹配，允许【】包裹、允许「一、」这类序号）。
 * 每条都给几个常见别名 —— 模型不一定会照抄我们给的标题。
 */
const SECTION_TITLES = {
  log: /^(这几天的生活|最近的生活|日常生活|生活|日常)$/,
  mood: /^(她的心情|现在的心情|心情|情绪)$/,
  say: /^(她想说的话|想说的一句话|想说的话|留言|第一句话)$/,
} as const

export type DailyParsed = {
  log: { date: string; text: string }[]
  mood: string
  greeting: string
}

/**
 * 解析模型输出（容错：标题宽松匹配；缺段不报错而是留空）。
 * 「（无）」视为没有留言 —— 这是提示词里约定的表达方式，不是内容。
 */
export function parseDailyReply(text: string): DailyParsed {
  const raw = String(text ?? '').replace(/\r\n/g, '\n')
  let section: 'log' | 'mood' | 'say' | null = null
  const logLines: string[] = []
  let mood = ''
  let say = ''

  const push = (sec: 'log' | 'mood' | 'say', body: string) => {
    if (sec === 'log') logLines.push(body)
    else if (sec === 'mood') { if (!mood) mood = body }
    else say = say ? `${say}\n${body}` : body
  }

  /** 这一行（去掉序号与包裹符号后）是不是某个段落标题 */
  const titleOf = (line: string): 'log' | 'mood' | 'say' | null => {
    const bare = line.replace(/[\s*#]/g, '')
      .replace(/^[一二三四五六]、/, '')
      .replace(/^\d+[.、]/, '')
      .replace(/^[【\[（(]+/, '')
      .replace(/[】\]）)]+$/, '')
    if (SECTION_TITLES.log.test(bare)) return 'log'
    if (SECTION_TITLES.mood.test(bare)) return 'mood'
    if (SECTION_TITLES.say.test(bare)) return 'say'
    return null
  }

  for (const line of raw.split('\n')) {
    const body = line.trim()
    if (!body) continue
    // ① 整行就是标题
    const whole = titleOf(body)
    if (whole) { section = whole; continue }
    // ② 「【她的心情】有点烦」——标题与内容挤在同一行。
    //    模型很爱这么写，若不切开，标题行会被当成日志内容丢掉、后续内容还会串段。
    const m = body.match(/^[【\[（(]\s*([^】\]）)]+?)\s*[】\]）)]\s*(.*)$/)
    if (m) {
      const hit = titleOf(m[1])
      if (hit) {
        section = hit
        const rest = m[2].trim()
        if (rest) push(hit, rest)
        continue
      }
    }
    // ③ 普通内容行
    if (section) push(section, body)
  }

  const log = logLines
    .map(l => {
      const m = l.match(/^[-·•]?\s*(\d{2}-\d{2})\s*[：:]\s*(.+)$/)
      if (m) return { date: m[1], text: m[2].trim() }
      // 没有日期前缀（模型偶尔省略）：留空日期，由调用方补今天
      const t = l.replace(/^[-·•]\s*/, '').trim()
      return t ? { date: '', text: t } : null
    })
    .filter((x): x is { date: string; text: string } => !!x && !!x.text)
    .slice(0, DAILY_LOG_KEEP)

  const cleanSay = say.trim()
  const isNone = /^[（(]?\s*(无|没有|暂无)\s*[）)]?$/.test(cleanSay.replace(/\s/g, ''))
  return { log, mood: mood.replace(/[。.]$/, '').slice(0, 8), greeting: isNone ? '' : cleanSay }
}
/**
 * 跑一次日常推进 + 生成留言。**不落库**（调用方决定何时保存、何时投递留言）。
 * 失败会抛出（调用方保留旧状态即可，下次打开还会再试）。
 */
export async function advanceDaily(args: AdvanceArgs): Promise<AdvanceResult> {
  const { char, prev, memory, providerId, chatFn, signal, now = Date.now() } = args
  const { provider } = await resolveTavernProvider(providerId ? { providerId } : undefined)
  const runChat = chatFn ?? chat

  const base = prev ?? emptyDaily(char.id, now)
  const days = daysSince(base.lastActiveAt, now)

  const user = [
    '【她的角色卡】',
    `名字：${char.name}`,
    char.world.trim() ? `世界：${char.world.trim()}` : '',
    char.profile.core.trim() ? `内核：${char.profile.core.trim()}` : '',
    char.profile.speech.trim() ? `语言特征：${char.profile.speech.trim()}` : '',
    char.profile.cannot.trim() ? `做不到的事：${char.profile.cannot.trim()}` : '',
    char.profile.knowledge.trim() ? `知识边界：${char.profile.knowledge.trim()}` : '',
    '',
    '【她的长期记忆（含关系状态）】',
    memory ? memoryToText(memory) : memoryToText(emptyMemory(char.id)),
    '',
    `【时间线】距上次见面已经过了 ${days} 天。`,
    base.log.length ? `【之前几天的记录（供你接着写，不要重复）】\n${base.log.map(l => `- ${l.date}：${l.text}`).join('\n')}` : '',
    '',
    `请补写这 ${days} 天里她的生活，并给出她此刻的心情与想说的话。`,
  ].filter(Boolean).join('\n')

  const msgs: ChatMessage[] = [
    { role: 'system', content: buildDailySystem(char.name, now) },
    { role: 'user', content: user },
  ]

  const reply = await runChat(provider, msgs, {
    timeoutMs: CHAT_TIMEOUT_MS,
    signal,
    // 这是**创作**（写她的日常），不是整理 —— 用默认创作温度更生动；思考链则不需要
    think: false,
  })

  const parsed = parseDailyReply(reply)

  // 日志按天累加：新的在前，旧的接在后面，只留最近 N 条
  const fresh = parsed.log.map(l => ({ date: l.date || mmdd(now), text: l.text }))
  const merged = [...fresh, ...base.log]
  // 同日去重（同一天重复推进时不叠加）
  const seen = new Set<string>()
  const log = merged.filter(l => (seen.has(l.date) ? false : (seen.add(l.date), true))).slice(0, DAILY_LOG_KEEP)

  return {
    state: {
      charId: char.id,
      lastActiveAt: now,
      log,
      mood: parsed.mood || base.mood,
    },
    greeting: parsed.greeting,
  }
}

export { isCancelled }
