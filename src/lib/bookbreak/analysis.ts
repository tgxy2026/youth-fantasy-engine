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
}

export type AnalysisUnitState = 'completed' | 'failed' | 'skipped'

export interface AnalysisUnit {
  index: number
  chapterTitle: string
  chars: number
  /** 单元键（章名 + 文本指纹）—— 复用/重试的判据 */
  unitKey: string
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
  unit: { index: number; chapterTitle: string; text: string; unitKey: string }
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
export async function analyzeBook(raw: string, opts: AnalysisOptions = {}): Promise<AnalysisResult> {
  const dims = (opts.dimensions?.length ? [...opts.dimensions] : ANALYSIS_DIMENSIONS.map(d => d.id))
    .filter(d => VALID_DIMS.has(d))
  const maxUnitChars = Math.max(500, opts.maxUnitChars ?? ANALYSIS_LIMITS.maxUnitChars)
  const maxUnits = Math.max(1, opts.maxUnits ?? ANALYSIS_LIMITS.maxUnits)
  const sp = splitNovelText(raw, opts.maxChunks !== undefined ? { maxChunks: opts.maxChunks } : {})
  const { units, truncated } = expandUnits(sp, maxUnitChars, maxUnits)
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
      done.push({ ...reusable, index: unit.index, chapterTitle: unit.chapterTitle, chars: unit.text.length })
      processedChars += unit.text.length
      opts.onProgress?.({ done: done.length, total: units.length, label: `复用已完成单元：${unit.chapterTitle}` })
      continue
    }
    if (aborted) {
      done.push({ index: unit.index, chapterTitle: unit.chapterTitle, chars: unit.text.length, unitKey: unit.unitKey, state: 'skipped', cards: [] })
      continue
    }
    if (!cfg && !opts.acpText) {
      done.push({
        index: unit.index, chapterTitle: unit.chapterTitle, chars: unit.text.length, unitKey: unit.unitKey,
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
        unit: { index: unit.index, chapterTitle: unit.chapterTitle, text: unit.text, unitKey: unit.unitKey },
        dimensions: dims,
      })
      done.push({
        index: unit.index, chapterTitle: unit.chapterTitle, chars: unit.text.length, unitKey: unit.unitKey,
        state: 'completed', cards,
      })
      processedChars += unit.text.length
    } catch (e) {
      const name = e instanceof Error ? e.name : ''
      if (name === 'AbortError' || opts.signal?.aborted) {
        aborted = true
        done.push({ index: unit.index, chapterTitle: unit.chapterTitle, chars: unit.text.length, unitKey: unit.unitKey, state: 'skipped', cards: [] })
      } else {
        const code = /JSON|解析|parse/i.test(e instanceof Error ? e.message : '') ? 'parse-invalid' : 'request-failed'
        done.push({
          index: unit.index, chapterTitle: unit.chapterTitle, chars: unit.text.length, unitKey: unit.unitKey,
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
  return { units: done, cards, coverage, dimensions: dims, aborted }
}

function buildSystem(): string {
  return '你是资深网文编辑，擅长拆解叙事方法。只依据给出的原文分析，不脑补未出现的内容；引文必须逐字摘自原文。'
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
