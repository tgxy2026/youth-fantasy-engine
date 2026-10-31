/**
 * 3.3.3 · A1：重复与表达观察（**纯本地**，不发任何模型请求）。
 *
 * 【它回答什么】「这一段/这一句，前面是不是已经出现过？」——只报**可定位的重复事实**，
 *    并且把「完全重复」（事实）与「近似重复」（候选）分开；后者永远不混进事实成绩。
 *
 * 【范围】当前章 + 按卷章顺序在它之前最多 N 章（默认 10，可设 1–30）；**不含后续章**。
 *    空章跳过，并回报实际覆盖了多少章 —— 不能拿"我查了 10 章"糊弄只查到 3 章的情形。
 *
 * 【为什么不做词频推断】规划 §3 明确删掉「动词/名词密度 → 注水」这类因果推断：
 *    密度是分布事实，不是质量结论；本模块也不判断"像不像机器写的"。
 *
 * 【忽略】专名、口头禅、引用、回顾、刻意复沓都可以忽略；忽略有作用域（按组 id + 文本指纹），
 *    可撤销，并在运行时只过滤展示，不改变"检测到了什么"的原始结果。
 *
 * 🔴 算法版本变化会让旧缓存与旧忽略失效（`ALGORITHM_VERSION` 进指纹）。
 * 🔴 性能：不做全书两两比较。范围上限 11 章，近似候选在同一长度桶内比较，桶内上限 300 句。
 */
export const ALGORITHM_VERSION = 'repetition-v1'

export interface ChapterInput {
  id: string
  title: string
  content: string
  order: number
}

export interface Occurrence {
  chapterId: string
  chapterTitle: string
  /** 在**该章正文**中的字符区间 [start, end) */
  start: number
  end: number
  /** 原文短引用（逐字，未改写） */
  quote: string
}

export type RepetitionKind = 'sentence' | 'paragraph' | 'gram'

export interface RepetitionGroup {
  /** 稳定 id：kind + 标准化文本哈希（忽略记录按它绑定） */
  id: string
  kind: RepetitionKind
  /** 首次出现的原文 */
  text: string
  /** 标准化后的比较串（不展示，供调试/测试） */
  normalized: string
  /** 出现次数（同一章内多次也累计） */
  count: number
  /** 覆盖到几章 */
  chapters: number
  occurrences: Occurrence[]
  /** 近似候选的相似度（0–1）；完全重复不带 */
  similarity?: number
  /** true = 近似候选（不是"确定重复"） */
  candidateOnly?: boolean
}

export interface RepetitionReport {
  /** 实际参与比对的章数（含当前章，已跳过空章） */
  coveredChapters: number
  /** 范围内因空正文被跳过的章数 */
  skippedEmpty: number
  /** 请求范围（1–30） */
  range: number
  groups: RepetitionGroup[]
  /** 完全不重复组数（不含近似候选） */
  exactGroups: number
  /** 近似候选组数 */
  candidateGroups: number
  /** 因作者忽略而未展示的组数 */
  ignoredGroups: number
  algorithmVersion: string
  /** 参与比对的章 + 正文指纹（改一个字就变） */
  inputFingerprint: string
}

const MIN_SENTENCE_CHARS = 8
/** 近似候选阈值：一个字符之差约 0.82；低于 0.8 的差异已经不算"近似重复"（宁可少列） */
const NEAR_DUP_THRESHOLD = 0.8
const MIN_PARAGRAPH_CHARS = 16
const MAX_OCCURRENCES_PER_GROUP = 50
const MAX_BUCKET = 300

/** FNV-1a + 长度（同步；只用于"变了没有"，不做安全用途） */
export function stableHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${h.toString(16).padStart(8, '0')}-${text.length.toString(16)}`
}

/** 比较用标准化：去空白与标点、全角转半角、英文小写（用于判"完全重复"） */
export function normalizeForCompare(s: string): string {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；：""''（）()【】《》…—\-·,.!?;:'"“”‘’<>《》]/g, '')
}

interface Span { start: number; end: number; raw: string }

/** 句子区间：以中英文句末标点/分号/换行为界，保留区间与原文 */
export function sentenceSpans(text: string): Span[] {
  const out: Span[] = []
  const re = /[^。！？!?…；;\n]+[。！？!?…；;]?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const lead = m[0].length - m[0].trimStart().length
    const raw = m[0].trim()
    if (!raw) continue
    out.push({ start: m.index + lead, end: m.index + lead + raw.length, raw })
  }
  return out
}

/** 段落区间：按换行切分（与 `splitParagraphs` 同口径：一行一段，空行忽略） */
export function paragraphSpans(text: string): Span[] {
  const out: Span[] = []
  const re = /[^\n]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const lead = m[0].length - m[0].trimStart().length
    const raw = m[0].trim()
    if (!raw) continue
    out.push({ start: m.index + lead, end: m.index + lead + raw.length, raw })
  }
  return out
}

/** 三字词组（与 `manuscriptCheck.repeatedGrams` 同口径；这里保留出现位置） */
export function gramSpans(text: string, n = 3): Map<string, Span[]> {
  const out = new Map<string, Span[]>()
  const cleanRe = /[\s，。！？、；：""''（）()【】《》…—\-·,.!?;:]/g
  // 逐个扫描：以"干净字符"为索引建立原文位置映射，避免用去标点后的串反查位置（会错位）
  const chars: Array<{ ch: string; start: number; end: number }> = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (cleanRe.test(ch)) { cleanRe.lastIndex = 0; continue }
    cleanRe.lastIndex = 0
    chars.push({ ch, start: i, end: i + 1 })
  }
  for (let i = 0; i + n <= chars.length; i++) {
    const slice = chars.slice(i, i + n)
    const g = slice.map(c => c.ch).join('')
    const span: Span = { start: slice[0].start, end: slice[n - 1].end, raw: text.slice(slice[0].start, slice[n - 1].end) }
    const arr = out.get(g) ?? []
    arr.push(span)
    out.set(g, arr)
  }
  return out
}

function toOccurrence(ch: ChapterInput, span: Span): Occurrence {
  return { chapterId: ch.id, chapterTitle: ch.title || '（未命名章）', start: span.start, end: span.end, quote: span.raw }
}

/** 二元组 Dice 相似度（中文按字符二元组，够用且 O(n)） */
export function diceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const bigrams = (s: string) => {
    const m = new Map<string, number>()
    for (let i = 0; i + 1 < s.length; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    return m
  }
  const A = bigrams(a), B = bigrams(b)
  let inter = 0
  for (const [g, n] of A) inter += Math.min(n, B.get(g) ?? 0)
  const total = (a.length - 1) + (b.length - 1)
  return total > 0 ? (2 * inter) / total : 0
}

function assertRange(range: number): number {
  if (!Number.isFinite(range)) return 10
  return Math.min(30, Math.max(1, Math.round(range)))
}

/** 选范围：当前章 + 其前面最多 `range` 章（按传入顺序，已排序）；不含后续章 */
export function scopeChapters(chapters: ChapterInput[], currentChapterId: string, range: number): ChapterInput[] {
  const r = assertRange(range)
  const idx = chapters.findIndex(c => c.id === currentChapterId)
  if (idx < 0) return []
  const start = Math.max(0, idx - r)
  return chapters.slice(start, idx + 1)
}

export interface AnalyzeInput {
  /** 已按阅读顺序排好的章节 */
  chapters: ChapterInput[]
  currentChapterId: string
  /** 往前看几章（1–30，默认 10） */
  range?: number
  /** 作者忽略的组 id（来自本机记录） */
  ignoredIds?: string[]
}

/**
 * 范围指纹（轻量，不跑重复检测）—— 界面据此判断"缓存还能不能用"。
 * 与 `analyzeRepetition` 内部用的是同一个算法，避免两处漂移。
 */
export function scopeFingerprint(chapters: ChapterInput[], currentChapterId: string, range = 10): string {
  const scope = scopeChapters(chapters, currentChapterId, range)
  const parts: string[] = []
  for (const c of scope) {
    if (!(c.content ?? '').trim()) continue
    parts.push(`${c.id}\u0001${c.content}`)
  }
  return `${ALGORITHM_VERSION}:${stableHash(parts.join('\u0002'))}`
}

/**
 * 跑一次重复检测（纯函数）。
 * @returns 报告；范围内没有当前章/没有正文时返回空报告（counts 如实为 0）
 */
export function analyzeRepetition(input: AnalyzeInput): RepetitionReport {
  const range = assertRange(input.range ?? 10)
  const scope = scopeChapters(input.chapters, input.currentChapterId, range)
  const nonEmpty = scope.filter(c => (c.content ?? '').trim().length > 0)
  const skippedEmpty = scope.length - nonEmpty.length
  const inputFingerprint = scopeFingerprint(input.chapters, input.currentChapterId, range)

  type Acc = { kind: RepetitionKind; text: string; normalized: string; occ: Occurrence[] }
  const exact = new Map<string, Acc>()

  const add = (kind: RepetitionKind, span: Span, ch: ChapterInput, minChars: number) => {
    const norm = normalizeForCompare(span.raw)
    if (norm.length < minChars) return
    const id = `${kind}:${stableHash(norm)}`
    const cur = exact.get(id)
    if (cur) cur.occ.push(toOccurrence(ch, span))
    else exact.set(id, { kind, text: span.raw, normalized: norm, occ: [toOccurrence(ch, span)] })
  }

  for (const ch of nonEmpty) {
    for (const s of sentenceSpans(ch.content)) add('sentence', s, ch, MIN_SENTENCE_CHARS)
    for (const p of paragraphSpans(ch.content)) add('paragraph', p, ch, MIN_PARAGRAPH_CHARS)
    for (const [g, spans] of gramSpans(ch.content)) {
      // 单章内出现 ≥3 次才算"重复词组"（与既有行文指标同口径）
      if (spans.length < 3) continue
      const norm = normalizeForCompare(g)
      const id = `gram:${stableHash(norm)}`
      const cur = exact.get(id)
      if (cur) cur.occ.push(...spans.map(s => toOccurrence(ch, s)))
      else exact.set(id, { kind: 'gram', text: g, normalized: norm, occ: spans.map(s => toOccurrence(ch, s)) })
    }
  }

  const ignored = new Set(input.ignoredIds ?? [])
  let ignoredGroups = 0
  const groups: RepetitionGroup[] = []
  for (const [id, acc] of exact) {
    if (acc.occ.length < 2) continue
    if (ignored.has(id)) { ignoredGroups++; continue }
    const chapters = new Set(acc.occ.map(o => o.chapterId)).size
    groups.push({
      id, kind: acc.kind, text: acc.text, normalized: acc.normalized,
      count: acc.occ.length, chapters,
      occurrences: acc.occ.slice(0, MAX_OCCURRENCES_PER_GROUP),
    })
  }

  // 近似候选：只在"不同句子、同一长度桶"里比较（范围小，但也不能全书两两比）
  const sentPool: Array<{ ch: ChapterInput; span: Span; norm: string }> = []
  for (const ch of nonEmpty) {
    for (const s of sentenceSpans(ch.content)) {
      const norm = normalizeForCompare(s.raw)
      if (norm.length < 12) continue
      sentPool.push({ ch, span: s, norm })
    }
  }
  const buckets = new Map<number, typeof sentPool>()
  for (const item of sentPool) {
    const key = Math.floor(item.norm.length / 8)
    const arr = buckets.get(key) ?? []
    if (arr.length < MAX_BUCKET) arr.push(item)
    buckets.set(key, arr)
  }
  const seenPair = new Set<string>()
  for (const arr of buckets.values()) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j]
        if (a.norm === b.norm) continue
        const sim = diceSimilarity(a.norm, b.norm)
        if (sim < NEAR_DUP_THRESHOLD) continue
        const lo = a.norm < b.norm ? a : b
        const hi = lo === a ? b : a
        const id = `near:${stableHash(lo.norm)}:${stableHash(hi.norm)}`
        if (seenPair.has(id) || ignored.has(id)) { if (ignored.has(id)) ignoredGroups++; continue }
        seenPair.add(id)
        groups.push({
          id, kind: 'sentence', text: lo.span.raw, normalized: lo.norm,
          count: 2, chapters: new Set([lo.ch.id, hi.ch.id]).size,
          occurrences: [toOccurrence(lo.ch, lo.span), toOccurrence(hi.ch, hi.span)],
          similarity: Math.round(sim * 100) / 100,
          candidateOnly: true,
        })
      }
    }
  }

  groups.sort((a, b) => {
    if (!!a.candidateOnly !== !!b.candidateOnly) return a.candidateOnly ? 1 : -1
    if (b.count !== a.count) return b.count - a.count
    return b.text.length - a.text.length
  })
  const exactGroups = groups.filter(g => !g.candidateOnly).length
  const candidateGroups = groups.filter(g => g.candidateOnly).length

  return {
    coveredChapters: nonEmpty.length,
    skippedEmpty, range, groups, exactGroups, candidateGroups, ignoredGroups,
    algorithmVersion: ALGORITHM_VERSION, inputFingerprint,
  }
}

/**
 * 组 id 就是忽略作用域：`kind:hash(标准化文本)` 已经含内容指纹，正文一变它就变。
 * （早先还打算再拼一层哈希，纯属重复 —— 保留函数是为了调用点不用改。）
 */
export function ignoreKeyOf(group: RepetitionGroup): string {
  return group.id
}

/** 校验一条引文是否逐字出现在该章正文里（定位失效的旧报告必须被识别） */
export function quoteMatches(content: string, occ: Occurrence): boolean {
  return content.slice(occ.start, occ.end) === occ.quote
}