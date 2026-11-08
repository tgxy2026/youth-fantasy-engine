/**
 * 3.4.3 · Agent 后端注册表（后端轨）
 *
 * 与协议轨 `protocols/index.ts` 的注册表同构，但两者正交：那边登记「怎么跟 HTTP 端点说话」，
 * 这边登记「怎么跟有状态 Agent 共事」。🔴 后端不实现 ChatDriver，不进协议注册表。
 *
 * 出厂为空：本版未内置真实 Agent 驱动（官方 ACP 交互式驱动待 P3 真实账号验证后提供）。
 * 配置界面照 `backendTrackStatus()` 如实说话 —— 空就是「未配置」，不伪装可用。
 */

import { defineAgentBackend, type AgentBackend } from './contract'
import type { UsageQuota } from '@/lib/aiCore/usage'

const backends = new Map<string, AgentBackend>()

/** 注册一个 Agent 后端（能力声明过校验才准入）；同 id 重复注册即抛，不静默覆盖 */
export function registerAgentBackend(backend: AgentBackend): void {
  defineAgentBackend(backend)
  if (backends.has(backend.id)) throw new Error(`Agent 后端重复注册：${backend.id}`)
  backends.set(backend.id, backend)
}

/** 注销（测试与未来的驱动热卸载用）；不存在即抛，不静默 */
export function unregisterAgentBackend(id: string): void {
  if (!backends.delete(id)) throw new Error(`Agent 后端未注册：${id}`)
}

export function getAgentBackend(id: string): AgentBackend | null {
  return backends.get(id) ?? null
}

export function listAgentBackends(): readonly AgentBackend[] {
  return [...backends.values()]
}

/** 配置界面用的如实状态：有哪些后端、各自额度口径；空列表 = 未配置 */
export function backendTrackStatus(): { available: boolean; backends: { id: string; label: string; quota: UsageQuota }[] } {
  const list = [...backends.values()].map(b => ({ id: b.id, label: b.label, quota: b.capabilities.quota }))
  return { available: list.length > 0, backends: list }
}