/**
 * 外部 Agent 的多步任务台账（3.4.3 · Agent 模式可上线的任务生命周期）。
 *
 * MCP 的 `tools/call` 是单次请求/响应，没有长任务进度通道；外部 Agent 往往要跨多次调用
 * 完成「全书审读 / 逐章改写 / 设定补全」。本模块把任务状态持久化到项目 settingsKV，
 * 让 Agent 能在断开、重启后恢复进度，也让作者在「Agent 连接设置」里看到正在做什么。
 *
 * 🔴 引擎不能终止外部 Agent 进程：`cancelRequested` 只是用户/调用方的**协作式取消请求**，
 *    由 Agent 在下一步读取并自行停止；不能宣传为强制取消。
 * 🔴 台账只存任务元数据与简短说明，不存正文、不存模型对话。
 */
import type { AgentExecutorDeps } from '@/lib/agentHost/executor'
import {
  agentActionAllowed, fail,
  type AgentScope, type AgentToolResult,
} from '@/lib/agentHost/contract'
import { AgentContentInputError } from '@/lib/agentHost/contentOps'
import { getSettingFor, setSettingFor } from '@/lib/db'
import { touchProject } from '@/lib/db'
import type { OwnedOperation } from '@/lib/storage/ownedOperation'

export const AGENT_TASKS_KEY = 'agentTasks'
const MAX_TASKS = 50
const MAX_TITLE = 200
const MAX_KIND = 80
const MAX_NOTE = 2_000
const MAX_SUMMARY = 4_000

export type AgentTaskStatus = 'running' | 'paused' | 'done' | 'cancelled' | 'failed' | 'cancel-requested'

export interface AgentTaskRecord {
  id: string
  title: string
  kind: string
  status: AgentTaskStatus
  /** 0–100；未知时保持上次值 */
  progress: number
  totalSteps?: number
  currentStep?: number
  note: string
  summary: string
  cancelRequested: boolean
  createdAt: number
  updatedAt: number
}

interface AgentTaskState {
  version: 1
  tasks: AgentTaskRecord[]
}

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

function readInt(args: Record<string, unknown>, key: string, min: number, max: number, required = true): number | undefined {
  const raw = args[key]
  if (raw === undefined || raw === null) {
    if (required) throw new AgentContentInputError(`参数 ${key} 必填（整数）`)
    return undefined
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new AgentContentInputError(`参数 ${key} 必须是 ${min} 到 ${max} 之间的整数`)
  }
  return raw
}

async function requireOpenProject(projectId: string, deps: AgentExecutorDeps): Promise<AgentToolResult | null> {
  if (!(await deps.getProjects()).some(project => project.id === projectId)) return fail('PROJECT_NOT_FOUND', `项目不存在：${projectId}`)
  if (deps.currentProjectId() !== projectId) return fail('PROJECT_NOT_OPEN', '请先在引擎中打开该项目。')
  return null
}

function normalizeState(raw: unknown): AgentTaskState {
  if (raw == null) return { version: 1, tasks: [] }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Agent 任务台账损坏，拒绝读取或覆盖。')
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  if (record.version !== 1 || !Array.isArray(record.tasks)) throw new Error('Agent 任务台账版本或格式无效，拒绝读取或覆盖。')
  const tasks = Array.isArray(record.tasks)
    ? record.tasks.filter((item): item is AgentTaskRecord => !!item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string')
    : []
  const valid = (item: AgentTaskRecord) => item.id.length > 0
    && typeof item.title === 'string' && typeof item.kind === 'string'
    && ['running', 'paused', 'done', 'cancelled', 'failed', 'cancel-requested'].includes(item.status)
    && Number.isFinite(item.progress) && item.progress >= 0 && item.progress <= 100
    && typeof item.note === 'string' && typeof item.summary === 'string' && typeof item.cancelRequested === 'boolean'
    && Number.isSafeInteger(item.createdAt) && Number.isSafeInteger(item.updatedAt)
    && (item.totalSteps === undefined || (Number.isInteger(item.totalSteps) && item.totalSteps > 0))
    && (item.currentStep === undefined || (Number.isInteger(item.currentStep) && item.currentStep >= 0))
  if (tasks.length !== record.tasks.length || tasks.some(item => !valid(item)) || new Set(tasks.map(item => item.id)).size !== tasks.length) throw new Error('Agent 任务台账包含无效或重复任务，拒绝读取或覆盖。')
  return { version: 1, tasks }
}

function summaryOf(task: AgentTaskRecord) {
  return {
    id: task.id, title: task.title, kind: task.kind, status: task.status,
    progress: task.progress, totalSteps: task.totalSteps ?? null, currentStep: task.currentStep ?? null,
    note: task.note, cancelRequested: task.cancelRequested,
    createdAt: task.createdAt, updatedAt: task.updatedAt,
  }
}

async function saveState(projectId: string, state: AgentTaskState, deps: AgentExecutorDeps, hint: string, owner: OwnedOperation): Promise<AgentToolResult | null> {
  owner.assertCurrent()
  // 淘汰：只删已结束的最旧任务，绝不删仍在运行/暂停的任务。
  if (state.tasks.length > MAX_TASKS) {
    const finished = state.tasks.filter(item => ['done', 'cancelled', 'failed'].includes(item.status))
      .sort((a, b) => a.updatedAt - b.updatedAt)
    const remove = new Set(finished.slice(0, state.tasks.length - MAX_TASKS).map(item => item.id))
    state.tasks = state.tasks.filter(item => !remove.has(item.id))
  }
  if (state.tasks.length > MAX_TASKS) return fail('BAD_REQUEST', '任务台账已满，且没有可淘汰的已结束任务。')
  await setSettingFor(projectId, AGENT_TASKS_KEY, state, owner)
  void touchProject(projectId, owner.store)
  let flushed = false
  try {
    flushed = await deps.flush()
    owner.assertCurrent()
  } catch {
    return fail('OUTCOME_UNKNOWN', `${hint}：写入期间项目或存储状态改变，请先核对。`)
  }
  if (!flushed) return fail('SAVE_FAILED', `${hint}：可能已进入内存但未确认落盘，请先核对。`)
  const saved = normalizeState(await getSettingFor<unknown>(projectId, AGENT_TASKS_KEY, null, owner))
  return JSON.stringify(saved) === JSON.stringify(state) ? null : fail('OUTCOME_UNKNOWN', `${hint}：回读内容不一致`)
}

/** 创建任务。 */
export async function startAgentTask(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const title = readString(args, 'title', MAX_TITLE).trim()
  const kind = readString(args, 'kind', MAX_KIND, false).trim() || 'agent'
  const note = readString(args, 'note', MAX_NOTE, false)
  const totalSteps = readInt(args, 'totalSteps', 1, 10_000, false)
  if (!agentActionAllowed(scope, projectId, 'task:write')) return fail('SCOPE_DENIED', '该项目未授权写入 Agent 任务台账。')
  const blocked = deps.storageBlockReason()
  if (blocked) return fail('STORAGE_BLOCKED', `引擎存储当前不可写入：${blocked}`)
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const owner = deps.captureOwner(projectId)
  const state = normalizeState(await getSettingFor<unknown>(projectId, AGENT_TASKS_KEY, null, owner))
  const now = deps.now()
  const task: AgentTaskRecord = {
    id: deps.uid(), title, kind, status: 'running', progress: 0,
    ...(totalSteps ? { totalSteps } : {}), note, summary: '', cancelRequested: false,
    createdAt: now, updatedAt: now,
  }
  state.tasks = [task, ...state.tasks]
  const failure = await saveState(projectId, state, deps, '创建任务台账后未能确认保存', owner)
  if (failure) return failure
  deps.notify({ projectId, kind: 'agent-task' })
  return { ok: true, value: { taskId: task.id, title: task.title, status: task.status, progress: task.progress, updatedAt: task.updatedAt, saved: true } }
}

/** 更新进度 / 备注 / 暂停。 */
export async function updateAgentTask(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const taskId = readString(args, 'taskId', 200)
  const expectedUpdatedAt = readInt(args, 'expectedUpdatedAt', 0, Number.MAX_SAFE_INTEGER)!
  const statusRaw = args.status === undefined ? '' : readString(args, 'status', 20)
  if (statusRaw && statusRaw !== 'running' && statusRaw !== 'paused') return fail('BAD_REQUEST', 'status 只能传 running 或 paused。')
  const progress = args.progress === undefined ? undefined : readInt(args, 'progress', 0, 100, false)
  const currentStep = args.currentStep === undefined ? undefined : readInt(args, 'currentStep', 0, 1_000_000, false)
  const note = args.note === undefined ? undefined : readString(args, 'note', MAX_NOTE, false)
  if (progress === undefined && currentStep === undefined && note === undefined && !statusRaw) return fail('BAD_REQUEST', 'progress / currentStep / note / status 至少改一项。')
  if (!agentActionAllowed(scope, projectId, 'task:write')) return fail('SCOPE_DENIED', '该项目未授权写入 Agent 任务台账。')
  const blocked = deps.storageBlockReason()
  if (blocked) return fail('STORAGE_BLOCKED', `引擎存储当前不可写入：${blocked}`)
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const owner = deps.captureOwner(projectId)
  const state = normalizeState(await getSettingFor<unknown>(projectId, AGENT_TASKS_KEY, null, owner))
  const index = state.tasks.findIndex(item => item.id === taskId)
  if (index < 0) return fail('NOT_FOUND', `任务不存在：${taskId}`)
  const task = state.tasks[index]
  if (task.updatedAt !== expectedUpdatedAt) return fail('CONFLICT', '任务台账已变化，请重新读取。', { taskId, updatedAt: task.updatedAt })
  if (['done', 'cancelled', 'failed'].includes(task.status)) return fail('CONFLICT', '任务已结束，不能再更新进度。', { taskId, status: task.status })
  const next: AgentTaskRecord = {
    ...task,
    ...(statusRaw ? { status: statusRaw as AgentTaskStatus } : {}),
    ...(progress !== undefined ? { progress } : {}),
    ...(currentStep !== undefined ? { currentStep } : {}),
    ...(note !== undefined ? { note } : {}),
    updatedAt: Math.max(deps.now(), task.updatedAt + 1),
  }
  state.tasks[index] = next
  const failure = await saveState(projectId, state, deps, '更新任务台账后未能确认保存', owner)
  if (failure) return failure
  deps.notify({ projectId, kind: 'agent-task' })
  return { ok: true, value: { ...summaryOf(next), saved: true } }
}

/** 结束任务（完成 / 取消 / 失败）。 */
export async function finishAgentTask(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const taskId = readString(args, 'taskId', 200)
  const expectedUpdatedAt = readInt(args, 'expectedUpdatedAt', 0, Number.MAX_SAFE_INTEGER)!
  const status = readString(args, 'status', 20)
  if (!['done', 'cancelled', 'failed'].includes(status)) return fail('BAD_REQUEST', 'status 只能传 done / cancelled / failed。')
  const summary = readString(args, 'summary', MAX_SUMMARY, false)
  if (!agentActionAllowed(scope, projectId, 'task:write')) return fail('SCOPE_DENIED', '该项目未授权写入 Agent 任务台账。')
  const blocked = deps.storageBlockReason()
  if (blocked) return fail('STORAGE_BLOCKED', `引擎存储当前不可写入：${blocked}`)
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const owner = deps.captureOwner(projectId)
  const state = normalizeState(await getSettingFor<unknown>(projectId, AGENT_TASKS_KEY, null, owner))
  const index = state.tasks.findIndex(item => item.id === taskId)
  if (index < 0) return fail('NOT_FOUND', `任务不存在：${taskId}`)
  const task = state.tasks[index]
  if (task.updatedAt !== expectedUpdatedAt) return fail('CONFLICT', '任务台账已变化，请重新读取。', { taskId, updatedAt: task.updatedAt })
  if (['done', 'cancelled', 'failed'].includes(task.status)) return fail('CONFLICT', '任务已结束。', { taskId, status: task.status })
  const next: AgentTaskRecord = {
    ...task, status: status as AgentTaskStatus, summary,
    ...(status === 'done' ? { progress: 100 } : {}),
    updatedAt: Math.max(deps.now(), task.updatedAt + 1),
  }
  state.tasks[index] = next
  const failure = await saveState(projectId, state, deps, '结束任务后未能确认保存', owner)
  if (failure) return failure
  deps.notify({ projectId, kind: 'agent-task' })
  return { ok: true, value: { ...summaryOf(next), saved: true } }
}

/** 协作式取消请求：引擎记录意图，由外部 Agent 在下一步读取并停止。 */
export async function cancelAgentTask(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const taskId = readString(args, 'taskId', 200)
  const expectedUpdatedAt = readInt(args, 'expectedUpdatedAt', 0, Number.MAX_SAFE_INTEGER)!
  if (!agentActionAllowed(scope, projectId, 'task:write')) return fail('SCOPE_DENIED', '该项目未授权写入 Agent 任务台账。')
  const blocked = deps.storageBlockReason()
  if (blocked) return fail('STORAGE_BLOCKED', `引擎存储当前不可写入：${blocked}`)
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const owner = deps.captureOwner(projectId)
  const state = normalizeState(await getSettingFor<unknown>(projectId, AGENT_TASKS_KEY, null, owner))
  const index = state.tasks.findIndex(item => item.id === taskId)
  if (index < 0) return fail('NOT_FOUND', `任务不存在：${taskId}`)
  const task = state.tasks[index]
  if (task.updatedAt !== expectedUpdatedAt) return fail('CONFLICT', '任务台账已变化，请重新读取。', { taskId, updatedAt: task.updatedAt })
  if (['done', 'cancelled', 'failed'].includes(task.status)) return fail('CONFLICT', '任务已结束。', { taskId, status: task.status })
  const next: AgentTaskRecord = { ...task, cancelRequested: true, status: 'cancel-requested', updatedAt: Math.max(deps.now(), task.updatedAt + 1) }
  state.tasks[index] = next
  const failure = await saveState(projectId, state, deps, '登记取消请求后未能确认保存', owner)
  if (failure) return failure
  deps.notify({ projectId, kind: 'agent-task' })
  return { ok: true, value: { taskId, cancelRequested: true, status: next.status, updatedAt: next.updatedAt, note: '引擎只能登记取消请求；外部 Agent 需在下一步读取并停止。' } }
}

/** 列出任务摘要（默认最近 20 条）。 */
export async function listAgentTasks(args: Record<string, unknown>, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const limit = args.limit === undefined ? 20 : Number(args.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail('BAD_REQUEST', 'limit 必须在 1 到 100 之间。')
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const owner = deps.captureOwner(projectId)
  const state = normalizeState(await getSettingFor<unknown>(projectId, AGENT_TASKS_KEY, null, owner))
  const tasks = [...state.tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
  return { ok: true, value: { projectId, total: state.tasks.length, tasks: tasks.map(summaryOf) } }
}

/** 读取单条任务（含完整 summary）。 */
export async function getAgentTask(args: Record<string, unknown>, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const taskId = readString(args, 'taskId', 200)
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const owner = deps.captureOwner(projectId)
  const state = normalizeState(await getSettingFor<unknown>(projectId, AGENT_TASKS_KEY, null, owner))
  const task = state.tasks.find(item => item.id === taskId)
  if (!task) return fail('NOT_FOUND', `任务不存在：${taskId}`)
  return { ok: true, value: { ...summaryOf(task), summary: task.summary } }
}
