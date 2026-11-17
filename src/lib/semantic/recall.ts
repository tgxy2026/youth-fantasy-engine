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

// 🔴 分词取 `../tokenize`（纯函数）而**不是** `../search` —— 后者 import db，
//    而知识库（`lib/knowledgeBase.ts`）要复用本模块且必须对 db 零依赖，否则成环。
import { tokenize } from '@/lib/editor/tokenize'
import { fromVectorBuffer } from '@/lib/semantic/chunk'
import { embedOne, type EmbedConfig } from '@/lib/semantic/embed'
import { loadVectors, vectorIndex, type VecIndex, type VecKind, type VecRow, type VecBasis } from '@/lib/semantic/store'

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
  /**
   * 块的授权依据（3.2.0 Q2）。受模板治理的来源若缺失 ⇒ 注入侧必须隔离。
   * 章节 / 知识库 / 自由对话没有字段权限，可以为空。
   */
  basis?: VecBasis
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
  /**
   * **只**在这些来源里找（`excludeRefIds` 的对称能力）。null / 不传 = 不裁剪。
   * 对所有类别生效 —— 自由对话靠它把召回限定在**本会话**（见 `lib/tavern/recall.ts`）。
   */
  allowRefIds?: Set<string> | null
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

const RECALL_TOP_K = 6
const RECALL_MIN_SCORE = 0.35
const RECALL_PER_REF_CAP = 2
const RECALL_PREFILTER_AT = 1200

/**
 * 关键词降级召回的词面覆盖率阈值。
 *
 * 🔴 **不能沿用余弦的 0.35** —— 两者量纲不同。查询是「本意标题 + 摘要 + 前 900 字正文」，
 *    去重后通常有数百个二元 token，其中大量是本章独有的专名，别处根本不会出现；
 *    一个片段能覆盖 10% 已经算高度相关。用 0.35 会让降级模式几乎永远返回空，
 *    那就等于「静默失效」，比不做降级更糟。
 */
const KEYWORD_MIN_COVERAGE = 0.1

/** 只命中单字不算命中：中文单字噪声太大（「的」「了」「他」满篇都是） */
const KEYWORD_MIN_BIGRAM_HITS = 2


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
 * 候选过滤（**语义路径与关键词降级共用的唯一一份**）。
 *
 * 🔴 不抽出来的话，两条路径各写一份过滤条件，迟早漂移成
 *    「语义模式不召回 S 级，降级模式却召回」—— 那是绕过权限的漏洞，不是显示问题。
 */
/** 过滤只用到这几个字段（语义路径与降级路径都能满足，与 `cfg` 无关）。 */
type FilterOpts = Pick<RecallOptions, 'projectId' | 'allowRefIds' | 'excludeRefIds' | 'hideSecretRows' | 'allowChapterIds'>

function passesFilters(r: VecRow, opts: FilterOpts, allowKinds: Set<VecKind> | null): boolean {
  /**
   * 🔴 3.6.0 · G：**项目隔离的纵深防御**。
   *
   * 生产上靠 `loadVectors(projectId)` 在读取层过滤，所以正常路径不会串味；
   * 但召回层自己**一条项目校验都没有** —— 一旦 loader、索引分区或缓存出错，
   * 就会把别的项目的正文交进提示词（跨作品串味，是最难察觉、也最伤的一类错误）。
   * 合成语料实测：把别项目的行混进 loader，基线确实会交出 1 条别项目命中。
   * 这条判断成本近乎为零，必须在召回侧再拦一道。
   */
  if (r.projectId !== opts.projectId) return false
  if (allowKinds && !allowKinds.has(r.kind)) return false
  // 🔴 来源白名单（`excludeRefIds` 的对称能力，2026-10-05 T2 加）：
  //    自由对话要**只召回本场**的消息，而它和别的会话共用一个全局分区 ——
  //    没有这道闸就会把别场戏的内容召回进来（跨世界观串味）。
  if (opts.allowRefIds && !opts.allowRefIds.has(r.refId)) return false
  if (opts.excludeRefIds?.has(r.refId)) return false
  if (opts.hideSecretRows && r.secret) return false
  // 锚点白名单只裁章节（设定条目没有"发生在哪一章"这个维度）
  if (r.kind === 'chapter' && opts.allowChapterIds && !opts.allowChapterIds.has(r.refId)) return false
  return true
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
  const candidates = rows.filter(r => r.dim === queryVec!.length && passesFilters(r, opts, allowKinds))
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
      ...(r.basis ? { basis: r.basis } : {}),
    })
  }

  scored.sort((a, b) => b.score - a.score || a.refId.localeCompare(b.refId) || a.chunkIdx - b.chunkIdx)
  return takeByRefCap(scored, topK, perRefCap)
}

/** 同一来源限流：按 refId 计数，超出的丢掉（本章/本条目已有块入选，让位给别的来源）。 */
function takeByRefCap(scored: RecallHit[], topK: number, perRefCap: number): RecallHit[] {
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

// ============ 关键词降级召回（嵌入不可用时）============
//
// 为什么需要它（3.5.5）：ACP 模式下所有模型请求都经 Agent，引擎**发不出** `/embeddings`
// 请求（`withApiModeLease` 直接拒绝）。若这里什么都不做，`recallRelevant` 会一路返回 `[]`，
// 表现成「语义检索开着，但注入里永远没有召回段」—— 作者完全看不出是降级了还是库里没内容。
//
// 🔴 降级只换「怎么打分」，**不换**「允不允许」。过滤条件走 `passesFilters`（与语义路径同一份），
//    权限闸 `filterRecallHitsByPermission` 仍由调用方在注入前跑一遍。
// 🔴 打分是**纯本地计算**，不发请求、不读模型 —— 所以它不需要 `cfg`，也不会因为网络抖动失败。

export interface KeywordRecallOptions extends Omit<RecallOptions, 'cfg' | 'minScore' | 'embedFn'> {
  /** 词面覆盖率阈值，默认 `KEYWORD_MIN_COVERAGE` */
  minCoverage?: number
}

/** query token 权重：二元算 1，单字算 0.3（单字召回率高但几乎不含信息） */
function tokenWeight(t: string): number {
  return t.length >= 2 ? 1 : 0.3
}

/**
 * 用本地词面匹配从索引里捞片段。**永不抛**，拿不到就返回 `[]`。
 *
 * 与 `recallRelevant` 的差别只有打分：
 *   · 语义：查询先嵌入成向量，与库中向量算余弦（能命中"换了说法"的近义内容）；
 *   · 关键词：直接比 token 覆盖率（只能命中"用词相同"的内容）。
 * 所以降级后**召回率会下降**，但不会归零，也不会把不相关内容塞进上下文。
 */
export async function keywordRecallRelevant(
  query: string,
  opts: KeywordRecallOptions,
): Promise<RecallHit[]> {
  const q = (query ?? '').trim()
  if (!q || !opts.projectId) return []

  const topK = Math.max(1, opts.topK ?? RECALL_TOP_K)
  const minCoverage = opts.minCoverage ?? KEYWORD_MIN_COVERAGE
  const perRefCap = Math.max(1, opts.perRefCap ?? RECALL_PER_REF_CAP)
  const prefilterAt = Math.max(topK, opts.prefilterAt ?? RECALL_PREFILTER_AT)

  const doLoad = opts.loadFn ?? loadVectors
  const doIndex = opts.indexFn ?? vectorIndex

  // 与语义路径同序：先确认索引非空，再读全量行（空库上这一步几乎免费）
  const idx = await doIndex(opts.projectId).catch((): VecIndex => ({ hashes: new Map(), refs: new Set() }))
  if (idx.refs.size === 0) return []

  let rows: VecRow[] = []
  try {
    rows = await doLoad(opts.projectId)
  } catch {
    return []
  }
  if (rows.length === 0) return []

  const allowKinds = opts.kinds && opts.kinds.length > 0 ? new Set<VecKind>(opts.kinds) : null
  // 关键词路径**不看 `r.dim`**：降级时不用向量，维度不一致的旧块照样能被词面命中。
  const candidates = rows.filter(r => passesFilters(r, opts, allowKinds))
  if (candidates.length === 0) return []

  const qTokens = [...new Set(tokenize(q))]
  if (qTokens.length === 0) return []
  const totalWeight = qTokens.reduce((s, t) => s + tokenWeight(t), 0)
  if (totalWeight <= 0) return []

  /**
   * 🔴 3.6.0 · G：准入闸的「至少 2 个二元命中」要按**查询本身有几个二元词**收敛。
   *
   * 原写法固定要求 2 个，于是**只查一个专名**（「玉牌」这种最常见的查法）永远返回空 ——
   * 一个二元词最多只能命中 1 次，闸门物理上过不去。实测：查「玉牌」时，正文里满是玉牌的
   * 那一章被丢弃，界面表现成「没有相关资料」。
   * 现在的口径：
   *   · 查询里一个二元词都没有（纯单字，如「的了在」）⇒ 直接返回空：这种查询没有检索意义；
   *   · 否则要求 `min(2, 查询二元词数)` 个命中 —— 单词查询 1 个，多词查询仍是 2 个（不放宽精度）。
   */
  const qBigrams = qTokens.filter(t => t.length >= 2).length
  if (qBigrams === 0) return []
  const minBigramHits = Math.min(KEYWORD_MIN_BIGRAM_HITS, qBigrams)

  const narrowed = prefilter(candidates, q, prefilterAt)

  // 一次遍历：既算命中集合，也顺便统计 df（供 IDF 抑制「满篇都是」的词）
  /**
   * 🔴 3.6.0 · G：IDF 必须基于**整个项目语料**（`rows`），不能基于「过滤后的候选集」。
   *
   * 原来 df/N 都在 `narrowed` 上算。一旦调用方按用途（`kinds`）或章节锚点收窄到
   * 一两条，N 就变成 1：每个命中词的 idf 都塌到 `log(1.5)≈0.4`，覆盖率整体掉到阈值以下，
   * 结果是「明明有这条资料，却返回空」—— 界面表现成「没有相关材料」，作者完全看不出
   * 是过滤太紧还是真的没有。合成语料里复现：只看知识库时同名条目得 0 分被丢弃。
   *
   * IDF 是**语料统计量**，本来就不该被一次查询的过滤条件改写。
   */
  const N = Math.max(1, rows.length)
  const df = new Map<string, number>()
  const narrowedSet = new Set(narrowed)
  const hitsOf: { row: VecRow; hit: string[]; bigrams: number }[] = []
  // 🔴 一次遍历同时算 df 与命中：df 必须覆盖**整个项目语料**（见上），
  //    但分词只做一遍 —— 分成两遍会让 2000 块的库多花一倍时间（实测 p95 11ms → 25ms）。
  //    非候选行只参与 df，不参与命中判定。
  for (const r of rows) {
    if (opts.signal?.aborted) return []
    const tokens = new Set(tokenize(r.text))
    for (const t of qTokens) {
      if (tokens.has(t)) df.set(t, (df.get(t) ?? 0) + 1)
    }
    if (!narrowedSet.has(r)) continue
    const hit: string[] = []
    let bigrams = 0
    for (const t of qTokens) {
      if (!tokens.has(t)) continue
      hit.push(t)
      if (t.length >= 2) bigrams++
    }
    if (hit.length === 0 || bigrams < minBigramHits) continue
    hitsOf.push({ row: r, hit, bigrams })
  }
  if (hitsOf.length === 0) return []

  const scored: RecallHit[] = []
  for (const { row, hit } of hitsOf) {
    let got = 0
    for (const t of hit) {
      // 弱 IDF：铺满整个候选集的词（「的」「了」）权重趋近 0，专名权重接近 1
      const idf = Math.log(1 + N / (1 + (df.get(t) ?? 1)))
      got += tokenWeight(t) * idf
    }
    const score = got / totalWeight
    if (score < minCoverage) continue
    scored.push({
      kind: row.kind, refId: row.refId, chunkIdx: row.chunkIdx,
      text: row.text, title: row.title ?? '', score: Math.min(1, score), secret: row.secret,
      ...(row.basis ? { basis: row.basis } : {}),
    })
  }
  if (scored.length === 0) return []

  scored.sort((a, b) => b.score - a.score || a.refId.localeCompare(b.refId) || a.chunkIdx - b.chunkIdx)
  return takeByRefCap(scored, topK, perRefCap)
}
