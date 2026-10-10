/**
 * 联网检索（起草素材来源）
 *
 * 【为什么要有它】
 * 「一句话起草」在两种情况下的质量差别极大：
 *   · 模型**本来就知道**的题材（蒂法、《最终幻想 7》、梁山伯与祝英台）—— 不给资料也很准；
 *   · 冷门 / 新出的 / 特定版本的设定 —— 模型只会一本正经地编。
 * 所以给了两条路：**让模型自己去查**（模型/中转自带联网能力），或**我们查好再喂给它**（搜索接口）。
 *
 * 🔴 关键认识：走「搜索接口」这一档时，**联网与模型无关** —— 我们查出结果、渲染成一段文字塞进提示词，
 *    模型只是在读文本。所以本地 Ollama 这种「自己不会联网」的模型照样能用。
 *
 * 【为什么默认是关】
 * 只有「不联网」这条路是零配置零成本的（模型已有知识 + 作者粘贴的素材）。默认开着等于
 * 悄悄替用户发外部请求，也等于默认假设他配了密钥 —— 两样都不该替用户决定。
 *
 * 【请求由谁发出（决定能接哪些接口）】
 *   · 桌面版（Electron）：走 **主进程代发**（`electron/main.cjs` 的 `net:fetch`）→ 不受同源策略限制，
 *     **任何返回 JSON 的搜索接口都能接**（自建 SearXNG、Jina、Exa…）。请求不出本机。
 *   · 便携版（单文件 HTML，跑在系统浏览器里）：**没有主进程**，只能直连 → 只有自带
 *     `Access-Control-Allow-Origin` 的接口能用（**博查**实测可以）。
 * 这与当年网页版那条 `/api/ai/<host>` 反代是同一个道理（把发起方从浏览器换到后端），
 * 区别是桌面版的后端就是本机主进程 —— 不依赖服务器、也没有停服风险。
 *
 * 🔴 本文件只负责「查」，不负责「决定要不要查」：模式、开关、回退都在调用方（draft / 界面）里判。
 */
import { HAS_NET_BRIDGE, netFetch } from '@/lib/desktop'

export type SearchEngine = 'bocha' | 'searxng' | 'custom'

export type SearchSettings = {
  /**
   * 检索方式：
   *   · `off`   —— 不联网。只用模型已有知识 + 作者粘贴的参考素材（零配置，永远可用）
   *   · `model` —— 模型自带联网（适用于支持联网的模型/中转，检索发生在服务商那一侧）
   *   · `api`   —— 由我们调用下面配的搜索接口，把结果喂给模型
   */
  mode: 'off' | 'model' | 'api'
  engine: SearchEngine
  /** 接口地址（engine='searxng' 留空即用本地默认；engine='bocha' 留空即用博查默认地址） */
  endpoint: string
  apiKey: string
  /** 每次取几条结果（1–10） */
  topK: number
}

export const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  mode: 'off',
  engine: 'bocha',
  endpoint: '',
  apiKey: '',
  topK: 5,
}

/** 博查的默认接口（实测响应带 `Access-Control-Allow-Origin: *`，浏览器可直连；需要密钥） */
export const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search'

/**
 * 自建 SearXNG 的默认地址（免费、无密钥、无次数限制）。
 * ⚠️ 三处前提，缺一个都查不到东西：
 *   ① `settings.yml` 里 `search.formats` 要包含 `json` —— 官方默认**只有 html**，不加接口直接 403；
 *   ② `limiter` 要关掉 —— 开着它只放行「像浏览器」的请求，我们的调用会被判成机器人回 429；
 *   ③ 端口要与你的端口映射一致（这里默认 8888：官方 docker 文档示例用的就是这个，
 *      且 8080 很容易被别的程序占掉 —— 本机就被 Steam 的 steamwebhelper 占着）。
 * 地址里带 `{query}` 即按 **GET** 调用（SearXNG / Jina / Exa 这类都是 GET 取 JSON）。
 */
export const SEARXNG_ENDPOINT = 'http://127.0.0.1:8888/search?q={query}&format=json&language=zh-CN'

export type SearchItem = {
  title: string
  url: string
  /** 摘要（可能为空 —— 有些接口只给标题） */
  snippet: string
}

export type SearchOutcome = {
  /** 实际用上了检索结果 */
  used: boolean
  /** 用哪个引擎查的（给界面显示） */
  engine: string
  /** 实际发出的检索词 */
  query: string
  results: SearchItem[]
  /** 失败原因（used=false 时给界面看）。**不静默** —— 作者必须知道这次没查成 */
  error?: string
}

/** 一次请求的描述。**构造与发送分开** —— 构造是纯函数，可以脱离网络单测 */
export type SearchRequest = {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
}

/** 一次请求的结果。失败也照常返回（**不抛**），由调用方如实上报 */
export type TransportResult =
  | { ok: true; status: number; text: string }
  | { ok: false; error: string }

/**
 * 发送器：把一次请求发出去、取回响应文本。
 * 默认实现在桌面版走主进程、其余走浏览器 fetch；测试可注入桩。
 */
export type SearchTransport = (req: SearchRequest, signal?: AbortSignal) => Promise<TransportResult>

/** 检索方式的显示名（界面与日志共用一处，别各写各的） */
export const SEARCH_MODE_LABEL: Record<SearchSettings['mode'], string> = {
  off: '模型已有知识 + 粘贴素材',
  model: '模型自带联网',
  api: '搜索接口',
}

/** 引擎显示名 */
export const SEARCH_ENGINE_LABEL: Record<SearchEngine, string> = {
  bocha: '博查',
  searxng: 'SearXNG',
  custom: '自定义接口',
}

/**
 * 这一档在当前配置下**能不能真的用**。
 * 返回 null = 可用；否则返回「为什么用不了」——界面据此提前提示，而不是等跑完才发现白跑一趟。
 */
export function searchBlockedReason(s: SearchSettings): string | null {
  if (s.mode === 'off') return null
  if (s.mode === 'model') return null
  // api 档
  if (s.engine === 'bocha' && !s.apiKey.trim()) {
    return '博查这一档还没填密钥 —— 起草时会自动退回「模型已有知识 + 粘贴素材」。'
  }
  if (s.engine === 'custom' && !s.endpoint.trim()) {
    return '自定义接口还没填地址 —— 起草时会自动退回「模型已有知识 + 粘贴素材」。'
  }
  // SearXNG 是本地实例：便携版跑在浏览器里、没有主进程代发，一定会被跨域拦
  if (s.engine === 'searxng' && !HAS_NET_BRIDGE) {
    return '本地 SearXNG 在便携版 / 浏览器里用不了（没有主进程代发，会被跨域拦）—— 桌面版可直接用，或把引擎换成博查。'
  }
  return null
}

function resolveEndpoint(s: SearchSettings): string {
  const own = s.endpoint.trim()
  if (s.engine === 'custom') return own
  if (s.engine === 'searxng') return own || SEARXNG_ENDPOINT
  return own || BOCHA_ENDPOINT
}

/**
 * 构造一次检索请求（纯函数）。
 *
 * 规则：**地址里写了 `{query}` 就用 GET**，否则用 POST JSON（`{ query, count }`）。
 * 这样一份配置就能覆盖两类接口：博查这类 POST 的，和 SearXNG / Jina / Exa 这类 GET 的 ——
 * 不需要再加一个「方法」下拉框让作者去猜。
 */
export function buildSearchRequest(
  settings: SearchSettings,
  query: string,
  count: number,
): { req?: SearchRequest; error?: string } {
  const endpoint = resolveEndpoint(settings)
  if (!endpoint) return { error: '没填搜索接口地址' }
  const q = String(query ?? '').trim()
  if (!q) return { error: '没有可检索的内容（想法写太空了）' }
  const n = Math.max(1, Math.min(10, Math.round(count || 5)))
  const key = settings.apiKey.trim()
  const auth: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {}

  if (endpoint.includes('{query}')) {
    const url = endpoint
      .split('{query}').join(encodeURIComponent(q))
      .split('{count}').join(String(n))
    return { req: { url, method: 'GET', headers: { Accept: 'application/json', ...auth } } }
  }

  // SearXNG 选了却给了个没有占位符的地址 —— 直接说清楚，别让它去 POST 一个 GET 接口然后报「没返回结果」
  if (settings.engine === 'searxng') {
    return {
      error: 'SearXNG 这类接口必须用 GET，地址里要带 {query} 占位符'
        + '（例如 http://127.0.0.1:8080/search?q={query}&format=json）',
    }
  }

  const body = settings.engine === 'bocha'
    ? { query: q, count: n, summary: true, freshness: 'noLimit' }
    // 自定义接口：尽量用一个通用的形状（多数搜索服务都认 query + count）
    : { query: q, count: n }
  return {
    req: {
      url: endpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(body),
    },
  }
}

/** 直连的超时（主进程代发有它自己的 30s 闸，这里只管浏览器这条） */
const NET_TIMEOUT_MS = 20000

/**
 * 默认发送器。
 * 桌面版交给主进程（`net:fetch`）—— 不受同源策略限制，于是**任何 JSON 搜索接口都能接**；
 * 其余（便携版 / 纯浏览器 dev）直连，能被 CORS 放行的只有自带 ACAO 的接口。
 */
const defaultTransport: SearchTransport = async (req, signal) => {
  if (HAS_NET_BRIDGE) {
    const r = await netFetch(req.url, { method: req.method, headers: req.headers, body: req.body })
    return r.ok ? { ok: true, status: r.status, text: r.text } : { ok: false, error: r.error }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), NET_TIMEOUT_MS)
  const onAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onAbort)
  try {
    const res = await fetch(req.url, {
      method: req.method, headers: req.headers, body: req.body, signal: ctrl.signal,
    })
    return { ok: true, status: res.status, text: await res.text() }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 从任意形状的 JSON 里挖出「像搜索结果的条目」（自定义接口兜底用，不猜字段名） */
export function harvestItems(raw: unknown, limit: number): SearchItem[] {
  const out: SearchItem[] = []
  const seen = new Set<string>()
  const walk = (node: unknown, depth: number) => {
    if (!node || depth > 6 || out.length >= limit) return
    if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return }
    if (typeof node !== 'object') return
    const o = node as Record<string, unknown>
    const pick = (...keys: string[]): string => {
      for (const k of keys) {
        const v = o[k]
        if (typeof v === 'string' && v.trim()) return v.trim()
      }
      return ''
    }
    const title = pick('title', 'name', 'heading', 'siteName')
    const url = pick('url', 'link', 'href', 'website', 'sourceUrl')
    const snippet = pick('snippet', 'summary', 'content', 'description', 'text', 'passage', 'abstract')
    if (title && (url || snippet)) {
      const key = url || title
      if (!seen.has(key)) {
        seen.add(key)
        out.push({ title, url, snippet: snippet.slice(0, 600) })
      }
    }
    for (const v of Object.values(o)) walk(v, depth + 1)
  }
  walk(raw, 0)
  return out.slice(0, limit)
}

function safeJsonText(text: string): unknown {
  try { return JSON.parse(text) } catch { return { __raw: text.slice(0, 500) } }
}

/** 从错误响应里挖一句人话（各家字段名不一，挖不到就退回 HTTP 状态） */
function errMessage(data: unknown, status: number): string {
  const o = data as { message?: string; error?: { message?: string } | string } | null
  if (o) {
    if (typeof o.error === 'string' && o.error.trim()) return o.error
    if (o.error && typeof o.error === 'object' && o.error.message) return String(o.error.message)
    if (o.message) return String(o.message)
  }
  return `HTTP ${status}`
}

/**
 * 跑一次检索。**永远不抛**：失败也要回一个带 error 的结果，
 * 让调用方告诉作者「这次没查成」，而不是悄悄退化成「模型瞎编」。
 */
export async function webSearch(
  query: string,
  settings: SearchSettings,
  signal?: AbortSignal,
  deps: { transport?: SearchTransport } = {},
): Promise<SearchOutcome> {
  const q = String(query ?? '').trim()
  const base: SearchOutcome = { used: false, engine: settings.engine, query: q, results: [] }
  if (settings.mode !== 'api') return { ...base, error: '当前检索方式不是「搜索接口」' }

  const built = buildSearchRequest(settings, q, settings.topK)
  if (!built.req) return { ...base, error: built.error || '请求没构造出来' }
  const req = built.req
  const transport = deps.transport ?? defaultTransport

  try {
    const r = await transport(req, signal)
    if (!r.ok) {
      const hint = /Failed to fetch|NetworkError|load failed|跨域/i.test(r.error) && !HAS_NET_BRIDGE
        ? '（多半是跨域被拦 —— 桌面版会由主进程代发、不受此限；便携版只能用自带跨域许可的接口）'
        : ''
      return { ...base, error: `检索失败：${r.error}${hint}` }
    }
    const data = safeJsonText(r.text)
    if (r.status < 200 || r.status >= 300) {
      return { ...base, error: `搜索接口返回错误：${errMessage(data, r.status)}` }
    }
    const count = Math.max(1, Math.min(10, Math.round(settings.topK || 5)))
    const items = harvestItems(data, count)
    if (items.length === 0) {
      return { ...base, error: '搜索接口没有返回可识别的结果（换一条检索词，或换个接口试试）' }
    }
    return { used: true, engine: settings.engine, query: q, results: items }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const hint = /Failed to fetch|NetworkError|load failed/i.test(msg) && !HAS_NET_BRIDGE
      ? '（多半是跨域被拦或网络不通 —— 桌面版由主进程代发，不受跨域限制；便携版请用自带跨域许可的接口）'
      : ''
    return { ...base, error: `检索失败：${msg}${hint}` }
  }
}

/**
 * 把检索结果渲染成给模型看的一段。
 * 带编号与网址，并要求它**只依据这些资料 + 自己的知识**，别把检索符号当正文。
 */
export function renderSearchResults(o: SearchOutcome): string {
  if (!o.used || o.results.length === 0) return ''
  const lines = o.results.map((r, i) => {
    const head = r.url ? `${i + 1}. ${r.title}（${r.url}）` : `${i + 1}. ${r.title}`
    return r.snippet ? `${head}\n   ${r.snippet.replace(/\s+/g, ' ')}` : head
  })
  return [
    `〖联网检索结果〗（检索词：${o.query}）`,
    ...lines,
    '',
    '以上是外部资料，「当作参考而不是圣旨」：与你的已知信息冲突时以资料为准；资料没提到的不要编，',
    '宁可留空或写「待作者补充」。不要把这些编号与网址抄进正文。',
  ].join('\n')
}
