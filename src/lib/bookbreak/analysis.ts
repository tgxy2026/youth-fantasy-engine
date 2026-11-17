/**
 * 拆书 · 作品分析（只分析，不写项目）—— 3.6.0 · B 包首期
 *
 * 依据：3.6.0 规划第 4 节 / 第 16 节 B。
 *
 * 🔴 「只分析」是**结构上的**，不是靠隐藏按钮：
 *    本文件不 import persist / 设定草稿 / 关系整理 / 正文写入中的任何一环，
 *    产物只有分析卡（+ 覆盖统计）。调用方拿不到"顺手写库"的路径。
 *
 * 🔴 与一键拆书的分工：
 *    · 一键拆书：切分 → 写正文 → 逐章抽实体 → 设定草稿 → 关系整理（会改库）；
 *    · 本文件：切分 → 逐单元产出分析卡（**只读原文**，不落任何正式数据）。
 *    外部参考作品默认走这里（规划 §4：只分析、不写入项目正文）。
 *
 * 三条口径（与规划 §4 / §15.2 一致）：
 *  1. 证据：模型给的短引必须在**该单元原文**里逐字命中（去空白后包含）；
 *     没命中就标 `verified: false` + `claim: 'inferred'`，卡片**保留**（推测可以有用），
 *     但绝不显示成"已证实"。
 *  2. 覆盖：完成 / 失败 / 跳过 / 截断分别计数，并给出计划与实际字数；
 *     没有覆盖全部来源时，"未发现"只能限定在已处理范围。
 *  3. 复用：同一来源 + 同一配置的单元结果可复用（`previous` + 单元键），
 *     只重试失败单元要由调用方显式传 `retryUnits`。
 */
import { uid } from '@/lib/app/id'
import { requireProviderFor } from '@/lib/ai'
// 🔴 用 `ask` 而不是 `askSoft`：后者会把普通请求异常吞成空串，
//    于是「这一章失败了」又会变成「这一章没分析出内容」——正是本包要消灭的歧义。
import { ask } from '@/lib/editor/wordRange'
import { parseObjectArrayDetailed } from '@/lib/ai/aiParse'
import { splitNovelText, type SplitResult } from './split'
import { hashOf } from '@/lib/semantic/chunk'
import type { ArtefactRecord } from '@/lib/artefacts/types'

/** 四个分析维度（对应规划 §4 要求的四类产物） */
export type AnalysisDimension = 'scene' | 'turning' | 'character' | 'pacing'

export const ANALYSIS_DIMENSIONS: readonly { id: AnalysisDimension; label: string; hint: string }[] = [
  { id: 'scene', label: '场景与冲突', hint: '这一章发生了什么、目标与阻碍、场景承担的作用' },
  { id: 'turning', label: '转折与钩子', hint: '关键转折、章末悬念、读者继续读的理由' },
  { id: 'character', label: '人物动机与变化', hint: '谁做了什么、动机是什么、状态有没有变化' },
  { id: 'pacing', label: '节奏与叙事', hint: '信息释放节奏、叙述视角、铺垫与回收' },
]

export interface AnalysisEvidence {
  chapterTitle: string
  /** 原文短引（模型给的；≤200 字） */
  quote: string
  /** 是否在该单元原文里逐字命中（去空白后包含） */
  verified: boolean
}

export interface AnalysisCard {
  /** 稳定 id：单元键 + 维度 + 序号（同输入重跑得到同 id，便于去重） */
  id: string
  dimension: AnalysisDimension
  title: string
  content: string
  /** `observed` = 有原文依据；`inferred` = 推测（必须显眼标注） */
  claim: 'observed' | 'inferred'
  evidence?: AnalysisEvidence
  unitIndex: number
  chapterTitle: string
  /** 分析项目内章节时的真实章节 id（外部原文为空） */
  chapterId?: string
}

export type AnalysisUnitState = 'completed' | 'failed' | 'skipped'

export interface AnalysisUnit {
  index: number
  chapterTitle: string
  chars: number
  /** 单元键（章名 + 文本指纹）—— 复用/重试的判据 */
  unitKey: string
  /** 3.6.0 · B2：项目内章节的真实 id */
  chapterId?: string
  state: AnalysisUnitState
  errorCode?: string
  cards: AnalysisCard[]
}

export interface AnalysisCoverage {
  plannedUnits: number
  completedUnits: number
  failedUnits: number
  skippedUnits: number
  /** 超过 `maxUnits` 未处理的单元（"未发现"只能限定在已处理范围） */
  truncated: boolean
  plannedChars: number
  processedChars: number
}

export interface AnalysisResult {
  units: AnalysisUnit[]
  cards: AnalysisCard[]
  coverage: AnalysisCoverage
  dimensions: AnalysisDimension[]
  /** 中止时已完成的单元仍有效 */
  aborted: boolean
}

export interface AnalysisOptions {
  dimensions?: readonly AnalysisDimension[]
  maxChunks?: number
  /** 单元字符上限（超出的章再切，保持章名） */
  maxUnitChars?: number
  maxUnits?: number
  signal?: AbortSignal
  /** ACP 通道（给了就只走 Agent，无需 API 配置） */
  acpText?: (prompt: string, call?: { signal?: AbortSignal }) => Promise<string>
  onProgress?: (p: { done: number; total: number; label: string }) => void
  /** 上次结果：相同单元键且已完成的直接复用 */
  previous?: AnalysisResult
  /** 只重试这些下标（作者显式触发，不自动重试） */
  retryUnits?: readonly number[]
  /** 单单元最多几张卡（默认 8） */
  maxCardsPerUnit?: number
}

export const ANALYSIS_LIMITS = {
  maxUnits: 120,
  maxUnitChars: 4000,
  maxCardsPerUnit: 8,
  maxCardsTotal: 800,
} as const

interface Unit {
  index: number
  chapterTitle: string
  text: string
  unitKey: string
  /** 3.6.0 · B2：分析项目内章节时带上真实 id（成果可回指章节）；外部原文没有 */
  chapterId?: string
}

/** 章 → 单元：超过字符上限的章按窗口切（保留章名，加「（续 N）」） */
function expandUnits(sp: SplitResult, maxUnitChars: number, maxUnits: number): { units: Unit[]; truncated: boolean } {
  const out: Unit[] = []
  let truncated = false
  for (const ch of sp.chapters) {
    const title = (ch.title ?? '').trim() || '未命名章节'
    const text = ch.text ?? ''
    if (!text.trim()) continue
    if (out.length >= maxUnits) { truncated = true; break }
    const parts = text.length <= maxUnitChars
      ? [text]
      : Array.from({ length: Math.ceil(text.length / maxUnitChars) }, (_, i) =>
        text.slice(i * maxUnitChars, (i + 1) * maxUnitChars))
    for (let i = 0; i < parts.length; i++) {
      if (out.length >= maxUnits) { truncated = true; break }
      const seg = parts[i]
      const segTitle = parts.length > 1 ? `${title}（续 ${i + 1}）` : title
      out.push({
        index: out.length,
        chapterTitle: segTitle,
        text: seg,
        unitKey: `${segTitle}::${hashOf(seg)}::${seg.length}`,
      })
    }
    if (truncated) break
  }
  return { units: out, truncated }
}

/** 去空白（含全角空格）后的包含判断 —— 证据定位的唯一口径 */
function normalizeForEvidence(s: string): string {
  return s.replace(/[\s\u3000]+/g, '')
}

const DIMENSION_SPEC: Record<AnalysisDimension, string> = {
  scene: 'scene：事件与场景作用、角色目标与冲突（一句话讲清"这一章发生了什么、为什么重要"）',
  turning: 'turning：关键转折、章末钩子、悬念与线索（指出具体在哪一句之后发生变化）',
  character: 'character：人物的动机、选择与状态变化（只在原文有依据时写变化）',
  pacing: 'pacing：信息释放节奏、叙述视角与方法、铺垫与可能的回收',
}

/** 单单元的分析提示词（结构化 JSON，便于本地校验） */
function buildPrompt(unit: Unit, dims: readonly AnalysisDimension[]): string {
  const spec = dims.map(d => `- ${DIMENSION_SPEC[d]}`).join('\n')
  return [
    '你在拆解一部小说的写法（不是评价好坏，也不改写原文）。',
    `【章节】${unit.chapterTitle}`,
    '【正文】',
    unit.text,
    '',
    '请按下列维度提炼可迁移的写法：',
    spec,
    '',
    '输出 JSON 数组，每条：',
    '{"dimension":"scene|turning|character|pacing","title":"≤20字","content":"≤300字，具体到做法","quote":"原文短引，必须逐字摘自正文，≤120字","claim":"observed|inferred"}',
    '要求：',
    '1. 有原文依据的 claim 用 observed，并在 quote 里给**逐字**短引；',
    '2. 推测（如"这条线索可能在第 X 章回收"）用 inferred，quote 可留空；',
    '3. 只写这一章里能看到的东西，不要编造未出现的人物或事件；',
    '4. 最多 8 条，宁少勿凑。',
  ].join('\n')
}

const VALID_DIMS = new Set<AnalysisDimension>(['scene', 'turning', 'character', 'pacing'])
const isAnalysisDimension = (v: string): v is AnalysisDimension => VALID_DIMS.has(v as AnalysisDimension)

/** 解析模型输出（严格但宽容：缺字段的条目跳过，不整批丢） */
export function parseAnalysisCards(text: string, opts: {
  unit: { index: number; chapterTitle: string; text: string; unitKey: string; chapterId?: string }
  dimensions: readonly AnalysisDimension[]
  maxCards?: number
}): { cards: AnalysisCard[]; dropped: number } {
  const parsed = parseObjectArrayDetailed(text)
  const rows = Array.isArray(parsed.data) ? parsed.data : []
  const normText = normalizeForEvidence(opts.unit.text)
  const cards: AnalysisCard[] = []
  let dropped = 0
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') { dropped++; continue }
    const o = raw as Record<string, unknown>
    const dimRaw = typeof o.dimension === 'string' ? o.dimension.trim() : ''
    const title = typeof o.title === 'string' ? o.title.trim().slice(0, 40) : ''
    const content = typeof o.content === 'string' ? o.content.trim().slice(0, 600) : ''
    if (!isAnalysisDimension(dimRaw) || !opts.dimensions.includes(dimRaw) || !title || !content) { dropped++; continue }
    const dim = dimRaw
    const quoteRaw = typeof o.quote === 'string' ? o.quote.trim().slice(0, 200) : ''
    const quote = quoteRaw.length > 0 ? quoteRaw : ''
    const verified = quote.length > 0 && normText.includes(normalizeForEvidence(quote))
    const claimIn = o.claim === 'observed' || o.claim === 'inferred' ? o.claim : ''
    // 🔴 声称 observed 但引文没命中 ⇒ 降级为推测（不当成已证实事实）
    const claim: AnalysisCard['claim'] = claimIn === 'observed' && verified ? 'observed' : 'inferred'
    cards.push({
      id: `an_${hashOf(opts.unit.unitKey)}_${cards.length}`,
      dimension: dim,
      title,
      content,
      claim,
      ...(quote ? { evidence: { chapterTitle: opts.unit.chapterTitle, quote, verified } } : {}),
      unitIndex: opts.unit.index,
      chapterTitle: opts.unit.chapterTitle,
      ...(opts.unit.chapterId ? { chapterId: opts.unit.chapterId } : {}),
    })
    if (cards.length >= (opts.maxCards ?? ANALYSIS_LIMITS.maxCardsPerUnit)) break
  }
  return { cards, dropped }
}

/**
 * 跑一次「只分析」。**不写任何项目数据**。
 *
 * 中止：返回已完成部分，`aborted: true`；未跑到的单元记 `skipped`（不是 failed）。
 */
function resolveDims(opts: AnalysisOptions): AnalysisDimension[] {
  const list = opts.dimensions?.length ? [...opts.dimensions] : ANALYSIS_DIMENSIONS.map(d => d.id)
  return list.filter(d => VALID_DIMS.has(d))
}

/**
 * 项目内章节 → 单元（3.6.0 · B2）。
 *
 * 与「外部原文」的差别只有两点：单元带 `chapterId`（成果能回指章节、界面能跳回去），
 * 单元键里也掺了章节 id（不同章同名标题不会被误复用）。
 */
export function chapterUnits(
  chapters: readonly { id: string; title: string; content: string }[],
  maxUnitChars: number = ANALYSIS_LIMITS.maxUnitChars,
  maxUnits: number = ANALYSIS_LIMITS.maxUnits,
): { units: Unit[]; truncated: boolean } {
  const out: Unit[] = []
  let truncated = false
  for (const ch of chapters) {
    if (out.length >= maxUnits) { truncated = true; break }
    const title = (ch.title ?? '').trim() || '未命名章节'
    const text = ch.content ?? ''
    if (!text.trim()) continue
    const parts = text.length <= maxUnitChars
      ? [text]
      : Array.from({ length: Math.ceil(text.length / maxUnitChars) }, (_, i) =>
        text.slice(i * maxUnitChars, (i + 1) * maxUnitChars))
    for (let i = 0; i < parts.length; i++) {
      if (out.length >= maxUnits) { truncated = true; break }
      const seg = parts[i]
      const segTitle = parts.length > 1 ? `${title}（续 ${i + 1}）` : title
      out.push({
        index: out.length,
        chapterId: ch.id,
        chapterTitle: segTitle,
        text: seg,
        unitKey: `${ch.id}::${segTitle}::${hashOf(seg)}::${seg.length}`,
      })
    }
    if (truncated) break
  }
  return { units: out, truncated }
}

/** 单元执行内核（`analyzeBook` / `analyzeChapters` 共用，避免两套口径漂移） */
async function analyzeUnits(
  units: readonly Unit[], truncated: boolean, dims: readonly AnalysisDimension[], opts: AnalysisOptions,
): Promise<AnalysisResult> {
  const plannedChars = units.reduce((n, u) => n + u.text.length, 0)

  // 复用：相同单元键且已完成的直接沿用；调用方点名重试的不复用
  const retry = new Set(opts.retryUnits ?? [])
  const prevByKey = new Map<string, AnalysisUnit>()
  for (const u of opts.previous?.units ?? []) {
    if (u.state === 'completed') prevByKey.set(u.unitKey, u)
  }

  const done: AnalysisUnit[] = []
  let processedChars = 0
  let aborted = false
  const cfg = opts.acpText ? null : await requireProviderFor('create').catch(() => null)

  for (const unit of units) {
    if (opts.signal?.aborted) { aborted = true }
    const reusable = !retry.has(unit.index) ? prevByKey.get(unit.unitKey) : undefined
    if (reusable) {
      done.push({
        ...reusable, index: unit.index, chapterTitle: unit.chapterTitle, chars: unit.text.length,
        ...(unit.chapterId ? { chapterId: unit.chapterId } : {}),
      })
      processedChars += unit.text.length
      opts.onProgress?.({ done: done.length, total: units.length, label: `复用已完成单元：${unit.chapterTitle}` })
      continue
    }
    if (aborted) {
      done.push({
        index: unit.index, chapterTitle: unit.chapterTitle, chars: unit.text.length, unitKey: unit.unitKey,
        ...(unit.chapterId ? { chapterId: unit.chapterId } : {}), state: 'skipped', cards: [],
      })
      continue
    }
    if (!cfg && !opts.acpText) {
      done.push({
        index: unit.index, chapterTitle: unit.chapterTitle, chars: unit.text.length, unitKey: unit.unitKey,
        ...(unit.chapterId ? { chapterId: unit.chapterId } : {}),
        state: 'failed', errorCode: 'no-provider', cards: [],
      })
      continue
    }
    opts.onProgress?.({ done: done.length, total: units.length, label: `分析：${unit.chapterTitle}` })
    try {
      const text = await ask(cfg, buildSystem(), buildPrompt(unit, dims), {
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.acpText ? { acpText: opts.acpText } : {}),
      })
      const { cards } = parseAnalysisCards(typeof text === 'string' ? text : '', {
        unit: {
          index: unit.index, chapterTitle: unit.chapterTitle, text: unit.text, unitKey: unit.unitKey,
          ...(unit.chapterId ? { chapterId: unit.chapterId } : {}),
        },
        dimensions: dims,
      })
      done.push({
        index: unit.index, chapterTitle: unit.chapterTitle, chars: unit.text.length, unitKey: unit.unitKey,
        ...(unit.chapterId ? { chapterId: unit.chapterId } : {}),
        state: 'completed', cards,
      })
      processedChars += unit.text.length
    } catch (e) {
      const name = e instanceof Error ? e.name : ''
      if (name === 'AbortError' || opts.signal?.aborted) {
        aborted = true
        done.push({
          index: unit.index, chapterTitle: unit.chapterTitle, chars: unit.text.length, unitKey: unit.unitKey,
          ...(unit.chapterId ? { chapterId: unit.chapterId } : {}), state: 'skipped', cards: [],
        })
      } else {
        const code = /JSON|解析|parse/i.test(e instanceof Error ? e.message : '') ? 'parse-invalid' : 'request-failed'
        done.push({
          index: unit.index, chapterTitle: unit.chapterTitle, chars: unit.text.length, unitKey: unit.unitKey,
          ...(unit.chapterId ? { chapterId: unit.chapterId } : {}),
          state: 'failed', errorCode: code, cards: [],
        })
      }
    }
  }

  const cards = done.flatMap(u => u.cards).slice(0, ANALYSIS_LIMITS.maxCardsTotal)
  const coverage: AnalysisCoverage = {
    plannedUnits: units.length,
    completedUnits: done.filter(u => u.state === 'completed').length,
    failedUnits: done.filter(u => u.state === 'failed').length,
    skippedUnits: done.filter(u => u.state === 'skipped').length,
    truncated,
    plannedChars,
    processedChars,
  }
  return { units: done, cards, coverage, dimensions: [...dims], aborted }
}

/**
 * 跑一次「只分析」（外部原文）。**不写任何项目数据**。
 *
 * 中止：返回已完成部分，`aborted: true`；未跑到的单元记 `skipped`（不是 failed）。
 */
export async function analyzeBook(raw: string, opts: AnalysisOptions = {}): Promise<AnalysisResult> {
  const dims = resolveDims(opts)
  const maxUnitChars = Math.max(500, opts.maxUnitChars ?? ANALYSIS_LIMITS.maxUnitChars)
  const maxUnits = Math.max(1, opts.maxUnits ?? ANALYSIS_LIMITS.maxUnits)
  const sp = splitNovelText(raw, opts.maxChunks !== undefined ? { maxChunks: opts.maxChunks } : {})
  const { units, truncated } = expandUnits(sp, maxUnitChars, maxUnits)
  return analyzeUnits(units, truncated, dims, opts)
}

/**
 * 分析**项目内章节**（3.6.0 · B2）：产物带 `chapterId`，成果可回指章节。
 * 其余口径与 `analyzeBook` 完全一致（同一内核）。
 */
export async function analyzeChapters(
  chapters: readonly { id: string; title: string; content: string }[],
  opts: AnalysisOptions = {},
): Promise<AnalysisResult> {
  const dims = resolveDims(opts)
  const maxUnitChars = Math.max(500, opts.maxUnitChars ?? ANALYSIS_LIMITS.maxUnitChars)
  const maxUnits = Math.max(1, opts.maxUnits ?? ANALYSIS_LIMITS.maxUnits)
  const { units, truncated } = chapterUnits(chapters, maxUnitChars, maxUnits)
  return analyzeUnits(units, truncated, dims, opts)
}

function buildSystem(): string {
  return '你是资深网文编辑，擅长拆解叙事方法。只依据给出的原文分析，不脑补未出现的内容；引文必须逐字摘自原文。'
}

// ============ 跨章聚合（3.6.0 · B1）============

export type AggregateDimension = 'character-arc' | 'pacing-curve' | 'clue-thread'

export const AGGREGATE_DIMENSIONS: readonly { id: AggregateDimension; label: string; hint: string }[] = [
  { id: 'character-arc', label: '人物弧线', hint: '主要人物从开篇到当前的变化轨迹与动机演进' },
  { id: 'pacing-curve', label: '节奏曲线', hint: '整本的张弛变化：哪几章推进、哪几章铺陈、有没有塌陷段' },
  { id: 'clue-thread', label: '线索与回收', hint: '埋下的线索、已有回收、仍悬空的线头' },
]

export interface AggregateCard {
  id: string
  dimension: AggregateDimension
  title: string
  content: string
  /** 依据的章名（模型给；会与本次实际分析过的章名核对） */
  basis: string[]
  /** 依据章名是否都能对上本次分析范围 */
  basisVerified: boolean
  claim: 'observed' | 'inferred'
}

export interface AnalysisAggregateResult {
  cards: AggregateCard[]
  state: 'completed' | 'failed' | 'skipped'
  errorCode?: string
  materialChars: number
}

export const AGGREGATE_LIMITS = {
  /** 材料上限：只送「已产出的卡片摘要」，不重送原文 */
  maxMaterialChars: 12000,
  maxCards: 24,
} as const

const AGG_DIMS = new Set<AggregateDimension>(['character-arc', 'pacing-curve', 'clue-thread'])
const isAggDim = (v: string): v is AggregateDimension => AGG_DIMS.has(v as AggregateDimension)

/** 章名归一（去掉「（续 N）」后缀）—— 聚合依据按"原章"核对 */
function baseChapterTitle(t: string): string {
  return t.replace(/（续 \d+）$/, '').trim()
}

function buildAggregatePrompt(chapters: readonly { title: string; cards: AnalysisCard[] }[]): string {
  const lines: string[] = ['【已分析章节与卡片摘要】']
  for (const ch of chapters) {
    lines.push(`\n## ${ch.title}`)
    for (const c of ch.cards) {
      lines.push(`- [${c.dimension}] ${c.title}：${c.content.slice(0, 200)}${c.claim === 'inferred' ? '（推测）' : ''}`)
    }
  }
  return [
    '下面是逐章分析后的卡片摘要（不是原文）。请做**跨章**归纳，不要重复单章结论。',
    ...lines,
    '',
    '输出 JSON 数组，每条：',
    '{"dimension":"character-arc|pacing-curve|clue-thread","title":"≤24字","content":"≤400字，要写清变化/趋势/线头","basis":["依据的章名"],"claim":"observed|inferred"}',
    '要求：',
    '1. basis 只能写上面出现过的章名（原样抄），不要编造章节；',
    '2. 没有足够依据就少写，宁少勿凑；',
    '3. 只归纳，不要给"建议怎么写"的写作指导。',
  ].join('\n')
}

/** 解析聚合输出（依据章名对不上 ⇒ 标 unverified + 降级推测） */
export function parseAggregateCards(
  text: string, knownTitles: readonly string[], maxCards = AGGREGATE_LIMITS.maxCards,
): AggregateCard[] {
  const parsed = parseObjectArrayDetailed(text)
  const rows = Array.isArray(parsed.data) ? parsed.data : []
  const known = new Set(knownTitles.map(baseChapterTitle))
  const out: AggregateCard[] = []
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const dimRaw = typeof o.dimension === 'string' ? o.dimension.trim() : ''
    const title = typeof o.title === 'string' ? o.title.trim().slice(0, 40) : ''
    const content = typeof o.content === 'string' ? o.content.trim().slice(0, 800) : ''
    if (!isAggDim(dimRaw) || !title || !content) continue
    const basis = Array.isArray(o.basis)
      ? o.basis.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean).slice(0, 8)
      : []
    const basisVerified = basis.length > 0 && basis.every(b => known.has(baseChapterTitle(b)))
    const claimIn = o.claim === 'observed' || o.claim === 'inferred' ? o.claim : ''
    out.push({
      id: `agg_${hashOf(`${dimRaw}::${title}::${out.length}`)}`,
      dimension: dimRaw,
      title,
      content,
      basis,
      basisVerified,
      claim: claimIn === 'observed' && basisVerified ? 'observed' : 'inferred',
    })
    if (out.length >= maxCards) break
  }
  return out
}

/**
 * 跨章聚合：把逐章卡片归纳成人物弧线 / 节奏曲线 / 线索与回收。
 *
 * 🔴 材料只送**已产出的卡片摘要**（不重送原文）：一是省 token，二是聚合结论必须能追到卡片，
 *    否则又会出现"结论没有依据"的老问题。
 * 🔴 没有卡片 ⇒ `skipped`（不是"这本书没有可归纳的东西"）。
 */
export async function aggregateAnalysis(
  result: AnalysisResult,
  opts: { signal?: AbortSignal; acpText?: (prompt: string, call?: { signal?: AbortSignal }) => Promise<string>; maxMaterialChars?: number } = {},
): Promise<AnalysisAggregateResult> {
  const byChapter = new Map<string, AnalysisCard[]>()
  for (const c of result.cards) {
    const arr = byChapter.get(c.chapterTitle) ?? []
    arr.push(c)
    byChapter.set(c.chapterTitle, arr)
  }
  if (!result.cards.length) return { cards: [], state: 'skipped', errorCode: 'no-cards', materialChars: 0 }

  const maxChars = Math.max(2000, opts.maxMaterialChars ?? AGGREGATE_LIMITS.maxMaterialChars)
  const chapters: { title: string; cards: AnalysisCard[] }[] = []
  let used = 0
  for (const [title, cards] of byChapter) {
    if (used >= maxChars) break
    chapters.push({ title, cards })
    used += cards.reduce((n, c) => n + c.title.length + Math.min(c.content.length, 200) + 20, 0)
  }
  const prompt = buildAggregatePrompt(chapters)
  const cfg = opts.acpText ? null : await requireProviderFor('create').catch(() => null)
  if (!cfg && !opts.acpText) {
    return { cards: [], state: 'failed', errorCode: 'no-provider', materialChars: prompt.length }
  }
  try {
    const text = await ask(cfg, '你是资深网文编辑。只根据给出的卡片摘要做跨章归纳，不编造章节与情节。', prompt, {
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.acpText ? { acpText: opts.acpText } : {}),
    })
    const cards = parseAggregateCards(typeof text === 'string' ? text : '', chapters.map(c => c.title))
    if (!cards.length) return { cards: [], state: 'failed', errorCode: 'parse-invalid', materialChars: prompt.length }
    return { cards, state: 'completed', materialChars: prompt.length }
  } catch (e) {
    const name = e instanceof Error ? e.name : ''
    if (name === 'AbortError' || opts.signal?.aborted) {
      return { cards: [], state: 'skipped', errorCode: 'cancelled', materialChars: prompt.length }
    }
    return { cards: [], state: 'failed', errorCode: 'request-failed', materialChars: prompt.length }
  }
}

/**
 * 把分析卡转成作者成果（A1 的 `kind: 'analysis'`）。
 *
 * 🔴 只做**格式转换**，不写库：是否保存由作者点「保存为成果」决定，
 *    写入走 `lib/artefacts/store.ts`（`state: 'draft'`，作者审阅后再改 kept）。
 */
export function analysisCardsToArtefacts(
  result: AnalysisResult, projectId: string, now = Date.now(),
): ArtefactRecord[] {
  return result.cards.map(c => ({
    id: uid(),
    kind: 'analysis' as const,
    projectId,
    source: {
      chapterTitle: c.chapterTitle,
      ...(c.chapterId ? { chapterId: c.chapterId } : {}),
      // 只分析路径不绑定项目章节：来源只有章名 + 文本指纹
      fingerprint: hashOf(`${c.chapterTitle}::${c.evidence?.quote ?? c.title}`),
      ...(c.evidence?.quote ? { quote: c.evidence.quote } : {}),
    },
    deps: [],
    state: 'draft' as const,
    payload: {
      dimension: c.dimension,
      title: c.title,
      content: c.content,
      claim: c.claim,
      evidenceVerified: c.evidence?.verified ?? false,
    },
    createdAt: now,
    updatedAt: now,
  }))
}
