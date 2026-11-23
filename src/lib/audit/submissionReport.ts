// ============ 投稿体检 · 一页汇总（3.7.0 · W6）============
//
// 定位（规划 §3 W6）：**汇总额不是新检查** —— 只收集已有结果，原文引用、不改写；
// 没有结果的项如实显示「未跑」，**不补跑、不假装跑过**。
//
// 立场：不做全书等级、不做潜力量化、不做维度雷达。开篇结论直接引用既有 AI 定性原话，
// 并注明「AI 定性意见，仅供参考，以平台实际为准」。
import type { TicketItem } from '@/lib/app/optimizeTicket'

/** 一页体检的分区（顺序即界面顺序） */
export type SubmissionSectionKey = 'opening' | 'platform' | 'body' | 'todo'

export interface SubmissionSection {
  key: SubmissionSectionKey
  title: string
  /** 有结果 = ran；没有 = not-run（界面必须如实写「未跑」） */
  state: 'ran' | 'not-run'
  /** 摘要行（可为空） */
  lines: string[]
  /** 来源面板（跳回原入口） */
  source: string
  /** 生成时间（有结果为时间戳；未跑为 0） */
  at: number
}

export interface SubmissionReportInput {
  /** 开篇三章结论（既有 AI 定性原话） */
  opening?: { conclusion: string; at: number; source: string }
  /** 分平台预检的观察句 */
  platform?: { platform: string; observations: string[]; at: number }
  /** 正文事实：逐章指标里的连续无爽点段（本地事实） */
  body?: { lines: string[]; at: number }
  /** 待办问题：优化工单未决条数 */
  todo?: { tickets: readonly TicketItem[]; at: number }
}

export interface SubmissionReport {
  sections: SubmissionSection[]
  /** 每条结果都带来源与时间；未跑项时间为 0 */
  generatedAt: number
}

const NOT_RUN_HINT = '未跑：这次还没有这类结果。本页只汇总已有结论，不会替你补跑。'

/** 纯函数：把已有结果拼成一页（不新增检查、不改写原话） */
export function buildSubmissionReport(input: SubmissionReportInput, now = Date.now()): SubmissionReport {
  const sections: SubmissionSection[] = []

  sections.push(input.opening
    ? {
      key: 'opening', title: '开篇', state: 'ran',
      lines: [
        `结论（AI 原话）：${input.opening.conclusion}`,
        'AI 定性意见，仅供参考，以平台实际为准。',
      ],
      source: input.opening.source, at: input.opening.at,
    }
    : { key: 'opening', title: '开篇', state: 'not-run', lines: [NOT_RUN_HINT], source: '颉文姬 · 审读 · 黄金三章', at: 0 })

  sections.push(input.platform
    ? {
      key: 'platform', title: '平台适配', state: 'ran',
      lines: [`目标平台：${input.platform.platform}`, ...input.platform.observations],
      source: '检查工具 · 分平台预检', at: input.platform.at,
    }
    : { key: 'platform', title: '平台适配', state: 'not-run', lines: [NOT_RUN_HINT], source: '检查工具 · 分平台预检', at: 0 })

  sections.push(input.body
    ? {
      key: 'body', title: '正文事实', state: 'ran', lines: [...input.body.lines],
      source: '检查工具 · 节奏与章末钩子 · 全书曲线', at: input.body.at,
    }
    : { key: 'body', title: '正文事实', state: 'not-run', lines: [NOT_RUN_HINT], source: '检查工具 · 节奏与章末钩子', at: 0 })

  const openTickets = input.todo?.tickets.length ?? 0
  sections.push(input.todo
    ? {
      key: 'todo', title: '待办问题', state: 'ran',
      lines: [`优化工单未决 ${openTickets} 条`, ...(openTickets ? ['按章分组的明细在「优化工单」面板里。'] : ['当前没有未决条目。'])],
      source: '优化工单', at: input.todo.at,
    }
    : { key: 'todo', title: '待办问题', state: 'not-run', lines: [NOT_RUN_HINT], source: '优化工单', at: 0 })

  return { sections, generatedAt: now }
}

/** 导出用 JSON（与界面同一份内容；字段名即界面含义） */
export function submissionReportJson(report: SubmissionReport): string {
  return JSON.stringify({
    generatedAt: report.generatedAt,
    note: '本文件只汇总已有结论；未跑项标 state=not-run，不代表通过。',
    sections: report.sections,
  }, null, 2)
}