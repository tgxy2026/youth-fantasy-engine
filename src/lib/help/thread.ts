// ============ 内置使用手册 · 连续追问的「参考主题」（3.3.1 · §5.5） ============
//
// 规划 §5.5 对这一块有四条硬要求，这个文件把它们变成可以单测的纯逻辑：
//   ① 追问（「那怎么保存」「这个也需要模型吗」）必须**重新本地检索**，把上一问的主题作为补充查询；
//      不能只把上次回答塞给模型、也不能为改检索词另发一次模型请求（这里不碰模型，天然合规）。
//   ② 跨功能 / 切页后继续问：显示当前参考主题；**显式点名的主题优先于当前页加权**；
//      主题还是不确定就先在本地澄清，不能默认「这个」＝刚打开的那一页。
//   ③ 多轮历史只留「必要问题 + **已验证回答**」：本模块只接受 `AskTopic`，而它只能由
//      `kind:'answer'` 的结果构造 —— 失败输出、未校验流、无依据猜测从源头进不来。
//   ④ 旧引用不在本次片段里 ⇒ 重新召回（补充查询）或不作为本轮事实：`buildThreadContextLine`
//      明确告诉模型「上一轮只用来理解指代，不是本轮依据」。
//
// 🔴 纯函数、无 DOM、无网络、不读作者数据 —— 与 `search.ts` 一样属于手册层。
import { HELP_INDEX, helpArticlesForTab } from '@/lib/help/registry'
import { normalizeHelpText, searchHelp } from '@/lib/help/search'
import type { HelpHit } from '@/lib/help/types'

/** 一次答疑的召回条数（与 `helpAsk.ASK_RECALL_LIMIT` 同值；这里独立定义是为了避免反向 import） */
const DEFAULT_RECALL_LIMIT = 6

/** 上一轮回答里带进上下文的正文上限：够模型理解「这个」指什么，又不至于把上一条答案当资料背下来 */
export const MAX_TOPIC_ANSWER = 240

/** 主题里最多保留几篇文章（三篇已经能说明「刚才聊的是哪块功能」） */
const MAX_TOPIC_ARTICLES = 3

/**
 * 一个「可信主题」：只能由**校验通过**的回答构造（见 `topicFromAnswer`）。
 *
 * 🔴 为什么不存整段对话：规划 §5.5 要求「只保留必要用户问题和已验证回答」。
 *    存整段历史会把失败输出、未校验流一起带进下一轮上下文，那正是它禁止的事。
 */
export interface AskTopic {
  /** 上一轮作者的原话（用于补充检索，也用于在界面说明「在接哪一句」） */
  question: string
  /** 上一轮已验证的回答（截断；**只用于理解指代**，不得当作本轮依据） */
  answer: string
  articleIds: string[]
  titles: string[]
}

/** 澄清时给作者的候选主题 */
export interface AskTopicOption {
  articleId: string
  title: string
}

/** 「这句像追问，但不知道在问哪个功能」时的统一措辞（界面与单测共用一份） */
export const ASK_CLARIFY_TEXT = '这句话像是在接着上一问说的，但本次对话里还没有可参考的主题。请说清是哪个功能，或从下面挑一个：'

/**
 * 强指代：出现这些词，说明作者在用「上面那个」代替功能名。
 * 🔴 不含「这」「那」单字之外的泛词；也不含「还 / 也」——那两个太常见（「还有哪些快捷键」），
 *    单独出现不足以判定「在指上一句」。
 */
const STRONG_ANAPHORA = ['这个', '那个', '它', '上面', '上述', '刚才', '前面', '这一', '这功能', '该功能', '那']

/** 弱指代：只有**已经存在可信主题**时才当作追问信号（「那还需要模型吗」里的「还」） */
const WEAK_ANAPHORA = ['还', '也', '同样', '呢']

/**
 * 「问句自己就带清楚主题」的分值线。
 *
 * 🔴 取值依据：正常问题的命中分在 20～36（见 `search.ts` 的实测记录），而含糊的指代句
 *    （「这个东西在哪」）通常只剩通用词，命中分低于 10。放在 16 是为了「宁可澄清一次，
 *    也不拿一篇不相干的文章硬答」——但一旦真找到了 16 分以上的主题，就直接答，不折腾作者。
 */
export const SELF_TOPIC_SCORE = 16

/** 文章 id → 标题（只读一次，索引本身是静态的） */
let titleIndex: Map<string, string> | null = null
function articleTitle(articleId: string): string {
  if (!titleIndex) {
    titleIndex = new Map()
    for (const entry of HELP_INDEX) {
      if (!titleIndex.has(entry.articleId)) titleIndex.set(entry.articleId, entry.articleTitle)
    }
  }
  return titleIndex.get(articleId) ?? articleId
}

/** 这句话里有没有强指代（「这个 / 它 / 那…」） */
export function hasStrongAnaphora(question: string): boolean {
  const text = normalizeHelpText(question)
  if (!text) return false
  return STRONG_ANAPHORA.some(marker => text.includes(marker))
}

/**
 * 这句是不是在追问上一句。
 *
 * 判据分两档：
 *   · 强指代 ⇒ 一定是追问（哪怕上一轮没有可信主题，也要走「澄清」而不是乱答）；
 *   · 弱指代 ⇒ 只有存在可信主题时才算追问 —— 否则「还有哪些快捷键」会被当成
 *     「接着上一问」，那是把新问题硬拽回旧主题。
 */
export function looksLikeFollowUp(question: string, lastTopic: AskTopic | null): boolean {
  const text = normalizeHelpText(question)
  if (!text) return false
  if (STRONG_ANAPHORA.some(marker => text.includes(marker))) return true
  return !!lastTopic && WEAK_ANAPHORA.some(marker => text.includes(marker))
}

/** 补充查询：上一问的原话 + 上一轮回答依据的文章标题 */
export function buildTopicQuery(topic: AskTopic): string {
  const parts = [topic.question.trim(), ...topic.titles]
  return parts.filter(Boolean).join(' ').trim()
}

const hitKey = (hit: HelpHit): string => `${hit.articleId}/${hit.sectionId}`

/**
 * 合并召回：**主查询的片段永远排在前面**。
 *
 * 🔴 顺序就是「显式主题优先」的落地方式：作者点名的功能占满前排，补充查询只填空位，
 *    绝不把「上一问聊的」顶到「这次问的」前面。
 */
function mergeHits(primary: HelpHit[], extra: HelpHit[], limit: number): { hits: HelpHit[]; fromTopic: string[] } {
  const hits = [...primary]
  const seen = new Set(primary.map(hitKey))
  const fromTopic: string[] = []
  for (const hit of extra) {
    if (hits.length >= limit) break
    const key = hitKey(hit)
    if (seen.has(key)) continue
    seen.add(key)
    hits.push(hit)
    fromTopic.push(key)
  }
  return { hits, fromTopic }
}

/** 本轮召回的结论 */
export interface AskRecall {
  hits: HelpHit[]
  /** 本轮真的借用了上一问的主题（界面据此显示「本次参考」） */
  usedTopic: AskTopic | null
  followUp: boolean
  /** 既像追问、又没有可信主题、本地也没命中明确主题 ⇒ 先澄清，不问模型 */
  needsClarify: boolean
  /** 澄清用的候选主题（按文章去重，最多 3 个） */
  options: AskTopicOption[]
  /** 哪些片段是从上一问主题补进来的（key = articleId/sectionId） */
  fromTopic: string[]
}

/**
 * 追问感知的召回。
 *
 * 三条规则按顺序生效：
 *   1. **追问时不拿本页加权**（`currentTabId = null`）：追问说的是上一轮的事，
 *      让「当前打开的这一页」再加 8 分，就会把「刚才聊的功能」挤掉 —— 那正是规划要禁的
 *      「默认『这个』就是新打开页面」。
 *   2. **显式主题优先于当前页**：问句自身能命中一个 16 分以上的主题、而那篇文章本来不在本页时，
 *      改按**不加权**的顺序 —— 作者点了名，就别让本页加权改写排序。
 *   3. 追问且有可信主题 ⇒ 用「上一问原话 + 上一轮文章标题」补一次检索，**排在主查询之后**。
 */
export function routeAskRecall(
  question: string,
  currentTabId: string | null | undefined,
  lastTopic: AskTopic | null,
  limit = DEFAULT_RECALL_LIMIT,
): AskRecall {
  const tabId = currentTabId ?? null
  const followUp = looksLikeFollowUp(question, lastTopic)

  let primary = searchHelp(question, { currentTabId: followUp ? null : tabId, limit })

  if (!followUp && tabId && primary.length > 0) {
    const unbiased = searchHelp(question, { currentTabId: null, limit })
    const top = unbiased[0]
    if (top && top.score >= SELF_TOPIC_SCORE && top.articleId !== primary[0].articleId && !top.tabIds.includes(tabId)) {
      primary = unbiased
    }
  }

  let hits = primary
  let usedTopic: AskTopic | null = null
  let fromTopic: string[] = []
  if (followUp && lastTopic) {
    const supplement = searchHelp(buildTopicQuery(lastTopic), { currentTabId: null, limit })
    const merged = mergeHits(primary, supplement, limit)
    hits = merged.hits
    fromTopic = merged.fromTopic
    if (fromTopic.length > 0) usedTopic = lastTopic
  }

  const options: AskTopicOption[] = []
  for (const hit of hits) {
    if (options.length >= 3) break
    if (options.some(option => option.articleId === hit.articleId)) continue
    options.push({ articleId: hit.articleId, title: hit.articleTitle })
  }
  /**
   * 连弱命中都没有时，把**当前页**对应的文章作为候选摆出来。
   *
   * 🔴 这不违反「不能默认『这个』就是新打开页面」：那条禁的是**默认按本页作答**，
   *    而这里是把本页主题当成**选项请作者挑**（点了才按它问）。没有候选就只能干瞪眼，
   *    比多问一句更难用。
   */
  if (options.length === 0 && tabId) {
    for (const article of helpArticlesForTab(tabId)) {
      if (options.length >= 3) break
      options.push({ articleId: article.id, title: article.title })
    }
  }

  const needsClarify = followUp && !lastTopic && (hits.length === 0 || hits[0].score < SELF_TOPIC_SCORE)

  return { hits, usedTopic, followUp, needsClarify, options, fromTopic }
}

/**
 * 由一条**已校验**的回答构造主题。
 *
 * 🔴 唯一的输入来源是 `kind:'answer'` 的结果（带 `sources` 与 `sourceSnapshots`）：
 *    失败输出、未校验流、"模型说了但依据对不上"都到不了这里，多轮上下文因此天然干净。
 *    没有任何依据的回答返回 `null` —— 不产生主题，下一轮就不会拿它当上下文。
 */
export function topicFromAnswer(
  question: string,
  answer: string,
  sources: { articleId: string }[],
): AskTopic | null {
  const articleIds: string[] = []
  for (const source of sources) {
    if (source.articleId && !articleIds.includes(source.articleId)) articleIds.push(source.articleId)
  }
  if (articleIds.length === 0) return null
  const kept = articleIds.slice(0, MAX_TOPIC_ARTICLES)
  return {
    question: question.trim(),
    answer: answer.trim().slice(0, MAX_TOPIC_ANSWER),
    articleIds: kept,
    titles: kept.map(articleTitle),
  }
}

/**
 * 拼进提示词的一行「上一轮」上下文。
 *
 * 🔴 措辞是判据的一部分，不是客套：
 *    · 说明它**只用于理解指代** —— 否则模型会把上一轮的回答当资料，本轮片段没覆盖也照答；
 *    · 说明**不能当作本轮依据** —— 上一轮依据的原文若不在本次片段里，就不能再引用
 *      （规划 §5.5「旧引用如不在本次片段中，重新召回或不作为本轮事实」）。
 * @param topic 只有在「本轮真的用了这个主题」时才传（`AskRecall.usedTopic`）
 */
export function buildThreadContextLine(topic: AskTopic | null): string | null {
  if (!topic) return null
  const titles = topic.titles.map(title => `《${title}》`).join('、')
  return [
    `上一轮作者问过：「${topic.question}」，当时的回答（节选）：${topic.answer}${topic.answer.length >= MAX_TOPIC_ANSWER ? '…' : ''}`,
    `那次依据的是 ${titles || '手册片段'}。`,
    '以上只用于理解这次问题里的「这个 / 它 / 那」指什么；本轮依据仍然只能是下面的片段，上一轮的回答不能当作事实，也不要在本轮引用这些片段之外的原文。',
  ].join('')
}
