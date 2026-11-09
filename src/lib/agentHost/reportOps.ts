/**
 * Agent 生成的检查报告落库（3.4.3 · Agent 模式下可上线的 AI 服务产出）。
 *
 * 外部 Agent 用自己的模型完成审读 / 连续性 / 结构 / 市场等分析后，把**结构化发现**
 * 通过本模块写入引擎现有的检查报告存储（`revisionPayloads.kind='report'`），
 * 作者可以在「创作轨迹 → 检查报告」里回看，并沿用现有的「加入工单」链路。
 *
 * 🔴 只存结构化发现，不收自由文本报告：现有面板按「级别 / 标题 / 原文位置 / 说明」渲染，
 *    自由文本会让回看、计数和加入工单全部失效。
 * 🔴 不伪造证据：`where` 取不到就留空，报告层面会如实显示「未记录证据」。
 */
import type { AgentExecutorDeps } from '@/lib/agentHost/executor'
import {
  agentActionAllowed, fail,
  type AgentScope, type AgentToolResult,
} from '@/lib/agentHost/contract'
import { AgentContentInputError } from '@/lib/agentHost/contentOps'
import { persistCheckResult } from '@/lib/revision/checkPersistence'
import { loadCheckResult } from '@/lib/revision/checkPersistence'
import { listCheckReportViews } from '@/lib/revision/checkReports'

const LEVELS = ['严重', '中等', '提示'] as const
const MAX_FINDINGS = 200
const MAX_TITLE = 200
const MAX_DETAIL = 4_000
const MAX_WHERE = 400
const MAX_SUMMARY = 2_000
const MAX_CHECK_ID = 80

function readString(args: Record<string, unknown>, key: string, max: number, required = true): string {
  const raw = args[key]
  if (raw === undefined || raw === null) {
    if (required) throw new AgentContentInputError(`参数 ${key} 必填（非空字符串）`)
    return ''
  }
  if (typeof raw !== 'string') throw new AgentContentInputError(`参数 ${key} 必须是字符串`)
  if (required && !raw.trim()) throw new AgentContentInputError(`参数 ${key} 必填（非空字符串）`)
  if (raw.length > max) throw new AgentContentInputError(`参数 ${key} 超过上限（${max} 字符）`)
  return raw
}

async function requireOpenProject(projectId: string, deps: AgentExecutorDeps): Promise<AgentToolResult | null> {
  if (!(await deps.getProjects()).some(project => project.id === projectId)) return fail('PROJECT_NOT_FOUND', `项目不存在：${projectId}`)
  if (deps.currentProjectId() !== projectId) return fail('PROJECT_NOT_OPEN', '请先在引擎中打开该项目。')
  return null
}

interface Finding {
  level: string
  title: string
  detail: string
  where?: string
}

function readFindings(args: Record<string, unknown>): Finding[] {
  const raw = args.findings
  if (!Array.isArray(raw)) throw new AgentContentInputError('参数 findings 必须是数组')
  if (raw.length > MAX_FINDINGS) throw new AgentContentInputError(`findings 一次最多 ${MAX_FINDINGS} 条`)
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AgentContentInputError(`findings[${index}] 必须是对象`)
    const record = item as Record<string, unknown>
    const level = typeof record.level === 'string' ? record.level.trim() : ''
    if (!(LEVELS as readonly string[]).includes(level)) throw new AgentContentInputError(`findings[${index}].level 只能是「严重 / 中等 / 提示」`)
    const title = typeof record.title === 'string' ? record.title.trim() : ''
    const detail = typeof record.detail === 'string' ? record.detail : ''
    if (!title) throw new AgentContentInputError(`findings[${index}].title 必填`)
    if (title.length > MAX_TITLE) throw new AgentContentInputError(`findings[${index}].title 超过 ${MAX_TITLE} 字符`)
    if (detail.length > MAX_DETAIL) throw new AgentContentInputError(`findings[${index}].detail 超过 ${MAX_DETAIL} 字符`)
    const where = typeof record.where === 'string' ? record.where : ''
    if (where.length > MAX_WHERE) throw new AgentContentInputError(`findings[${index}].where 超过 ${MAX_WHERE} 字符`)
    return { level, title, detail, ...(where ? { where } : {}) }
  })
}

/** 把 Agent 的结构化发现写入检查报告存储。 */
export async function saveCheckReport(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps, requestId: string): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const checkId = readString(args, 'checkId', MAX_CHECK_ID).trim()
  const summary = readString(args, 'summary', MAX_SUMMARY, false)
  const chapterId = readString(args, 'chapterId', 200, false)
  const chapterTitleInput = readString(args, 'chapterTitle', MAX_TITLE, false)
  let chapterNo: number | undefined
  if (args.chapterNo !== undefined) {
    if (typeof args.chapterNo !== 'number' || !Number.isInteger(args.chapterNo) || args.chapterNo < 0) {
      return fail('BAD_REQUEST', 'chapterNo 必须是非负整数。')
    }
    chapterNo = args.chapterNo
  }
  const findings = readFindings(args)
  if (!findings.length) return fail('BAD_REQUEST', 'findings 至少一条；没有发现问题时不要落报告（与引擎「全绿不落库」一致）。')
  if (!agentActionAllowed(scope, projectId, 'report:write')) return fail('SCOPE_DENIED', '该项目未授权保存检查报告。')
  const blocked = deps.storageBlockReason()
  if (blocked) return fail('STORAGE_BLOCKED', `引擎存储当前不可写入：${blocked}`)
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const owner = deps.captureOwner(projectId)
  owner.assertCurrent()

  let chapterTitle = chapterTitleInput
  if (chapterId) {
    const chapters = await deps.getChapters(owner)
    const chapter = chapters.find(item => item.id === chapterId && item.projectId === projectId)
    if (!chapter) return fail('NOT_FOUND', `章节不存在：${chapterId}`)
    if (!chapterTitle) chapterTitle = chapter.title
    if (chapterNo === undefined) {
      const volumes = await deps.getVolumes(owner)
      chapterNo = deps.chapterSeqOf(volumes, chapters, chapterId)
    }
  }

  owner.assertCurrent()
  const saved = await persistCheckResult(
    `agent-${requestId}`,
    projectId,
    checkId,
    'agent',
    findings,
    undefined,
    summary || `外部 Agent 检查：${checkId}`,
    {
      ...(chapterId ? { chapterId } : {}),
      ...(chapterNo !== undefined ? { chapterNo } : {}),
      ...(chapterTitle ? { chapterTitle } : {}),
    },
  )
  if (!saved.ok || !saved.payloadId) return fail('SAVE_FAILED', `检查报告写入失败：${saved.error ?? '未知原因'}`)
  try {
    owner.assertCurrent()
    if (!await deps.flush()) return fail('OUTCOME_UNKNOWN', '检查报告可能已写入但未确认落盘，请先核对。', { reportId: saved.payloadId })
    owner.assertCurrent()
  } catch {
    return fail('OUTCOME_UNKNOWN', '检查报告写入期间项目或存储状态改变，结果未确认，请先核对。', { reportId: saved.payloadId })
  }
  const verified = await loadCheckResult(saved.payloadId)
  owner.assertCurrent()
  const stored = verified ? (Array.isArray(verified.result) ? verified.result : []) : []
  if (!verified || verified.projectId !== projectId || stored.length !== findings.length) {
    return fail('OUTCOME_UNKNOWN', '检查报告写入后回读不一致，请先在引擎中核对。', { reportId: saved.payloadId })
  }
  const counts = findings.reduce((acc, item) => {
    if (item.level === '严重') acc.serious++
    else if (item.level === '中等') acc.minor++
    else acc.info++
    return acc
  }, { serious: 0, minor: 0, info: 0 })
  return { ok: true, value: { reportId: saved.payloadId, projectId, checkId, ...(chapterId ? { chapterId } : {}), ...counts, saved: true } }
}

/** 列出当前项目的检查报告摘要（包含引擎自身和外部 Agent 落库的报告）。 */
export async function listCheckReports(args: Record<string, unknown>, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const limit = args.limit === undefined ? 20 : Number(args.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail('BAD_REQUEST', 'limit 必须在 1 到 100 之间。')
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const views = await listCheckReportViews(projectId, { limit })
  return {
    ok: true,
    value: {
      projectId,
      reports: views.map(view => ({
        id: view.id, checkId: view.checkId, source: view.source, createdAt: view.createdAt,
        chapterId: view.chapterId ?? null, chapterNo: view.chapterNo ?? null, chapterTitle: view.chapterTitle ?? '',
        summary: view.summary, serious: view.serious, minor: view.minor, info: view.info, bytes: view.bytes,
      })),
    },
  }
}

/** 读取一份检查报告的完整发现。 */
export async function readCheckReport(args: Record<string, unknown>, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const reportId = readString(args, 'reportId', 200)
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const report = await loadCheckResult(reportId)
  if (!report || report.projectId !== projectId) return fail('NOT_FOUND', `检查报告不存在或不属于该项目：${reportId}`)
  const findings = Array.isArray(report.result) ? report.result : (report.result as { data?: unknown })?.data
  return {
    ok: true,
    value: {
      reportId: report.id, checkId: report.checkId, source: report.source, summary: report.summary,
      chapterId: report.chapterId ?? null, chapterNo: report.chapterNo ?? null, chapterTitle: report.chapterTitle ?? '',
      createdAt: report.createdAt,
      findings: Array.isArray(findings) ? findings : [],
      evidence: report.evidence ?? [],
    },
  }
}
