// ============ 3.3.2 · P1-5b 桌面登录（渲染层封装）============
//
// 主进程那边已经做完了完整流程（回环端口收 code、换令牌、safeStorage 存），
// 渲染层这里只负责两件事：**判断当前环境有没有这个能力**、**把结果翻译成人话**。
//
// 🔴 令牌不经过渲染层：这里拿到的只有「用户名 + 是否已记住」，没有 token。
//    要在桌面里发带令牌的请求，走 `desktopFetch()`（主进程加 Authorization 头）。
//
// 🔴 非 Electron 环境（网页版 / 便携版 / 游客）**明确返回"不支持"**，
//    而不是静默失败 —— 否则界面上会变成"点了没反应"。
import { DESKTOP } from '@/lib/app/desktop'

/** 登录状态变化（同窗口内通知同步入口显示 / 隐藏；跨窗口不保证） */
export const DESKTOP_ACCOUNT_EVENT = 'yfe:desktop-account-changed'

/** 主进程暴露的最小接口（见 `electron/preload.cjs` 的 `electronAuth`） */
export interface ElectronAuthAPI {
  status(): Promise<{ signedIn: boolean; encrypted: boolean; base?: string }>
  login(opts: { baseUrl: string; name?: string }): Promise<
    | { ok: true; user: { name: string } | null; persisted: boolean; persistedReason: string }
    | { ok: false; error: string }
  >
  /** 账号密码直登（3.3.2 · 2026-10-31 起界面用这条路，不跳浏览器） */
  loginPassword(opts: { name: string; password: string; baseUrl?: string }): Promise<
    | {
        ok: true; user: { name: string } | null; persisted: boolean; persistedReason: string
        sessionLimitExceeded?: boolean; sessionCount?: number
      }
    | { ok: false; error: string; status?: number; code?: string }
  >
  logout(): Promise<{ ok: boolean }>
  fetch(opts: {
    url: string; method?: string; headers?: Record<string, string>; body?: string | Uint8Array; origin?: string
    /** true 时返回 base64（同步要下对象二进制）；不传仍返回 text */
    binary?: boolean
  }): Promise<{ ok: boolean; status: number; text?: string; base64?: string; error?: string }>
  /** 登录服务器 origin（未登录返回空串） */
  origin(): Promise<{ origin: string }>
}

declare global {
  interface Window {
    electronAuth?: ElectronAuthAPI
  }
}

/** 当前环境有没有桌面登录能力 */
export function hasDesktopAuth(): boolean {
  return DESKTOP && typeof window !== 'undefined' && !!window.electronAuth
}

export interface DesktopLoginResult {
  ok: boolean
  /** 成功时的人话 */
  message: string
  /** 失败原因（已翻译，可直接显示） */
  reason?: string
  /** 凭据是否被记住；false 时界面要提示"仅本次运行有效" */
  persisted?: boolean
  userName?: string
}

/** 读取登录状态（桌面且已登录时返回用户名；调用方据此决定要不要显示"去登录"） */
export async function desktopAuthStatus(): Promise<{
  available: boolean; signedIn: boolean; encrypted: boolean
  /** 当前连的账号服务器（界面只读展示；改服务器走环境变量 YFE_CLOUD_BASE） */
  base: string
}> {
  if (!hasDesktopAuth()) return { available: false, signedIn: false, encrypted: false, base: '' }
  try {
    const r = await window.electronAuth!.status()
    return { available: true, signedIn: !!r.signedIn, encrypted: !!r.encrypted, base: String(r.base || '') }
  } catch {
    return { available: false, signedIn: false, encrypted: false, base: '' }
  }
}

/**
 * 账号 + 密码登录（不跳浏览器、不填网址）。
 *
 * 🔴 密码只在这一次 IPC 里过一手，主进程不保存它；令牌进 safeStorage，渲染层拿不到。
 * 🔴 失败原因原样透出：密码错 / 设备超限 / 连不上，界面上必须是三句不同的话。
 */
export async function desktopLoginPassword(name: string, password: string): Promise<DesktopLoginResult> {
  if (!hasDesktopAuth()) {
    return { ok: false, message: '', reason: '当前环境不支持桌面账号登录（仅桌面版可用）' }
  }
  const userName = String(name || '').trim()
  if (!userName) return { ok: false, message: '', reason: '请输入账号' }
  if (!password) return { ok: false, message: '', reason: '请输入密码' }
  try {
    const r = await window.electronAuth!.loginPassword({ name: userName, password })
    if (!r.ok) return { ok: false, message: '', reason: r.error || '登录未完成' }
    const who = r.user?.name || userName
    const message = r.persisted
      ? `${who}，已登录并记住这台设备`
      : `${who}，已登录（这台机器没有可用的安全存储，重启后需重新登录）`
    return {
      ok: true,
      message: r.sessionLimitExceeded
        ? `${message}。已在 ${r.sessionCount || 0} 台设备登录，建议在「登录设备」里撤销不用的`
        : message,
      persisted: r.persisted,
      userName: who,
    }
  } catch (e) {
    return { ok: false, message: '', reason: e instanceof Error ? e.message : '登录失败' }
  }
}

/**
 * 走系统浏览器登录。
 *
 * @param baseUrl 账号服务器地址（如 `https://yfe.example.com`）
 */
export async function desktopLogin(baseUrl: string, name?: string): Promise<DesktopLoginResult> {
  if (!hasDesktopAuth()) {
    return { ok: false, message: '', reason: '当前环境不支持桌面账号登录（仅桌面版可用）' }
  }
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(base)) {
    return { ok: false, message: '', reason: '请先填写账号服务器地址（http:// 或 https:// 开头）' }
  }
  try {
    const r = await window.electronAuth!.login({ baseUrl: base, name })
    if (!r.ok) return { ok: false, message: '', reason: r.error || '登录未完成' }
    const userName = r.user?.name || ''
    // 🔴 没记住凭据时必须说清楚：否则用户下次启动发现又要登录，会以为"登录失效了"
    const message = r.persisted
      ? `${userName ? `${userName}，` : ''}已登录并记住这台设备`
      : `${userName ? `${userName}，` : ''}已登录（这台机器没有可用的安全存储，重启后需重新登录）`
    return { ok: true, message, persisted: r.persisted, userName }
  } catch (e) {
    return { ok: false, message: '', reason: e instanceof Error ? e.message : '登录失败' }
  }
}

/** 退出（清掉本机凭据） */
export async function desktopLogout(): Promise<boolean> {
  if (!hasDesktopAuth()) return false
  try {
    await window.electronAuth!.logout()
    return true
  } catch {
    return false
  }
}

/**
 * 用当前令牌代发请求。
 *
 * 🔴 必须传 `origin`：主进程会拒绝把令牌发到别的源。
 *    少了这道校验，一个被注入的脚本就能把令牌 POST 到任意地址。
 */
export async function desktopFetch(
  origin: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ ok: boolean; status: number; text: string; error?: string }> {
  if (!hasDesktopAuth()) return { ok: false, status: 0, text: '', error: '当前环境不支持' }
  const url = path.startsWith('http') ? path : `${origin.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`
  try {
    const r = await window.electronAuth!.fetch({ url, origin, ...init })
    return { ok: r.ok, status: r.status, text: r.text ?? '', error: r.error }
  } catch (e) {
    return { ok: false, status: 0, text: '', error: e instanceof Error ? e.message : '请求失败' }
  }
}

/** 登录服务器 origin（未登录时为空串） */
export async function desktopOrigin(): Promise<string> {
  if (!hasDesktopAuth()) return ''
  try {
    const r = await window.electronAuth!.origin()
    return String(r?.origin || '')
  } catch {
    return ''
  }
}

export interface DesktopBytesResult {
  ok: boolean
  status: number
  bytes: Uint8Array
  error?: string
}

function base64Bytes(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(0)
  try {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return new Uint8Array(0)
  }
}

/**
 * 代发请求并取**二进制**（同步下载内容对象用）。
 *
 * 🔴 不能用上面的 `desktopFetch`：它按 UTF-8 解码正文，图片与二进制分片会被解坏，
 *    表现为「哈希对不上」「图片打不开」。主进程侧 `binary:true` 返回 base64，浏览器侧再还原成字节。
 */
export async function desktopFetchBytes(
  origin: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array } = {},
): Promise<DesktopBytesResult> {
  if (!hasDesktopAuth()) return { ok: false, status: 0, bytes: new Uint8Array(0), error: '当前环境不支持' }
  const url = path.startsWith('http') ? path : `${origin.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`
  try {
    const r = await window.electronAuth!.fetch({ url, origin, ...init, binary: true })
    if (r.error) return { ok: false, status: r.status || 0, bytes: new Uint8Array(0), error: r.error }
    return { ok: r.ok, status: r.status, bytes: base64Bytes(r.base64 || '') }
  } catch (e) {
    return { ok: false, status: 0, bytes: new Uint8Array(0), error: e instanceof Error ? e.message : '请求失败' }
  }
}
