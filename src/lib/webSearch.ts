/**
 * 联网检索（起草素材来源）
 *
 * 【为什么要有它】
 * 「一句话起草」在两种情况下的质量差别极大：
 *   · 模型**本来就知道**的题材（蒂法、《最终幻想 7》、梁山伯与祝英台）—— 不给资料也很准；
 *   · 冷门 / 新出的 / 特定版本的设定 —— 模型只会一本正经地编。
 * 所以给了两条路：**让模型自己去查**（模型/中转自带联网能力），或**我们查好再喂给它**（搜索接口）。
 *
 * 【为什么默认是关】
 * 只有「不联网」这条路是零配置零成本的（模型已有知识 + 作者粘贴的素材）。默认开着等于
 * 悄悄替用户发外部请求，也等于默认假设他配了密钥 —— 两样都不该替用户决定。
 *
 * 【为什么主推博查】
 * 2026-09-15 实测：`api.bochaai.com` 的响应带 `Access-Control-Allow-Origin: *`、`Allow-Headers: *`
 * 与 OPTIONS —— **浏览器与 Electron 渲染进程都能直连**（本项目的联网模型也是这样直连的）。
 * 智谱的 `web_search` 响应里**没有** ACAO 头（只有 `Vary: Origin`），直连会被 CORS 拦掉，
 * 所以在界面上明确标注「博查可直接用；其它接口若报跨域，请用博查或走网页版代理」。
 *
 * 🔴 本文件只负责「查」，不负责「决定要不要查」：模式、开关、回退都在调用方（draft / 界面）里判。
 */
import { WEB } from './env'

export type SearchEngine = 'bocha' | 'custom'

export type SearchSettings = {
  /**
   * 检索方式：
   *   · `off`   —— 不联网。只用模型已有知识 + 作者粘贴的参考素材（零配置，永远可用）
   *   · `model` —— 模型自带联网（适用于支持联网的模型/中转，检索发生在服务商那一侧）
   *   · `api`   —— 由我们调用下面配的搜索接口，把结果喂给模型
   */
  mode: 'off' | 'model' | 'api'
  engine: SearchEngine
  /** 自定义接口地址（engine='custom' 时用；留空即用博查默认地址） */
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

/** 博查的默认接口（实测支持跨域直连） */
export const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search'

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

/** 检索方式的显示名（界面与日志共用一处，别各写各的） */
export const SEARCH_MODE_LABEL: Record<SearchSettings['mode'], string> = {
  off: '模型已有知识 + 粘贴素材',
  model: '模型自带联网',
  api: '搜索接口',
}

/**
 * 这一档在当前配置下**能不能真的用**。
 * 返回 null = 可用；否则返回「为什么用不了」——界面据此提前提示，而不是等跑完才发现白跑一趟。
 */
export function searchBlockedReason(s: SearchSettings): string | null {
  if (s.mode === 'off') return null
  if (s.mode === 'model') return null
  // api 档
  const endpoint = s.endpoint.trim() || BOCHA_ENDPOINT
  if (s.engine === 'bocha' && !s.apiKey.trim()) {
    return '博查这一档还没填密钥 —— 起草时会自动退回「模型已有知识 + 粘贴素材」。'
  }
  if (s.engine === 'custom' && !s.endpoint.trim()) {
    return '自定义接口还没填地址 —— 起草时会自动退回「模型已有知识 + 粘贴素材」。'
  }
  void endpoint
  return null
}

function resolveEndpoint(s: SearchSettings): string {
  if (s.engine === 'custom') return s.endpoint.trim()
  return s.endpoint.trim() || BOCHA_ENDPOINT
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

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { __raw: text.slice(0, 500) } }
}

/**
 * 跑一次检索。**永远不抛**：失败也要回一个带 error 的结果，
 * 让调用方告诉作者「这次没查成」，而不是悄悄退化成「模型瞎编」。
 */
export async function webSearch(query: string, settings: SearchSettings, signal?: AbortSignal): Promise<SearchOutcome> {
  const q = String(query ?? '').trim()
  const base: SearchOutcome = { used: false, engine: settings.engine, query: q, results: [] }
  if (settings.mode !== 'api') return { ...base, error: '当前检索方式不是「搜索接口」' }
  if (!q) return { ...base, error: '没有可检索的内容（想法写太空了）' }

  const endpoint = resolveEndpoint(settings)
  if (!endpoint) return { ...base, error: '没填搜索接口地址' }
  const count = Math.max(1, Math.min(10, Math.round(settings.topK || 5)))

  // 网页体验版走服务器反代（/api/ai/<host>）绕开跨域；桌面/便携直连（博查本身带 ACAO）。
  const url = toProxyUrl(endpoint)

  const body = settings.engine === 'bocha'
    ? { query: q, count, summary: true, freshness: 'noLimit' }
    // 自定义接口：尽量用一个通用的形状（多数搜索服务都认 query + count）
    : { query: q, count }

  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 20000)
    const onAbort = () => ctrl.abort()
    signal?.addEventListener('abort', onAbort)
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(settings.apiKey.trim() ? { Authorization: `Bearer ${settings.apiKey.trim()}` } : {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    const data = await safeJson(res)
    if (!res.ok) {
      const msg = (data as { message?: string; error?: { message?: string } })?.error?.message
        || (data as { message?: string })?.message
        || `HTTP ${res.status}`
      return { ...base, error: `搜索接口返回错误：${msg}` }
    }
    const items = harvestItems(data, count)
    if (items.length === 0) {
      return { ...base, error: '搜索接口没有返回可识别的结果（换一条检索词，或换个接口试试）' }
    }
    return { used: true, engine: settings.engine, query: q, results: items }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const hint = /Failed to fetch|NetworkError|load failed/i.test(msg)
      ? '（多半是跨域被拦或网络不通 —— 博查实测可直连，其它接口可能不行）'
      : ''
    return { ...base, error: `检索失败：${msg}${hint}` }
  }
}

/** 与 ai.ts 同一套规则：网页版走同源反代，桌面/便携直连 */
function toProxyUrl(base: string): string {
  if (!WEB) return base
  try {
    const u = new URL(base)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return base
    return `/api/ai/${u.host}${u.pathname}${u.search}`
  } catch {
    return base
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
    '以上是外部资料，**当作参考而不是圣旨**：与你的已知信息冲突时以资料为准；资料没提到的不要编，',
    '宁可留空或写「待作者补充」。不要把这些编号与网址抄进正文。',
  ].join('\n')
}
