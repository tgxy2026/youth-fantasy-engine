// Antigravity ACP 登录地址识别（单一真源）。
//
// 组件会把 OAuth 地址打到 stderr，有两种形态：
//   · 通过 BROWSER 代理：`YFE_ACP_AUTH:"https://accounts.google.com/..."`
//   · 组件自身提示：`Open the following link to authenticate the ACP server: https://...`
// 打包环境里 BROWSER 代理可能未生效（实测只见第二种），故两种都要认。
const AUTH_PREFIX = 'YFE_ACP_AUTH:'
const AUTH_LINK = 'Open the following link to authenticate the ACP server: '

/** 从一行 stderr 中取出可打开的 Google OAuth 地址；不是登录地址则返回 null。 */
export function parseAuthUrl(line) {
  const text = String(line ?? '').trim()
  if (!text) return null
  let raw = ''
  if (text.startsWith(AUTH_PREFIX)) raw = text.slice(AUTH_PREFIX.length).trim()
  else {
    const index = text.indexOf(AUTH_LINK)
    if (index < 0) return null
    raw = text.slice(index + AUTH_LINK.length).trim()
  }
  if (raw.startsWith('"')) {
    try { raw = JSON.parse(raw) } catch { return null }
  }
  try {
    const url = new URL(raw)
    if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' ||
        url.username || url.password || url.hash) return null
    return url.href
  } catch {
    return null
  }
}