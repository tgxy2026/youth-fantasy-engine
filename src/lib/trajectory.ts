/**
 * 创作轨迹 —— 把「这一章是怎么写出来的」聚合成结构化模型（唯一来源）。
 *
 * 【它解决什么问题】
 * 作者投稿 / 报名 / 被质疑时，需要一条**可核验的创作过程**：细纲是什么、改过几次、
 * 什么时候写的。这些材料本机其实都有（章节时间戳、自动快照、每日字数），
 * 但散在三个 store 里、各自的口径也不同。这里把它们合成一个模型，
 * 页签展示与证据包导出**共用同一个模型** —— 否则两处各读一遍，必然漂移
 * （本项目对「两处各写一份必然漂移」有多次教训，见 exportDoc.ts 的同款说明）。
 *
 * 🔴 **两处数据现实（不要试图绕过，只能如实标注）**：
 *   ① 细纲卡的创建时间**老数据缺、新数据有**（2.4.0 起 `saveCardRecord` 才写入 createdAt）
 *      —— 所以「细纲」节点 `at` 可能是 null。**老卡片就显示「—」/「未记录时间」，
 *      绝不补一个"当前时间"上去**（那是编造历史，比缺字段更糟）。
 *   ② 快照每章只留 {@link MAX_SNAPSHOTS_PER_CHAPTER} 份，且裁剪会丢最旧的自动快照 ——
 *      所以「初稿」可能已不在本机。这时 `likelyTruncated` 为 true，
 *      界面与证据包都必须写清「本机保留 N 个版本」，而不是假装这就是全部。
 *
 * 🔴 措辞纪律：本模块服务于**创作主权存证**。严禁任何「降低 AI 检测率 / 洗掉痕迹」
 *    一类表述 —— 我们只如实记录过程，不参与对抗检测。
 */
import type { Chapter, Volume, CardRecord } from './types'
import { snapshotSourceOf, type Snapshot, type SnapshotSource } from './db'
import { chapterSeqMap } from './chapterSeq'
import { chapterNoOf } from './outlineCard'
import { formatDate } from './date'
import { MAX_SNAPSHOTS_PER_CHAPTER } from './db/chapters'

/** 节点类型：细纲（起点，无时间） / 历史版本 / 当前稿 */
export type TrajectoryStage = 'outline' | 'version' | 'current'

export interface TrajectoryNode {
  stage: TrajectoryStage
  /** 时间戳；**细纲节点为 null**（细纲卡没有时间戳，不编时间） */
  at: number | null
  /** 展示标签，如「章节细纲」「AI 整章改写前 · 旧稿」 */
  label: string
  /** 来源（仅 version 节点有） */
  source?: SnapshotSource
  wordCount?: number
  /** 单行摘要（列表用） */
  preview: string
  /** 完整内容（证据包导出用） */
  content: string
}

/** 来源 → 人话标签。改动这里等于改界面文案，注意与 A3 的 source 语义保持一致。 */
const SOURCE_LABEL: Record<SnapshotSource, string> = {
  auto: '写作过程中 · 自动留档',
  'ai-rewrite': 'AI 整章改写前 · 旧稿',
  'ai-continue': 'AI 续写前 · 旧稿',
  'ai-generate': 'AI 生成前 · 旧稿',
  'manual-restore': '回滚版本前 · 留档',
}

/** 该来源是不是「AI 动笔前的旧稿」—— 证据包里最值钱的那一类，UI 里高亮 */
export function isAIVersion(source: SnapshotSource | undefined): boolean {
  return !!source && source.startsWith('ai-')
}

const PREVIEW_LEN = 120

/** 取内容摘要：折叠换行、截断（列表里只给一眼能认出来的量） */
function previewOf(text: string): string {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()
  return one.length > PREVIEW_LEN ? one.slice(0, PREVIEW_LEN) + '…' : one
}

/**
 * 细纲卡 → 可读文本。
 * 存储键形如 `模块::字段`，这里取末段当字段名（只用于展示，不回写）。
 */
export function outlineTextOf(card: CardRecord): string {
  const lines: string[] = []
  for (const [k, v] of Object.entries(card.data ?? {})) {
    const val = String(v ?? '').trim()
    if (!val) continue
    const label = k.includes('::') ? k.split('::').pop()! : k
    lines.push(`${label}：${val}`)
  }
  return lines.join('\n')
}

export interface TrajectoryDailyPoint { date: string; words: number }

export interface ChapterTrajectory {
  chapterId: string
  title: string
  /** 全局章号（0 = 算不出，如空项目） */
  no: number
  /** 时间线：细纲 → 各历史版本 → 当前稿 */
  nodes: TrajectoryNode[]
  /** 本机保留的历史版本数（不含当前稿） */
  retainedVersions: number
  /** 版本名额已满 —— 更早的版本很可能已被自动清理 */
  snapshotLimitReached: boolean
  /** 最早版本明显晚于建章时间 —— 早期版本很可能已被清理 */
  likelyTruncated: boolean
  /** 是否拿到了本章细纲 */
  hasOutline: boolean
  currentWords: number
  /** 最早版本的字数（没有版本时为 null） */
  firstVersionWords: number | null
  /** 当前稿相对最早版本的字数变化（没有版本时为 null） */
  wordDelta: number | null
  createdAt: number
  updatedAt: number
  /** 从最早可考时间到当前稿的天数（含首尾） */
  spanDays: number
  /**
   * 该章跨度内的每日字数。
   * ⚠️ 这是**本项目当天写的总字数**，不是「这一章当天写的」—— `dailyStats` 没有章节维度。
   *    界面与证据包都必须照这个口径写，别把它说成"这一章每天写了多少"。
   */
  daily: TrajectoryDailyPoint[]
  /** 跨度内有写作记录（words > 0）的天数 */
  activeDays: number
}

export interface TrajectoryInput {
  chapter: Chapter
  volumes: Volume[]
  /** 全书章节（用来算该章的全局章号，进而匹配细纲卡） */
  chapters: Chapter[]
  /** 该章的快照（顺序不限，内部会排序） */
  snapshots: Snapshot[]
  /** 该章的细纲卡（找不到传 null / 省略） */
  outline?: CardRecord | null
  dailyStats: readonly { date: string; words: number }[]
}

/** 按日期区间过滤每日统计（闭区间，字符串比较即可 —— 键是 `YYYY-MM-DD`） */
function dailyInRange(
  dailyStats: readonly { date: string; words: number }[],
  fromTs: number, toTs: number,
): TrajectoryDailyPoint[] {
  const from = formatDate(fromTs)
  const to = formatDate(toTs)
  return dailyStats
    .filter(s => s.date >= from && s.date <= to)
    .map(s => ({ date: s.date, words: s.words }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** 两个时间戳之间隔了几天（按本地日历日算，含首尾） */
function spanDaysOf(fromTs: number, toTs: number): number {
  const a = new Date(formatDate(fromTs) + 'T00:00:00').getTime()
  const b = new Date(formatDate(toTs) + 'T00:00:00').getTime()
  return Math.max(1, Math.round((b - a) / 86400000) + 1)
}

/** 早期版本「可能已被清理」的判据：最早快照比建章晚超过这个时长 */
const TRUNCATION_GAP_MS = 12 * 3600 * 1000

/** 聚合「一章的创作轨迹」 */
export function buildChapterTrajectory(input: TrajectoryInput): ChapterTrajectory {
  const { chapter, volumes, chapters, snapshots, outline, dailyStats } = input
  const no = chapterSeqMap(volumes, chapters).get(chapter.id) ?? 0

  // 按时间升序：最早的一版在最前（时间线上"初稿"应该在靠近细纲的一侧）
  const versions = [...snapshots].sort((a, b) => a.createdAt - b.createdAt)
  const outlineText = outline ? outlineTextOf(outline) : ''

  const nodes: TrajectoryNode[] = []
  if (outlineText) {
    nodes.push({
      // 细纲卡自 2.4.0 起带创建时间；老卡片没有 → at 为 null，
      // 🔴 界面显示「—」而不是编一个时间（编时间＝造假，这条比"好看"重要）
      stage: 'outline', at: outline?.createdAt ?? null, label: '章节细纲',
      preview: previewOf(outlineText), content: outlineText,
    })
  }
  for (const s of versions) {
    const source = snapshotSourceOf(s)
    nodes.push({
      stage: 'version', at: s.createdAt, label: SOURCE_LABEL[source] ?? '历史版本',
      source, wordCount: s.wordCount, preview: previewOf(s.content), content: s.content,
    })
  }
  nodes.push({
    stage: 'current', at: chapter.updatedAt, label: '当前稿',
    wordCount: chapter.wordCount, preview: previewOf(chapter.content), content: chapter.content,
  })

  const earliest = versions[0] ?? null
  const firstAt = earliest ? earliest.createdAt : chapter.createdAt
  const daily = dailyInRange(dailyStats, firstAt, chapter.updatedAt)
  const snapshotLimitReached = versions.length >= MAX_SNAPSHOTS_PER_CHAPTER
  const likelyTruncated = snapshotLimitReached
    || (!!earliest && earliest.createdAt - chapter.createdAt > TRUNCATION_GAP_MS)

  return {
    chapterId: chapter.id,
    title: chapter.title || '（未命名章节）',
    no,
    nodes,
    retainedVersions: versions.length,
    snapshotLimitReached,
    likelyTruncated,
    hasOutline: !!outlineText,
    currentWords: chapter.wordCount,
    firstVersionWords: earliest ? earliest.wordCount : null,
    wordDelta: earliest ? chapter.wordCount - earliest.wordCount : null,
    createdAt: chapter.createdAt,
    updatedAt: chapter.updatedAt,
    spanDays: spanDaysOf(firstAt, chapter.updatedAt),
    daily,
    activeDays: daily.filter(d => d.words > 0).length,
  }
}

// ==================== 全书总览 ====================

export interface TrajectoryOverview {
  /** 章节总数 */
  totalChapters: number
  /** 已有正文的章节数（wordCount > 0） */
  writtenChapters: number
  totalWords: number
  firstAt: number | null
  lastAt: number | null
  /** 全书跨度的每日字数 */
  daily: TrajectoryDailyPoint[]
  activeDays: number
  /** 跨度天数 */
  spanDays: number
}

/** 聚合全书层面的写作总览（页签顶部与整书证据包用） */
export function buildTrajectoryOverview(
  chapters: readonly Chapter[], dailyStats: readonly { date: string; words: number }[],
): TrajectoryOverview {
  const withWords = chapters.filter(c => c.wordCount > 0)
  const stamps = chapters.flatMap(c => [c.createdAt, c.updatedAt]).filter(t => t > 0)
  const firstAt = stamps.length ? Math.min(...stamps) : null
  const lastAt = stamps.length ? Math.max(...stamps) : null
  const daily = firstAt !== null && lastAt !== null
    ? dailyInRange(dailyStats, firstAt, lastAt)
    : [...dailyStats].map(s => ({ date: s.date, words: s.words })).sort((a, b) => a.date.localeCompare(b.date))
  return {
    totalChapters: chapters.length,
    writtenChapters: withWords.length,
    totalWords: chapters.reduce((n, c) => n + (c.wordCount || 0), 0),
    firstAt,
    lastAt,
    daily,
    activeDays: daily.filter(d => d.words > 0).length,
    spanDays: firstAt !== null && lastAt !== null ? spanDaysOf(firstAt, lastAt) : 0,
  }
}

/** 按章号找该章的细纲卡（卡名约定见 outlineCard：`第N章 标题`） */
export function findOutlineCard(
  no: number, cards: readonly CardRecord[],
): CardRecord | null {
  if (!no) return null
  return cards.find(c => chapterNoOf(c.name) === no) ?? null
}
