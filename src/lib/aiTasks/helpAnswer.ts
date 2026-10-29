// ============ 软件答疑的回答构造与引用校验（3.3.1 · P4 地基） ============
//
// 规划 §5.3：答疑链路 = 本地检索 → 依据足够才请求模型 → **校验来源引用** → 显示回答 + 原文。
//
// 🔴 这个文件只做纯逻辑（提示词 / 解析 / 校验），**不发起任何模型调用**：
//    调用归属（`scope:'global'`、`projectId:null`）、提示词隔离、额度预算属于下一层的事，
//    先把「模型说了什么算数」这条判据钉死，再接请求。
//
// 🔴 三条硬规则（都不是可选项）：
//   ① 来源只能取自**本次召回**的片段 —— 模型编一个 articleId 出来的回答一律不算数；
//   ② 摘录（quote）必须能在该段原文里**逐字**找到 —— 「大意相近」不算有依据；
//   ③ 一条都校验不过 ⇒ 不显示为答案，退回手册检索结果（规划 §5.3 的回退）。
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
  sources: HelpSourceRef[]
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

/**
 * 构造答疑提示词。
 *
 * 片段 id 直接写进提示词，并要求模型只能引用这些 id —— 这是「来源可追溯」的第一道闸；
 * 第二道闸是 `verifyHelpAnswer`，不靠提示词自觉。
 */
export function buildHelpAnswerPrompt(question: string, hits: HelpHit[]): { system: string; user: string } {
  const picked = hits.slice(0, MAX_PROMPT_HITS)
  const blocks = picked.map((hit, index) => {
    const text = (sectionText(hit.articleId, hit.sectionId) ?? hit.excerpt).slice(0, MAX_SECTION_CHARS)
    return `【片段 ${index + 1}】id=${hit.articleId}/${hit.sectionId}｜《${hit.articleTitle}》·${hit.heading}\n${text}`
  })
  const system = [
    '你是这款写作软件的内置手册答疑助手。只根据下面给出的【手册片段】回答「这个功能怎么用」。',
    '规则：',
    '1. 先直接回答，再给步骤；步骤里只出现片段中真实存在的入口与名称，不要编造按钮、菜单、快捷键或能力。',
    '2. 片段没覆盖的部分，明确说「手册里还没有写这一点」，并建议查看哪个栏目；不要凭常识补全。',
    '3. 不要评论作者的稿件内容，不要生成任何创作文本，不要执行或建议进入具体业务操作。',
    '4. 只输出 JSON，不要额外文字：',
    '{"answer":"给作者看的回答","sources":[{"articleId":"片段里的 id 前半段","sectionId":"id 后半段","quote":"从该片段逐字摘一句，8~80 字"}]}',
    '5. sources 至少一条、最多三条；quote 必须是片段原文里的连续文字，不得改写。',
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
  return { ok: true, value: { answer, sources } }
}

/**
 * 校验答案与来源。
 *
 * @param value 解析后的模型输出
 * @param hits  本次实际召回的片段（**不是**整本手册）—— 模型引用召回之外的条目一律不算
 */
export function verifyHelpAnswer(value: HelpAnswer, hits: HelpHit[]): HelpAnswerCheck {
  if (!value.answer.trim()) return { ok: false, reason: 'empty-answer' }
  if (value.sources.length === 0) return { ok: false, reason: 'no-sources' }
  const recalled = new Map(hits.map(hit => [`${hit.articleId}/${hit.sectionId}`, hit]))
  const accepted: HelpSourceRef[] = []
  for (const source of value.sources) {
    const key = `${source.articleId}/${source.sectionId}`
    if (!recalled.has(key)) {
      return { ok: false, reason: 'out-of-scope-source', detail: key }
    }
    const text = sectionText(source.articleId, source.sectionId)
    if (!text) {
      // 召回列表里有、手册里查不到 —— 说明索引与内容不同版本，按「无法核对」处理而不是硬认
      return { ok: false, reason: 'unverifiable-source', detail: `${key}（正文缺失）` }
    }
    if (source.quote.length < MIN_QUOTE_LENGTH || !text.includes(source.quote)) {
      return { ok: false, reason: 'unverifiable-source', detail: `${key}：${source.quote.slice(0, 24)}` }
    }
    accepted.push(source)
  }
  return { ok: true, answer: value.answer, sources: accepted }
}

/** 一步到位：解析 + 校验（调用方拿到 ok 才显示为「AI 回答」） */
export function readHelpAnswer(raw: string, hits: HelpHit[]): HelpAnswerCheck {
  const parsed = parseHelpAnswer(raw)
  if (!parsed.ok) return { ok: false, reason: 'unparsable', detail: parsed.detail }
  return verifyHelpAnswer(parsed.value, hits)
}

/** 失败原因 → 给作者看的话（与「手册没写」区分开，规划 §5.4 不允许把技术失败说成没答案） */
export const HELP_ANSWER_FAILURE_TEXT: Record<HelpAnswerFailure, string> = {
  'unparsable': '模型这次的回答格式不合法，已退回手册检索结果。',
  'empty-answer': '模型没有给出可用回答，已退回手册检索结果。',
  'no-sources': '回答没有给出依据，已退回手册检索结果。',
  'unverifiable-source': '回答引用的原文对不上，无法核对，已退回手册检索结果。',
  'out-of-scope-source': '回答引用了本次没有召回的内容，已退回手册检索结果。',
}
