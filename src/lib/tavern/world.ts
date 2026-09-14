/**
 * 酒馆模式 · 背景设定（路线图第 5 批，老大 2026-09-14 定制方案）
 *
 * 【要解决的问题】
 * 剧情推演时，「世界」那一层是**直接把项目资料铺进上下文**的 —— 世界观、势力、人物、伏笔
 * 一次全上，几千字打底，而且每轮都重复。作者真正需要的是：**把已有的资料精简整合成一份背景**，
 * 只在相关的时候带上，而不是每次喂一大堆。
 *
 * 【2026-09-15 收口：只服务剧情推演】
 * 原先两种模式各一份（`plot` / `free`）。老大把 `free` 那份去掉了，理由是**自由对话本来就没有统一世界观** ——
 * 同一批对话里可能同时存在仙侠角色和赛博角色，用一份背景设定把它们框住反而不对；
 * 而且每个角色的世界观已经在**角色卡的第 1 章「世界」**里写过了，再来一份就是重复占额度。
 * 所以现在只有一份（剧情推演，随项目）。旧库里 `tavern.world.free` 那份**保留不删**（不动用户数据），
 * 只是界面与引擎都不再到它 —— 想找回来的话见 `docs/酒馆模式-工程红线.md` §9。
 *
 * 【结构】
 *   · `brief`：一句话总纲（时代 / 地点 / 基调）—— 最先注入，模型先抓住大基调
 *   · `sections`：分节正文（3–6 节，每节 ≤300 字）
 *   · `keywords`：**命中才注入**（如「便利店」「城南」）。为空 = 总是注入。
 *
 * 【数据归属】**随项目**（`db.getSetting`，自动带项目前缀）—— 它描述的就是这本书的世界，换书就是另一份。
 *
 * 【为什么要有硬上限】
 * 这一层每轮都进 system。不设上限的话，作者一路往 additions 里贴资料，
 * 迟早把对话历史挤没（表现为「它怎么忘了我刚说的话」）。所以有 `WORLD_MAX_CHARS` 截断 +
 * 界面显示字数。
 */
import * as db from '../db'
import { uid } from '../id'
import { chat, CHAT_TIMEOUT_MS, isCancelled, type ChatMessage } from '../ai'
import { parsePlainObject, asText } from '../aiParse'
import { newAuthorFence, authorBlock } from '../promptGuard'
import { resolveTavernProvider, type ChatFn } from './engine'

export type WorldSection = { id: string; title: string; body: string }

export type WorldSetting = {
  /** 一句话总纲：时代 / 地点 / 基调 */
  brief: string
  /** 分节正文（顺序即注入顺序） */
  sections: WorldSection[]
  /** 关键词命中才注入；为空 = 总是注入 */
  keywords: string[]
  /** 一键录入的输入：自由模式＝作者填的基础信息；剧情模式＝从项目资料提炼时的备注 */
  seed: string
  /** 上次 AI 录入的时间（0 = 从没跑过） */
  draftedAt: number
  updatedAt: number
}

export const EMPTY_WORLD_SETTING: WorldSetting = {
  brief: '', sections: [], keywords: [], seed: '', draftedAt: 0, updatedAt: 0,
}

/** 注入上限（字符）。超了截断并注明 —— 宁可少给，也不能把对话历史挤没 */
export const WORLD_MAX_CHARS = 1800

const K = 'tavern.world'

export function isEmptyWorld(w: WorldSetting | null | undefined): boolean {
  if (!w) return true
  return !w.brief.trim() && !w.sections.some(s => s.body.trim() || s.title.trim())
}

/** 读（读不到就是空设定，不抛） */
export async function getWorldSetting(): Promise<WorldSetting> {
  try {
    const raw = await db.getSetting<Partial<WorldSetting> | null>(K, null)
    if (!raw || typeof raw !== 'object') return EMPTY_WORLD_SETTING
    return {
      brief: String(raw.brief ?? ''),
      sections: Array.isArray(raw.sections)
        ? raw.sections
          .filter(s => s && typeof s === 'object')
          .map(s => ({ id: String(s.id ?? uid()), title: String(s.title ?? ''), body: String(s.body ?? '') }))
        : [],
      keywords: Array.isArray(raw.keywords) ? raw.keywords.map(k => String(k)).filter(Boolean) : [],
      seed: String(raw.seed ?? ''),
      draftedAt: Number(raw.draftedAt ?? 0),
      updatedAt: Number(raw.updatedAt ?? 0),
    }
  } catch {
    return EMPTY_WORLD_SETTING
  }
}

/** 写 */
export async function saveWorldSetting(w: WorldSetting): Promise<WorldSetting> {
  const next: WorldSetting = { ...w, updatedAt: Date.now() }
  await db.setSetting(K, next)
  return next
}

/** 渲染成注入用的一段文本（超上限截断并注明，别悄悄吞掉） */
export function worldToText(w: WorldSetting | null | undefined): string {
  if (!w || isEmptyWorld(w)) return ''
  const parts: string[] = []
  if (w.brief.trim()) parts.push(w.brief.trim())
  for (const s of w.sections) {
    const body = s.body.trim()
    if (!body) continue
    parts.push(s.title.trim() ? `【${s.title.trim()}】\n${body}` : body)
  }
  let text = parts.join('\n\n')
  if (text.length > WORLD_MAX_CHARS) {
    text = text.slice(0, WORLD_MAX_CHARS) + '\n（背景设定较长，此处已截断 —— 建议在「背景设定」页里精简）'
  }
  return text
}

/**
 * 该不该把这份背景设定注入这一轮？
 * 关键词为空 = 总是注入；否则命中任一关键词才注入（这是「不每次喂一大堆」的落点）。
 */
export function shouldInjectWorld(w: WorldSetting | null | undefined, haystack: string): boolean {
  if (!w || isEmptyWorld(w)) return false
  const keys = w.keywords.map(k => k.trim()).filter(Boolean)
  if (keys.length === 0) return true
  const h = String(haystack ?? '')
  return keys.some(k => h.includes(k))
}

/** 关键词命中判定的取材：会话标题 + 场景 + 最近几条消息（别扫全史，太贵也没必要） */
export function worldHaystack(parts: (string | undefined)[], recent: string[] = []): string {
  return [...parts.filter(Boolean), ...recent].join('\n')
}

// ==================== 一键录入 ====================

export function buildWorldDraftSystem(): string {
  const head = [
    '你在为一部小说做背景设定卡：把下面这份〖项目资料〗精简整合成一份可直接使用的背景设定。',
    '',
    '〖为什么必须精简〗',
    '这份背景设定会每一轮都进模型的上下文。把资料原样搬过去，等于每轮都烧掉几千字额度，',
    '对话历史反而被挤没了。所以你的任务是「提炼」不是「摘抄」：留下会影响人物言行的东西，',
    '删掉背景板式的描述。',
  ].join('\n')

  return [
    head,
    '',
    '〖输出要求〗',
    '- brief：一句话说清这个世界的时代 / 地点 / 基调（不超过 60 字）。',
    '- sections：3–6 节，每节 `title` 简短（如「时代与地理」「规矩与禁忌」「主要人物关系」），',
    '  `body` 控制在一百多字、最多不超过 300 字。**宁少勿滥**：只留会影响人物言行的内容。',
    '- keywords：3–8 个「提到它们才需要这段背景」的词（地名、势力名、行话）。',
    '  如果不该有开关（任何话题都需要这份背景），就给空数组。',
    '',
    '〖输出格式〗只输出一个 JSON 对象，不要代码块、不要解释：',
    '{"brief":"…","sections":[{"title":"…","body":"…"}],"keywords":["…"]}',
  ].join('\n')
}

export type WorldDraftArgs = {
  /** 作者的额外要求 / 备注（可为空） */
  seed: string
  /** 项目资料（由调用方用 buildProjectContext 取） */
  projectDigest?: string
  providerId?: string
  chatFn?: ChatFn
  signal?: AbortSignal
}

/**
 * 跑一次一键录入，产出 **WorldSetting 骨架**（不落库；调用方填 seed/draftedAt 后保存）。
 * 模型乱答时抛错，让调用方保留作者现有内容 —— 绝不写半截结果。
 */
export async function draftWorldSetting(args: WorldDraftArgs): Promise<{ brief: string; sections: WorldSection[]; keywords: string[] }> {
  const { seed, projectDigest, providerId, chatFn, signal } = args
  const material = String(projectDigest ?? '').trim()
  if (!material) throw new Error('没有可提炼的项目资料 —— 先在项目里写点世界观 / 人物 / 势力之类的设定，或用记事本起个头也行')

  const { provider } = await resolveTavernProvider(providerId ? { providerId } : undefined)
  const runChat = chatFn ?? chat

  const fence = newAuthorFence()
  const msgs: ChatMessage[] = [
    { role: 'system', content: buildWorldDraftSystem() },
    {
      role: 'user',
      content: [
        '〖项目资料〗',
        authorBlock(fence, material),
        '',
        seed.trim() ? `〖作者的额外要求〗\n${seed.trim()}\n` : '',
        '请按格式输出 JSON。',
      ].filter(Boolean).join('\n'),
    },
  ]

  const reply = await runChat(provider, msgs, {
    timeoutMs: CHAT_TIMEOUT_MS,
    signal,
    json: true,
    think: false,
  })

  const parsed = parseWorldDraft(reply)
  if (!parsed) throw new Error('模型没有返回可用的背景设定（没按 JSON 格式输出）')
  return parsed
}

/** 解析一键录入的结果（导出便于单测）。形状不对就返回 null，绝不猜 */
export function parseWorldDraft(raw: string): { brief: string; sections: WorldSection[]; keywords: string[] } | null {
  const o = parsePlainObject(raw)
  if (!o) return null
  const brief = asText(o.brief).trim()
  const rawSections = Array.isArray(o.sections) ? o.sections : []
  const sections: WorldSection[] = rawSections
    .filter(s => s && typeof s === 'object')
    .map(s => {
      const r = s as Record<string, unknown>
      return { id: uid(), title: asText(r.title).trim(), body: asText(r.body).trim() }
    })
    .filter(s => s.title || s.body)
    .slice(0, 8)
  const keywords = (Array.isArray(o.keywords) ? o.keywords : [])
    .map(k => asText(k).trim()).filter(Boolean).slice(0, 12)
  if (!brief && sections.length === 0) return null
  return { brief, sections, keywords }
}

export { isCancelled }
