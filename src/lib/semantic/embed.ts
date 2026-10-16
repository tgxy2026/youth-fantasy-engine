// ============ 语义检索 · 嵌入传输 ============
//
// 为什么不能复用 `aiCore/chat.ts`：`chat()` 只打 `/api/chat` 或 `/chat/completions`，
// 既**不支持 embedding 接口**，也**不返回向量**（它返回的是文本）。
// 更关键的是 `aiCore/transport.ts` 里有一条 `NON_CHAT_MODEL_RE`，专门在「列对话模型」时
// **把 embedding 模型剔出去** —— 那是列对话模型用的过滤，与这里无关，别误以为它也挡了本通道。
//
// 故本文件自建一条独立通道，但**HTTP 出口仍然复用** `fetchWithTimeout`：
// 它是全项目唯一的 fetch 出口，自带超时 / 取消（AICancelled）/ 统一的中文错误翻译，
// 另起一个裸 fetch 等于把这套契约复制一份，迟早漂移。
//
// 🔴 铁律：**永不抛**。失败一律返回 `{ ok: false, error }` —— 调用方据此静默降级
//    回关键词召回（语义检索是"补一层"，绝不能因为它挂了就阻断写作链路）。
//    口径与 `webSearch` 一致。

import { fetchWithTimeout, isCancelled, openaiBaseOf } from '@/lib/aiCore/transport'
import { mergeHeaders } from '@/lib/aiCore/headers'

export interface EmbedConfig {
  type: 'ollama' | 'openai'
  /** Ollama 默认 http://localhost:11434；OpenAI 兼容填到 …/v1 之类前缀 */
  baseUrl: string
  apiKey?: string
  model: string
  /**
   * 该 provider 的**自定义请求头**（3.1.1 第 4 项）——嵌入与对话复用同一份模型配置，
   * 若某个网关要求额外请求头（如 OpenCode Go 的 `x-opencode-session`），
   * 这里不带就等于「对话能通、嵌入必 400」，故必须一并传下去。
   */
  headers?: Record<string, string>
}

export interface EmbedResult {
  ok: boolean
  vectors?: number[][]
  /** 向量维度（同一批内不一致时按失败处理） */
  dim?: number
  error?: string
}

/** 单次请求最多带多少条文本。Ollama 与主流 OpenAI 兼容端都能接受 32，再大就有被拒的风险 */
export const EMBED_BATCH = 32
/** 嵌入请求超时（毫秒）。它与对话不同 —— 不流式、通常 1~3 秒返回，30 秒已很宽裕 */
const EMBED_TIMEOUT_MS = 30_000
/** 极端情况下单条文本的字符上限（防某个畸形超长块把请求撑爆） */
const EMBED_TEXT_CAP = 4000

function stripSlash(s: string): string {
  return (s ?? '').trim().replace(/\/+$/, '')
}

/**
 * 归一化基址。
 * · Ollama：直接剥尾斜杠。
 * · OpenAI 兼容：先剥掉误粘的 `/chat/completions` 与 `/embeddings` 尾段
 *   （中转站商家常给完整接口地址），得到"接口前缀"。
 */
export function embedBaseOf(cfg: Pick<EmbedConfig, 'type' | 'baseUrl'>): string {
  if (cfg.type === 'ollama') return stripSlash(cfg.baseUrl)
  const base = openaiBaseOf(cfg.baseUrl)
  return base.endsWith('/embeddings') ? stripSlash(base.slice(0, -'/embeddings'.length)) : base
}

/** 嵌入端点路径（纯函数，便于单测钉住两种平台的差异） */
export function embedPath(cfg: Pick<EmbedConfig, 'type' | 'baseUrl'>): string {
  return cfg.type === 'ollama' ? `${embedBaseOf(cfg)}/api/embed` : `${embedBaseOf(cfg)}/embeddings`
}

/** 配置是否填全（缺一不可）。不完整时连请求都不发 —— 与 `precheck` 同思路 */
export function embedConfigError(cfg: EmbedConfig | null | undefined): string {
  if (!cfg) return '尚未配置嵌入模型'
  if (!stripSlash(cfg.baseUrl)) return '嵌入模型缺少接口地址'
  if (!(cfg.model ?? '').trim()) return '嵌入模型缺少模型名'
  // 非本机的 OpenAI 兼容端必须有密钥；ollama 与 local 走免密钥
  if (cfg.type === 'openai' && !(cfg.apiKey ?? '').trim()) {
    const host = embedBaseOf(cfg)
    const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(host)
    if (!local) return '远程嵌入服务缺少 API 密钥'
  }
  return ''
}

/**
 * 构造一次嵌入请求（**纯函数**，不发请求）。
 * 两种平台的**请求体形状恰好相同**（`{ model, input: string[] }`），差异只在响应解析 —— 
 * 但 URL 与鉴权头不同，故仍按平台分支，方便将来某一端改协议时只动一处。
 */
export function buildEmbedRequest(cfg: EmbedConfig, texts: string[]): { url: string; init: RequestInit } {
  const url = embedPath(cfg)
  const clipped = texts.map(t => (t ?? '').slice(0, EMBED_TEXT_CAP))
  // 与对话链路同一出口：自定义头走 mergeHeaders（合法名放行、浏览器禁止的头不静默丢弃）。
  // 🔴 口径与 `aiCore/chat.ts` 对齐：自定义头**只对 OpenAI 兼容端点有意义** ——
  //    Ollama 原生走 `/api/embed`，不认这套头；模型配置界面也只在 `type !== 'ollama'`
  //    时才渲染编辑器（填不进去）。这里显式按 type 分支，避免将来有人给 Ollama 补了 UI
  //    却只在"嵌入"这一半生效、对话那一半不生效。
  const headers = cfg.type === 'openai'
    ? mergeHeaders(
      { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
      cfg.headers,
    )
    : { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) }
  const body: Record<string, unknown> = { model: (cfg.model ?? '').trim(), input: clipped }
  if (cfg.type === 'openai') body.encoding_format = 'float'
  return { url, init: { method: 'POST', headers, body: JSON.stringify(body) } }
}

/**
 * 解析响应体（**纯函数**）。认两种形态：
 * · Ollama：`{ embeddings: number[][] }`
 * · OpenAI 兼容：`{ data: [{ embedding: number[], index? }] }`（按 index 排序，缺省按原序）
 * 返回 null = 形状不可识别（调用方按失败处理，并给出可读原因）。
 */
export function parseEmbedResponse(type: EmbedConfig['type'], json: unknown): number[][] | null {
  const o = json as Record<string, unknown> | null
  if (!o || typeof o !== 'object') return null
  if (type === 'ollama') {
    const arr = o.embeddings
    if (!Array.isArray(arr)) return null
    const out = arr.map(v => (Array.isArray(v) ? v.map(n => Number(n)) : null))
    return out.every(Array.isArray) ? (out as number[][]) : null
  }
  const data = o.data
  if (!Array.isArray(data)) return null
  const rows = data as Array<Record<string, unknown>>
  const ordered = rows
    .map((r, i) => ({ i, idx: typeof r?.index === 'number' ? r.index : i, emb: r?.embedding }))
    .sort((a, b) => a.idx - b.idx)
  const out: number[][] = []
  for (const r of ordered) {
    if (!Array.isArray(r.emb)) return null
    out.push((r.emb as unknown[]).map(n => Number(n)))
  }
  return out
}

/** 一批内所有向量维度必须一致；返回 dim，不一致返回 null */
function uniformDim(vectors: number[][]): number | null {
  if (vectors.length === 0) return null
  const dim = vectors[0]?.length ?? 0
  if (dim === 0) return null
  for (const v of vectors) if (v.length !== dim) return null
  return dim
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * 批量嵌入。**永不抛** —— 任何失败都收敛成 `{ ok: false, error }`。
 *
 * @param texts 待嵌入文本（空数组 ⇒ `ok: false`，因为"成功但没向量"对调用方毫无意义）
 * @param cfg   嵌入模型配置（不完整 ⇒ 不发请求直接失败）
 * @param signal 取消信号：用户中止索引任务时传它，已取消的批次按失败返回
 */
export async function embedTexts(
  texts: string[],
  cfg: EmbedConfig,
  signal?: AbortSignal,
): Promise<EmbedResult> {
  const list = (texts ?? []).map(t => String(t ?? ''))
  const bad = embedConfigError(cfg)
  if (bad) return { ok: false, error: bad }
  if (list.length === 0) return { ok: false, error: '没有需要嵌入的文本' }

  const batches = chunk(list, EMBED_BATCH)
  const all: number[][] = []
  let dim = 0
  for (let i = 0; i < batches.length; i++) {
    if (signal?.aborted) return { ok: false, error: '已取消' }
    const { url, init } = buildEmbedRequest(cfg, batches[i])
    let res: Response
    try {
      res = await fetchWithTimeout(url, init, EMBED_TIMEOUT_MS, signal)
    } catch (e) {
      if (isCancelled(e)) return { ok: false, error: '已取消' }
      return { ok: false, error: `连接嵌入服务失败：${url}（请确认服务已启动、地址可达）` }
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const brief = detail.slice(0, 200).replace(/\s+/g, ' ').trim()
      return { ok: false, error: `嵌入服务返回 ${res.status}${brief ? `：${brief}` : ''}` }
    }
    const json = await res.json().catch(() => null)
    const vecs = parseEmbedResponse(cfg.type, json)
    if (!vecs) return { ok: false, error: '嵌入服务返回的数据无法识别（既非 embeddings 也非 data[].embedding）' }
    if (vecs.length !== batches[i].length) {
      return { ok: false, error: `嵌入结果条数不符：请求 ${batches[i].length} 条、返回 ${vecs.length} 条` }
    }
    const d = uniformDim(vecs)
    if (d === null) return { ok: false, error: '嵌入结果维度不一致或为空' }
    if (dim === 0) dim = d
    else if (dim !== d) return { ok: false, error: `嵌入结果维度前后不一致（${dim} → ${d}）` }
    all.push(...vecs)
  }
  return { ok: true, vectors: all, dim }
}

/** 便捷封装：单条文本嵌入（召回查询用）。失败返回 null */
export async function embedOne(text: string, cfg: EmbedConfig, signal?: AbortSignal): Promise<number[] | null> {
  const r = await embedTexts([text], cfg, signal)
  return r.ok && r.vectors?.[0] ? r.vectors[0] : null
}
