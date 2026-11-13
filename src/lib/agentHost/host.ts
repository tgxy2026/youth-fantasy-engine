/**
 * Agent 宿主桥（页面侧）：把宿主收到的工具调用交给执行器，再把结果回传。
 *
 * 平台差异只在传输：
 *   · 桌面版 —— 主进程持有本地 HTTP 服务与账本，经 IPC 把请求送进渲染进程；
 *   · 便携版 —— 便携本地服务持有队列与账本，页面按固定间隔取任务 / 回传结果。
 * 两边的执行与校验完全共用本文件 + `executor.ts`。
 *
 * 🔴 页面**不保存**授权范围：scope 由宿主随每次请求下发（宿主以 host 文件为准），
 *    执行器再校验一次。这样即使页面被其他入口误触发，也不能绕过宿主授权。
 */

import { DESKTOP } from '@/lib/app/desktop'
import { PORTABLE } from '@/lib/storage/fileBackend'
import { WEB, WEB_CLOUD, WEB_GUEST } from '@/lib/app/platform'
import {
  EMPTY_AGENT_SCOPE, isValidRequestId, normalizeAgentScope,
  type AgentScope, type AgentToolCall, type AgentToolResult,
} from '@/lib/agentHost/contract'
import { createAgentExecutor, defaultExecutorDeps } from '@/lib/agentHost/executor'
import type { ConnectionMode } from './modeTransition'

export type AgentHostMode = 'desktop' | 'portable' | 'web'

export interface AgentHostStatus {
  mode: AgentHostMode
  /** 宿主服务是否在监听（桌面：主进程本地服务已起；便携：本地服务已起） */
  running: boolean
  /** 用户是否开启 Agent 写入连接 */
  enabled: boolean
  port: number | null
  /** 桥要读取的 host 文件路径（界面展示用；不含 token） */
  bridgeFile: string | null
  scope: AgentScope
  /** 当前已连接的页面客户端数 */
  clients: number
  /** 不可用 / 出错原因（空 = 正常） */
  lastError: string
  /** 宿主是否配置了连接令牌（只返回布尔，不返回令牌本身） */
  tokenConfigured?: boolean
  /** 3.4.3：连接模式真源摘要（页面只读，不可由此推断权限） */
  connectionMode?: { phase: 'stable' | 'switching' | 'blocked'; mode: ConnectionMode | null; busy: boolean; reason: string } | null
}

const EMPTY_STATUS: AgentHostStatus = {
  mode: 'web', running: false, enabled: false, port: null, bridgeFile: null,
  scope: EMPTY_AGENT_SCOPE, clients: 0, lastError: '',
}

function webStatus(): AgentHostStatus {
  const reason = WEB || WEB_CLOUD || WEB_GUEST || (!DESKTOP && !PORTABLE)
    ? '网页版没有本机宿主进程，不能把 Agent 写入接入浏览器页面。'
    : ''
  return { ...EMPTY_STATUS, mode: 'web', lastError: reason }
}

function apiBase(): string {
  const marker = typeof window !== 'undefined' ? (window as unknown as { __YFE_PORTABLE__?: { apiBase?: string } }).__YFE_PORTABLE__ : null
  if (marker && typeof marker === 'object' && typeof marker.apiBase === 'string' && marker.apiBase) return marker.apiBase
  return ''
}

function desktopApi(): AgentHostDesktopAPI | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as { electronAgentHost?: AgentHostDesktopAPI }).electronAgentHost ?? null
}

interface AgentHostDesktopAPI {
  status(): Promise<AgentHostStatus>
  setConfig(patch: { enabled?: boolean; scope?: AgentScope }): Promise<{ ok: boolean; status?: AgentHostStatus; error?: string }>
  writeBridgeScriptPath(): Promise<string>
  ready(): void
  onCall(handler: (payload: unknown) => Promise<AgentToolResult>): void
}

/** 便携本地服务只接受**同源页面**的页面端点请求；这个头跨源页面带不上（会触发预检被拒） */
const PAGE_HEADER = 'x-yfe-agent-page'
const pageHeaders = (): Record<string, string> => ({ [PAGE_HEADER]: '1' })

/** 读取宿主状态。任何失败都返回 `running:false` + 原因，绝不抛给界面。 */
export async function agentHostStatus(): Promise<AgentHostStatus> {
  if (DESKTOP) {
    const api = desktopApi()
    if (!api) return { ...EMPTY_STATUS, mode: 'desktop', lastError: '当前安装包尚未提供 Agent 宿主接口（请使用 3.4.3 开发版）。' }
    try {
      const status = await api.status()
      return { ...EMPTY_STATUS, ...status, mode: 'desktop', scope: normalizeAgentScope(status?.scope) }
    } catch (error) {
      return { ...EMPTY_STATUS, mode: 'desktop', lastError: error instanceof Error ? error.message : String(error) }
    }
  }
  // 🔴 网页云端形态的 `PORTABLE` 也为 true（复用 HTTP 存储），但它**不是本机便携服务**：
  //    必须先判 WEB，否则会去请求网页服务端不存在的 /api/agent/status。
  if (WEB || WEB_GUEST) return webStatus()
  if (PORTABLE) {
    try {
      const res = await fetch(apiBase() + '/api/agent/status', { cache: 'no-store', headers: pageHeaders() })
      if (!res.ok) return { ...EMPTY_STATUS, mode: 'portable', lastError: `本地服务返回 HTTP ${res.status}` }
      const raw = await res.json() as Partial<AgentHostStatus>
      return { ...EMPTY_STATUS, ...raw, mode: 'portable', scope: normalizeAgentScope(raw?.scope) }
    } catch (error) {
      return { ...EMPTY_STATUS, mode: 'portable', lastError: `无法连接便携本地服务：${error instanceof Error ? error.message : String(error)}` }
    }
  }
  return webStatus()
}

/** 更新授权 / 开关。**只经宿主**落盘，页面不写任何本机配置文件。 */
export async function updateAgentHostConfig(patch: { enabled?: boolean; scope?: AgentScope }): Promise<{ ok: boolean; status?: AgentHostStatus; error?: string }> {
  const payload = {
    ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
    ...(patch.scope ? { scope: normalizeAgentScope(patch.scope) } : {}),
  }
  if (DESKTOP) {
    const api = desktopApi()
    if (!api) return { ok: false, error: '当前安装包尚未提供 Agent 宿主接口。' }
    try {
      const r = await api.setConfig(payload)
      return r.ok ? { ok: true, status: r.status ? { ...r.status, mode: 'desktop', scope: normalizeAgentScope(r.status.scope) } : undefined } : { ok: false, error: r.error ?? '保存失败' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  if (WEB || WEB_GUEST) return { ok: false, error: '网页版不支持本机 Agent 连接。' }
  if (PORTABLE) {
    try {
      const res = await fetch(apiBase() + '/api/agent/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...pageHeaders() }, body: JSON.stringify(payload),
      })
      const raw = await res.json() as { ok?: boolean; error?: string; status?: AgentHostStatus }
      if (!res.ok || raw.ok === false) return { ok: false, error: raw.error ?? `HTTP ${res.status}` }
      return { ok: true, status: raw.status ? { ...raw.status, mode: 'portable', scope: normalizeAgentScope(raw.status.scope) } : undefined }
    } catch (error) {
      return { ok: false, error: `无法连接便携本地服务：${error instanceof Error ? error.message : String(error)}` }
    }
  }
  return { ok: false, error: '网页版不支持本机 Agent 连接。' }
}

/** 可写桥脚本的完整路径（桌面版由主进程返回；便携版为空，需要用户手填） */
export async function agentWriteBridgeScriptPath(): Promise<string> {
  if (!DESKTOP) return ''
  const api = desktopApi()
  if (!api) return ''
  try { return await api.writeBridgeScriptPath() } catch { return '' }
}

const executor = createAgentExecutor(defaultExecutorDeps())

function toCall(payload: unknown): { call: AgentToolCall; scope: AgentScope } | null {
  const p = payload as { call?: unknown; scope?: unknown } | null
  const raw = p?.call as Partial<AgentToolCall> | undefined
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.sessionId !== 'string' || !raw.sessionId || raw.sessionId.length > 100) return null
  if (!isValidRequestId(raw.requestId)) return null
  if (typeof raw.tool !== 'string' || !raw.tool) return null
  if (!raw.args || typeof raw.args !== 'object' || Array.isArray(raw.args)) return null
  return {
    call: { sessionId: raw.sessionId, requestId: raw.requestId, tool: raw.tool, args: raw.args as Record<string, unknown> },
    scope: normalizeAgentScope(p?.scope),
  }
}

async function runOne(payload: unknown): Promise<AgentToolResult> {
  const parsed = toCall(payload)
  if (!parsed) {
    return { ok: false, code: 'BAD_REQUEST', error: '宿主请求格式不合法（缺少 sessionId / requestId / tool / args）' }
  }
  return executor.call(parsed.call, parsed.scope)
}

/** 便携页面轮询间隔。任务由服务端原子领取，重复轮询不会拿到同一条。 */
const PORTABLE_POLL_MS = 800
let installed = false
let documentClientId = ''

/**
 * 安装页面侧宿主桥。多次调用保持幂等。
 * @returns 卸载函数（测试 / 热更新用；正常应用生命周期不卸载）
 */
export function installAgentHostBridge(): () => void {
  if (installed) return () => undefined
  installed = true
  if (DESKTOP) {
    const api = desktopApi()
    if (!api) return () => { installed = false }
    try {
      api.onCall(payload => runOne(payload))
      api.ready()
    } catch {
      installed = false
      return () => undefined
    }
    return () => { installed = false }
  }
  if (WEB || WEB_GUEST) { installed = false; return () => undefined }
  if (PORTABLE) {
    const clientId = portableClientId()
    let stopped = false
    let busy = false
    const tick = async (): Promise<void> => {
      if (stopped || busy) return
      busy = true
      try {
        const res = await fetch(apiBase() + `/api/agent/next?clientId=${encodeURIComponent(clientId)}`, { cache: 'no-store', headers: pageHeaders() })
        if (!res.ok) return
        const body = await res.json() as { request?: { id?: unknown; payload?: unknown } | null }
        const request = body?.request
        if (!request || typeof request.id !== 'string') return
        const result = await runOne(request.payload)
        await fetch(apiBase() + '/api/agent/result', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...pageHeaders() },
          body: JSON.stringify({ clientId, id: request.id, result }),
        })
      } catch {
        // 本地服务暂不可达（启动中 / 已关闭）：静默等待下一轮。状态由 /api/agent/status 如实展示。
      } finally {
        busy = false
      }
    }
    const timer = setInterval(() => { void tick() }, PORTABLE_POLL_MS)
    void tick()
    return () => { stopped = true; clearInterval(timer); installed = false }
  }
  installed = false
  return () => undefined
}

function portableClientId(): string {
  // sessionStorage 可被 window.open / 复制标签克隆，不能用作页面身份。
  // 同一文档重新安装桥时复用；新文档（包括重载）必须使用新的身份。
  if (!documentClientId) {
    const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
    documentClientId = `page-${random}`
  }
  return documentClientId
}
