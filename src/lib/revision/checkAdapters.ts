// ============ W4 检查适配：本地章节体检 → 留存/工单的统一发现形状 ============
// 2026-10-21 · 方案 §9.2（报告留存）+ §7.2（加入工单）
//
// 🔴 为什么必须有这一层：工单侧的 `runChapterCheck`（五个本地引擎）用 `IssueSeverity`
//    （error / warn / info）；留存侧 `checkReports` 与 AI 自检侧用中文词表（严重 / 中等 / 提示）。
//    两套词表各自都成立，但**必须在一个地方对齐**：分散在各处写 if/else 迟早会漏掉一处，
//    漏掉的结果是「冲突级问题被当成提示 → 按 A 策略不落库 → 作者回头查不到」。
//
// 🔴 为什么只落一份（一章一份）而不是五项各一份：配额是「每章 5 份」，五项各落一份的话
//    跑两轮就把同章其它检查挤没了。合成一份后，同一章重复诊断靠**指纹去重**，
//    只有发现内容真的变了才会多占一份额度。
//
// 🔴 `where` 不是装饰：工单侧 `fromContinuityFinding` 拿它去正文里逐字定位段号，
//    定位不到就没有证据（没有证据的条目会被如实标成"未定位"，不硬编段号）。

import type { AuditIssue, IssueSeverity } from '@/lib/audit/audit'
import type { ChapterCheckReport } from '@/lib/outline/chapterCheck'
import type { CheckFindingLike, CheckRunLike } from './checkReports'

/**
 * 本地诊断这条链的**固定任务 id**。
 *
 * 🔴 为什么不用每次诊断一个新 id：留存去重是按 `jobId` 圈定的（`persistCheckReports` 只比对
 *    同一 jobId 下已有的指纹）。用固定值，重跑同一章才会被认成「同一批发现」而不重复占额度；
 *    用新 id 的话，每跑一次就多一份，几百章跑几轮就把 200 份配额吃光。
 */
export const LOCAL_TICKET_JOB_ID = 'local-ticket'

/** 严重度 → 留存词表（**唯一**去处；改词表只改这里） */
export const SEVERITY_TO_LEVEL: Record<IssueSeverity, string> = {
  error: '严重',
  warn: '中等',
  info: '提示',
}

/** 本地严重度转留存级别（未知值按"提示"处理 —— 宁可少存，不可误判成严重） */
export function levelOfSeverity(s: IssueSeverity): string {
  return SEVERITY_TO_LEVEL[s] ?? '提示'
}

/** 「没问题 / 没填写作规范」这类提示不该变成发现 —— 口径与 `optimizeTicket.issuesOf` 逐字一致 */
const STYLE_NOISE_IDS = new Set(['s-ok', 's-empty', 's-style-missing'])

/** 从审计问题里取出可定位的引文（没有就不给，绝不编） */
function whereOf(i: AuditIssue): string {
  const loc = i.location
  if (!loc || !('hint' in loc)) return ''
  return typeof loc.hint === 'string' ? loc.hint : ''
}

/**
 * 一章体检报告 → 统一发现列表。
 *
 * 顺序与工单呈现一致（连续性 → 伏笔 → 敏感词 → 错别字 → 文风），
 * 便于作者把「报告里的第 3 条」和「工单里的第 3 条」对上。
 */
export function chapterReportToFindings(rep: ChapterCheckReport): CheckFindingLike[] {
  const out: CheckFindingLike[] = []

  for (const i of rep.continuity) {
    out.push({ level: levelOfSeverity(i.severity), title: i.title, detail: i.detail, where: whereOf(i) })
  }
  for (const i of rep.foreshadow.issues) {
    out.push({ level: levelOfSeverity(i.severity), title: i.title, detail: i.detail, where: whereOf(i) })
  }
  for (const h of rep.sensitive) {
    out.push({
      level: '严重',
      title: `敏感词：${h.word}`,
      detail: `${h.count} 处；例如：${h.context}`,
      where: h.word,
    })
  }
  for (const h of rep.typos) {
    out.push({
      level: '中等',
      title: `错别字：${h.word} → ${h.suggest}`,
      detail: `${h.count} 处；例如：${h.context}`,
      where: h.word,
    })
  }
  for (const i of rep.style) {
    if (STYLE_NOISE_IDS.has(i.id)) continue
    out.push({ level: levelOfSeverity(i.severity), title: i.title, detail: i.detail, where: whereOf(i) })
  }

  return out
}

/**
 * 一章体检报告 → 留存侧的形状。
 *
 * 🔴 `state` 恒为 `completed`：这里拿到的报告一定是跑完的（跑失败时调用方拿不到报告），
 *    所以不存在「失败却看起来像通过」的风险 —— 那种情况由 `CheckItemResult.status='failed'` 承担。
 */
export function chapterReportToRun(rep: ChapterCheckReport): CheckRunLike {
  return { state: 'completed', result: { data: chapterReportToFindings(rep) } }
}
