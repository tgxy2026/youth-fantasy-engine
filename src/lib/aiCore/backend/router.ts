/**
 * 3.4.3 · 三轨路由（后端轨，P1 隔离原型的产品化移植）
 *
 * 三轨（规划 §6.B）：
 *   baseline 保底轨：现有 AI 功能全量；未配置 Agent 时与 3.4.2 逐字一致（纯透传）；
 *                    配置后默认仍走原通道；无人值守 / 自动静默链路永不路由到 Agent。
 *   adapt    需适配轨：显式选择 Agent 但能力不足 / 产物形态不符 ⇒ 跳过并留痕，禁止静默返回空。
 *   enhance  增强轨：仅手动触发 + 显式选择；产出独立产物 descriptor，回写走既有导入通道。
 *
 * 🔴 路由唯一依据 = 能力声明（DriverCapabilities），不另立能力表。
 * 🔴 降级与拒绝必须可观测：每次路由写账本（track/action/reason/backend/quota）。
 * 🔴 本文件是叶子逻辑：不 import db / 门面 / chat；保底轨执行体由调用方注入，
 *    因此与 chat() 不构成环（chat → router，router 不认识 chat）。
 */

import type { ChatMessage } from '@/lib/aiCore/core'
import { assertBackendCapabilities, type AgentBackend, type BackendArtifact, type BackendTask, type RecordedBackendEvent } from './contract'
import type { UsageQuota } from '@/lib/aiCore/usage'

/** 一次逻辑调用的路由输入：消息历史（保底轨的其余上下文由调用方闭包携带，路由层不碰密钥） */
export interface RouteCall {
  messages: ChatMessage[]
}

/** Agent 轨的执行结果：事件流 + 产物；text 只在 consumes='text' 时拼装（仅 message 事件） */
export interface AgentRunResult {
  sessionId: string
  events: readonly RecordedBackendEvent[]
  artifacts: readonly BackendArtifact[]
  text?: string
}

/** 路由账本条目：每次路由必写一条（含跳过/失败），供调用归属与复盘 */
export interface RouteLedgerEntry {
  at: number
  taskId: string
  track: 'baseline' | 'adapt' | 'enhance'
  action: 'ran' | 'skipped' | 'failed'
  reason: string | null
  backend: string | null
  quota: UsageQuota | null
  sessionId?: string
}

export type RouteOutcome<B> =
  | { track: 'baseline' | 'adapt' | 'enhance'; action: 'ran'; result: B | AgentRunResult }
  | { track: 'baseline' | 'adapt' | 'enhance'; action: 'skipped'; reason: string; result: null }

/**
 * 跳过留痕的显式错误（chat() 闸用它把「本次未执行」如实抛给调用方）。
 * 🔴 绝不返回空字符串冒充成功 —— 调用方 catch 后应提示「本次未执行 / 由何原因跳过」。
 */
export class BackendTrackSkipError extends Error {
  readonly reason: string
  constructor(reason: string, message: string) {
    super(message)
    this.name = 'BackendTrackSkipError'
    this.reason = reason
  }
}

const SKIP_TEXT: Record<string, string> = {
  'agent-no-clean-json': 'Agent 后端产出的是过程事件流与产物文件，没有干净的 JSON 字符串；本次结构化任务未执行（未改动任何数据）。请继续使用 API 模型完成该任务。',
  'agent-artifact-requires-session': '产物任务需要使用 Agent 会话接口，chat 只能返回正文；本次未执行。',
  'no-agent-backend': '尚未配置可用的 Agent 后端，本次未执行。请先在「模型设置 → Agent 后端」查看可用后端。',
  'enhance-requires-manual-explicit-agent': '增强轨任务仅支持手动触发并显式选择 Agent；本次未执行。',
}

export function skipMessage(reason: string): string {
  if (reason.startsWith('missing-capabilities:')) {
    return `Agent 后端缺少本任务必需的能力（${reason.slice('missing-capabilities:'.length)}），本次未执行（已留痕）。请改用 API 模型。`
  }
  return SKIP_TEXT[reason] ?? `本次未执行（${reason}，已留痕）。`
}

export interface BackendRouter<B> {
  ledger: RouteLedgerEntry[]
  route(task: BackendTask, call: RouteCall): Promise<RouteOutcome<B>>
}

/**
 * 创建三轨路由。
 * @param runBaseline 保底轨执行体（协议轨）。不可用时传 null —— 路由会如实记 failed 并抛错。
 * @param baselineQuota 保底轨的额度口径（调用方从协议 driver 能力声明取，供路由账本如实记账）。
 * @param agentBackend 已注册的 Agent 后端；null = 未配置（默认轨纯透传，逐字一致）。
 */
export function createBackendRouter<B>({ runBaseline, baselineQuota = null, agentBackend = null, ledger = [] }: {
  runBaseline: ((call: RouteCall) => Promise<B>) | null
  baselineQuota?: UsageQuota | null
  agentBackend?: AgentBackend | null
  ledger?: RouteLedgerEntry[]
}): BackendRouter<B> {
  if (agentBackend) assertBackendCapabilities(agentBackend.capabilities, `backend ${agentBackend.id}`)

  function record(entry: Omit<RouteLedgerEntry, 'at'>): void {
    ledger.push({ at: ledger.length, ...entry })
  }

  function missingCapabilities(task: BackendTask): string[] {
    const caps = agentBackend!.capabilities
    return Object.entries(task.requires ?? {})
      .filter(([key, need]) => need === true && caps[key as keyof typeof caps] !== true)
      .map(([key]) => key)
  }

  async function baseline(task: BackendTask, call: RouteCall): Promise<RouteOutcome<B>> {
    if (!runBaseline) {
      record({ taskId: task.id, track: 'baseline', action: 'failed', reason: 'no-protocol-driver', backend: null, quota: null })
      throw new Error(`任务 ${task.id}：保底轨不可用（未配置协议模型）`)
    }
    try {
      const result = await runBaseline(call)
      record({ taskId: task.id, track: 'baseline', action: 'ran', reason: null, backend: 'protocol', quota: baselineQuota })
      return { track: 'baseline', action: 'ran', result }
    } catch (error) {
      record({ taskId: task.id, track: 'baseline', action: 'failed', reason: 'protocol-error', backend: 'protocol', quota: baselineQuota })
      throw error
    }
  }

  function skip(task: BackendTask, track: 'adapt' | 'enhance', reason: string): RouteOutcome<B> {
    record({ taskId: task.id, track, action: 'skipped', reason, backend: agentBackend?.id ?? null, quota: null })
    return { track, action: 'skipped', reason, result: null }
  }

  async function runAgent(task: BackendTask, call: RouteCall, track: 'adapt' | 'enhance'): Promise<RouteOutcome<B>> {
    const backend = agentBackend!
    let session: Awaited<ReturnType<AgentBackend['createSession']>> | undefined
    try {
      session = await backend.createSession(task)
      const prompt = call.messages.map(m => `${m.role}: ${m.content}`).join('\n')
      const { events, artifacts } = await session.send(prompt)
      record({ taskId: task.id, track, action: 'ran', reason: null, backend: backend.id, quota: backend.capabilities.quota, sessionId: session.id })
      // 🔴 过程文本绝不混进正文：consumes='text' 时只拼装 message 事件（plan/tool/diff 是过程痕迹）
      const text = task.consumes === 'text'
        ? events.filter(e => e.kind === 'message').map(e => (e as { text: string }).text).join('')
        : undefined
      return { track, action: 'ran', result: { sessionId: session.id, events, artifacts, text } }
    } catch (error) {
      record({ taskId: task.id, track, action: 'failed', reason: 'agent-error', backend: backend.id, quota: backend.capabilities.quota, ...(session ? { sessionId: session.id } : {}) })
      throw error
    } finally {
      session?.close()
    }
  }

  return {
    ledger,
    async route(task, call) {
      // 硬闸 1：无人值守 / 自动静默链路永不路由到 Agent（条款约束，unattended=false）
      if (task.kind === 'auto-silent' || task.requires?.unattended) return baseline(task, call)
      // 硬闸 2：增强轨仅手动触发 + 显式选择 Agent
      if (task.kind === 'enhance') {
        if (!task.manual || task.select !== 'agent') return skip(task, 'enhance', 'enhance-requires-manual-explicit-agent')
        if (!agentBackend) return skip(task, 'enhance', 'no-agent-backend')
        const missing = missingCapabilities(task)
        if (missing.length > 0) return skip(task, 'adapt', `missing-capabilities:${missing.join(',')}`)
        if (task.consumes === 'json-string') return skip(task, 'adapt', 'agent-no-clean-json')
        return runAgent(task, call, 'enhance')
      }
      // 默认轨：未显式选择 Agent ⇒ 保底轨（配置后仍默认走原通道）
      if (task.select !== 'agent') return baseline(task, call)
      if (!agentBackend) return skip(task, 'adapt', 'no-agent-backend')
      const missing = missingCapabilities(task)
      if (missing.length > 0) return skip(task, 'adapt', `missing-capabilities:${missing.join(',')}`)
      if (task.consumes === 'json-string') return skip(task, 'adapt', 'agent-no-clean-json')
      return runAgent(task, call, 'adapt')
    },
  }
}