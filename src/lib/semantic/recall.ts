// ============ 语义检索 · 召回编排 ============
//
// 职责：给定一段「当前写到哪」的文本，去向量库里捞出意思最接近的片段。
// 三步：查询嵌入 → 候选收窄（关键词粗筛）→ 余弦排序 + 阈值过滤。
//
// 🔴 三条纪律：
//   1. **永不抛**。嵌入服务挂了 / 索引库坏了 / 维度不对 —— 一律返回 `[]`，
//      由调用方静默跳过这一段（语义检索是"补一层"，绝不能因为它阻断写作链路）。
//   2. **不做 I/O 之外的决定**。本模块**不读** aiContext / db，只吃 `projectId` 与向量行 ——
//      这样 `aiContext` 可以安全地 import 它，不会形成环。
//   3. **S 级过滤在召回侧**（`hideSecretRows`）。

import { tokenize } from '../search'
import { fromVectorBuffer } from './chunk'
import { embedOne, type EmbedConfig } from './embed'
import { loadVectors, vectorIndex, type VecIndex, type VecKind, type VecRow } from './store'

export interface RecallHit {
  kind: VecKind
  refId: string
  chunkIdx: number
  text: string
  /** 来源标题（章节名 / 条目名） */
  title: string
  score: number
  /** 该块来源被标为 S 级（绝密）—— 调用方可据此再作判断 */
  secret: boolean
}

export interface RecallOptions {
  projectId: string
  cfg: EmbedConfig
  /** 最多返回多少条，默认 6 */
  topK?: number
  /** 只在这些类别里找（不传 = 全部） */
  kinds?: VecKind[]
  /** 余弦阈值，默认 0.35（低于它的多半只是"用词像"，不是"意思近"）*/
  minScore?: number
  /** 角色视角：剔除 S 级来源块 */
  hideSecretRows?: boolean
  /**
   * 叙事锚点白名单（章节 id 集合）。**只对 `kind === 'chapter'` 的命中生效** ——
   * 设定条目没有"发生在哪一章"这个维度，用章节白名单去裁它没有意义。
   * 传 null / 不传 = 不裁剪。
   */
  allowChapterIds?: Set<string> | null
  /**
   * 排除这些来源（如**焦点章自己** —— 它的正文本来就在提示里，再召回一遍纯属占预算）。
   * 对所有类别生效。
   */
  excludeRefIds?: Set<string> | null
  signal?: AbortSignal
  /** 同一个来源最多保留几块（防某一章把召回名额刷满），默认 2 */
  perRefCap?: number
  /** 候选超过这个数才启用关键词粗筛，默认 1200 */
  prefilterAt?: number
  /** 单测注入点（生产不传） */
  embedFn?: (text: string, cfg: EmbedConfig, signal?: AbortSignal) => Promise<number[] | null>
  loadFn?: (projectId: string) => Promise<VecRow[]>
  indexFn?: (projectId: string) => Promise<VecIndex>
}

export const RECALL_TOP_K = 6
export const RECALL_MIN_SCORE = 0.35
export const RECALL_PER_REF_CAP = 2
export const RECALL_PREFILTER_AT = 1200

/**
 * 余弦相似度。
 * 边界：任一侧为零向量 ⇒ 返回 0（**不是 NaN** —— NaN 会在排序里变成"随机位置"，
 * 那种 bug 极难发现；长度不等时按较短的一侧算，不崩）。
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 索引是否与当前嵌入模型匹配（维度 + 模型名双判）。不匹配 ⇒ 视为整库失效 */
export function checkIndexFreshness(
  rows: VecRow[],
  cfg: Pick<EmbedConfig, 'model'>,
): { fresh: boolean; reason: string } {
  if (rows.length === 0) return { fresh: false, reason: '索引为空' }
  const model = (cfg.model ?? '').trim()
  for (const r of rows) {
    if (r.model !== model) return { fresh: false, reason: '嵌入模型已变更，请重建索引' }
  }
  return { fresh: true, reason: '' }
}

/**
 * 关键词粗筛：把候选缩到 `keep` 条。
 *
 * 🔴 全都没字面命中时**退回全量**（见函数末尾）—— 那是"纯语义、零字面重叠"的查询，
 *    正是语义检索最该赢的场景，此时若只留下 hit=0 的那几条（排序无意义）等于把结果毁掉。
 *    宁可这次不省，也不能把召回质量换掉。
 */
function prefilter(rows: VecRow[], query: string, keep: number): VecRow[] {
  if (rows.length <= keep) return rows
  const q = new Set(tokenize(query))
  if (q.size === 0) return rows
  const scored = rows.map((r, i) => {
    const tokens = new Set(tokenize(r.text))
    let hit = 0
    for (const t of q) if (tokens.has(t)) hit++
    return { r, i, hit }
  })
  const hitRows = scored.filter(x => x.hit > 0)
  if (hitRows.length === 0) return rows
  hitRows.sort((a, b) => b.hit - a.hit || a.i - b.i)
  return hitRows.slice(0, keep).map(x => x.r)
}

/**
 * 召回与 `query` 语义最接近的片段。
 *
 * 任一步失败都返回 `[]`（不抛、不报错）—— 调用方只需判断"有没有拿到东西"。
 */
export async function recallRelevant(query: string, opts: RecallOptions): Promise<RecallHit[]> {
  const q = (query ?? '').trim()
  if (!q || !opts.projectId) return []

  const topK = Math.max(1, opts.topK ?? RECALL_TOP_K)
  const minScore = opts.minScore ?? RECALL_MIN_SCORE
  const perRefCap = Math.max(1, opts.perRefCap ?? RECALL_PER_REF_CAP)
  const prefilterAt = Math.max(topK, opts.prefilterAt ?? RECALL_PREFILTER_AT)

  const doEmbed = opts.embedFn ?? embedOne
  const doLoad = opts.loadFn ?? loadVectors
  const doIndex = opts.indexFn ?? vectorIndex

  // 🔴 先看索引里到底有没有东西，**再**决定要不要发嵌入请求。
  //    顺序反过来（先嵌入后读库）的代价是真实的：没建索引的项目每次 AI 调用都会白花
  //    一次嵌入请求（联网模型就是白花钱 + 白等一次 RTT）。
  //    `vectorIndex` 只读轻量字段、不读 vec —— 空库上这一步几乎免费。
  const emptyIndex = await doIndex(opts.projectId).catch((): VecIndex => ({ hashes: new Map(), refs: new Set() }))
  if (emptyIndex.refs.size === 0) return []

  let queryVec: number[] | null = null
  try {
    queryVec = await doEmbed(q, opts.cfg, opts.signal)
  } catch {
    return []
  }
  if (!queryVec || queryVec.length === 0) return []

  let rows: VecRow[] = []
  try {
    rows = await doLoad(opts.projectId)
  } catch {
    return []
  }
  if (rows.length === 0) return []

  // 维度 / 模型守卫：不匹配说明这份索引是上一个模型留下的，拿它算余弦只会得到噪声
  if (!checkIndexFreshness(rows, opts.cfg).fresh) return []

  const allowKinds = opts.kinds && opts.kinds.length > 0 ? new Set<VecKind>(opts.kinds) : null
  const candidates = rows.filter(r => {
    if (allowKinds && !allowKinds.has(r.kind)) return false
    if (opts.excludeRefIds?.has(r.refId)) return false
    if (opts.hideSecretRows && r.secret) return false
    // 锚点白名单只裁章节（设定条目没有"发生在哪一章"这个维度）
    if (r.kind === 'chapter' && opts.allowChapterIds && !opts.allowChapterIds.has(r.refId)) return false
    return r.dim === queryVec!.length
  })
  if (candidates.length === 0) return []

  const narrowed = prefilter(candidates, q, prefilterAt)

  const qv = Float32Array.from(queryVec)
  const scored: RecallHit[] = []
  for (const r of narrowed) {
    let score = 0
    try {
      score = cosine(qv, fromVectorBuffer(r.vec))
    } catch {
      continue // 单行损坏（buffer 形状不对）→ 跳过它，不影响其他行
    }
    if (score < minScore) continue
    scored.push({
      kind: r.kind, refId: r.refId, chunkIdx: r.chunkIdx,
      text: r.text, title: r.title ?? '', score, secret: r.secret,
    })
  }

  scored.sort((a, b) => b.score - a.score || a.refId.localeCompare(b.refId) || a.chunkIdx - b.chunkIdx)

  // 同一来源限流：按 refId 计数，超出的丢掉（本章/本条目已有块入选，让位给别的来源）
  const used = new Map<string, number>()
  const out: RecallHit[] = []
  for (const h of scored) {
    const n = used.get(h.refId) ?? 0
    if (n >= perRefCap) continue
    used.set(h.refId, n + 1)
    out.push(h)
    if (out.length >= topK) break
  }
  return out
}
