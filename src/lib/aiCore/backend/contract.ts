/**
 * 3.4.3 · 后端轨契约（`aiCore` 叶子层，与协议轨正交）
 *
 * 🔴 为什么不实现 ChatDriver：协议轨是「一次请求 → 一次响应 → 一次用量」；
 *    Agent 后端是**有状态 session**：过程事件流（plan/tool/diff/message）、可暂停恢复、
 *    产出独立产物文件。硬压成 chat() 会扭曲超时/取消/用量/降级四条契约，
 *    且「过程文本混进 JSON」正是结构化任务静默失效的形态（P1 原型 60 项实测实证）。
 *
 * 🔴 能力声明复用协议层 `DriverCapabilities`（唯一路由依据，不另立能力表）。
 *    `unattended` 是**条款约束**而非技术能力：官方条款禁止无人值守时一律 false。
 *
 * 依赖方向：本文件只 import type，不引入任何运行时值，不构成环。
 */

import type { DriverCapabilities } from '@/lib/aiCore/protocols/contract'
import type { UsageQuota } from '@/lib/aiCore/usage'

/** 过程事件种类（P1 原型定型）：message 才是正文，其余都是过程痕迹 */
export const BACKEND_EVENT_KINDS = ['plan', 'tool', 'diff', 'message', 'artifact', 'state'] as const
export type BackendEventKind = typeof BACKEND_EVENT_KINDS[number]

/** 能力声明键（与 DriverCapabilities 一一对应，校验用） */
export const CAPABILITY_KEYS = ['stream', 'cancel', 'multiTurn', 'embedding', 'latency', 'unattended', 'quota'] as const

/** 校验能力声明：七键齐全 + 枚举合法。缺键/非法即抛，绝不带病上岗 */
export function assertBackendCapabilities(caps: DriverCapabilities, label: string): DriverCapabilities {
  for (const key of CAPABILITY_KEYS) {
    if (!(key in caps)) throw new Error(`${label} 能力声明缺键：${key}`)
  }
  for (const key of ['stream', 'cancel', 'multiTurn', 'embedding', 'unattended'] as const) {
    if (typeof caps[key] !== 'boolean') throw new Error(`${label} ${key} 必须是布尔值`)
  }
  if (!['low', 'medium', 'high'].includes(caps.latency)) throw new Error(`${label} latency 非法`)
  const quotas: UsageQuota[] = ['local', 'subscription', 'metered', 'unknown']
  if (!quotas.includes(caps.quota)) throw new Error(`${label} quota 非法`)
  return caps
}

/**
 * 产物 descriptor：后端轨**只描述、不落库**。
 * 🔴 回写一律走既有「导出项目包 → 导入」通道或独立建议文件；外部进程无写库路径。
 */
export interface BackendArtifact {
  /** 产物种类（如 'foreshadow-suggestions' / 'continuation-advice'） */
  kind: string
  /** 建议文件名（大产物由 Agent 侧落盘后给路径，引擎经导入通道收） */
  path?: string
  /** 小产物的文本内容（可直接携带） */
  content?: string
}

/** 过程事件：message 是正文；plan/tool/diff 是过程痕迹；artifact 是产物；state 是生命周期 */
export type BackendEvent =
  | { kind: 'plan' | 'tool' | 'diff' | 'message'; text: string }
  | { kind: 'artifact'; artifact: BackendArtifact }
  | { kind: 'state'; text: string }

/** session 记下的事件（带归属与序号，供复盘） */
export type RecordedBackendEvent = BackendEvent & { sessionId: string; at: number }

export type BackendSessionState = 'open' | 'paused' | 'finished' | 'cancelled' | 'closed' | 'failed'

/** 有状态会话：创建 / 发送 / 暂停恢复 / 取消 / 关闭；取消保留已收片段 */
export interface BackendSession {
  readonly id: string
  readonly taskId: string
  readonly state: BackendSessionState
  readonly events: readonly RecordedBackendEvent[]
  readonly artifacts: readonly BackendArtifact[]
  send(text: string): Promise<{ events: readonly RecordedBackendEvent[]; artifacts: readonly BackendArtifact[] }>
  pause(): void
  resume(): void
  cancel(): void
  close(): void
}

/** 任务声明（路由输入）：kind 定轨，consumes 定产物形态闸，select/manual 定显式性 */
export interface BackendTask {
  id: string
  kind: 'sync-json' | 'long-text' | 'multi-turn' | 'auto-silent' | 'enhance'
  /**
   * 调用方要消费的产物形态。
   * 🔴 'json-string' 是硬闸：Agent 产出事件流+文件、无干净 JSON 字符串 ⇒ 一律跳过留痕，
   *    结构上杜绝过程文本混进 JSON（禁止靠宽松解析再猜一次）。
   * 'text' 只拼装 message 事件；'artifacts' 取产物 descriptor。
   */
  consumes: 'json-string' | 'text' | 'artifacts'
  /** 是否手动触发（增强轨硬闸；auto-silent 恒 false） */
  manual?: boolean
  /** 显式选择：'protocol'（默认）| 'agent'（增强轨必须） */
  select?: 'protocol' | 'agent'
  /** 能力需求子集（值为 true 的键参与能力闸） */
  requires?: Partial<Record<'stream' | 'cancel' | 'multiTurn' | 'embedding' | 'unattended', boolean>>
}

/** Agent 后端：与协议 driver 正交的可插拔后端（注册表见 registry.ts） */
export interface AgentBackend {
  id: string
  /** 配置界面 / 错误文案用的显示名 */
  label: string
  capabilities: DriverCapabilities
  createSession(task: BackendTask): Promise<BackendSession>
}

/** 便捷构造：强制能力声明过校验（照协议层 defineDriver 的先例） */
export function defineAgentBackend<B extends AgentBackend>(backend: B): B {
  assertBackendCapabilities(backend.capabilities, `backend ${backend.id}`)
  if (typeof backend.createSession !== 'function') throw new Error('backend 缺少 createSession')
  return backend
}