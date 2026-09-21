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
 * 【为什么新增角色卡的模板写在这里，剧本/背景设定留在各自模块】
 * 剧本与背景设定的模板早就在 `script.ts` / `world.ts` 里，且各有自己的解析与合并规则 —— 搬过来
 * 只会拆散「模板 + 解析 + 合并」这一组本该放一起的东西。角色卡此前没有起草，模板落在这里。
 *
 * 【第 2、3 章为什么要求「按小项写」】
 * 2026-09-16 起这两章在界面上是**细字段表格**（见 `cardFields.ts`），存到库里仍是同一段文本，
 * 靠「标签：内容」的行格式往返。所以起草时就得按这个格式输出 —— 否则模型给的散文进到界面里
 * 会整段掉进「其他」那一格，作者看不到分好的条目。
 */
import { chat, CHAT_TIMEOUT_MS, isCancelled, type ChatMessage } from '../ai'
import { parsePlainObject, asText } from '../aiParse'
import { newAuthorFence, authorBlock } from '../promptGuard'
// 🔴 从 provider 取、**别从 engine 取**：engine 反向 import 本文件（经 script/world），会形成循环依赖
import { resolveTavernProvider, type ChatFn } from './provider'
import type { SearchSettings, webSearch } from '../webSearch'
import { prepareDraftMaterial, type DraftSource } from '../draftMaterial'
import { structFieldLines } from './cardFields'

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
  '- 对方的台词：用〖对方〗起头（输入侧的结构标注，正式输出里不会出现）；',
  '- 动作、神态、心理与客观环境：全部用全角括号（ ）包住、一件事一个括号；',
  // 🔴 2026-09-16 老大反馈 #7：起草出来的样本会被逐字模仿，人称若在这里写错，
  //    后面每一轮都会跟着错 —— 所以第 4 章的写法规范必须与协议 O1 对齐。
  '- **描写一律第三人称**：括号里指代人物写名字、写「他」「她」，或按中文习惯省略主语；',
  '  **不要写"我""你"** —— 只有对白里才说"我""你"（那是人物自己说的话）；',
  '- 性别还没定的角色，指代一律用「Ta」，别猜「他」或「她」；',
  '- 写 2–4 组来回，短句为主，别写成小说段落。',
].join('\n')

export function buildCardDraftSystem(): string {
  return [
    '你在帮一位小说作者做**角色扮演用的角色卡**。作者会给一句话想法（可能是一个已有作品里的角色，',
    '也可能是他自己的原创），你按下面的四章模板把它填成一张可直接使用的卡。',
    '',
    '〖语言风格 —— 这一条优先于文采〗',
    '- 只写**事实与结论**：一条一行，主谓宾说清就停。不许抒情、不许散文式烘托、不许形容词堆砌。',
    '- 不许重复：同一件事换个说法再说一遍，是这里最常见的废话。',
    '- 拿不准的栏写「待作者补充」，**不要用空话填满**。',
    '',
    '〖四章各写什么〗',
    '- world（第 1 章 · 角色与设定的关系）：**不写世界本身**（世界观写在故事层），只写**角色与这个世界的关系** ——',
    '  Ta 的身份、处境、常去的地方，以及这个世界怎么影响 Ta。一到三句即可。',
    '- 第 2 章 · 人物档案 与 第 3 章 · 行为规范：每一栏都**按小项分条写**，一行一项，形如「外貌：短发」。',
    '  **不要写成一整段**。模板里没有、但又确实该写的，放进该栏的「其他」小项。可用的小项：',
    ...structFieldLines(),
    '- examples（第 4 章）：示例对话。见下面的写法要求。',
    '',
    CARD_OUTPUT_RULES,
    '',
    // 🔴 2026-09-16 老大反馈 #10：旧版这段写的是「细节记不准就写得保守些，不要编造具体情节」——
    //    结果起草出来的卡只剩骨架（原型越陌生越空），作者还得从零补一遍。
    //    现在的取向反过来：**形象层大胆扩散、设定层守住红线**。
    //    老大原话：不用太担心和原型不符或出戏，生成后作者自己会改。
    '〖依据什么写 —— 原型角色要写得「像个人」，不能只有骨架〗',
    '- 作者点名的原型若是**现实中的人物**，或**游戏 / 小说 / 影视等作品里的角色** → 按那个原型的公认形象写，',
    '  并**在已知信息的基础上大胆扩散**：外貌细节、说话习惯（口头禅、句子长短）、日常偏好、对别人的态度、',
    '  在意什么、讨厌什么 —— 凡是**能从原型性格自然推出来**的，都替作者补足。',
    '- 🔴 **信息不足时尤其要发挥**：宁可顺着已知信息合理地多写几笔，也不要只丢一句「不详」「待补充」。',
    '  作者拿到一张满是空白的卡，等于还得从零写一遍 —— 那正是这次要修掉的问题。',
    '- 扩散的**边界**：补的是**形象层**（长什么样、怎么说话、什么脾气、在意什么）；',
    '  **不要编造重大设定**（身世之谜、结局、隐藏秘密、与谁有血海深仇）—— 那是作者的地盘。',
    '- 原创角色（没点名任何原型）→ 顺着作者给的信息往足里写，同样别替 Ta 定身世、结局、隐藏秘密。',
    '',
    '🔴 **不必担心「和原型对不上」或「演起来出戏」**：这张卡生成后作者还会自己逐栏改。',
    '   这里真正要避免的是**写得保守、单薄** —— 那种卡作者回头多半整张推翻重来。',
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
