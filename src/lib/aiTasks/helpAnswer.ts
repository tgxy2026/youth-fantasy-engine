// ============ 软件答疑的回答构造与引用校验（3.3.1 · P4 地基） ============
//
// 规划 §5.3：答疑链路 = 本地检索 → 依据足够才请求模型 → **校验来源引用** → 显示回答 + 原文。
//
// 🔴 这个文件只做纯逻辑（提示词 / 解析 / 校验），**不发起任何模型调用**：
//    调用归属（`scope:'global'`、`projectId:null`）、提示词隔离、额度预算属于下一层的事，
//    先把「模型说了什么算数」这条判据钉死，再接请求。
//
// 🔴 三条硬规则（都不是可选项）：
//   ① 依据只能取自**本次召回**的片段 —— 模型编一段手册里没有的话，一律不算数；
//   ② 摘录必须能在该段原文里**逐字**找到 —— 「大意相近」不算有依据；
//   ③ 一条都校验不过 ⇒ 不显示为答案，退回手册检索结果（规划 §5.3 的回退）。
//
// 2026-10-29 实测修正（本地 27B 跑真链路）：模型能答对内容，却把片段 id 抄崩一个字符，
//   于是整条回答被「引用了召回之外的内容」作废 —— 那是格式噪声，不是撒谎。
//   现在改成**模型只摘原文、来源由程序反查**（`quotes` 路径）：模型连编造来源的机会都没有，
//   而「逐字、不短于 8 字」这两条一寸没松。旧 `sources` 口径仍接受并逐条校验，向后兼容。
import { parsePlainObjectDetailed } from '@/lib/ai/aiParse'
import { getHelpArticle, type HelpHit } from '@/lib/help'

/** 模型给出的一条来源 */
export interface HelpSourceRef {
  articleId: string
  sectionId: string
  /** 从该段逐字摘的一句（用于界面上「依据原文」的回显） */
  quote: string
}

/** 模型的受约束输出 */
export interface HelpAnswer {
  answer: string
  /**
   * 逐字摘的原文（**新口径，首选**）：只给句子，不给 id。
   *
   * 🔴 为什么不让模型报 id：实测（2026-10-29，本地 27B）它能答对内容，却把片段 id 写崩一个字符，
   *    于是整条回答被判「引用了召回之外的内容」而作废 —— 那是格式噪声，不是撒谎。
   *    来源本来就能由程序按原文精确定位，让模型手抄 id 只是多一个出错的地方。
   */
  quotes?: string[]
  /** 模型自己报的来源（旧口径，仍接受并逐条校验；两侧都为空则判 no-sources） */
  sources?: HelpSourceRef[]
}

export type HelpAnswerFailure =
  | 'unparsable'
  | 'empty-answer'
  | 'no-sources'
  | 'unverifiable-source'
  | 'out-of-scope-source'

export type HelpAnswerCheck =
  | { ok: true; answer: string; sources: HelpSourceRef[] }
  | { ok: false; reason: HelpAnswerFailure; detail?: string }

/** 摘录最短长度：太短的「依据」（如「保存」两字）在任何段落里都能找到，等于没校验 */
export const MIN_QUOTE_LENGTH = 8

/** 单条来源摘录最长保留长度（只用于回显与校验，不影响模型输出） */
export const MAX_QUOTE_LENGTH = 120

/** 拼给模型的片段上限（规划 §5.4：首版最多 5 个片段） */
export const MAX_PROMPT_HITS = 5

/** 每段正文送进提示词的最大字数（超了截断，避免把整篇手册塞进去） */
export const MAX_SECTION_CHARS = 600

function sectionText(articleId: string, sectionId: string): string | null {
  const article = getHelpArticle(articleId)
  const section = article?.sections.find(item => item.id === sectionId)
  if (!section) return null
  return section.body.join('\n')
}

/** 单次请求真正交给模型的文本快照，校验只接受这份快照里的来源。 */
export interface HelpPromptFragment {
  hit: HelpHit
  text: string
  /** 记录整段与标题，后续不能让旧回答默默指向更新后的正文。 */
  sourceSnapshot: string
}

export function helpSourceSnapshot(articleId: string, sectionId: string): string | null {
  const article = getHelpArticle(articleId)
  const section = article?.sections.find(item => item.id === sectionId)
  return article && section ? JSON.stringify([article.title, section.heading, section.body]) : null
}

export function prepareHelpPromptFragments(hits: HelpHit[]): HelpPromptFragment[] {
  return hits.slice(0, MAX_PROMPT_HITS).flatMap(hit => {
    const text = sectionText(hit.articleId, hit.sectionId)
    const sourceSnapshot = helpSourceSnapshot(hit.articleId, hit.sectionId)
    return text && sourceSnapshot ? [{ hit, text: text.slice(0, MAX_SECTION_CHARS), sourceSnapshot }] : []
  })
}

/**
 * 构造答疑提示词。
 *
 * 片段带序号，要求模型只回报「摘了哪几句原文」，**不要抄 id** —— 来源由 `verifyHelpAnswer`
 * 按原文反查，这样模型没有机会编造来源，也不会因为抄错一个字符就整条作废（见 `HelpAnswer.quotes`）。
 * 提示词里给的约束只是第一道；第二道是逐字校验，不靠模型自觉。
 */
export function buildHelpAnswerPrompt(question: string, hits: HelpHit[], fragments = prepareHelpPromptFragments(hits)): { system: string; user: string } {
  const blocks = fragments.map(({ hit, text }, index) => {
    return `【片段 ${index + 1}】《${hit.articleTitle}》· ${hit.heading}\n${text}`
  })
  const system = [
    '你是这款写作软件的内置手册答疑助手。只根据下面给出的【手册片段】回答「这个功能怎么用」。',
    '规则：',
    '1. 先直接回答，再给步骤；步骤里只出现片段中真实存在的入口与名称，不要编造按钮、菜单、快捷键或能力。',
    '2. 片段没覆盖的部分，明确说「手册里还没有写这一点」，并建议查看哪个栏目；不要凭常识补全。',
    '3. 不要评论作者的稿件内容，不要生成任何创作文本，不要执行或建议进入具体业务操作。',
    '4. 只输出 JSON，不要额外文字，不要写片段编号或文章 id：',
    '{"answer":"给作者看的回答","quotes":["从片段里逐字复制的一句原文","再一句"]}',
    '5. quotes 至少一条、最多三条；必须是片段中的连续原文（8~80 字），一个字都不许改写或拼接；',
    '   不要写成「片段 1」「第一条」这类编号，也不要加引号或省略号。',
  ].join('\n')
  const user = [
    `作者的问题：${question.trim()}`,
    '',
    blocks.length > 0 ? blocks.join('\n\n') : '（本次没有召回到任何手册片段）',
  ].join('\n')
  return { system, user }
}

/** 解析模型返回（兼容代码围栏与前后废话；解析不了就如实失败） */
export function parseHelpAnswer(raw: string): { ok: true; value: HelpAnswer } | { ok: false; reason: 'unparsable'; detail?: string } {
  const parsed = parsePlainObjectDetailed(raw)
  if (parsed.outcome !== 'valid') {
    return { ok: false, reason: 'unparsable', detail: parsed.diagnostics[0]?.detail }
  }
  const data = parsed.data
  const answer = typeof data.answer === 'string' ? data.answer.trim() : ''
  const quotes: string[] = []
  if (Array.isArray(data.quotes)) {
    for (const item of data.quotes) {
      if (typeof item !== 'string') continue
      const quote = item.trim().slice(0, MAX_QUOTE_LENGTH)
      if (quote) quotes.push(quote)
    }
  }
  const rawSources = Array.isArray(data.sources) ? data.sources : []
  const sources: HelpSourceRef[] = []
  for (const item of rawSources) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const articleId = typeof record.articleId === 'string' ? record.articleId.trim() : ''
    const sectionId = typeof record.sectionId === 'string' ? record.sectionId.trim() : ''
    const quote = typeof record.quote === 'string' ? record.quote.trim().slice(0, MAX_QUOTE_LENGTH) : ''
    if (!articleId || !sectionId || !quote) continue
    sources.push({ articleId, sectionId, quote })
  }
  return { ok: true, value: { answer, quotes, sources } }
}

/** 去掉模型常裹在摘录外的引号与省略号：这些是排版，不是原文的一部分 */
function trimQuoteDecor(quote: string): string {
  return quote
    .replace(/^[\s「『“"'（(【\[]+/, '')
    .replace(/[\s」』”"'）)】\]…。，、；：]+$/, '')
    .trim()
}

/**
 * 校验答案与来源。
 *
 * 两条路径，判定标准一样严：
 *   · `quotes`（首选）：逐个在**本次召回**的段落里找逐字匹配 —— 找到哪段就算哪段的依据。
 *     找不到 ⇒ 这条摘录不是原文（编的 / 改写过的），整条回答作废；
 *   · `sources`（旧口径）：id 必须在召回里，摘录必须在**那一段**逐字出现。
 *
 * 🔴 两条都不放宽「逐字、且不短于 8 字」：两字摘录在任何段落里都能找到，等于没校验。
 * @param value 解析后的模型输出
 * @param hits  本次实际召回的片段（**不是**整本手册）—— 模型引用召回之外的条目一律不算
 */
export function verifyHelpAnswer(value: HelpAnswer, hits: HelpHit[], fragments = prepareHelpPromptFragments(hits)): HelpAnswerCheck {
  if (!value.answer.trim()) return { ok: false, reason: 'empty-answer' }
  const quotes = value.quotes ?? []
  const declared = value.sources ?? []
  if (quotes.length === 0 && declared.length === 0) return { ok: false, reason: 'no-sources' }

  const recalled = new Map(fragments.map(({ hit, text }) => [`${hit.articleId}/${hit.sectionId}`, text]))
  const accepted: HelpSourceRef[] = []
  const seen = new Set<string>()
  const push = (source: HelpSourceRef) => {
    const key = `${source.articleId}/${source.sectionId}`
    if (seen.has(key)) return
    seen.add(key)
    accepted.push(source)
  }

  // ---- 路径一：模型只给原文，来源由程序反查 ----
  for (const rawQuote of quotes) {
    const quote = trimQuoteDecor(rawQuote).slice(0, MAX_QUOTE_LENGTH)
    if (quote.length < MIN_QUOTE_LENGTH) {
      return { ok: false, reason: 'unverifiable-source', detail: `摘录过短：${quote}` }
    }
    let matched: HelpSourceRef | null = null
    for (const { hit, text } of fragments) {
      if (text && text.includes(quote)) {
        matched = { articleId: hit.articleId, sectionId: hit.sectionId, quote }
        break
      }
    }
    // 召回里有、手册里查不到 ⇒ 索引与内容不同版本；都算「无法核对」，不放行
    if (!matched) return { ok: false, reason: 'unverifiable-source', detail: quote.slice(0, 24) }
    push(matched)
  }

  // ---- 路径二：模型自报 id（旧口径，兼容更"听话"的模型） ----
  for (const source of declared) {
    const key = `${source.articleId}/${source.sectionId}`
    if (!recalled.has(key)) {
      return { ok: false, reason: 'out-of-scope-source', detail: key }
    }
    const text = recalled.get(key)
    if (!text) {
      return { ok: false, reason: 'unverifiable-source', detail: `${key}（正文缺失）` }
    }
    const quote = trimQuoteDecor(source.quote).slice(0, MAX_QUOTE_LENGTH)
    if (quote.length < MIN_QUOTE_LENGTH || !text.includes(quote)) {
      return { ok: false, reason: 'unverifiable-source', detail: `${key}：${quote.slice(0, 24)}` }
    }
    push({ articleId: source.articleId, sectionId: source.sectionId, quote })
  }

  return { ok: true, answer: value.answer, sources: accepted }
}

/** 一步到位：解析 + 校验（调用方拿到 ok 才显示为「AI 回答」） */
export function readHelpAnswer(raw: string, hits: HelpHit[], fragments = prepareHelpPromptFragments(hits)): HelpAnswerCheck {
  const parsed = parseHelpAnswer(raw)
  if (!parsed.ok) return { ok: false, reason: 'unparsable', detail: parsed.detail }
  return verifyHelpAnswer(parsed.value, hits, fragments)
}

/** 失败原因 → 给作者看的话（与「手册没写」区分开，规划 §5.4 不允许把技术失败说成没答案） */
export const HELP_ANSWER_FAILURE_TEXT: Record<HelpAnswerFailure, string> = {
  'unparsable': '模型这次的回答格式不合法，已退回手册检索结果。',
  'empty-answer': '模型没有给出可用回答，已退回手册检索结果。',
  'no-sources': '回答没有给出依据，已退回手册检索结果。',
  'unverifiable-source': '回答引用的原文对不上，无法核对，已退回手册检索结果。',
  'out-of-scope-source': '回答引用了本次没有召回的内容，已退回手册检索结果。',
}
