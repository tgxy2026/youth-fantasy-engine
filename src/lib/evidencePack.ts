/**
 * 证据包 —— 把「一章的创作轨迹」导成**可带走、可核验**的两件东西。
 *
 * 【它是什么，不是什么】
 * 它是一份**创作过程记录**：细纲是什么、改过几版、什么时候改的、现在长什么样。
 * 它**不是**、也永远不会是「检测规避工具」—— 本模块不含任何对抗检测的逻辑，
 * 措辞里也不出现那类说法。软件只做一件事：把作者真实做过的事如实记下来（红线，见 SOUL）。
 *
 * 【为什么要两份格式】
 *   · 单文件 HTML —— **给人看的**，也是唯一的**排版真源**（自包含、可打印、桌面版可一键存 PDF）；
 *   · JSON —— **给机器核验的**，含原始时间戳与各版全文，不含任何美化后的加工。
 * 两份都由同一个 {@link EvidencePack} 模型渲染 —— 两条路各读一遍库必然漂移。
 *
 * 🔴 **如实申报**：本机只保留有限个版本（见 retention 字段）。早期版本可能已被自动清理，
 *    证据包必须把这件事写出来，而不是假装"这就是全部"。这也是「可信」的一部分。
 */
import type { DocModel, DocBlock } from '@/lib/tavern/exportDoc'
import type { SnapshotSource } from '@/lib/db'
import { MAX_SNAPSHOTS_PER_CHAPTER } from '@/lib/db/chapters'
import { APP_VERSION_LABEL } from '@/lib/env'
import { docFileName } from '@/lib/tavern/exportDoc'
import type { ChapterTrajectory, TrajectoryDailyPoint } from '@/lib/trajectory'

/** 证据包文件标识（写进 JSON，供外部工具认格式） */
export const EVIDENCE_KIND = 'youth-fantasy-engine-trajectory'
/** 证据包结构版本：字段增减时 +1，读端按此兼容 */
export const EVIDENCE_SPEC_VERSION = 1

/** `YYYY-MM-DD HH:MM`（本地时区）—— 证据包里的所有人类可读时间都用它 */
export function formatStamp(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export interface EvidenceVersionRecord {
  at: number
  atLabel: string
  source: SnapshotSource
  label: string
  wordCount: number
  content: string
}

export interface EvidencePack {
  kind: typeof EVIDENCE_KIND
  specVersion: number
  exportedAt: number
  exportedAtLabel: string
  generator: { app: string; version: string }
  project: { name: string }
  chapter: {
    id: string
    no: number
    title: string
    createdAt: number
    updatedAt: number
    spanDays: number
    activeDays: number
    wordCount: number
  }
  outline: string | null
  /** 细纲卡的创建时间（2.4.0 起卡片才记；老卡片为 null → 时间线显示「起点」而不编时间） */
  outlineAt?: number | null
  versions: EvidenceVersionRecord[]
  current: { at: number; wordCount: number; content: string }
  /** 🔴 本机保留情况 —— 如实申报，不假装完整 */
  retention: { retained: number; limit: number; likelyTruncated: boolean; note: string }
  /**
   * 每日字数。
   * ⚠️ 口径＝**本项目当天写的总字数**（`dailyStats` 没有章节维度，算不出"这一章当天写了多少"）。
   */
  daily: TrajectoryDailyPoint[]
  change: { firstVersionWords: number | null; currentWords: number; delta: number | null }
  /** 生成说明：数据从哪来、有没有外发、软件不做什么 —— 随证据包一起交给对方 */
  statement: string[]
}

/** JSON 永远是**全量原件**（不受 HTML 的显示选项影响） */
export function buildEvidencePack(
  t: ChapterTrajectory, projectName: string, exportedAt: number = Date.now(),
): EvidencePack {
  const versions: EvidenceVersionRecord[] = t.nodes
    .filter(n => n.stage === 'version')
    .map(n => ({
      at: n.at ?? 0,
      atLabel: n.at ? formatStamp(n.at) : '时间未知',
      source: n.source ?? 'auto',
      label: n.label,
      wordCount: n.wordCount ?? 0,
      content: n.content,
    }))

  const note = t.likelyTruncated
    ? `本机为本章保留最近 ${t.retainedVersions} 个版本（上限 ${MAX_SNAPSHOTS_PER_CHAPTER} 个）。` +
      '更早的版本已被自动清理，不在本证据包内 —— 此处如实说明，未做补全。'
    : `本机为本章保留的 ${t.retainedVersions} 个版本已全部收录（上限 ${MAX_SNAPSHOTS_PER_CHAPTER} 个）。`

  return {
    kind: EVIDENCE_KIND,
    specVersion: EVIDENCE_SPEC_VERSION,
    exportedAt,
    exportedAtLabel: formatStamp(exportedAt),
    generator: { app: '青春幻想引擎', version: APP_VERSION_LABEL },
    project: { name: projectName || '未命名作品' },
    chapter: {
      id: t.chapterId, no: t.no, title: t.title,
      createdAt: t.createdAt, updatedAt: t.updatedAt,
      spanDays: t.spanDays, activeDays: t.activeDays, wordCount: t.currentWords,
    },
    outline: t.hasOutline ? (t.nodes.find(n => n.stage === 'outline')?.content ?? null) : null,
    outlineAt: t.nodes.find(n => n.stage === 'outline')?.at ?? null,
    versions,
    current: {
      at: t.updatedAt,
      wordCount: t.currentWords,
      content: t.nodes.find(n => n.stage === 'current')?.content ?? '',
    },
    retention: {
      retained: t.retainedVersions,
      limit: MAX_SNAPSHOTS_PER_CHAPTER,
      likelyTruncated: t.likelyTruncated,
      note,
    },
    daily: t.daily,
    change: {
      firstVersionWords: t.firstVersionWords,
      currentWords: t.currentWords,
      delta: t.wordDelta,
    },
    statement: [
      '本证据包由青春幻想引擎在本机生成，内容全部取自该软件内的创作记录（章节时间戳、章节快照、每日字数）。',
      '软件不采集键盘输入内容；导出只写入你选择的本机位置。',
      '软件不提供、也不参与任何「绕过 AI 检测」的功能；此处仅如实记录创作过程。',
      t.likelyTruncated ? '注意：早期版本可能已被自动清理，收录范围见「保留情况」。' : '',
    ].filter(Boolean),
  }
}

/** 与 {@link buildEvidencePack} 唯一的不同：多带一次 JSON 序列化（供导出与单测共用） */
export function packToJson(pack: EvidencePack): string {
  return JSON.stringify(pack, null, 2)
}

/** HTML 的显示选项（**JSON 不受影响** —— 它始终是全量原件） */
export interface EvidenceViewOptions {
  /** 附各版完整正文（关掉只留摘要，篇幅会小很多） */
  includeVersions: boolean
  /** 附细纲 */
  includeOutline: boolean
  /** 附每日字数分布 */
  includeDaily: boolean
}

export const DEFAULT_EVIDENCE_OPTIONS: EvidenceViewOptions = {
  includeVersions: true,
  includeOutline: true,
  includeDaily: true,
}

/** 章号展示：`第 3 章`（算不出章号时留空） */
function chapterNoLabel(no: number): string {
  return no > 0 ? `第 ${no} 章` : ''
}

/** 把 `{date, words}` 逐条渲染成一行（证据包里要能逐日核对，不做图表化压缩） */
function dailyLines(daily: TrajectoryDailyPoint[]): string[] {
  return daily.map(d => `${d.date}　${d.words} 字`)
}

/**
 * 证据包 → 中立文档模型（HTML / Markdown 共用）。
 *
 * 🔴 正文类内容一律走 `pre` 块（保留行首缩进），**不用 `para`** ——
 *    `para` 会 trim 掉作者手写的段首缩进（见 exportDoc 的 DocBlock 说明）。
 */
export function packToDocModel(pack: EvidencePack, opts: EvidenceViewOptions): DocModel {
  const blocks: DocBlock[] = []
  const stamp = (ts: number) => (ts ? formatStamp(ts) : '时间未知')

  const meta = [
    chapterNoLabel(pack.chapter.no),
    `当前 ${pack.chapter.wordCount} 字`,
    `本机保留 ${pack.retention.retained} 个历史版本`,
    `跨度 ${pack.chapter.spanDays} 天`,
    `有写作记录 ${pack.chapter.activeDays} 天`,
    `导出 ${pack.exportedAtLabel}`,
  ].filter(Boolean)

  // ---- 一、章节概况 ----
  blocks.push({ type: 'section', text: '一、章节概况' })
  const overview: { tag: string; title?: string; text: string }[] = [
    { tag: '章节', title: pack.chapter.title, text: pack.project.name },
    { tag: '建章', text: stamp(pack.chapter.createdAt) },
    { tag: '最近改动', text: stamp(pack.chapter.updatedAt) },
  ]
  if (pack.change.firstVersionWords !== null && pack.change.delta !== null) {
    const sign = pack.change.delta >= 0 ? '+' : ''
    overview.push({
      tag: '字数变化',
      text: `最早保留版本 ${pack.change.firstVersionWords} 字 → 当前 ${pack.change.currentWords} 字（${sign}${pack.change.delta} 字）`,
    })
  } else {
    overview.push({ tag: '字数变化', text: `当前 ${pack.change.currentWords} 字（本机没有更早的版本可比对）` })
  }
  overview.push({ tag: '历史版本', text: `本机收录 ${pack.retention.retained} 个（上限 ${pack.retention.limit} 个）` })
  blocks.push({ type: 'items', items: overview })

  // ---- 二、创作过程时间线 ----
  blocks.push({ type: 'section', text: '二、创作过程时间线' })
  const timeline: { tag: string; title?: string; text: string; sub?: string }[] = []
  if (opts.includeOutline && pack.outline) {
    timeline.push({
      tag: pack.outlineAt ? stamp(pack.outlineAt) : '起点',
      title: '章节细纲',
      text: pack.outlineAt
        ? '细纲卡创建时间'
        : '该细纲卡未记录时间（2.4.0 之前创建的卡片没有这个字段）',
      sub: '内容见下节',
    })
  }
  pack.versions.forEach((v, i) => {
    timeline.push({
      tag: stamp(v.at),
      title: v.label,
      text: `第 ${i + 1} 个保留版本 · ${v.wordCount} 字`,
    })
  })
  timeline.push({
    tag: stamp(pack.current.at),
    title: '当前稿',
    text: `${pack.current.wordCount} 字`,
  })
  blocks.push({ type: 'items', items: timeline })

  // ---- 三、保留情况（如实申报） ----
  blocks.push({ type: 'section', text: '三、本机保留情况' })
  blocks.push({ type: 'note', text: pack.retention.note })

  // ---- 四、写作分布 ----
  if (opts.includeDaily) {
    blocks.push({ type: 'section', text: '四、写作分布（本项目当日总字数）' })
    if (pack.daily.length === 0) {
      blocks.push({ type: 'note', text: '该章时间跨度内没有每日字数记录。' })
    } else {
      blocks.push({
        type: 'note',
        text: '口径说明：每日统计记录的是「本项目当天写的总字数」，软件不按章节拆分，' +
          '因此这里不能用来说明「这一章当天写了多少」。',
      })
      blocks.push({ type: 'pre', text: dailyLines(pack.daily).join('\n') })
    }
  }

  // ---- 五、细纲 ----
  if (opts.includeOutline) {
    blocks.push({ type: 'section', text: '五、本章细纲' })
    blocks.push(pack.outline
      ? { type: 'pre', text: pack.outline }
      : { type: 'note', text: '本机没有找到该章的细纲卡。' })
  }

  // ---- 六、各版本正文 ----
  if (opts.includeVersions) {
    blocks.push({ type: 'section', text: '六、各版本正文' })
    if (pack.versions.length === 0) {
      blocks.push({ type: 'note', text: '本机没有保留该章的历史版本。' })
    } else {
      pack.versions.forEach((v, i) => {
        blocks.push({ type: 'pre', label: `第 ${i + 1} 版 · ${v.label} · ${v.atLabel} · ${v.wordCount} 字`, text: v.content })
      })
    }
    blocks.push({ type: 'pre', label: `当前稿 · ${stamp(pack.current.at)} · ${pack.current.wordCount} 字`, text: pack.current.content })
  }

  return {
    title: `${pack.project.name} · ${pack.chapter.title} · 创作轨迹`,
    meta,
    blocks,
    foot: pack.statement,
  }
}

/** HTML 证据包文件名（用 `docFileName` 统一过滤非法字符） */
export function evidenceHtmlFileName(pack: EvidencePack): string {
  return docFileName(`${pack.project.name}-${pack.chapter.title}-创作轨迹`, '.html')
}

/** JSON 证据包文件名 */
export function evidenceJsonFileName(pack: EvidencePack): string {
  return docFileName(`${pack.project.name}-${pack.chapter.title}-创作轨迹`, '.json')
}

/** 供界面显示用：这份证据包大概会有多少内容（版本数 + 字数），让作者心里有数 */
export function evidenceSummary(pack: EvidencePack): string {
  const words = pack.versions.reduce((n, v) => n + v.wordCount, 0) + pack.current.wordCount
  return `${pack.retention.retained} 个历史版本 + 当前稿，合计约 ${words} 字`
}

/** 便于界面提示：跨度内最早 / 最晚的写作日期 */
export function dailyRange(pack: EvidencePack): { from: string; to: string } | null {
  if (pack.daily.length === 0) return null
  return { from: pack.daily[0].date, to: pack.daily[pack.daily.length - 1].date }
}

/** 把 `YYYY-MM-DD` 显示成 `M月D日`（页签里空间紧，日期不必带年） */
export function shortDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return date
  return `${parseInt(m[2], 10)}月${parseInt(m[3], 10)}日`
}
