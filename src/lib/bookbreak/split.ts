/**
 * 原文切分（纯函数，零 AI 依赖，可单测）。
 *
 * 两条路径（照 `一键拆书-详细设计.md` §3 的定论「A+B」）：
 *   ① 章节正则优先 —— 命中 ≥2 个章节标题，按标题切
 *   ② 兜底分块     —— 识别不到章节（或只有一章）的纯文本，按 token 分块 + 重叠
 * 两路都记录 `charStart/charEnd`，供后续「原文引用核对」回定位（抽出的实体要能指回原文）。
 *
 * 🔴 为什么必须先切分而不是整本塞给模型：本地 27B 的 num_ctx 是 32768，
 *    一整本几十万字直接超窗口——Ollama 会**静默截断**（先裁掉尾部的章节，作者还看不出来）。
 */

export interface RawChapter {
  /** 1 起序号 */
  index: number
  /** 标题（如「第1章 风起云州」；兜底分块时为「第N段」） */
  title: string
  /** 正文（不含标题行） */
  text: string
  /** 在原文本中的字符区间（含标题行） */
  charStart: number
  charEnd: number
}

export interface TextChunk {
  start: number
  end: number
  text: string
}

export interface SplitResult {
  chapters: RawChapter[]
  mode: 'chapters' | 'chunks'
  stats: {
    /** 章节/块数 */
    count: number
    /** 原文字符数 */
    chars: number
    /** 估算 token 数 */
    estTokens: number
    /** 是否因超过 maxChunks 被截断（界面必须提示，否则用户以为整本都抽了） */
    truncated: boolean
  }
}

export interface SplitOptions {
  /** 兜底分块时每块目标 token（默认 1200） */
  chunkTokens?: number
  /** 相邻块重叠 token（默认 100，避免实体正好落在切缝上被漏抽） */
  overlapTokens?: number
  /** 最多产出多少章/块（默认 60）。超出部分不处理并置 truncated=true。 */
  maxChunks?: number
}

const DEFAULT_CHUNK_TOKENS = 1200
const DEFAULT_OVERLAP_TOKENS = 100
const DEFAULT_MAX_CHUNKS = 60

/** 中文数字字符表 */
const CN_NUM = '0-9零一二两三四五六七八九十百千壹贰叁肆伍陆柒捌玖拾佰仟'
/**
 * 章节标题行正则（整行匹配）。
 * 支持：第1章 / 第一章 / 第壹回 / 第12节 / Chapter 1 / 卷一 / 卷1： / 【序章】
 * 标题后可跟不超过 40 字的标题文字（如「第一章 风起云州」）。
 */
const CHAPTER_TITLE_RE = new RegExp(
  '^\\s*(?:' +
  `第\\s*[${CN_NUM}]+\\s*[章回节]` +
  '|Chapter\\s*\\d+' +
  `|卷\\s*[${CN_NUM}]+\\s*[:：]?` +
  '|【\\s*[^】]{1,20}\\s*】' +
  ')[^\\n]{0,40}$',
)

/** 「卷X」标题行正则 —— 落库分层时用它判断「这一条是卷边界，不是章」 */
const VOLUME_TITLE_RE = new RegExp(`^\\s*卷\\s*[${CN_NUM}]+\\s*[:：]?[^\\n]{0,40}$`)

/**
 * 这一条是不是「卷」标题（而非章节标题）。
 * 切分把「卷一」「卷1：风起」这类行也当章节条目产出，落库时要靠它分层。
 */
export function isVolumeTitle(line: string): boolean {
  return VOLUME_TITLE_RE.test(line ?? '')
}

/** 估算 token 数：中文字 ≈1 token/字，英文词 ≈1.3 token/词 */
export function estTokens(s: string): number {
  const cn = (s.match(/[\u4e00-\u9fff]/g) || []).length
  const en = (s.match(/[A-Za-z]+/g) || []).length
  const other = (s.length - cn - (s.match(/[A-Za-z]/g) || []).length)
  return cn + Math.ceil(en * 1.3) + Math.max(0, Math.floor(other * 0.3))
}

/** 按行扫描：返回每行的起始偏移与文本（\r 已剥）——R2 起导出，AI 切分回定位（aiSplit.ts）复用 */
export function scanLinesOf(raw: string): { start: number; text: string }[] {
  const out: { start: number; text: string }[] = []
  let pos = 0
  while (pos <= raw.length) {
    const nl = raw.indexOf('\n', pos)
    const end = nl < 0 ? raw.length : nl
    out.push({ start: pos, text: raw.slice(pos, end).replace(/\r$/, '') })
    if (nl < 0) break
    pos = nl + 1
  }
  return out
}

/** 按空行切段落（保留每段在原文本中的起点） */
function splitParagraphs(text: string): { start: number; text: string }[] {
  return scanLinesOf(text).filter(l => l.text.trim().length > 0)
}

/** 句末标点（含紧随的收尾引号/括号）——硬切时用它把切口退到句子边界 */
const SENTENCE_END_RE = /[。！？…；!?;]+[”’」』）】]*/g

/**
 * 从 `from` 往前找最近的句末标点，返回切口位置（含标点）；找不到返回 -1。
 * 只在 `[minPos, from]` 内找，避免退得太远把块切得过于零碎。
 */
function findSentenceEnd(text: string, from: number, minPos: number): number {
  if (from <= minPos) return -1
  const seg = text.slice(minPos, from)
  SENTENCE_END_RE.lastIndex = 0
  let last = -1
  let m: RegExpExecArray | null
  while ((m = SENTENCE_END_RE.exec(seg)) !== null) last = minPos + m.index + m[0].length
  return last
}

/**
 * 兜底分块：按 token 上限切，尽量落在段落边界，相邻块重叠 `overlapTokens`。
 * 单段落本身超限时硬切（否则一整章不换行的文本会变成一块超大块）。
 */
export function chunkText(text: string, opts: SplitOptions = {}): TextChunk[] {
  const limit = Math.max(200, opts.chunkTokens ?? DEFAULT_CHUNK_TOKENS)
  const overlap = Math.max(0, Math.min(limit / 2, opts.overlapTokens ?? DEFAULT_OVERLAP_TOKENS))
  // 重叠的字符数：中文按 1 token≈1 字估算
  const overlapChars = Math.round(overlap)
  const paras = splitParagraphs(text)
  const chunks: TextChunk[] = []
  let start = -1
  let end = -1
  let tok = 0

  const flush = () => {
    if (start < 0) return
    chunks.push({ start, end, text: text.slice(start, end) })
    // 下一块从本块尾部回推 overlapChars 起，保证切缝处的实体不被漏掉
    const back = Math.min(end - start, overlapChars)
    start = back > 0 ? end - back : -1
    end = -1
    tok = 0
  }

  for (const p of paras) {
    const pEnd = p.start + p.text.length
    const pTok = estTokens(p.text)
    if (pTok > limit) {
      // 单段超限：先收尾，再硬切这一段
      flush()
      let s = p.start
      while (s < pEnd) {
        // 硬切按字符数走（中文 1 字 ≈ 1 token）
        let e = Math.min(pEnd, s + limit)
        if (e < pEnd) {
          // 🔴 文本完整性：宁可这一块短一点，也不在句子中间截断。
          //    回溯范围取块的末 40%（下限 200 字），退到最近的句末标点。
          const floor = s + Math.max(200, Math.floor(limit * 0.6))
          const cut = findSentenceEnd(text, e, floor)
          if (cut > s) e = cut
        }
        chunks.push({ start: s, end: e, text: text.slice(s, e) })
        if (e >= pEnd) break
        s = Math.max(s + 1, e - overlapChars)
      }
      start = -1; end = -1; tok = 0
      continue
    }
    if (start < 0) { start = p.start; end = pEnd; tok = pTok; continue }
    if (tok + pTok > limit) {
      flush()
      // flush 后 start 可能已被设为回推位置；把本段并入
      start = start < 0 ? p.start : start
      end = pEnd
      tok = estTokens(text.slice(start, end))
      continue
    }
    end = pEnd
    tok += pTok
  }
  flush()
  // 过滤空白块
  return chunks.filter(c => c.text.trim().length > 0)
}

/**
 * 由「章节起始行标记」重建章节列表（R2 起导出：AI 切分回定位后复用同一套重建口径）。
 * marks 无须有序（内部会排序）；超过 maxChunks 截断并置 truncated。
 */
export function buildChaptersFromMarks(
  text: string,
  marks: { start: number; title: string }[],
  maxChunks: number,
): SplitResult {
  const sorted = [...marks].sort((a, b) => a.start - b.start)
  const chapters: RawChapter[] = []
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i].start
    const e = i + 1 < sorted.length ? sorted[i + 1].start : text.length
    // 正文：标题行之后到下一章标题之前
    const firstNl = text.indexOf('\n', s)
    const bodyStart = firstNl < 0 ? e : Math.min(firstNl + 1, e)
    chapters.push({
      index: chapters.length + 1,
      title: sorted[i].title,
      text: text.slice(bodyStart, e).trim(),
      charStart: s,
      charEnd: e,
    })
  }
  let truncated = false
  let out = chapters
  if (out.length > maxChunks) { out = out.slice(0, maxChunks); truncated = true }
  return {
    chapters: out,
    mode: 'chapters',
    stats: { count: chapters.length, chars: text.length, estTokens: estTokens(text), truncated },
  }
}

/**
 * 切分整本原文。命中 ≥2 个章节标题走章节模式，否则兜底分块。
 */
export function splitNovelText(raw: string, opts: SplitOptions = {}): SplitResult {
  const text = raw ?? ''
  const maxChunks = Math.max(1, opts.maxChunks ?? DEFAULT_MAX_CHUNKS)
  const chars = text.length
  const totalTok = estTokens(text)

  // 找章节标题行
  const marks: { start: number; title: string }[] = []
  for (const line of scanLinesOf(text)) {
    if (CHAPTER_TITLE_RE.test(line.text)) marks.push({ start: line.start, title: line.text.trim() })
  }

  if (marks.length >= 2) {
    const r = buildChaptersFromMarks(text, marks, maxChunks)
    return { ...r, stats: { ...r.stats, chars, estTokens: totalTok } }
  }

  // 兜底：整文分块
  const chunks = chunkText(text, opts)
  const chapters = chunks.map((c, i) => ({
    index: i + 1,
    title: `第${i + 1}段`,
    text: c.text.trim(),
    charStart: c.start,
    charEnd: c.end,
  }))
  let truncated = false
  let out = chapters
  if (out.length > maxChunks) { out = out.slice(0, maxChunks); truncated = true }
  return {
    chapters: out,
    mode: 'chunks',
    stats: { count: out.length, chars, estTokens: totalTok, truncated },
  }
}
