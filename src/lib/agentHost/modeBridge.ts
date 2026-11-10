/**
 * 连接模式（3.4.3）：页面侧的**唯一**消费入口。
 *
 * 🔴 模式真源在桌面主进程 / 便携服务的同一份 mode-service：
 *    页面只申请租约、请求切换、读取状态，不能自行判定「现在是 API 还是 Agent 模式」。
 * 🔴 全部模型请求（对话、连通性测试、嵌入、模型列表、卸载、联网检索）必须包在
 *    `withApiModeLease` 里 —— 租约覆盖整段任务（含流式响应体），不是只包请求头。
 */
import { DESKTOP } from '@/lib/app/desktop'
import { PORTABLE } from '@/lib/storage/fileBackend'
import { WEB, WEB_GUEST } from '@/lib/app/platform'
import type { ConnectionMode } from '@/lib/agentHost/modeTransition'
import { runWithModeLease, type ModeLeaseTransport } from '@/lib/agentHost/modeClient'

export interface ConnectionModeStatus {
  phase: 'stable' | 'switching' | 'blocked'
  mode: ConnectionMode | null
  reason: string
  busy: boolean
  active: { api: number; agent: number }
  ownsLock: boolean
  lock: { pid: number | null; corrupt: boolean; alive: boolean | null } | null
  canRecover: boolean
  agent?: { running?: boolean; enabled?: boolean; port?: number | null } | null
}

interface ModeMutation {
  ok: boolean
  status?: ConnectionModeStatus
  error?: string
}

interface ModeDesktopAPI {
  modeStatus?(): Promise<ConnectionModeStatus>
  modeAcquire?(mode: ConnectionMode): Promise<{ ok: boolean; leaseId?: string; error?: string }>
  modeRelease?(leaseId: string): Promise<{ ok: boolean }>
  modeSwitch?(payload: { to: ConnectionMode; transitionId: string }): Promise<ModeMutation>
  modeCancel?(transitionId: string): Promise<{ ok: boolean }>
  modeRecover?(payload: { confirm: boolean; confirmPid: number | null }): Promise<ModeMutation>
}

const PAGE_HEADER = 'x-yfe-agent-page'

function desktopApi(): ModeDesktopAPI | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as { electronAgentHost?: ModeDesktopAPI }).electronAgentHost ?? null
}

function portableApiBase(): string {
  const marker = typeof window !== 'undefined' ? (window as unknown as { __YFE_PORTABLE__?: { apiBase?: string } }).__YFE_PORTABLE__ : null
  if (marker && typeof marker === 'object' && typeof marker.apiBase === 'string' && marker.apiBase) return marker.apiBase
  return ''
}

/** 本机是否存在可信模式宿主。 */
export function hasLocalModeHost(): boolean {
  if (WEB || WEB_GUEST) return false
  // 桌面版必须有 preload 注入的 Agent 宿主对象；只有 electronStore 的测试替身不属于真实外壳。
  if (DESKTOP) return !!desktopApi()
  return PORTABLE
}

const BLOCKED_STATUS: ConnectionModeStatus = {
  phase: 'blocked', mode: null, reason: '网页版没有本机连接模式服务', busy: false,
  active: { api: 0, agent: 0 }, ownsLock: false, lock: null, canRecover: false,
}

const DENIED_IN_AGENT = '当前为 Agent 连接模式：引擎内置的 API 调用已停用。要使用 API 调用，请到「模型设置 → API 调用」切换并等待切换完成。'
const MODE_UNREADY = '无法从本机宿主确认连接模式，已拒绝模型请求。请到「模型设置」查看模式状态并按提示安全恢复。'

function leaseFailure(message?: string): Error {
  if (!message) return new Error(DENIED_IN_AGENT)
  if (/不允许/.test(message)) return new Error(`${DENIED_IN_AGENT}（${message}）`)
  return new Error(`${MODE_UNREADY}（${message}）`)
}

/** 读取真实连接模式；不可用时返回 blocked + 原因，绝不假装稳定。 */
export async function connectionModeStatus(): Promise<ConnectionModeStatus> {
  if (!hasLocalModeHost()) return { ...BLOCKED_STATUS }
  if (DESKTOP) {
    const api = desktopApi()
    if (!api || typeof api.modeStatus !== 'function') {
      return { ...BLOCKED_STATUS, reason: '当前安装包不支持连接模式互斥（请使用 3.4.3 互斥版）', canRecover: false }
    }
    try {
      const status = await api.modeStatus()
      if (!status || typeof status !== 'object') return { ...BLOCKED_STATUS, reason: '连接模式状态格式无效' }
      return { ...BLOCKED_STATUS, ...status }
    } catch (error) {
      return { ...BLOCKED_STATUS, reason: error instanceof Error ? error.message : String(error), canRecover: true }
    }
  }
  try {
    const res = await fetch(portableApiBase() + '/api/mode/status', { cache: 'no-store', headers: { [PAGE_HEADER]: '1' } })
    const raw = await res.json() as Partial<ConnectionModeStatus> & { error?: string }
    if (!res.ok || raw.phase === undefined) {
      return { ...BLOCKED_STATUS, reason: raw.error ?? `本地服务返回 HTTP ${res.status}`, canRecover: true }
    }
    return { ...BLOCKED_STATUS, ...(raw as ConnectionModeStatus) }
  } catch (error) {
    return { ...BLOCKED_STATUS, reason: `无法连接便携本地服务：${error instanceof Error ? error.message : String(error)}`, canRecover: true }
  }
}

function portablePost(path: string, body: unknown): Promise<Record<string, unknown>> {
  return fetch(portableApiBase() + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [PAGE_HEADER]: '1' },
    body: JSON.stringify(body),
  }).then(async res => {
    const raw = await res.json() as Record<string, unknown>
    if (!res.ok) return { ok: false, error: typeof raw.error === 'string' ? raw.error : `本地服务返回 HTTP ${res.status}` }
    return raw
  })
}

/** 请求切换；调用方必须自己生成并保留 transitionId，取消时用它。 */
export async function switchConnectionMode(to: ConnectionMode, transitionId: string): Promise<ModeMutation> {
  if (!hasLocalModeHost()) return { ok: false, error: '网页版没有本机连接模式服务，不能切换 API / Agent 模式。' }
  if (DESKTOP) {
    const api = desktopApi()
    if (!api || typeof api.modeSwitch !== 'function') return { ok: false, error: '当前安装包不支持连接模式互斥。' }
    try {
      return await api.modeSwitch({ to, transitionId })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  try {
    const raw = await portablePost('/api/mode/switch', { to, transitionId })
    return raw as unknown as ModeMutation
  } catch (error) {
    return { ok: false, error: `无法连接便携本地服务：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 取消等待中的切换；取消不代表旧任务已结束，服务端会如实保持阻断。 */
export async function cancelConnectionModeSwitch(transitionId: string): Promise<boolean> {
  if (!hasLocalModeHost()) return false
  if (DESKTOP) {
    const api = desktopApi()
    if (!api || typeof api.modeCancel !== 'function') return false
    try { return (await api.modeCancel(transitionId)).ok } catch { return false }
  }
  try {
    const raw = await portablePost('/api/mode/cancel', { transitionId })
    return raw.ok === true
  } catch {
    return false
  }
}

/** 用户明确确认后的安全恢复：固定回到 API 模式，Agent 连接保持停用。 */
export async function recoverConnectionMode(confirmPid: number | null): Promise<ModeMutation> {
  if (!hasLocalModeHost()) return { ok: false, error: '网页版没有本机连接模式服务。' }
  if (DESKTOP) {
    const api = desktopApi()
    if (!api || typeof api.modeRecover !== 'function') return { ok: false, error: '当前安装包不支持连接模式恢复。' }
    try {
      return await api.modeRecover({ confirm: true, confirmPid })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  try {
    const raw = await portablePost('/api/mode/recover', { confirm: true, confirmPid })
    return raw as unknown as ModeMutation
  } catch (error) {
    return { ok: false, error: `无法连接便携本地服务：${error instanceof Error ? error.message : String(error)}` }
  }
}

function apiTransport(): ModeLeaseTransport {
  return {
    async acquire() {
      if (DESKTOP) {
        const api = desktopApi()
        if (!api || typeof api.modeAcquire !== 'function') {
          throw new Error('当前安装包不支持连接模式互斥，已拒绝模型请求（请使用 3.4.3 互斥版）。')
        }
        const r = await api.modeAcquire('api')
        if (!r.ok || typeof r.leaseId !== 'string' || !r.leaseId) throw leaseFailure(r.error)
        return r.leaseId
      }
      let raw: Record<string, unknown>
      try {
        raw = await portablePost('/api/mode/lease', { mode: 'api' })
      } catch (error) {
        throw new Error(`无法连接便携本地服务确认连接模式，已拒绝模型请求：${error instanceof Error ? error.message : String(error)}`)
      }
      if (raw.ok !== true || typeof raw.leaseId !== 'string' || !raw.leaseId) {
        throw leaseFailure(typeof raw.error === 'string' ? raw.error : undefined)
      }
      return raw.leaseId
    },
    async release(leaseId) {
      if (DESKTOP) {
        const api = desktopApi()
        if (!api || typeof api.modeRelease !== 'function') return false
        try { return (await api.modeRelease(leaseId)).ok } catch { return false }
      }
      const raw = await portablePost('/api/mode/release', { leaseId })
      return raw.ok === true
    },
  }
}

/** 包住**整段模型任务**。流式任务必须在响应体消费完 / 取消确认后才释放租约。 */
export async function withApiModeLease<T>(work: () => Promise<T>): Promise<T> {
  // 网页和无宿主的开发环境沿用原行为；桌面/便携外壳缺少接口时必须拒绝，不能绕过租约。
  if (typeof window === 'undefined' || WEB || WEB_GUEST || (!DESKTOP && !PORTABLE)) return work()
  return runWithModeLease(apiTransport(), 'api', work)
}
