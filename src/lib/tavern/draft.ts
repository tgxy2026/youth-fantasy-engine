/**
 * 起草管线（一句话 → 按模板填）
 *
 * 三处起草（角色卡 / 剧本 / 背景设定）共用**同一套 plumbing**（现住 `../draftMaterial.ts`，
 * 因为非酒馆模块的 AI 补全也要用它），各自只提供自己的模板：
 *   ① 检索：按设置的检索方式决定「自己查 / 让模型查 / 不查」，并把结果整理成素材块；
 *   ② 素材：作者的一句话想法、粘贴的参考、现有内容（补完模式）都用 `authorBlock` 包起来；
 *   ③ 反馈：**这次到底用的是哪种模式**要一路带回界面（老大明确要求「给用户反馈使用的是哪种模式」）。
 *
 * 【为什么把「来源」做成返回值而不是让界面自己判】
 * 界面判的话就得复刻一遍「有没有 key / 查没查成 / 是不是 model 档」的逻辑 —— 两份判定必然漂移，
 * 表现是「弹窗说联网了，其实没查成」这种最难查的不一致。所以由本模块统一裁决，界面只负责显示。
 *
 * 【为什么角色卡的模板写在这里，剧本/背景设定留在各自模块】
 * 剧本与背景设定的模板早就在 `script.ts` / `world.ts` 里，且各有自己的解析与合并规则 —— 搬过来
 * 只会拆散「模板 + 解析 + 合并」这一组本该放一起的东西。角色卡此前没有起草，模板落在这里。
 */
import { chat, CHAT_TIMEOUT_MS, isCancelled, type ChatMessage } from '../ai'
import { parsePlainObject, asText } from '../aiParse'
import { newAuthorFence, authorBlock } from '../promptGuard'
import { resolveTavernProvider, type ChatFn } from './engine'
import type { SearchSettings, webSearch } from '../webSearch'
import { prepareDraftMaterial, type DraftSource } from '../draftMaterial'

// ==================== 角色卡模板 ====================

/** 角色卡起草的产出（扁平 13 栏 —— 给模型扁平结构比嵌套好写、好检） */
export type CardDraft = {
  name: string
  world: string
  externals: string
  core: string
  speech: string
  relations: string
  cannot: string
  knowledge: string
  perspective: string
  bottomLine: string
  paceLock: string
  rating: string
  examples: string
}

export const EMPTY_CARD_DRAFT: CardDraft = {
  name: '', world: '', externals: '', core: '', speech: '', relations: '', cannot: '', knowledge: '',
  perspective: '', bottomLine: '', paceLock: '', rating: '', examples: '',
}

const CARD_KEYS: (keyof CardDraft)[] = [
  'name', 'world', 'externals', 'core', 'speech', 'relations', 'cannot', 'knowledge',
  'perspective', 'bottomLine', 'paceLock', 'rating', 'examples',
]

/**
 * 角色卡起草的输出规范里，**示例对话那一段必须遵守扮演协议的输出格式** ——
 * 它不是装饰：模型会照着第 4 章的写法模仿（协议里也是这么要求的），起草时写错格式，
 * 之后每一轮对话都会跟着错。所以这条必须写进起草提示词。
 */
const CARD_OUTPUT_RULES = [
  '〖第 4 章「示例对话」的写法（必须严格遵守，模型会照它模仿）〗',
  '- 对白：纯文本，**不带说话人名字**，也不要把名字单独写成一行；',
  '- 动作 / 神态 / 心理：用（）包住；',
  '- 客观环境与人物外在：用【】包住；',
  '- 指代角色一律用「Ta」；',
  '- 写 2–4 组来回，短句为主，别写成小说段落。',
].join('\n')

export function buildCardDraftSystem(): string {
  return [
    '你在帮一位小说作者做**角色扮演用的角色卡**。作者会给一句话想法（可能是一个已有作品里的角色，',
    '也可能是他自己的原创），你按下面的四章模板把它填成一张可直接使用的卡。',
    '',
    '〖四章各写什么〗',
    '- world（第 1 章 · 世界）：这个角色所处的世界。**只写会影响 Ta 言行的东西**（时代、地点、',
    '  有什么规矩或禁忌、技术/超自然水平）。一到三句话。这是唯一一处该写世界的地方 —— 别写成百科。',
    '- 第 2 章 · 人物档案（6 栏）：',
    '  · externals 外在：年纪、外貌、穿着、体态、常带的东西 —— 能让读者一眼认出 Ta 的细节；',
    '  · core 内核：性格、在乎什么、怕什么、想要什么。要能推出行为，不要形容词堆砌；',
    '  · speech 语言特征：说话的习惯、口头禅、句长、称呼别人的方式；',
    '  · relations 关系：与谁有什么牵扯（有具体名字更好）；',
    '  · cannot 做不到的事：Ta 绝不会做 / 做不到什么 —— 这是防角色崩坏最重要的一栏；',
    '  · knowledge 知识边界：Ta 知道什么、**不知道什么**（防它替作者全知全能）。',
    '- 第 3 章 · 行为规范（4 栏）：perspective 视角与人称 / bottomLine 底线清单 /',
    '  paceLock 进度锁（关系推进的节奏限制）/ rating 尺度（一句话：适合什么尺度的内容）。',
    '- 第 4 章 · examples：示例对话。见下面的格式要求。',
    '',
    CARD_OUTPUT_RULES,
    '',
    '〖依据什么写〗',
    '- 作者的想法里点名了某个已有作品的角色 → 按**那个角色的公认设定**写；细节记不准就写得保守些，',
    '  **不要编造具体情节**（编错比写少更坏）；',
    '- 原创角色 → 顺着作者给的信息写，别替他定身世、结局、隐藏秘密这类重大设定；',
    '- 拿不准的栏写「待作者补充」，**不要用空话填满**。',
    '',
    '〖长度〗每一栏尽量控制在 120 字以内（examples 除外，它按 2–4 组对话写）。这些内容每轮都进上下文，',
    '写太满会把对话历史挤没。',
    '',
    '〖输出格式〗只输出一个 JSON 对象，不要代码块、不要围栏、不要任何解释：',
    `{${CARD_KEYS.map(k => `"${k}":"…"`).join(',')}}`,
  ].join('\n')
}

export function buildCardDraftUser(a: { idea: string; material: string }): string {
  const fence = newAuthorFence()
  return [
    '〖作者的一句话想法〗',
    authorBlock(fence, a.idea.trim()),
    '',
    a.material ? a.material + '\n' : '',
    '请按四章模板填写，直接输出 JSON。',
  ].filter(Boolean).join('\n')
}

/** 解析起草结果（导出便于单测）。十三栏全空 → null，绝不猜 */
export function parseCardDraft(raw: string): CardDraft | null {
  const o = parsePlainObject(raw)
  if (!o) return null
  const out = { ...EMPTY_CARD_DRAFT }
  for (const k of CARD_KEYS) out[k] = asText(o[k]).trim()
  if (!CARD_KEYS.some(k => out[k])) return null
  out.name = out.name.slice(0, 30)
  return out
}

/** 合并：**AI 空着的栏不覆盖作者已写的**（起草是补，不是重写） */
export function mergeCardDraft(cur: CardDraft, out: CardDraft): CardDraft {
  const next = { ...cur }
  for (const k of CARD_KEYS) {
    const v = out[k]
    if (typeof v === 'string' && v.trim()) next[k] = v.trim()
  }
  return next
}

export function isEmptyCardDraft(f: CardDraft): boolean {
  return !CARD_KEYS.some(k => String(f[k] ?? '').trim())
}

export type CardDraftArgs = {
  idea: string
  refs?: string
  existing?: string
  settings: SearchSettings
  providerId?: string
  chatFn?: ChatFn
  signal?: AbortSignal
  searchFn?: typeof webSearch
}

/** 跑一次角色卡起草（不落库；调用方合并后由作者保存） */
export async function draftCard(a: CardDraftArgs): Promise<{ fields: CardDraft; source: DraftSource }> {
  const idea = String(a.idea ?? '').trim()
  if (!idea && !a.refs?.trim() && !a.existing?.trim()) {
    throw new Error('先写一句你想要的角色（或粘一段参考素材）')
  }
  const material = await prepareDraftMaterial({
    idea, refs: a.refs, existing: a.existing, settings: a.settings, signal: a.signal, searchFn: a.searchFn,
  })
  const { provider } = await resolveTavernProvider(a.providerId ? { providerId: a.providerId } : undefined)
  const runChat = a.chatFn ?? chat
  const msgs: ChatMessage[] = [
    { role: 'system', content: buildCardDraftSystem() },
    { role: 'user', content: buildCardDraftUser({ idea, material: material.blocks }) },
  ]
  const reply = await runChat(provider, msgs, {
    timeoutMs: CHAT_TIMEOUT_MS,
    signal: a.signal,
    json: true,
    think: false,
  })
  const fields = parseCardDraft(reply)
  if (!fields) throw new Error('模型没有返回可用的角色卡（没按 JSON 格式输出）')
  return { fields, source: material.source }
}

// 素材管线住在项目级（`../draftMaterial.ts`）—— 这里再导出一次，让原有 import 路径继续可用
export { prepareDraftMaterial } from '../draftMaterial'
export type { DraftSource, DraftMaterial } from '../draftMaterial'

export { isCancelled }
