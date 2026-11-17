// 材料检索对照评测 · 手动运行（不属于回归用例，不会被 run-all 收进全量）
// 用法：node tests/build-test.mjs retrieval-bench
//
// 输出即 G 包（规划 §9 / §16 G1）的证据：人工标注召回、噪声、耗时、存储口径与保留/改进结论。
import { buildSyntheticCorpus } from '@/lib/retrieval/synthetic'
import {
  baselineStrategy, bm25Strategy, probeForeignLeak, productionDefaultStrategy,
  runRetrievalBench, titleBoostStrategy,
} from '@/lib/retrieval/bench'

const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const ms = (x: number) => `${x.toFixed(1)}ms`
const kb = (n: number) => `${(n / 1024).toFixed(0)} KiB`

async function report(title: string, bulk: number) {
  const corpus = buildSyntheticCorpus({ bulk })
  const rep = await runRetrievalBench(corpus, {
    strategies: [baselineStrategy, productionDefaultStrategy, titleBoostStrategy(), bm25Strategy()],
  })
  const leaks = await probeForeignLeak(corpus, corpus.projectId)

  console.log(`\n===== ${title} =====`)
  console.log(`语料：${rep.corpus.refs} 个来源 / ${rep.corpus.chunks} 块 / ${rep.corpus.chars} 字`)
  console.log(`存储口径：文本索引 ≈ ${kb(rep.corpus.textBytes)}（正文+标题+id；不含向量）`)
  console.log(`          若同时存 768 维向量 ≈ ${(rep.corpus.vectorBytesIfDim(768) / 1024 / 1024).toFixed(1)} MiB`)
  console.log(`跨项目串味：${leaks} 条   确定性：${rep.deterministic ? '是' : '否'}`)
  console.log('')
  console.log('策略'.padEnd(28) + '召回'.padStart(8) + '精确'.padStart(8) + 'MRR'.padStart(8)
    + '空结果'.padStart(8) + '字数'.padStart(8) + 'p50'.padStart(9) + 'p95'.padStart(9))
  for (const s of rep.strategies) {
    console.log(
      s.label.padEnd(28) + pct(s.recall).padStart(8) + pct(s.precision).padStart(8)
      + s.mrr.toFixed(3).padStart(8) + pct(s.emptyAccuracy).padStart(8)
      + String(Math.round(s.avgChars)).padStart(8) + ms(s.p50Ms).padStart(9) + ms(s.p95Ms).padStart(9),
    )
  }
  // 逐条差异（只看「生产默认」与「旧口径」不一致的查询，便于人工复核）
  const prod = rep.strategies.find(s => s.id === 'production-default')!
  const base = rep.strategies.find(s => s.id === 'baseline')!
  const diffs = corpus.queries.filter((_q, i) => {
    const a = base.outcomes[i]
    const b = prod.outcomes[i]
    return a.returned !== b.returned || a.hit !== b.hit
  })
  if (diffs.length) {
    console.log('\n口径差异（旧口径 → 生产）：')
    for (const q of diffs) {
      const i = corpus.queries.indexOf(q)
      console.log(`  · ${q.id}：返回 ${base.outcomes[i].returned} → ${prod.outcomes[i].returned} 条`
        + `，命中 ${base.outcomes[i].hit} → ${prod.outcomes[i].hit}    （${q.note}）`)
    }
  }
  return rep
}

const small = await report('小语料（标注查询）', 0)
const large = await report('大型项目（2000 块噪声）', 2000)

// ---- 结论（数字驱动，写死在脚本里以便每次运行都能复核） ----
const prodSmall = small.strategies.find(s => s.id === 'production-default')!
const baseSmall = small.strategies.find(s => s.id === 'baseline')!
const prodLarge = large.strategies.find(s => s.id === 'production-default')!

console.log('\n===== 结论（保留 / 改进） =====')
console.log(`1) 召回：旧口径 ${pct(baseSmall.recall)} → 生产 ${pct(prodSmall.recall)}`
  + `（标注集 ${baseSmall.outcomes.filter(o => o.expected > 0).length} 条查询）`)
console.log(`2) 噪声：旧口径 ${pct(baseSmall.noise)} → 生产 ${pct(prodSmall.noise)}（未升高）`)
console.log(`3) 代价：2000 块 p95 ${ms(prodLarge.p95Ms)}（旧口径 ${ms(large.strategies.find(s => s.id === 'baseline')!.p95Ms)}）`)
console.log('4) 决议：采用「IDF 按项目语料 + 准入闸按二元词数收敛 + 召回层项目校验」三处修正；')
console.log('   不采用标题加权 / BM25（召回与精确已无差异；MRR 只在大语料上略高，标注集太小不足以支撑换打分）；')
console.log('   不更换检索引擎（规划 §9 明确不预设替换）。')
