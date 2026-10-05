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
// 🔴 从 provider 取、**别从 engine 取**：engine 反向 import 本文件，绕 engine 会形成循环依赖
import { resolveTavernProvider, type ChatFn } from './provider'
import { prepareDraftMaterial, type DraftSource } from './draft'
import { webSearch, type SearchSettings } from '../webSearch'
import type { TavernMessage } from './types'
import { buildWorldBookText, type WorldEntry, type EntryState } from './worldBook'

/**
 * 一节背景设定。
 *
 * 【2026-10-05 W3：升级为「词条」，可选的四个字段 = 世界书能力】
 *   原本只有 `id/title/body`，整份设定共用一个 `keywords`（命中才整份注入）。
 *   现在每节可以**自己**带关键词与概率 —— 这就是 ST 世界书的条目级粒度。
 *
 * 🔴 **四个新字段全部可选**：老数据读出来仍是 `{id,title,body}`，
 *    `keys` 缺省 = 空 = **总是注入**，于是「老数据」的行为与升级前**逐字一致**。
 *    这条是等价性红线 —— 见 `worldBook.ts` 文件头的说明。
 */
export type WorldSection = {
  id: string
  title: string
  body: string
  /** 本节自己的触发关键词；为空 = 总是注入（缺省即如此 ⇒ 老数据行为不变） */
  keys?: string[]
  /** 触发概率 0–1（缺省 1 = 必中） */
  prob?: number
  /** 排序权重（缺省 = 数组下标） */
  order?: number
  /** 是否允许激活别的节（缺省 true） */
  recursive?: boolean
  /** 常驻标记（等价于 keys 为空，但语义更明确） */
  constant?: boolean
  /** 四色灯（缺省按 keys/constant/recursive 推断；显式给了就以它为准） */
  state?: EntryState
  /** 休眠（等价于 state:'off'，保留字段以免老数据丢失意图） */
  off?: boolean
}

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

/** 注入上限（字符）。超了**逐条取舍**并注明 —— 宁可少给，也不能把对话历史挤没。
 *  2026-09-15 由 1800 提到 2400：上下文预算同时提到 24000，这一层多占的额度从预算里出得起。
 *  2026-10-05：改为**按当前模型窗口动态计算**（见 `quotas.ts` 的 `fixedQuotaOf`）。
 *  下面这个常量降级为「拿不到窗口时的兜底」，不再直接用于截断。 */
export const WORLD_MAX_CHARS = 2400

/**
 * 一句话总纲的条目 id —— **固定层**的判据（见 `buildPlotWorldBook` 的两层渲染）。
 * 🔴 全项目唯一真源：`worldEntriesOf` 用它造条目，`buildPlotWorldBook` 用它分层。
 */
export const WORLD_BRIEF_ID = 'world-brief'

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
          .map((s): WorldSection => {
            const r = s as Record<string, unknown>
            const out: WorldSection = {
              id: String(r.id ?? uid()),
              title: String(r.title ?? ''),
              body: String(r.body ?? ''),
            }
            // 🔴 世界书字段**只在原数据里存在时才回填** —— 老数据不该被塞进新键
            //    （否则「没填过关键词」会变成「填了空数组」，两者在本文件语义相同但落盘不同，
            //     会让后续的「是否升级过」判断失真）。
            if (Array.isArray(r.keys)) out.keys = r.keys.map(k => String(k)).filter(Boolean)
            if (typeof r.prob === 'number' && Number.isFinite(r.prob)) out.prob = r.prob
            if (typeof r.order === 'number' && Number.isFinite(r.order)) out.order = r.order
            if (r.recursive !== undefined) out.recursive = !!r.recursive
            if (r.constant !== undefined) out.constant = !!r.constant
            // 四色灯：只在原数据里存在时回填（同上面的「不凭空塞新键」原则）
            if (r.state === 'on' || r.state === 'hit' || r.state === 'ref' || r.state === 'off') out.state = r.state
            if (r.off !== undefined) out.off = !!r.off
            return out
          })
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
    parts.push(s.title.trim() ? `〖${s.title.trim()}〗\n${body}` : body)
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
  // 🔴 大小写口径必须与词条层（`worldBook.entryHits` 两侧都 toLowerCase）一致 ——
  //    否则同一个关键词可能在「整份闸」判不中、在「词条闸」判中（或反之），
  //    作者会看到「明明提到了却一条都不注入」。
  const h = String(haystack ?? '').toLowerCase()
  return keys.some(k => h.includes(k.toLowerCase()))
}

/**
 * 这条消息算不算「可取材」的那批（会进上下文的）—— **单一真源**。
 *
 * 🔴 `system` 不进上下文（它是装配出来的，不是历史），作者**隐藏**的也不进
 *   （`prompt.ts` 的 `toChatMessages` 与 `memory.ts` 的水位线都跳它们）。
 *   凡是"拿历史消息做判定/做文本"的地方都要过这里 —— 别在各自调用点再判一次：
 *   判漏一处，作者特意藏起来的内容就会从那儿漏出去（世界书关键词 / 语义索引都是这个道理）。
 */
export function isUsableMessage(m: TavernMessage): boolean {
  return m.role !== 'system' && !m.hidden
}

/**
 * 关键词判定取材的「最近消息」部分：**只取真正会进上下文的消息**。
 *
 * 🔴 必须滤掉 `system` 与作者**隐藏**的消息（2026-09-23 六维审计 P1）：
 *    原先 engine 那边直接 `messages.slice(-6).map(m => m.content)`，与全项目口径
 *    （prompt.ts / memory.ts / report.ts / revise.ts / summarize.ts 都滤）不一致 ——
 *    作者特意藏起来的内容仍会影响「要不要注入背景设定」的判定。
 *    收进这里而不是留在调用点：让「滤什么」与 `shouldInjectWorld` 放在一起，调用方不必记。
 */
export function keywordHaystackMessages(messages: readonly TavernMessage[], take = 6): string[] {
  return messages.filter(isUsableMessage).slice(-take).map(m => m.content)
}

/** 关键词命中判定的取材：会话标题 + 场景 + 最近几条消息（别扫全史，太贵也没必要） */
export function worldHaystack(parts: (string | undefined)[], recent: string[] = []): string {
  return [...parts.filter(Boolean), ...recent].join('\n')
}

// ==================== 世界书（W3，2026-10-05） ====================
//
// 【本模式的世界书有两种粒度，同时生效】
//   ① **整份开关**（既有）：`WorldSetting.keywords` 为空 = 总是注入；否则命中才整份注入。
//      这是「不每次喂一大堆」的第一道闸，老作者已经按这个用法填了数据，**必须保留**。
//   ② **词条级开关**（本轮新增）：每节自己的 `keys` / `prob` / `order` / `recursive`。
//      粒度更细 —— 提到「城南」只带城南那一节，不是整份。
//
// 【两道的合成规则（关键，别搞混）】
//   · ① 判「整份要不要带」：`shouldInjectWorld` 为 false ⇒ 一条都不带（省下全部额度）
//   · ① 通过后，② 已在 `worldEntriesOf` 里**把整份开关折算进每条词条**：
//     一份「有整份 keywords 的设定」在通过①之后，其内部**没有自己 keys 的节**
//     仍然要全带（否则作者设了整份闸、内部又没设词条闸 → 结果一条都不带，是明显的退化）。
//   折算方式：整份 keywords 非空时，把缺失自身 keys 的节补成「常驻」—— 因为它们已经在
//   ①那一层被筛过一次了，进到这里就该出现。
//
// 【老数据的行为】sections 里没有 keys / 整份 keywords 为空 ⇒ 全部节常驻 ⇒
//   渲染结果与升级前的 `worldToText` 逐字一致（等价性红线）。

/** `WorldSetting.sections` → `WorldEntry[]`（供世界书判据用） */
export function worldEntriesOf(w: WorldSetting | null | undefined): WorldEntry[] {
  if (!w) return []
  const hasGlobalKeys = w.keywords.map(k => k.trim()).filter(Boolean).length > 0
  const out: WorldEntry[] = []

  // 🔴 `brief`（一句话总纲）必须进池，且**总是注入**、排在最前。
  //    它是这一层最高优先级的定调（时代 / 地点 / 基调），旧 `worldToText` 也是先渲染它。
  //    漏掉它会静默丢掉整份设定 —— 2026-10-05 实测踩过：只填 brief 的设定会渲染成空串，
  //    连带 budget 的「背景设定占 1800 字」分配全部归零（tavernUsage 三条断言当场变红）。
  //    `order: -1` 保证它排在任何 section 之前（作者没显式给 order 时）。
  const brief = String(w.brief ?? '').trim()
  if (brief) {
    out.push({
      id: WORLD_BRIEF_ID, title: '', body: brief,
      keys: [], prob: 1, order: -1, recursive: false, constant: true,
    })
  }

  w.sections.forEach((s, i) => {
    const body = (s.body ?? '').trim()
    const title = (s.title ?? '').trim()
    if (!body && !title) return
    // 🔴 折算整份闸：整份设了 keywords ⇒ 没自己 keys 的节视为常驻（已过①那一层）
    const ownKeys = (s.keys ?? []).map(k => String(k ?? '').trim()).filter(Boolean)
    const constant = s.constant ?? (hasGlobalKeys && ownKeys.length === 0 ? true : undefined)
    out.push({
      id: s.id || `sec${i}`,
      title,
      body,
      keys: ownKeys,
      prob: typeof s.prob === 'number' && Number.isFinite(s.prob) ? Math.max(0, Math.min(1, s.prob)) : 1,
      order: typeof s.order === 'number' && Number.isFinite(s.order) ? s.order : i,
      recursive: s.recursive === undefined ? true : !!s.recursive,
      constant,
      // 🔴 四色灯：**只在作者显式设过时才透传**。没设 = `undefined` ⇒ `entryStateOf` 按老语义推断
      //    （keys 空 → 常驻；recursive 关 → 引荐；其余 → 触发）。老数据行为逐字不变。
      state: s.state,
      off: s.off,
    })
  })
  return out
}

/**
 * 世界书入口（剧情模式）：整份闸 ① + 词条闸 ②，一步到位。
 *
 * 返回空串的情形（都等价于「这一层不出现」）：
 *   · 设定为空 / ① 整份关键词未命中
 *   · ② 之后一条都没选中
 */
export function buildPlotWorldBook(
  w: WorldSetting | null | undefined,
  haystack: string,
  opts: { rand?: () => number; maxChars?: number; fixedMaxChars?: number } = {},
): { text: string; hits: WorldEntry[]; skippedByProb: string[]; dropped: WorldEntry[] } {
  const empty = { text: '', hits: [], skippedByProb: [], dropped: [] }
  if (!w || isEmptyWorld(w)) return empty
  if (!shouldInjectWorld(w, haystack)) return empty
  const pool = worldEntriesOf(w)
  if (!pool.length) return empty
  // 🔴 两层**分开渲染**（对齐 `quotas.ts` 的额度设计）：
  //    · 固定层 = 一句话总纲（`WORLD_BRIEF_ID`）—— 保存时已卡过 8% 额度，注入时不该再被词条挤掉；
  //    · 动态层 = 各节词条 —— 四色灯控制，按动态层额度逐条取舍。
  //    合池渲染的坏处很具体：小窗口下 `dynamic`（8K 时约 1229）< `fixed` 下限 2400，
  //    作者按界面提示存了 2400 字总纲，进上下文时却被砍掉一半 —— 「存得下、注不进」。
  const rf = renderLayer(pool.filter(e => e.id === WORLD_BRIEF_ID), haystack, opts.fixedMaxChars, opts)
  const rd = renderLayer(pool.filter(e => e.id !== WORLD_BRIEF_ID), haystack, opts.maxChars, opts)
  return {
    text: [rf.text, rd.text].filter(Boolean).join('\n\n'),
    hits: [...rf.hits, ...rd.hits],
    skippedByProb: [...rf.skippedByProb, ...rd.skippedByProb],
    dropped: [...rf.dropped, ...rd.dropped],
  }
}

/** 单层渲染（空池 ⇒ 空结果，整层不出现，与既有「空设定不注入」一致） */
function renderLayer(
  entries: WorldEntry[],
  haystack: string,
  maxChars: number | undefined,
  opts: { rand?: () => number },
): { text: string; hits: WorldEntry[]; skippedByProb: string[]; dropped: WorldEntry[] } {
  if (!entries.length) return { text: '', hits: [], skippedByProb: [], dropped: [] }
  const r = buildWorldBookText(entries, haystack, { ...opts, maxChars: maxChars ?? WORLD_MAX_CHARS })
  return { text: r.text, hits: r.hits, skippedByProb: r.skippedByProb, dropped: r.dropped }
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
  /** 作者粘贴的参考素材（可空）—— 例如要写民国上海，粘一段史料进来 */
  refs?: string
  /** 检索设置（不传 = 不联网） */
  searchSettings?: SearchSettings
  providerId?: string
  chatFn?: ChatFn
  signal?: AbortSignal
  /** 测试用：替换检索实现 */
  searchFn?: typeof webSearch
}

/**
 * 跑一次一键录入，产出 **WorldSetting 骨架**（不落库；调用方填 seed/draftedAt 后保存）。
 * 模型乱答时抛错，让调用方保留作者现有内容 —— 绝不写半截结果。
 */
export async function draftWorldSetting(args: WorldDraftArgs): Promise<{ fields: { brief: string; sections: WorldSection[]; keywords: string[] }; source: DraftSource }> {
  const { seed, projectDigest, providerId, chatFn, signal } = args
  const material = String(projectDigest ?? '').trim()
  if (!material) throw new Error('没有可提炼的项目资料 —— 先在项目里写点世界观 / 人物 / 势力之类的设定，或用记事本起个头也行')

  // 素材（含可选的联网检索结果）统一在 draft.ts 里裁决
  const extra = await prepareDraftMaterial({
    idea: seed,
    refs: args.refs,
    settings: args.searchSettings ?? { mode: 'off', engine: 'bocha', endpoint: '', apiKey: '', topK: 5 },
    signal,
    searchFn: args.searchFn,
  })

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
        // 🔴 作者的额外要求同样属作者原文 —— 复用同一次调用的 fence（同一任务里的多段作者文本
        //    应共用一套边界语言，见 promptGuard 的文件头）
        seed.trim() ? `〖作者的额外要求〗\n${authorBlock(fence, seed.trim())}` : '',
        extra.blocks,
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
  return { fields: parsed, source: extra.source }
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
