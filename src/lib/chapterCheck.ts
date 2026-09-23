// ============ 本章体检（C3 · 2.4.2） ============
// 把既有五个检查引擎串成「针对当前章」的一条流水线：
//   · 单章直接跑：文风（styleAudit）、错别字（typoWords）、敏感词（sensitiveWords）；
//   · 全书级引擎跑完再**过滤出与本章相关**的：连续性（continuityCheck，取定位在本章的问题）、
//     伏笔（foreshadowEngine，取埋设/回收落在本章的条目及其问题）。
// 🔴 全部本地确定性检查，不发 AI 请求；默认手动触发，由 ChapterCheckPanel 调用。
import type { Chapter } from './types'
import type { AuditIssue } from './audit'
import { auditContinuity } from './continuityCheck'
import { auditForeshadow, type ForeshadowBoardItem } from './foreshadowEngine'
import { auditStyle } from './styleAudit'
import { scanTypos, type TypoHit } from './typoWords'
import { scanText, getCustomSensitiveWords, type SensitiveHit } from './sensitiveWords'

export interface ChapterCheckReport {
  chapterId: string
  chapterTitle: string
  /** 定位在本章的连续性问题（死者复活 / 人名未登记等；全书性问题不带本章定位，不收） */
  continuity: AuditIssue[]
  /** 本章埋设 / 回收的伏笔及其问题 */
  foreshadow: { codes: string[]; issues: AuditIssue[] }
  /** 敏感词命中（正文） */
  sensitive: SensitiveHit[]
  /** 错别字命中（正文） */
  typos: TypoHit[]
  /** 文风体检（正文 + 写作规范） */
  style: AuditIssue[]
}

/** 纯函数：只保留「定位在本章」的问题（location.kind === 'chapter' 且 chapterId 匹配） */
export function filterChapterIssues(issues: AuditIssue[], chapterId: string): AuditIssue[] {
  return issues.filter(i => i.location?.kind === 'chapter' && i.location.chapterId === chapterId)
}

/**
 * 纯函数：从伏笔看板里挑出「本章埋设 / 本章回收」的条目。
 *
 * ⚠️ 口径与引擎一致：看板里的 plantChapters / recycleChapters 存的是**章标题**
 * （foreshadowEngine 用 titleById 认章），同名章会被一并命中 —— 引擎本身就按标题认章，
 * 这里不另立口径。
 */
export function pickChapterForeshadow(
  board: ForeshadowBoardItem[],
  chapterTitle: string,
): { codes: string[]; issues: AuditIssue[] } {
  const codes: string[] = []
  const issues: AuditIssue[] = []
  for (const item of board) {
    const hit = item.plantChapters.includes(chapterTitle) || item.recycleChapters.includes(chapterTitle)
    if (!hit) continue
    codes.push(item.code)
    issues.push(...item.issues)
  }
  return { codes, issues }
}

/** 跑一遍本章体检。任何单个引擎失败都不拖垮整体（该组留空，面板如实展示）。 */
export async function runChapterCheck(chapter: Chapter): Promise<ChapterCheckReport> {
  const content = chapter.content || ''
  const [continuityAll, foreshadowAll, style, customWords] = await Promise.all([
    auditContinuity().catch(() => [] as AuditIssue[]),
    auditForeshadow().catch(() => ({ issues: [] as AuditIssue[], board: [] as ForeshadowBoardItem[] })),
    auditStyle(content).catch(() => [] as AuditIssue[]),
    getCustomSensitiveWords().catch(() => [] as string[]),
  ])

  return {
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    continuity: filterChapterIssues(continuityAll, chapter.id),
    foreshadow: pickChapterForeshadow(foreshadowAll.board, chapter.title),
    sensitive: scanText(content, customWords),
    typos: scanTypos(content),
    style,
  }
}

/** 汇总计数（面板顶栏用）：不含文风的「通过 ✓ / 未登记」这类提示性 info */
export function countActionable(report: ChapterCheckReport): number {
  const styleReal = report.style.filter(i => i.id !== 's-ok' && i.id !== 's-empty' && i.id !== 's-style-missing')
  return report.continuity.length + report.foreshadow.issues.length
    + report.sensitive.reduce((s, h) => s + h.count, 0)
    + report.typos.reduce((s, h) => s + h.count, 0)
    + styleReal.length
}
