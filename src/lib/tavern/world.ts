/**
 * 酒馆模式 · 背景设定（路线图第 5 批，老大 2026-09-14 定制方案）
 *
 * 【要解决的问题】
 * 剧情推演时，「世界」那一层是**直接把项目资料铺进上下文**的 —— 世界观、势力、人物、伏笔
 * 一次全上，几千字打底，而且每轮都重复。作者真正需要的是：**把已有的资料精简整合成一份背景**，
 * 只在相关的时候带上，而不是每次喂一大堆。
 *
 * 【做法】
 * 两个模式各自一份（`WorldScope = 'plot' | 'free'`），结构相同：
 *   · `brief`：一句话总纲（时代 / 地点 / 基调）—— 最先注入，模型先抓住大基调
 *   · `sections`：分节正文（3–6 节，每节 ≤300 字）
 *   · `keywords`：**命中才注入**（如「便利店」「城南」）。为空 = 总是注入。
 *
 * 【数据归属】按模式分开，与既有会话归属一致：
 *   · plot → **随项目**（`db.getSetting`，自动带项目前缀）—— 它描述的就是这本书的世界；
 *   · free → **跨项目**（`db.getMeta`）—— 自由对话自成一套，不绑某一本书。
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

/** 两个模式各自一份背景设定 */
export type WorldScope = 'plot' | 'free'

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

const K_PLOT = 'tavern.world'
const K_FREE = 'tavern.world.free'

export function isEmptyWorld(w: WorldSetting | null | undefined): boolean {
  if (!w) return true
  return !w.brief.trim() && !w.sections.some(s => s.body.trim() || s.title.trim())
}

/** 读（读不到就是空设定，不抛） */
export async function getWorldSetting(scope: WorldScope): Promise<WorldSetting> {
  try {
    const raw = scope === 'plot'
      ? await db.getSetting<Partial<WorldSetting> | null>(K_PLOT, null)
      : await db.getMeta<Partial<WorldSetting> | null>(K_FREE, null)
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
export async function saveWorldSetting(scope: WorldScope, w: WorldSetting): Promise<WorldSetting> {
  const next: WorldSetting = { ...w, updatedAt: Date.now() }
  if (scope === 'plot') await db.setSetting(K_PLOT, next)
  else await db.setMeta(K_FREE, next)
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

export function buildWorldDraftSystem(scope: WorldScope): string {
  const head = scope === 'plot'
    ? [
        '你在为一部小说做**背景设定卡**：把下面这份〖项目资料〗精简整合成一份可直接使用的背景设定。',
        '',
        '〖为什么必须精简〗',
        '这份背景设定会**每一轮都进模型的上下文**。把资料原样搬过去，等于每轮都烧掉几千字额度，',
        '对话历史反而被挤没了。所以你的任务是「提炼」不是「摘抄」：留下会影响人物言行的东西，',
        '删掉背景板式的描述。',
      ].join('\n')
    : [
        '你在为一段角色扮演对话做**背景设定卡**：根据作者给出的〖基础信息〗，把它扩展成一份可用的背景设定。',
        '',
        '〖扩展的边界〗',
        '只能**顺着作者给的信息**扩展：地点、氛围、规矩、人物之间已经存在的关系。',
        '作者没提的重大设定（身世、历史事件、结局走向）一律不要替他定 —— 那是他的故事。',
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
  scope: WorldScope
  /** 自由模式：作者填的基础信息；剧情模式：备注（可为空） */
  seed: string
  /** 剧情模式：项目资料（由调用方用 buildProjectContext 取；自由模式传空） */
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
  const { scope, seed, projectDigest, providerId, chatFn, signal } = args
  const material = scope === 'plot' ? String(projectDigest ?? '').trim() : String(seed ?? '').trim()
  if (!material) throw new Error(scope === 'plot' ? '没有可提炼的项目资料' : '请先填基础信息（时代 / 地点 / 基调 / 主要人物等）')

  const { provider } = await resolveTavernProvider(providerId ? { providerId } : undefined)
  const runChat = chatFn ?? chat

  const fence = newAuthorFence()
  const msgs: ChatMessage[] = [
    { role: 'system', content: buildWorldDraftSystem(scope) },
    {
      role: 'user',
      content: [
        scope === 'plot' ? '〖项目资料〗' : '〖基础信息（作者填写）〗',
        authorBlock(fence, material),
        '',
        seed.trim() && scope === 'plot' ? `〖作者的额外要求〗\n${seed.trim()}\n` : '',
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
