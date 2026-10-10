/**
 * 整书证据包 —— 「这本书是怎么写出来的」成书过程总览。
 *
 * 与「本章证据包」（`lib/evidencePack.ts`）的分工：
 *   · 本章包 —— 一个章节的完整过程（细纲 → 各版 → 当前稿），带各版全文，用于**单章的**自证；
 *   · 整书包 —— 全书规模的过程材料（成书时间线、逐章版本数、写作分布），用于**投稿 / 报名**时
 *     一眼看清"这本书写了多久、改了多少次"。**不含各章全文**（那会让文件大到没法用）。
 *
 * 两者共用同一套声明文案与渲染范式（`tavern/exportDoc` 的中立文档模型），改一处两边同步。
 *
 * 🔴 与本章包同一条纪律：只**如实**呈现。老数据缺什么就写缺什么，不做补全、不做推测。
 */
import type { DocModel, DocBlock } from '@/lib/tavern/exportDoc'
import type { Chapter, Volume, CardRecord } from '@/lib/types'
import type { Snapshot } from '@/lib/db'
import { MAX_SNAPSHOTS_PER_CHAPTER } from '@/lib/db/chapters'
import { chapterSeqMap } from '@/lib/outline/chapterSeq'
import { findOutlineCard } from '@/lib/ai/trajectory'
import { buildTrajectoryOverview } from '@/lib/ai/trajectory'
import { formatDate } from '@/lib/app/date'
import { APP_VERSION_LABEL } from '@/lib/app/env'
import { docFileName } from '@/lib/tavern/exportDoc'
import { formatStamp } from '@/lib/audit/evidencePack'

/** 整书证据包文件标识 */
export const BOOK_EVIDENCE_KIND = 'youth-fantasy-engine-trajectory-book'
export const BOOK_EVIDENCE_SPEC_VERSION = 1

/** 逐章一行：这一章的规模与"改了多少次" */
export interface BookEvidenceChapterRow {
  id: string
  no: number
  title: string
  wordCount: number
  createdAt: number
  updatedAt: number
  /** 本机为这一章保留的版本数 */
  versions: number
  /** 该章早期版本可能已被清理（版本名额满） */
  likelyTruncated: boolean
  /** 这一章有没有细纲卡 */
  hasOutline: boolean
}

export interface BookEvidencePack {
  kind: typeof BOOK_EVIDENCE_KIND
  specVersion: number
  exportedAt: number
  exportedAtLabel: string
  generator: { app: string; version: string }
  project: { name: string }
  overview: {
    chapters: number
    writtenChapters: number
    totalWords: number
    activeDays: number
    spanDays: number
    firstAt: number | null
    lastAt: number | null
    /** 全书累计保留的版本数 */
    totalVersions: number
  }
  /** 全书跨度的每日字数（⚠️ 项目级口径，不按章节拆分） */
  daily: { date: string; words: number }[]
  chapters: BookEvidenceChapterRow[]
  statement: string[]
}

export interface BookEvidenceInput {
  projectName: string
  chapters: Chapter[]
  volumes: Volume[]
  /** 全量快照（用 `db.getAllSnapshots()` 一次读，别逐章查） */
  snapshots: Snapshot[]
  /** 细纲卡（`db.getCardRecords('chapter-outline')`） */
  outlineCards: CardRecord[]
  dailyStats: readonly { date: string; words: number }[]
  exportedAt?: number
}

/** JSON 永远是**全量原件** */
export function buildBookEvidencePack(input: BookEvidenceInput): BookEvidencePack {
  const { projectName, chapters, volumes, snapshots, outlineCards, dailyStats } = input
  const exportedAt = input.exportedAt ?? Date.now()
  const seqs = chapterSeqMap(volumes, chapters)
  const ov = buildTrajectoryOverview(chapters, dailyStats)

  // 按章分组统计版本数（一次遍历，别对每章再 filter 一遍）
  const versionCount = new Map<string, number>()
  for (const s of snapshots) versionCount.set(s.chapterId, (versionCount.get(s.chapterId) ?? 0) + 1)

  const rows: BookEvidenceChapterRow[] = [...chapters]
    .sort((a, b) => (seqs.get(a.id) ?? 0) - (seqs.get(b.id) ?? 0))
    .map(ch => {
      const versions = versionCount.get(ch.id) ?? 0
      return {
        id: ch.id,
        no: seqs.get(ch.id) ?? 0,
        title: ch.title || '（未命名章节）',
        wordCount: ch.wordCount || 0,
        createdAt: ch.createdAt,
        updatedAt: ch.updatedAt,
        versions,
        likelyTruncated: versions >= MAX_SNAPSHOTS_PER_CHAPTER,
        hasOutline: !!findOutlineCard(seqs.get(ch.id) ?? 0, outlineCards),
      }
    })

  return {
    kind: BOOK_EVIDENCE_KIND,
    specVersion: BOOK_EVIDENCE_SPEC_VERSION,
    exportedAt,
    exportedAtLabel: formatStamp(exportedAt),
    generator: { app: '青春幻想引擎', version: APP_VERSION_LABEL },
    project: { name: projectName || '未命名作品' },
    overview: {
      chapters: ov.totalChapters,
      writtenChapters: ov.writtenChapters,
      totalWords: ov.totalWords,
      activeDays: ov.activeDays,
      spanDays: ov.spanDays,
      firstAt: ov.firstAt,
      lastAt: ov.lastAt,
      totalVersions: snapshots.length,
    },
    daily: ov.daily,
    chapters: rows,
    statement: [
      '本证据包由青春幻想引擎在本机生成，内容全部取自该软件内的创作记录（章节时间戳、章节快照、每日字数）。',
      '软件不采集键盘输入内容；导出只写入你选择的本机位置。',
      '软件不提供、也不参与任何「绕过 AI 检测」的功能；此处仅如实记录写作过程。',
      `「版本数」是本机保留的数量（每章上限 ${MAX_SNAPSHOTS_PER_CHAPTER} 个）；达到上限的章节，更早版本已被自动清理。`,
    ],
  }
}

export function bookPackToJson(pack: BookEvidencePack): string {
  return JSON.stringify(pack, null, 2)
}

/** 整书包的显示选项（JSON 不受影响） */
export interface BookEvidenceViewOptions {
  /** 附逐章一览表 */
  includeChapterList: boolean
  /** 附写作分布 */
  includeDaily: boolean
}

export const DEFAULT_BOOK_EVIDENCE_OPTIONS: BookEvidenceViewOptions = {
  includeChapterList: true,
  includeDaily: true,
}

/** 整书包 → 中立文档模型（HTML / Markdown 共用） */
export function bookPackToDocModel(pack: BookEvidencePack, opts: BookEvidenceViewOptions): DocModel {
  const blocks: DocBlock[] = []
  const stamp = (ts: number | null) => (ts ? formatStamp(ts) : '时间未知')
  const o = pack.overview

  const meta = [
    `${o.writtenChapters} / ${o.chapters} 章已有正文`,
    `共 ${o.totalWords} 字`,
    `跨度 ${o.spanDays} 天`,
    `有写作记录 ${o.activeDays} 天`,
    `本机保留 ${o.totalVersions} 个历史版本`,
    `导出 ${pack.exportedAtLabel}`,
  ]

  blocks.push({ type: 'section', text: '一、成书总览' })
  blocks.push({
    type: 'items',
    items: [
      { tag: '作品', title: pack.project.name, text: `生成于 ${pack.generator.app} ${pack.generator.version}` },
      { tag: '起笔', text: stamp(o.firstAt) },
      { tag: '最近动笔', text: stamp(o.lastAt) },
      { tag: '章节', text: `${o.chapters} 章（其中 ${o.writtenChapters} 章已有正文）` },
      { tag: '字数', text: `${o.totalWords} 字` },
      { tag: '版本留痕', text: `全书累计保留 ${o.totalVersions} 个章节版本` },
    ],
  })

  if (opts.includeDaily) {
    blocks.push({ type: 'section', text: '二、写作分布（本项目当日总字数）' })
    if (pack.daily.length === 0) {
      blocks.push({ type: 'note', text: '没有每日字数记录。' })
    } else {
      blocks.push({
        type: 'note',
        text: '口径说明：每日统计记录的是本项目当天写的总字数，软件不按章节拆分；' +
          '因此这里不能用来说明「某一章当天写了多少」。',
      })
      blocks.push({ type: 'pre', text: pack.daily.map(d => `${d.date}　${d.words} 字`).join('\n') })
    }
  }

  if (opts.includeChapterList) {
    blocks.push({ type: 'section', text: '三、逐章一览' })
    if (pack.chapters.length === 0) {
      blocks.push({ type: 'note', text: '这个作品还没有章节。' })
    } else {
      blocks.push({
        type: 'items',
        items: pack.chapters.map(ch => ({
          tag: ch.no > 0 ? `第 ${ch.no} 章` : '—',
          title: ch.title,
          text: `${ch.wordCount} 字 · 保留 ${ch.versions} 个版本${ch.hasOutline ? ' · 有细纲' : ''}` +
            `${ch.likelyTruncated ? '（版本名额已满，更早的已被清理）' : ''}`,
          sub: `建章 ${stamp(ch.createdAt)} · 最近改动 ${stamp(ch.updatedAt)}`,
        })),
      })
    }
  }

  return {
    title: `${pack.project.name} · 成书过程证据包`,
    meta,
    blocks,
    foot: pack.statement,
  }
}

export function bookEvidenceHtmlFileName(pack: BookEvidencePack): string {
  return docFileName(`${pack.project.name}-成书过程证据包`, '.html')
}

export function bookEvidenceJsonFileName(pack: BookEvidencePack): string {
  return docFileName(`${pack.project.name}-成书过程证据包`, '.json')
}

/** 界面摘要：这份整书包大概是什么规模 */
export function bookEvidenceSummary(pack: BookEvidencePack): string {
  const o = pack.overview
  return `${o.chapters} 章 · ${o.totalWords} 字 · 本机保留 ${o.totalVersions} 个版本`
}

/** 便于界面提示：跨度内最早 / 最晚的写作日期 */
export function bookDailyRange(pack: BookEvidencePack): { from: string; to: string } | null {
  if (pack.daily.length === 0) return null
  const dates = pack.daily.map(d => d.date).sort()
  return { from: formatDate(new Date(dates[0] + 'T00:00:00').getTime()), to: dates[dates.length - 1] }
}
