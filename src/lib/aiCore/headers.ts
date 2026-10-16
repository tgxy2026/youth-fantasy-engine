/**
 * 模型配置 · **自定义请求头**（3.1.1 第 4 项）
 *
 * 【为什么需要】有些订阅 / 网关要求额外的请求头才认 —— 典型是 OpenCode Go
 * （`x-opencode-session`，缺失直接 400：`Request is missing x-opencode-session…`）。
 * 本项目原先把请求头**硬编码**在 `aiCore/chat.ts` 里，界面上没有任何入口 ⇒ 根本接不了。
 *
 * 【设计取舍：通用能力，不是某个平台的专用后门】
 * 这里只做「配置里多几张键值对，发请求时合并进去」，因此中转站 / 企业网关 / 需要额外鉴权头的
 * 服务一并受益。**不做**任何「伪装 UA / 反检测 / 绕过平台流量监控」的事。
 *
 * 【为什么必须拦截一部分头名】
 * 浏览器与 Electron 渲染进程的 `fetch` 有一批**禁止设置的请求头**（forbidden header name）——
 * 设了也会被静默忽略。若不拦，作者会以为「我填了却没生效」，很难排查。故这里**明确拒绝并说明原因**，
 * 而不是悄悄丢掉（沿用本项目「绝不静默」的口径）。
 *
 * ⚠️ 本模块是**纯逻辑**：不 import 任何运行时依赖，便于单测。
 */

/** 前缀即禁止的头（`Sec-*` / `Proxy-*`） */
const FORBIDDEN_PREFIXES = ['sec-', 'proxy-']

/**
 * fetch 规范里的禁止头名（小写）。
 * 说明：`User-Agent` 在新规范里已可设，但 Chromium 仍不接受（由浏览器决定），故一并拦下。
 */
const FORBIDDEN_NAMES = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method',
  'connection', 'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive',
  'origin', 'referer', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via', 'user-agent', 'set-cookie',
])

/** 本项目固定按 JSON 发送，不允许被自定义头顶掉 */
const PROTECTED_NAMES = new Set(['content-type'])

export interface RejectedHeader {
  name: string
  reason: string
}

export interface SanitizeResult {
  /** 真正会发出去的自定义头 */
  allowed: Record<string, string>
  /** 被拒绝的头（附原因）——界面必须把它们显示出来 */
  rejected: RejectedHeader[]
}

/** 单个头名的检查：返回拒绝原因；通过则返回 null */
export function rejectReasonOf(name: string): string | null {
  const n = name.trim().toLowerCase()
  if (!n) return '缺少头名称'
  if (PROTECTED_NAMES.has(n)) return '本项目的请求体固定是 JSON，这一项不能改'
  if (FORBIDDEN_PREFIXES.some(p => n.startsWith(p))) return '浏览器不允许设置这一类请求头，填了也不会生效'
  if (FORBIDDEN_NAMES.has(n)) return '浏览器不允许设置这个请求头（由客户端自己决定），填了也不会生效'
  return null
}

/**
 * 过滤一份自定义头：合法的留下、非法的连同原因一起报出来。
 * 🔴 空名 / 纯空白的条目直接跳过（不算拒绝，是编辑中途的残留）。
 */
export function sanitizeCustomHeaders(raw: Record<string, string> | undefined | null): SanitizeResult {
  const allowed: Record<string, string> = {}
  const rejected: RejectedHeader[] = []
  if (!raw) return { allowed, rejected }
  for (const [k, v] of Object.entries(raw)) {
    const name = k.trim()
    if (!name) continue
    const reason = rejectReasonOf(name)
    if (reason) { rejected.push({ name, reason }); continue }
    allowed[name] = String(v ?? '').trim()
  }
  return { allowed, rejected }
}

/**
 * 把自定义头合并到基础头之上。
 * 自定义头**排在后面** ⇒ 可覆盖同名的基础头（例如用另一套鉴权方案覆盖默认的 `Authorization`），
 * 但 `Content-Type` 已在 `sanitizeCustomHeaders` 里被拦下，不会被顶掉。
 */
export function mergeHeaders(
  base: Record<string, string>,
  custom: Record<string, string> | undefined | null,
): Record<string, string> {
  const { allowed } = sanitizeCustomHeaders(custom)
  return { ...base, ...allowed }
}
