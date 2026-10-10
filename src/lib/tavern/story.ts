/**
 * 酒馆模式 · 故事（自由对话专用）
 *
 * 【解决什么】
 * 原先「世界设定」写在每张角色卡的第1章里 —— N 张卡就是 N 份复制，改一处要改 N 处，
 * 还常常互相打架。于是把「这个世界什么样」整层抽出来，起名「故事」，与剧本构成父子结构。
 *
 * 【分工（老大 2026-09-16 定）】
 *   故事 → 这个世界的基本设定（规则 / 地理 / 势力 / 常识）
 *   剧本 → 这一个场景发生什么事（六栏）
 *   一个故事下可以有多份剧本；故事与故事之间并列。
 *
 * 【为什么数据是全局的】
 * 🔴 **全局（`db.getMeta`，跨项目）** —— 与角色卡、剧本同性质：是「玩法模板」，不绑某一本书。
 *    换项目照样用。
 *
 * 【铁律】索引与分条成对读写（同 store.ts / script.ts）：只写一边就会出现
 *        「列表里有、点开是空的」的幽灵条目。
 */
import * as db from '@/lib/db'
import { uid } from '@/lib/id'
import { chat, type ChatMessage } from '@/lib/ai'
import { parsePlainObject, asText } from '@/lib/aiParse'
import { newAuthorFence, authorBlock } from '@/lib/promptGuard'
// 🔴 从 provider 取、**别从 engine 取**：engine 反向 import 本文件，绕 engine 会形成循环依赖
import { resolveTavernProvider, type ChatFn } from '@/lib/tavern/provider'
import { getTavernSettings, timeoutMsOf } from '@/lib/tavern/settings'
import { prepareDraftMaterial, type DraftSource } from '@/lib/tavern/draft'
import { webSearch, type SearchSettings } from '@/lib/webSearch'
import type { TavernStory, TavernStoryIndexItem, StorySettingSnapshot } from '@/lib/tavern/types'
import { sessionStoryId } from '@/lib/tavern/types'
import { buildWorldBookText, normalizeEntry, type WorldEntry } from '@/lib/tavern/worldBook'

// 全局 meta 键（无项目前缀）
const G = {
  index: 'tavern.storyIndex',
  one: (id: string) => `tavern.story.${id}`,
} as const

/** 故事名长度上限（列表 / 下拉里都放得下）。**写入口统一收口**，见 `saveStory` */
export const STORY_NAME_MAX = 20
/** 世界设定长度上限：每轮都要注入，写太长会把对话历史挤没 */
export const STORY_SETTING_MAX = 2400

/**
 * 「整段世界设定」退化成的那个条目 id —— **固定层**的判据（见 `buildStoryWorldBook`）。
 * 🔴 全项目唯一真源：`storyEntriesOf` 用它造条目，`buildStoryWorldBook` 用它分层。
 */
export const STORY_SETTING_ID = 'story-setting'

export function emptyStory(): TavernStory {
  return { id: '', name: '', setting: '', draftedAt: 0, createdAt: 0, updatedAt: 0 }
}

/** 名称缺省时给个占位（列表里空名字最难找） */
export function storyDisplayName(s: Pick<TavernStory, 'name'>): string {
  return s.name.trim() || '（未命名故事）'
}

/** 取首行当列表摘要；全空返回空串（让界面自己决定写什么占位） */
function briefOf(text: string, max = 40): string {
  const line = (text ?? '').trim().split(/\r?\n/)[0] ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

// ==================== 读写（全局） ====================

export async function listStories(): Promise<TavernStoryIndexItem[]> {
  const list = await db.getMeta<TavernStoryIndexItem[]>(G.index, [])
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getStory(id: string): Promise<TavernStory | null> {
  return db.getMeta<TavernStory | null>(G.one(id), null)
}

// ==================== 会话侧：快照与「这一场用哪份设定」 ====================

/**
 * 把一份故事拍成**快照**（新建会话时调用）。
 * 此后作者改故事设定，这一场不跟着变 —— 理由与剧本快照一致（见 types 的 `ScriptSnapshot`）。
 */
export function snapshotStorySetting(s: TavernStory): StorySettingSnapshot {
  const snap: StorySettingSnapshot = { storyId: s.id, name: s.name, setting: (s.setting ?? '').trim(), at: Date.now() }
  // 🔴 只在有词条时才带这个键 —— 老故事快照的形状保持原样（不动已有会话的落盘形状）
  if (s.entries?.length) snap.entries = s.entries
  return snap
}

/**
 * 「故事的一份设定」→ 世界书词条池（W3，2026-10-05）。
 *
 * 🔴 **老故事的退化路径**：没有 `entries` ⇒ 把整段 `setting` 当成**一个总是注入**的词条。
 *    于是老数据的注入结果与升级前逐字一致（等价性红线）。
 * 🔴 **两条都写时以 `entries` 为准** —— `setting` 只在没有词条时才当兜底。
 *
 * 传入的是 `{setting, entries}` 的最小形状（故事本体与会话快照都满足），
 * 这样 engine 那边不必先判断「拿到的是故事还是快照」。
 */
export function storyEntriesOf(src: { setting?: string; entries?: WorldEntry[] } | null | undefined): WorldEntry[] {
  if (!src) return []
  const entries = Array.isArray(src.entries) ? src.entries : []
  if (entries.length) {
    return entries
      .map((e, i) => normalizeEntry(e, i))
      .filter((e): e is WorldEntry => !!e)
  }
  const setting = String(src.setting ?? '').trim()
  if (!setting) return []
  // 整段退化成一个常驻词条：不设标题（保持与 worldToText 的 brief-only 情形同形）
  return [{
    id: STORY_SETTING_ID, title: '', body: setting,
    keys: [], prob: 1, order: 0, recursive: false, constant: true,
  }]
}

/**
 * 故事世界书入口（自由模式）：选 + 渲染，一步到位。
 *
 * `haystack` 由调用方给（会话标题 + 剧本 + 最近消息）—— 与剧情模式同一套取材口径。
 * 池为空 ⇒ 返回空串（整层不出现）。
 */
export function buildStoryWorldBook(
  src: { setting?: string; entries?: WorldEntry[] } | null | undefined,
  haystack: string,
  opts: { rand?: () => number; maxChars?: number; fixedMaxChars?: number } = {},
): { text: string; hits: WorldEntry[]; skippedByProb: string[]; dropped: WorldEntry[] } {
  const pool = storyEntriesOf(src)
  if (!pool.length) return { text: '', hits: [], skippedByProb: [], dropped: [] }
  // 🔴 两层分开渲染，与剧情模式同一口径（见 `world.buildPlotWorldBook`）：
  //    固定层 = 整段世界设定（`STORY_SETTING_ID`，没拆词条时的形态）；
  //    动态层 = 各家词条（含被标「常驻」的 —— 它们是词条，仍吃动态额度）。
  const rf = renderStoryLayer(pool.filter(e => e.id === STORY_SETTING_ID), haystack, opts.fixedMaxChars, opts)
  const rd = renderStoryLayer(pool.filter(e => e.id !== STORY_SETTING_ID), haystack, opts.maxChars, opts)
  return {
    text: [rf.text, rd.text].filter(Boolean).join('\n\n'),
    hits: [...rf.hits, ...rd.hits],
    skippedByProb: [...rf.skippedByProb, ...rd.skippedByProb],
    dropped: [...rf.dropped, ...rd.dropped],
  }
}

/** 单层渲染（空池 ⇒ 空结果） */
function renderStoryLayer(
  entries: WorldEntry[],
  haystack: string,
  maxChars: number | undefined,
  opts: { rand?: () => number },
): { text: string; hits: WorldEntry[]; skippedByProb: string[]; dropped: WorldEntry[] } {
  if (!entries.length) return { text: '', hits: [], skippedByProb: [], dropped: [] }
  const r = buildWorldBookText(entries, haystack, { ...opts, maxChars: maxChars ?? STORY_SETTING_MAX })
  return { text: r.text, hits: r.hits, skippedByProb: r.skippedByProb, dropped: r.dropped }
}

/**
 * 取「这一场该用哪份故事设定」：优先会话里的**快照**，没有（老会话）则实时读那份故事。
 *
 * ⚠️ engine 只以**动态 import** 调它。原由是本文件要从 engine 取 `resolveTavernProvider`、
 *    静态互引就成环；2026-09-18 起本文件改为直接从 `./provider` 取（真源），这条理由已不成立，
 *    动态 import 保留作**防御** —— 项目纪律：能不断环就不加环。
 *
 * 读不到一律返回空串：故事被删了不该让一场老对话打不开，也不该报错打断这一轮生成。
 *
 * @returns `from` 说明这份设定从哪来（便于排查「作者改了故事但对话没变」这类疑问）
 */
export async function resolveSessionStorySetting(
  session: { storyId?: string; charIds: string[]; storySetting?: StorySettingSnapshot },
  charIndex: { id: string; storyId?: string }[],
): Promise<{ name: string; setting: string; entries?: WorldEntry[]; from: 'snapshot' | 'live' | 'none' }> {
  const snap = session.storySetting
  if (snap) {
    return { name: snap.name ?? '', setting: (snap.setting ?? '').trim(), entries: snap.entries, from: 'snapshot' }
  }
  // 老会话（这场功能上线前建的）没有快照：按会话 → 角色卡反推故事 id，再实时读
  const id = sessionStoryId(session, charIndex)
  if (!id) return { name: '', setting: '', from: 'none' }
  try {
    const s = await getStory(id)
    if (!s) return { name: '', setting: '', from: 'none' }
    return { name: s.name, setting: (s.setting ?? '').trim(), entries: s.entries, from: 'live' }
  } catch {
    return { name: '', setting: '', from: 'none' }
  }
}

export async function saveStory(s: TavernStory): Promise<TavernStory> {
  const now = Date.now()
  const next: TavernStory = {
    ...s,
    // 名称在此**统一收口**：界面输入框也设了 maxLength，但导入 / AI 起草 / 将来的批量导入
    // 都绕过界面 —— 只在界面拦，等于「故事名 ≤ 20 字」这条约定是句空话。
    name: (s.name ?? '').trim().slice(0, STORY_NAME_MAX),
    id: s.id || uid(),
    createdAt: s.createdAt || now,
    updatedAt: now,
  }
  await db.setMeta(G.one(next.id), next)
  const idx = await db.getMeta<TavernStoryIndexItem[]>(G.index, [])
  const item: TavernStoryIndexItem = {
    id: next.id,
    name: storyDisplayName(next),
    settingBrief: briefOf(next.setting),
    updatedAt: next.updatedAt,
  }
  const i = idx.findIndex(x => x.id === next.id)
  if (i >= 0) idx[i] = item
  else idx.push(item)
  await db.setMeta(G.index, idx)
  return next
}

export async function createStory(init: Partial<TavernStory> = {}): Promise<TavernStory> {
  return saveStory({ ...emptyStory(), ...init })
}

/**
 * 删除故事。
 *
 * 🔴 **其下的剧本一并删** —— 剧本是挂在故事下的子节点，留着就成了没人管的孤儿节点；
 *    会话里存的是剧本**快照**，所以老会话照样能跑，不受影响。
 * 🔴 **角色卡一张都不删**，只**解除归属**（`storyId=''`）→ 这些卡退成「自由状态」，
 *    落在角色卡列表的「未归属」分组里，随时能在编辑时重新挂到别的故事下。
 *    与「删地图不删地点」同一原则：卡连着记忆与日记，删了就是不可逆丢数据。
 *
 * @returns 被解绑的角色卡张数（给界面提示用：「已把 N 张卡移出故事」）
 */
export async function deleteStory(id: string): Promise<{ reboundChars: number }> {
  // 动态 import：script.ts 将来可能反向引用 story.ts（树状查询），先绕开循环依赖的可能
  const { listScripts, deleteScript } = await import('@/lib/tavern/script')
  const scripts = await listScripts()
  for (const s of scripts) {
    if (s.storyId === id) await deleteScript(s.id)
  }

  // 卡：解绑不删。store.ts 不会反向依赖 story.ts，但保持动态 import 的一致写法更省心。
  const { rebindCharsStory } = await import('@/lib/tavern/store')
  const reboundChars = await rebindCharsStory(id, '')

  const idx = await db.getMeta<TavernStoryIndexItem[]>(G.index, [])
  await db.setMeta(G.index, idx.filter(x => x.id !== id))
  await db.setMeta(G.one(id), null)
  return { reboundChars }
}

// ==================== AI 起草 / 对话引导 ====================

/** 故事的可编辑字段（表单与 AI 起草共用这一个形状，避免两边漂移） */
export type StoryDraftFields = Pick<TavernStory, 'name' | 'setting'>

export const EMPTY_STORY_FIELDS: StoryDraftFields = { name: '', setting: '' }

function buildStoryDraftSystem(): string {
  return [
    '你在为一个角色扮演世界写「故事」的基本设定。作者会给一句粗略的想法，你把它补成两栏。',
    '',
    '〖两栏各写什么〗',
    `- name（故事名）：2–8 字的短名（如"雨夜便利店"），列表里能一眼认出。`,
    '- setting（世界设定）：这个世界的基本设定 —— 时代与地点、社会规则与常识、',
    '  有没有超自然或科技底色、有哪些势力、普通人怎么过日子。',
    '',
    '〖纪律 —— 这几条比写得好更重要〗',
    '- 只写**事实与规则**：一条一行，主谓宾说清就停。不许抒情、不许散文式烘托、不许形容词堆砌。',
    '- 不许重复：同一个意思换个说法再说一遍，是这里最常见的废话。',
    '- **不写具体人物**（人物归角色卡），**不写某一场戏发生了什么**（那归剧本）。',
    '- 不要替作者定死结局、揭开秘密的答案 —— 那些留给他们自己填。',
    `- 控制在 ${STORY_SETTING_MAX} 字以内。这段每轮都要给模型看，写长了是在挤自己的对话历史。`,
    '',
    '〖输出格式〗只输出一个 JSON 对象，不要代码块、不要围栏、不要任何解释：',
    '{"name":"…","setting":"…"}',
  ].join('\n')
}

export type StoryDraftArgs = {
  /** 作者的粗略想法（必填 —— 没有它就等于让模型凭空编） */
  seed: string
  /** 作者粘贴的参考素材（可空） */
  refs?: string
  /** 补完模式：现有内容的摊平文本（可空） */
  existing?: string
  searchSettings?: SearchSettings
  providerId?: string
  chatFn?: ChatFn
  signal?: AbortSignal
  /** 测试用：替换检索实现 */
  searchFn?: typeof webSearch
}

/**
 * 跑一次起草，产出故事的名字 + 世界设定（**不落库**；界面过一遍再保存）。
 * 模型乱答就抛错 —— 让调用方保留作者现有内容，绝不写半截结果进去。
 */
export async function draftStory(args: StoryDraftArgs): Promise<{ fields: StoryDraftFields; source: DraftSource }> {
  const seed = String(args.seed ?? '').trim()
  if (!seed && !args.refs?.trim() && !args.existing?.trim()) {
    throw new Error('请先写一句粗略的想法（这个世界大概是什么样的）')
  }

  const material = await prepareDraftMaterial({
    idea: seed,
    refs: args.refs,
    existing: args.existing,
    settings: args.searchSettings ?? { mode: 'off', engine: 'bocha', endpoint: '', apiKey: '', topK: 5 },
    signal: args.signal,
    searchFn: args.searchFn,
  })

  const { provider } = await resolveTavernProvider(args.providerId ? { providerId: args.providerId } : undefined)
  const runChat = args.chatFn ?? chat

  const fence = newAuthorFence()
  const msgs: ChatMessage[] = [
    { role: 'system', content: buildStoryDraftSystem() },
    {
      role: 'user',
      content: [
        '〖作者的想法〗',
        authorBlock(fence, seed),
        '',
        material.blocks,
        '请按格式输出 JSON。',
      ].filter(Boolean).join('\n'),
    },
  ]

  const reply = await runChat(provider, msgs, {
    timeoutMs: timeoutMsOf(await getTavernSettings()),
    signal: args.signal,
    json: true,
    think: false,
  })

  const parsed = parseStoryDraft(reply)
  if (!parsed) throw new Error('模型没有返回可用的故事（没按 JSON 格式输出）')
  return { fields: parsed, source: material.source }
}

/** 把现有内容摊平给「补完」模式用（只给非空的栏） */
export function flattenStoryFields(f: StoryDraftFields): string {
  return ([['名称', f.name], ['世界设定', f.setting]] as [string, string][])
    .filter(([, v]) => String(v ?? '').trim())
    .map(([k, v]) => `〖${k}〗${String(v).trim()}`)
    .join('\n')
}

/** 解析起草结果（导出便于单测）。拿不到设定就返回 null，绝不猜 */
function parseStoryDraft(raw: string): StoryDraftFields | null {
  const o = parsePlainObject(raw)
  if (!o) return null
  const name = asText(o.name).trim().slice(0, STORY_NAME_MAX)
  const setting = asText(o.setting).trim()
  if (!setting) return null
  return { name, setting }
}

/** 把起草结果并进现有内容：**AI 空着的栏不覆盖**（起草是补，不是重写） */
export function mergeStoryDraft(cur: StoryDraftFields, out: StoryDraftFields): StoryDraftFields {
  const next: StoryDraftFields = { ...cur }
  for (const k of Object.keys(EMPTY_STORY_FIELDS) as (keyof StoryDraftFields)[]) {
    const v = out[k]
    if (typeof v === 'string' && v.trim()) next[k] = v.trim()
  }
  return next
}

export function isEmptyStoryFields(f: StoryDraftFields): boolean {
  return !String(f.name ?? '').trim() && !String(f.setting ?? '').trim()
}
