// ============ 3.3.2 · P5 同步请求通道（可替换）============
//
// 【它解决什么】网页版的同步请求是「同源 + httpOnly Cookie」；桌面版没有 Cookie 罐，
//   走的是主进程 `desktopFetch`（Bearer + 安全存储）。两边的**调用方式**相同（fetch 形态），
//   但底层完全不同 —— 把差异收在这一个文件里，`syncApi` 就只认 `CloudFetch` 一种形状。
//
// 🔴 桌面适配器必须支持**二进制**：上传用 ArrayBuffer、下载对象要原样字节。
//    `desktopFetch` 若按 UTF-8 解码正文，图片与分片会被解坏（表现为"哈希对不上"）。
// 🔴 默认通道是 `cookieFetch()`（全局 fetch）—— 不配置时网页行为**逐字节不变**。
export type CloudFetch = (url: string, init?: RequestInit) => Promise<Response>

/** 默认通道：浏览器同源 fetch（Cookie 自动附带） */
export function cookieFetch(): CloudFetch {
  return (url, init) => fetch(url, init)
}

/** 把各种 HeadersInit 统一成普通对象（主进程只收普通对象） */
export function headersToRecord(h: HeadersInit | undefined | null): Record<string, string> {
  if (!h) return {}
  if (typeof Headers !== 'undefined' && h instanceof Headers) {
    const out: Record<string, string> = {}
    h.forEach((v, k) => { out[k] = v })
    return out
  }
  if (Array.isArray(h)) {
    const out: Record<string, string> = {}
    for (const [k, v] of h) out[k] = v
    return out
  }
  return { ...(h as Record<string, string>) }
}

export function base64ToBytes(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(0)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function responseFromBase64(base64: string, status: number): Response {
  const bytes = base64ToBytes(base64)
  // 🔴 必须交出**独立 ArrayBuffer**：`Response` 只接受 ArrayBuffer / 字符串等 BodyInit，
  //    直接塞 `Uint8Array<ArrayBufferLike>` 类型不通，且共享底层 buffer 会让子视图带出多余字节。
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return new Response(ab, { status })
}

export interface DesktopRawFetchResult {
  ok: boolean
  status: number
  base64?: string
  text?: string
  error?: string
}

export type DesktopRawFetch = (opts: {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
  origin?: string
  binary?: boolean
}) => Promise<DesktopRawFetchResult>

/** 请求体归一：fetch 允许 string / ArrayBuffer / 类型化数组；Blob、FormData 不支持 */
function normalizeBody(body: RequestInit['body']): string | Uint8Array | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return body
  if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) {
    const v = body as ArrayBufferView
    return new Uint8Array(v.buffer as ArrayBuffer, v.byteOffset, v.byteLength)
  }
  throw new Error('桌面同步通道只支持字符串或二进制请求体')
}

/**
 * 桌面通道适配器：把 `desktopFetch` 的 `{ status, base64 }` 包装成标准 `Response`。
 *
 * @param raw 主进程代发（`window.electronAuth.fetch`）；测试注入假实现
 */
export function desktopCloudFetch(origin: string, raw: DesktopRawFetch): CloudFetch {
  return async (url, init) => {
    const r = await raw({
      url,
      method: init?.method || 'GET',
      headers: headersToRecord(init?.headers),
      body: normalizeBody(init?.body),
      origin,
      binary: true,
    })
    if (r.error) throw new Error(r.error)
    if (typeof r.base64 !== 'string') throw new Error('桌面同步通道没有返回内容')
    return responseFromBase64(r.base64, r.status || 0)
  }
}

/** 生产环境用：把 `window.electronAuth.fetch` 接到适配器上（非桌面环境返回 null） */
export function createDesktopCloudFetch(origin: string): CloudFetch | null {
  if (typeof window === 'undefined' || !window.electronAuth) return null
  const api = window.electronAuth
  return desktopCloudFetch(origin, (opts) => api.fetch(opts))
}