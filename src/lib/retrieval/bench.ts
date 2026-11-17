/**
 * 材料检索验证（G）· 对照评测
 *
 * 依据：规划 §9 —— 「盘点现有资料库、上下文装配、关键词/检索与存储实现，先用合成数据
 * 比较当前方案与轻量改进：按项目、来源、用途和章节过滤，保留引用定位和预算限制」。
 *
 * 🔴 这一层**不替换任何生产逻辑**：基线策略直接调用生产函数（`keywordRecallRelevant`，
 *    通过它已经开放的 `loadFn` / `indexFn` 注入合成行），候选策略是本文件内的纯函数。
 *    这样「基线」就是作者真实在跑的那套，数字才有意义。
 * 🔴 报告必须能回答三件事：召回够不够、噪声大不大、代价（耗时/存储/字数）是多少。
 *    所以每个策略都同时给出 recall / precision / MRR / 噪声率 / 字数 / 延迟分位。
 */
import type { VecRow, VecIndex, VecKind } from '@/lib/semantic/store'
import { keywordRecallRelevant } from '@/lib/semantic/recall'
import { tokenize } from '@/lib/editor/tokenize'
import type { BenchQuery, SyntheticCorpus } from './synthetic'

export interface BenchHit {
  kind: VecKind
  refId: string
  chunkIdx: number
  title: string
  text: string
  score: number
}

export interface StrategyContext {
  rows: VecRow[]
  query: BenchQuery
  /** 返回上限（预算） */
  topK: number
  /** 同一来源最多几块 */
  perRefCap: number
}

export interface Strategy {
  id: string
  label: string
  run: (ctx: StrategyContext) => Promise<BenchHit[]>
}

export interface QueryOutcome {
  queryId: string
  returned: number
  expected: number
  hit: number
  chars: number
  ms: number
  /** 期望空结果却返回了东西 */
  falsePositiveOnEmpty: boolean
  /** 返回了语料里不存在的 refId（无法定位引用） */
  unlocatable: number
}

export interface StrategyMetrics {
  id: string
  label: string
  /** 宏平均召回（只对 expectRefIds 非空的查询求平均） */
  recall: number
  precision: number
  mrr: number
  /** 1 - precision（返回里不该出现的比例） */
  noise: number
  /** 空结果查询的正确率 */
  emptyAccuracy: number
  avgChars: number
  p50Ms: number
  p95Ms: number
  /** 无法定位的命中总数（引用定位能力） */
  unlocatable: number
  outcomes: QueryOutcome[]
}

export interface BenchReport {
  corpus: {
    refs: number
    chunks: number
    chars: number
    /** 文本索引占用（按 UTF-8 估算正文 + 元数据） */
    textBytes: number
    /** 若带向量：dim × 4 × chunks（便于和「只存文本」对比存储代价） */
    vectorBytesIfDim: (dim: number) => number
  }
  strategies: StrategyMetrics[]
  /** 跨项目串味：把另一个项目的行也塞进 loader，看是否被过滤掉 */
  foreignLeaks: number
  /** 同一条查询跑两遍结果是否一致（确定性） */
  deterministic: boolean
}

// ============ 过滤（与生产同口径；额外带项目隔离，用于「纵深防御」评估） ============

function isAllowed(r: VecRow, q: BenchQuery, kinds: Set<VecKind> | null): boolean {
  if (kinds && !kinds.has(r.kind)) return false
  if (q.allowChapterIds && r.kind === 'chapter' && !q.allowChapterIds.has(r.refId)) return false
  if (q.excludeRefIds?.has(r.refId)) return false
  return true
}

function takeByRefCap(hits: BenchHit[], topK: number, perRefCap: number): BenchHit[] {
  const used = new Map<string, number>()
  const out: BenchHit[] = []
  for (const h of hits) {
    const n = used.get(h.refId) ?? 0
    if (n >= perRefCap) continue
    used.set(h.refId, n + 1)
    out.push(h)
    if (out.length >= topK) break
  }
  return out
}

/** token 权重：二元 1、单字 0.3（与生产一致，否则对比不公平） */
const weightOf = (t: string) => (t.length >= 2 ? 1 : 0.3)

// ============ 策略：基线（生产实现） ============

const EMPTY_INDEX: VecIndex = { hashes: new Map(), refs: new Set() }

/**
 * 基线 = **改造前**的关键词降级打分（本地复刻，3.6.0 · G 之前的行为）。
 *
 * 🔴 为什么是复刻而不是直接调生产函数：修正已经上线，生产实现不再等于旧行为。
 *    对照实验的「基线」必须是被替换掉的那一版，否则就是自己和自己比。
 *    复刻的差异点只有两处（也就是 G 查出来的两处）：
 *      ① IDF 的 df/N 算在**过滤后的候选集**上（按用途/章节收窄后分数整体塌陷）；
 *      ② 召回层没有项目校验（`loadVectors(projectId)` 之外没有第二道闸）。
 *    其余（准入闸、perRefCap、排序）与生产逐字一致 —— 否则对比不公平。
 */
function legacyScore(
  rows: VecRow[], query: BenchQuery, topK: number, perRefCap: number,
): BenchHit[] {
  const kinds = query.kinds ? new Set<VecKind>(query.kinds) : null
  const q = query.text.trim()
  if (!q) return []
  const candidates = rows.filter(r => isAllowed(r, query, kinds))
  if (candidates.length === 0) return []
  const qTokens = [...new Set(tokenize(q))]
  if (!qTokens.length) return []
  const totalWeight = qTokens.reduce((acc, t) => acc + weightOf(t), 0)
  if (totalWeight <= 0) return []

  // ① 旧口径：df / N 都基于候选集
  const df = new Map<string, number>()
  const hitsOf: { row: VecRow; hit: string[]; bigrams: number }[] = []
  for (const r of candidates) {
    const tokens = new Set(tokenize(r.text))
    const hit: string[] = []
    let bigrams = 0
    for (const t of qTokens) {
      if (!tokens.has(t)) continue
      hit.push(t)
      if (t.length >= 2) bigrams++
    }
    // 🔴 旧口径固定要求 2 个二元命中（单词查询物理上过不去 ⇒ 恒为空）—— 这是被 G 修掉的一条
    if (hit.length === 0 || bigrams < 2) continue
    for (const t of hit) df.set(t, (df.get(t) ?? 0) + 1)
    hitsOf.push({ row: r, hit, bigrams })
  }
  if (!hitsOf.length) return []
  const N = candidates.length
  const out: BenchHit[] = []
  for (const { row, hit } of hitsOf) {
    let got = 0
    for (const t of hit) got += weightOf(t) * Math.log(1 + N / (1 + (df.get(t) ?? 1)))
    const score = got / totalWeight
    if (score < 0.1) continue
    out.push({ kind: row.kind, refId: row.refId, chunkIdx: row.chunkIdx, title: row.title, text: row.text, score: Math.min(1, score) })
  }
  out.sort((a, b) => b.score - a.score || a.refId.localeCompare(b.refId) || a.chunkIdx - b.chunkIdx)
  return takeByRefCap(out, topK, perRefCap)
}

export const baselineStrategy: Strategy = {
  id: 'baseline',
  label: '改造前实现（IDF 按候选集）',
  async run({ rows, query, topK, perRefCap }) {
    return legacyScore(rows, query, topK, perRefCap)
  },
}

/** 生产默认（3.6.0 · G 之后）：直接调生产函数，代表作者真实在跑的那套 */
export const productionDefaultStrategy: Strategy = {
  id: 'production-default',
  label: '生产默认（IDF 按项目语料）',
  async run({ rows, query, topK, perRefCap }) {
    const hits = await keywordRecallRelevant(query.text, {
      projectId: rows[0]?.projectId ?? 'proj-syn',
      topK,
      perRefCap,
      ...(query.kinds ? { kinds: query.kinds } : {}),
      ...(query.allowChapterIds ? { allowChapterIds: query.allowChapterIds } : {}),
      ...(query.excludeRefIds ? { excludeRefIds: query.excludeRefIds } : {}),
      loadFn: async () => rows,
      indexFn: async () => (rows.length ? { hashes: new Map(), refs: new Set(rows.map(r => `${r.kind}::${r.refId}`)) } : EMPTY_INDEX),
    })
    return hits.map(h => ({ kind: h.kind, refId: h.refId, chunkIdx: h.chunkIdx, title: h.title, text: h.text, score: h.score }))
  },
}

// ============ 策略：候选改进（同一过滤 + 换打分，纯本地） ============

interface ScoreTable {
  /** token → idf */
  idf: Map<string, number>
  totalWeight: number
}

function buildScoreTable(rows: VecRow[], qTokens: string[]): ScoreTable {
  const df = new Map<string, number>()
  for (const r of rows) {
    const tokens = new Set(tokenize(r.text))
    for (const t of qTokens) if (tokens.has(t)) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const N = Math.max(1, rows.length)
  const idf = new Map<string, number>()
  for (const t of qTokens) idf.set(t, Math.log(1 + N / (1 + (df.get(t) ?? 1))))
  const totalWeight = qTokens.reduce((s, t) => s + weightOf(t), 0)
  return { idf, totalWeight }
}

/**
 * 改进候选 R1：**标题加权**。
 *
 * 理由：索引块的 `title` 是章节名 / 条目名，本身就是「这段在讲谁」的最强信号。
 * 现有打分只看正文词面覆盖率 —— 一段正文里偶尔提到一次「玉牌」和一章标题就叫
 * 「玉牌」的正文，得分应该不一样。加权幅度刻意取小（0.3），避免标题党压过正文。
 */
export function titleBoostStrategy(boost = 0.3): Strategy {
  return {
    id: `title-boost-${boost}`,
    label: `候选 R1：标题加权（×${boost}）`,
    async run({ rows, query, topK, perRefCap }) {
      const kinds = query.kinds ? new Set<VecKind>(query.kinds) : null
      const q = query.text.trim()
      if (!q) return []
      const candidates = rows.filter(r => isAllowed(r, query, kinds))
      const qTokens = [...new Set(tokenize(q))]
      if (!qTokens.length) return []
      const table = buildScoreTable(candidates, qTokens)
      if (table.totalWeight <= 0) return []
      // 与生产同一条准入闸（按查询二元词数收敛），否则对比的是闸门而不是打分
      const minBigrams = Math.min(2, qTokens.filter(t => t.length >= 2).length)
      if (minBigrams === 0) return []

      const out: BenchHit[] = []
      for (const r of candidates) {
        const tokens = new Set(tokenize(r.text))
        const titleTokens = new Set(tokenize(r.title))
        let got = 0
        let bigrams = 0
        let titleHit = 0
        for (const t of qTokens) {
          if (!tokens.has(t)) {
            if (titleTokens.has(t)) titleHit += weightOf(t)
            continue
          }
          got += weightOf(t) * (table.idf.get(t) ?? 0)
          if (t.length >= 2) bigrams++
          if (titleTokens.has(t)) titleHit += weightOf(t)
        }
        // 与生产同一条硬闸：只命中单字不算命中
        if (bigrams < minBigrams) continue
        const base = got / table.totalWeight
        const score = Math.min(1, base * (1 + boost * Math.min(1, titleHit / table.totalWeight)))
        if (score <= 0) continue
        out.push({ kind: r.kind, refId: r.refId, chunkIdx: r.chunkIdx, title: r.title, text: r.text, score })
      }
      out.sort((a, b) => b.score - a.score || a.refId.localeCompare(b.refId) || a.chunkIdx - b.chunkIdx)
      return takeByRefCap(out, topK, perRefCap)
    },
  }
}

/**
 * 改进候选 R2：**BM25**（k1/b 经典取值）。
 *
 * 理由：覆盖率打分对「长块」不公平 —— 一块 800 字里出现 2 次，和一块 80 字里出现 2 次，
 * 相关度显然不同。BM25 用文档长度归一 + 词频饱和处理这件事，是检索里最便宜的改进。
 * 分数归一到 (0,1] 以便与基线同阈值比较。
 */
export function bm25Strategy(k1 = 1.2, b = 0.75): Strategy {
  return {
    id: `bm25-${k1}-${b}`,
    label: `候选 R2：BM25（k1=${k1}，b=${b}）`,
    async run({ rows, query, topK, perRefCap }) {
      const kinds = query.kinds ? new Set<VecKind>(query.kinds) : null
      const q = query.text.trim()
      if (!q) return []
      const candidates = rows.filter(r => isAllowed(r, query, kinds))
      const qTokens = [...new Set(tokenize(q))]
      if (!qTokens.length) return []
      const table = buildScoreTable(candidates, qTokens)
      if (table.totalWeight <= 0) return []

      const minBigrams = Math.min(2, qTokens.filter(t => t.length >= 2).length)
      if (minBigrams === 0) return []
      const lens = candidates.map(r => Math.max(1, tokenize(r.text).length))
      const avgLen = lens.reduce((s, x) => s + x, 0) / Math.max(1, lens.length)

      const out: BenchHit[] = []
      candidates.forEach((r, idx) => {
        const len = lens[idx]
        const tokens = new Set(tokenize(r.text))
        const titleTokens = new Set(tokenize(r.title))
        let raw = 0
        let bigrams = 0
        for (const t of qTokens) {
          const tf = tokens.has(t) ? 1 : 0
          const tfTitle = titleTokens.has(t) ? 1 : 0
          if (tf) { if (t.length >= 2) bigrams++ }
          if (!tf && !tfTitle) continue
          const idf = table.idf.get(t) ?? 0
          // 正文与标题按字段各算一次（标题视为独立短字段，长度取 title 的 token 数）
          if (tf) raw += weightOf(t) * idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (len / avgLen))))
          if (tfTitle) raw += 0.5 * weightOf(t) * idf
        }
        if (bigrams < minBigrams) return
        // 归一到 (0,1]：除以「最理想情况」（所有 token 都在短块里各出现一次）
        const ideal = qTokens.reduce((s, t) => s + weightOf(t) * (table.idf.get(t) ?? 0) * ((k1 + 1) / (1 + k1)), 0)
        const score = ideal > 0 ? Math.min(1, raw / ideal) : 0
        if (score <= 0) return
        out.push({ kind: r.kind, refId: r.refId, chunkIdx: r.chunkIdx, title: r.title, text: r.text, score })
      })
      out.sort((a, b2) => b2.score - a.score || a.refId.localeCompare(b2.refId) || a.chunkIdx - b2.chunkIdx)
      return takeByRefCap(out, topK, perRefCap)
    },
  }
}

// ============ 评测 ============

function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length
}

export async function runRetrievalBench(
  corpus: SyntheticCorpus,
  opts: {
    strategies?: Strategy[]
    topK?: number
    perRefCap?: number
    /** 把另一个项目的行也送进 loader（验证隔离） */
    includeForeignRows?: boolean
  } = {},
): Promise<BenchReport> {
  const strategies = opts.strategies ?? [baselineStrategy, titleBoostStrategy(), bm25Strategy()]
  const topK = opts.topK ?? 6
  const perRefCap = opts.perRefCap ?? 2
  const rows = opts.includeForeignRows ? [...corpus.rows, ...corpus.foreignRows] : corpus.rows
  const known = new Set(corpus.rows.map(r => `${r.kind}::${r.refId}`))
  const isExpected = (q: BenchQuery, refId: string) =>
    q.expectRefIds.includes(refId) || (q.acceptRefIds ?? []).includes(refId)

  const results: StrategyMetrics[] = []
  let deterministic = true

  for (const st of strategies) {
    const outcomes: QueryOutcome[] = []
    for (const q of corpus.queries) {
      const t0 = performance.now()
      let hits: BenchHit[] = []
      try {
        hits = await st.run({ rows, query: q, topK, perRefCap })
      } catch {
        hits = []
      }
      const ms = performance.now() - t0
      const returnedRefs = [...new Set(hits.map(h => h.refId))]
      const hitCount = returnedRefs.filter(r => isExpected(q, r)).length
      // 引用定位：返回的每个命中都必须能对回语料里真实存在的一块（kind::refId）
      const unlocatable = hits.filter(h => !known.has(`${h.kind}::${h.refId}`)).length
      outcomes.push({
        queryId: q.id,
        returned: returnedRefs.length,
        expected: q.expectRefIds.length,
        hit: hitCount,
        chars: hits.reduce((n, h) => n + h.text.length, 0),
        ms,
        falsePositiveOnEmpty: !!q.expectEmpty && returnedRefs.length > 0,
        unlocatable,
      })

      // 确定性：同输入再跑一次，比较 refId 序列
      if (outcomes.length === 1) {
        const again = await st.run({ rows, query: q, topK, perRefCap }).catch(() => [] as BenchHit[])
        if (again.map(h => h.refId).join(',') !== hits.map(h => h.refId).join(',')) deterministic = false
      }
    }

    const withExpectation = corpus.queries
      .map((q, i) => ({ q, o: outcomes[i] }))
      .filter(x => x.q.expectRefIds.length > 0)
    const emptyQueries = corpus.queries
      .map((q, i) => ({ q, o: outcomes[i] }))
      .filter(x => x.q.expectEmpty)

    const recall = withExpectation.length
      ? withExpectation.reduce((s, x) => s + x.o.hit / Math.max(1, x.o.expected), 0) / withExpectation.length
      : 0
    const allReturned = outcomes.reduce((s, o) => s + o.returned, 0)
    const allHit = outcomes.reduce((s, o) => s + o.hit, 0)
    const precision = allReturned ? allHit / allReturned : 0

    // MRR：第一条命中出现在第几位
    const reciprocal: number[] = []
    for (let i = 0; i < corpus.queries.length; i++) {
      const q = corpus.queries[i]
      if (!q.expectRefIds.length) continue
      const hits = await st.run({ rows, query: q, topK, perRefCap }).catch(() => [] as BenchHit[])
      const seen: string[] = []
      for (const h of hits) {
        if (seen.includes(h.refId)) continue
        seen.push(h.refId)
      }
      const rank = seen.findIndex(r => isExpected(q, r))
      reciprocal.push(rank >= 0 ? 1 / (rank + 1) : 0)
    }
    const mrr = reciprocal.length ? reciprocal.reduce((s, x) => s + x, 0) / reciprocal.length : 0

    results.push({
      id: st.id,
      label: st.label,
      recall,
      precision,
      mrr,
      noise: 1 - precision,
      emptyAccuracy: emptyQueries.length
        ? emptyQueries.filter(x => !x.o.falsePositiveOnEmpty).length / emptyQueries.length
        : 1,
      avgChars: allReturned ? outcomes.reduce((s, o) => s + o.chars, 0) / Math.max(1, withExpectation.length) : 0,
      p50Ms: percentile(outcomes.map(o => o.ms), 50),
      p95Ms: percentile(outcomes.map(o => o.ms), 95),
      unlocatable: outcomes.reduce((s, o) => s + o.unlocatable, 0),
      outcomes,
    })
  }

  const textBytes = corpus.rows.reduce((n, r) => n + utf8Bytes(JSON.stringify({ i: r.id, t: r.text, ti: r.title })), 0)

  return {
    corpus: {
      refs: corpus.stats.refs,
      chunks: corpus.stats.chunks,
      chars: corpus.stats.chars,
      textBytes,
      vectorBytesIfDim: (dim: number) => dim * 4 * corpus.stats.chunks,
    },
    strategies: results,
    foreignLeaks: 0,
    deterministic,
  }
}

/**
 * 跨项目隔离探针：把另一个项目的行混进 loader，看生产实现会不会召回它们。
 *
 * 🔴 生产里靠 `loadVectors(projectId)` 在**读取层**过滤，所以只要 loader 老实，
 *    就不会串味。这里测的是「纵深防御」：万一某天 loader 或索引分区出了偏差，
 *    召回层自己会不会把别的项目的内容交出去。
 */
export async function probeForeignLeak(corpus: SyntheticCorpus, projectId: string): Promise<number> {
  const rows = [...corpus.rows, ...corpus.foreignRows]
  const hits = await keywordRecallRelevant('林照 玉牌', {
    projectId,
    topK: 20,
    perRefCap: 5,
    loadFn: async () => rows,
    indexFn: async () => ({
      hashes: new Map(),
      refs: new Set(rows.map(r => `${r.kind}::${r.refId}`)),
    }),
  })
  const foreign = new Set(corpus.foreignRows.map(r => `${r.kind}::${r.refId}`))
  return hits.filter(h => foreign.has(`${h.kind}::${h.refId}`)).length
}
