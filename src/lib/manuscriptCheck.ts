/**
 * 投稿前自检 · 行文指纹与节奏（2.4.1 · B2）—— **纯本地统计，不出 AI**
 *
 * 🔴 **立场（产品红线，与 B3 同一条）**：这是**质量自检**工具。
 *    它的存在意义是把"你自己可能看不出来的分布特征"摆在你面前，供你决定要不要改。
 *    它**不判断**"像不像机器写的"，也**绝不提供**"怎么改才不被认出来"的建议 ——
 *    因此本文件与相关 UI 里**不出现**「命中率 / 规避 / 反检测」这类词（`tests/manuscriptCheck.test.ts` 有断言盯着）。
 *
 * 【为什么全是"分布"指标而不是"分数"】
 * 句长是否均匀、段落是否等长，本身**不是缺点** —— 有些作者就爱写短句、爱用整段。
 * 所以这里只报**分布事实 + 参考区间**（`hint`），不做 0~100 的评分排名：
 * 打分会让作者机械迎合一个并不存在的"标准"。
 *
 * 【"高频套句"的分寸】
 * 网文本身的套路词（"不由得""深吸一口气"）是**类型特征**，不是毛病 ——
 * 所以只报**密度**（每千字命中几次）并给宽松参考值，不逐条标红、不建议替换。
 */
import { countWords } from '@/lib/textStats'

/** 句子切分：中英文句末标点 + 换行（保留标点，空串剔除） */
export function splitSentences(text: string): string[] {
  return String(text ?? '')
    .split(/(?<=[。！？!?…；;])/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

/** 段落切分：按空行或单换行（去空段） */
export function splitParagraphs(text: string): string[] {
  return String(text ?? '')
    .split(/\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

/** 方差（总体方差，够用且直观） */
export function variance(nums: number[]): number {
  if (nums.length === 0) return 0
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length
  return nums.reduce((s, n) => s + (n - mean) ** 2, 0) / nums.length
}

/** 变异系数（标准差 / 均值）—— 跨量级可比的"离散程度"，比方差更适合给作者看 */
export function cv(nums: number[]): number {
  if (nums.length === 0) return 0
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length
  if (mean <= 0) return 0
  return Math.sqrt(variance(nums)) / mean
}

/**
 * 常见网文套路词 / 过渡语（**类型特征，不是错误**）。
 * ⚠️ 只用于统计密度；不要据此做替换建议，也不要扩充成"黑名单"。
 */
const CLICHE_WORDS = [
  '不由得', '不禁', '竟然', '居然', '深吸一口气', '下意识', '忍不住',
  '愣住', '愣神', '微微一怔', '眉头一皱', '嘴角勾起', '嘴角微微上扬',
  '心中一惊', '心中一凛', '心神一震', '与此同时', '下一刻', '话音未落',
] as const

/** 重复的 3 字词组（同一章内出现 ≥ 3 次的），用于"重复句式/用词"提示 */
export function repeatedGrams(text: string, n = 3, minCount = 3): Array<{ gram: string; count: number }> {
  const clean = String(text ?? '').replace(/[\s，。！？、；：""''（）()【】《》…—\-·,.!?;:]/g, '')
  if (clean.length < n) return []
  const counter = new Map<string, number>()
  for (let i = 0; i + n <= clean.length; i++) {
    const g = clean.slice(i, i + n)
    counter.set(g, (counter.get(g) ?? 0) + 1)
  }
  return [...counter.entries()]
    .filter(([, c]) => c >= minCount)
    .map(([gram, count]) => ({ gram, count }))
    .sort((a, b) => b.count - a.count)
}

export interface StyleFingerprint {
  words: number
  sentences: number
  paragraphs: number
  /** 平均句长（字） */
  avgSentenceLen: number
  /** 句长变异系数（越小越"整齐"） */
  sentenceCv: number
  /** 段落长度变异系数 */
  paraCv: number
  /** 各句长度（给 UI 画分布用，已截断到前 200 条防大章拖慢渲染） */
  sentenceLens: number[]
  /** 套路词密度：每千字命中次数 */
  clichePerK: number
  /** 本章命中的套路词（词 → 次数），仅供参考 */
  clicheHits: Array<{ word: string; count: number }>
  /** 重复 3 字词组（≥3 次） */
  repeatedGrams: Array<{ gram: string; count: number }>
}

/** 单章行文指纹（纯函数，无副作用 —— 单测直接喂字符串即可） */
export function analyzeStyle(text: string): StyleFingerprint {
  const body = String(text ?? '')
  const words = countWords(body)
  const sents = splitSentences(body)
  const paras = splitParagraphs(body)
  const sentenceLens = sents.map(s => countWords(s))
  const paraLens = paras.map(p => countWords(p))

  const clicheHits: Array<{ word: string; count: number }> = []
  for (const w of CLICHE_WORDS) {
    let c = 0, idx = 0
    while ((idx = body.indexOf(w, idx)) !== -1) { c++; idx += w.length }
    if (c > 0) clicheHits.push({ word: w, count: c })
  }
  const clicheTotal = clicheHits.reduce((s, x) => s + x.count, 0)

  return {
    words,
    sentences: sents.length,
    paragraphs: paras.length,
    avgSentenceLen: sentenceLens.length ? Math.round((sentenceLens.reduce((a, b) => a + b, 0) / sentenceLens.length) * 10) / 10 : 0,
    sentenceCv: Math.round(cv(sentenceLens) * 100) / 100,
    paraCv: Math.round(cv(paraLens) * 100) / 100,
    sentenceLens: sentenceLens.slice(0, 200),
    clichePerK: words > 0 ? Math.round((clicheTotal / words) * 1000 * 10) / 10 : 0,
    clicheHits: clicheHits.sort((a, b) => b.count - a.count),
    repeatedGrams: repeatedGrams(body).slice(0, 20),
  }
}

/** 一条"观察"（不是"结论"）：值 + 参考区间 + 一句人话解释 */
export interface Observation {
  key: string
  label: string
  /** 展示值，如 "0.42" */
  value: string
  /** 参考区间说明（只描述常见范围，不判对错） */
  hint: string
  /** 是否落在参考区间之外（仅用于 UI 轻微提示，不是"不及格"） */
  notable: boolean
  /** 给作者的一句话（含"这条为什么值得看一眼"） */
  note: string
}

/**
 * 把指纹翻译成**可读的观察**。
 * 🔴 全篇口径：「参考区间」「值得看一眼」，**不是**「合格 / 不合格」。
 *    阈值是经验值，宁可宽松（避免把正常风格判成问题）。
 */
export function toObservations(fp: StyleFingerprint): Observation[] {
  const out: Observation[] = []
  if (fp.words <= 0) return out

  out.push({
    key: 'sentence-cv',
    label: '句长离散度',
    value: fp.sentenceCv.toFixed(2),
    hint: '常见 0.35 ~ 0.9',
    notable: fp.sentenceCv < 0.3,
    note: fp.sentenceCv < 0.3
      ? '这一章的句子长度相当整齐。整齐本身没问题，但如果通篇如此，读起来会少一点起伏 —— 可以挑几处换成长句或短句试试。'
      : '长短句有起伏，读感通常较自然。',
  })
  out.push({
    key: 'para-cv',
    label: '段落长度离散度',
    value: fp.paraCv.toFixed(2),
    hint: '常见 0.4 ~ 1.2',
    notable: fp.paraCv < 0.25,
    note: fp.paraCv < 0.25
      ? '段落长度很接近。若通篇等长，版面会显得平；可以按内容的轻重自然分长短。'
      : '段落长短有变化。',
  })
  out.push({
    key: 'cliche',
    label: '套路词密度',
    value: `${fp.clichePerK} 次/千字`,
    hint: '常见 0 ~ 12 次/千字',
    notable: fp.clichePerK > 15,
    note: fp.clichePerK > 15
      ? '过渡语 / 套路词用得偏频繁。这是网文常见写法、不是错误，只是密度高时容易让读者觉得"跳得快"。'
      : '过渡语密度在常见范围内。',
  })
  out.push({
    key: 'repeated',
    label: '重复用词',
    value: `${fp.repeatedGrams.length} 组`,
    hint: '同一章内出现 3 次以上的三字词组',
    notable: fp.repeatedGrams.length > 8,
    note: fp.repeatedGrams.length > 8
      ? '有若干词组在本章反复出现（见下方清单）。多数是人物名或专名，属正常；若混有形容易看腻。'
      : '没有明显的高频重复用词。',
  })
  return out
}

/** 章节节奏：字数分布是否异常均匀 + 更新节奏 */
export interface PacingReport {
  chapters: number
  /** 有正文的章数 */
  written: number
  avgWords: number
  /** 章节字数的变异系数（越小越均匀） */
  wordCv: number
  shortest: { title: string; words: number }
  longest: { title: string; words: number }
  /** 写作天数 / 跨度天 */
  activeDays: number
  spanDays: number
  /** 平均每天写的字数 */
  avgPerActiveDay: number
  observations: Observation[]
}

/**
 * 节奏与更新自检。
 * 🔴 「更新节奏」只报**事实**（日均多少、跨度多久），**不做**"是否超出人类规律"的判断 ——
 *    那既不可靠（作者就是可能爆更），也带有"你得证明自己不是机器"的暗示，与产品立场相悖。
 */
export function analyzePacing(
  chapters: Array<{ title: string; content: string; wordCount: number }>,
  dailyStats: Array<{ date: string; words: number }> = [],
): PacingReport {
  const written = chapters.filter(c => (c.wordCount || 0) > 0)
  const lens = written.map(c => countWords(c.content) || c.wordCount || 0)
  const avgWords = lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0
  const wordCv = Math.round(cv(lens) * 100) / 100

  const sorted = [...written].sort((a, b) => (countWords(a.content) || a.wordCount) - (countWords(b.content) || b.wordCount))
  const shortest = sorted[0]
  const longest = sorted[sorted.length - 1]

  const active = dailyStats.filter(d => (d.words || 0) > 0)
  const activeDays = active.length
  const spanDays = dailyStats.length
  const avgPerActiveDay = activeDays ? Math.round(active.reduce((s, d) => s + d.words, 0) / activeDays) : 0

  const obs: Observation[] = []
  if (lens.length >= 3) {
    obs.push({
      key: 'word-cv',
      label: '章节字数离散度',
      value: wordCv.toFixed(2),
      hint: '常见 0.2 ~ 0.7',
      notable: wordCv < 0.12,
      note: wordCv < 0.12
        ? '各章字数非常接近。若你本来就想统一章长，这是好事；若不是有意的，可以留意一下是否被"凑字"带偏。'
        : '章节长度有自然变化。',
    })
  }
  if (activeDays > 0) {
    obs.push({
      key: 'pace',
      label: '写作节奏',
      value: `${avgPerActiveDay} 字/天`,
      hint: `动笔 ${activeDays} 天 · 跨度 ${spanDays} 天`,
      notable: false,
      note: '这只是记录你的实际节奏，供你回看进度用 —— 快慢没有标准。',
    })
  }

  return {
    chapters: chapters.length,
    written: written.length,
    avgWords,
    wordCv,
    shortest: shortest ? { title: shortest.title, words: countWords(shortest.content) || shortest.wordCount } : { title: '', words: 0 },
    longest: longest ? { title: longest.title, words: countWords(longest.content) || longest.wordCount } : { title: '', words: 0 },
    activeDays,
    spanDays,
    avgPerActiveDay,
    observations: obs,
  }
}

/** 把观测拼成一段可复制的报告文本（供作者留档 / 贴给编辑） */
export function buildCheckReportText(
  bookName: string,
  fp: StyleFingerprint,
  pacing: PacingReport,
  extras: { continuity: number; foreshadowOpen: number; chapterTitle?: string },
): string {
  const lines: string[] = []
  lines.push(`《${bookName || '本书'}》投稿前自检报告`)
  if (extras.chapterTitle) lines.push(`（行文部分基于：${extras.chapterTitle}）`)
  lines.push('')
  lines.push('一、设定与结构')
  lines.push(`· 前后矛盾 / 设定冲突：${extras.continuity} 处`)
  lines.push(`· 尚未回收的伏笔：${extras.foreshadowOpen} 条`)
  lines.push('')
  lines.push('二、行文分布（本章）')
  lines.push(`· 字数 ${fp.words} · 句 ${fp.sentences} · 段 ${fp.paragraphs}`)
  for (const o of toObservations(fp)) lines.push(`· ${o.label}：${o.value}（${o.hint}）—— ${o.note}`)
  lines.push('')
  lines.push('三、节奏（全书）')
  lines.push(`· 已有正文 ${pacing.written} / ${pacing.chapters} 章 · 平均 ${pacing.avgWords} 字/章`)
  for (const o of pacing.observations) lines.push(`· ${o.label}：${o.value}（${o.hint}）—— ${o.note}`)
  lines.push('')
  lines.push('说明：以上均为本地统计与既有引擎的结果，未使用 AI；参考区间是经验值，不是评分标准。')
  return lines.join('\n')
}
