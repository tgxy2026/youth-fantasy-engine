// ============ 材料检索验证（G）· 对照评测契约闸 ============
//
// 盯六件事：
//   ① 合成语料必须确定性（同种子同结果），否则「这次比上次好」不可复现；
//   ② 过滤要对：用途（kinds）/ 章节锚点 / 排除焦点章，一条都不能漏；
//   ③ 空结果要老实：没有材料就返回空，不许硬凑；
//   ④ 引用定位：每个命中都要能对回语料里真实存在的一块；
//   ⑤ 预算：topK 与 perRefCap 必须真的生效；
//   ⑥ 跨项目不得串味（纵深防御）。
import { readFileSync } from 'node:fs'
import { buildSyntheticCorpus } from '@/lib/retrieval/synthetic'
import {
  baselineStrategy, bm25Strategy, probeForeignLeak, productionDefaultStrategy,
  runRetrievalBench, titleBoostStrategy,
} from '@/lib/retrieval/bench'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => readFileSync(p, 'utf8')

console.log('—— retrievalBench：材料检索对照评测（3.6.0 · G）——')

// ---------- ① 语料确定性 ----------
{
  const a = buildSyntheticCorpus({ seed: 7 })
  const b = buildSyntheticCorpus({ seed: 7 })
  const key = (c: ReturnType<typeof buildSyntheticCorpus>) => c.rows.map(r => `${r.id}:${r.text}`).join('|')
  ok('① 同种子生成完全一致', key(a) === key(b))
  // 噪声块只在 bulk > 0 时才生成 —— 不传 bulk 的语料与种子无关（这是刻意的：小语料要可读）
  ok('① 同种子 + 噪声规模一致 ⇒ 仍然一致',
    key(buildSyntheticCorpus({ seed: 7, bulk: 20 })) === key(buildSyntheticCorpus({ seed: 7, bulk: 20 })))
  ok('① 换种子后噪声块不同（随机不写死）',
    key(buildSyntheticCorpus({ seed: 7, bulk: 20 })) !== key(buildSyntheticCorpus({ seed: 8, bulk: 20 })))
  ok('① 语料覆盖章节/设定/知识库/摘要四类来源',
    ['chapter', 'setting', 'kb', 'summary'].every(k => a.rows.some(r => r.kind === k)))
  ok('① 标注查询不少于 8 条且都写了来历', a.queries.length >= 8 && a.queries.every(q => q.note.length > 0))
}

// ---------- ② 过滤：用途 / 锚点 / 排除 ----------
{
  const corpus = buildSyntheticCorpus()
  const settingOnly = await baselineStrategy.run({
    rows: corpus.rows, topK: 6, perRefCap: 2,
    query: corpus.queries.find(q => q.id === 'q-same-name-filter')!,
  })
  ok('🔴 ② 只看设定时不得召回知识库里的同名条目',
    settingOnly.length > 0 && settingOnly.every(h => h.kind === 'setting'),
    JSON.stringify(settingOnly.map(h => `${h.kind}:${h.refId}`)))

  const kbQuery = corpus.queries.find(q => q.id === 'q-same-name-kb')!
  // 生产实现（修正后）
  const prodKb = await productionDefaultStrategy.run({ rows: corpus.rows, topK: 6, perRefCap: 2, query: kbQuery })
  ok('🔴 ② 只看知识库时不得召回设定表的同名条目（不泄漏）',
    prodKb.every(h => h.kind === 'kb'), JSON.stringify(prodKb.map(h => `${h.kind}:${h.refId}`)))
  ok('🔴 ② 修正后按用途收窄仍能召回（这是 G 查出来的真 bug）',
    prodKb.some(h => h.refId === 'kb-玄天宗note'), `生产=${prodKb.length} 条`)

  // 🔴 旧口径在同一查询上是 **0 条**：按用途把候选收窄到 1 条后，IDF 的 N 变成 1，
  //    覆盖率整体塌到 0.1 阈值以下 —— 界面表现成「没有相关材料」，作者看不出是过滤太紧。
  const legacyKb = await baselineStrategy.run({ rows: corpus.rows, topK: 6, perRefCap: 2, query: kbQuery })
  ok('② 基线复刻确实重现了旧口径的漏检（对照不是自己比自己）', legacyKb.length === 0,
    JSON.stringify(legacyKb.map(h => h.refId)))

  const anchored = await baselineStrategy.run({
    rows: corpus.rows, topK: 6, perRefCap: 2,
    query: corpus.queries.find(q => q.id === 'q-anchor-filter')!,
  })
  ok('② 章节锚点白名单生效（只返回该章）',
    anchored.length > 0 && anchored.every(h => h.kind !== 'chapter' || h.refId === 'ch-3'),
    JSON.stringify(anchored.map(h => `${h.kind}:${h.refId}`)))

  const excluded = await baselineStrategy.run({
    rows: corpus.rows, topK: 6, perRefCap: 2,
    query: corpus.queries.find(q => q.id === 'q-exclude-focus')!,
  })
  ok('② 排除焦点章生效（结果里没有 ch-1）', excluded.every(h => h.refId !== 'ch-1'),
    JSON.stringify(excluded.map(h => h.refId)))
}

// ---------- ③ 空结果 ----------
{
  const corpus = buildSyntheticCorpus()
  const q = corpus.queries.find(x => x.id === 'q-empty')!
  const hits = await baselineStrategy.run({ rows: corpus.rows, topK: 6, perRefCap: 2, query: q })
  ok('🔴 ③ 没有相关材料时返回空（不硬凑）', hits.length === 0, JSON.stringify(hits.map(h => h.refId)))
}

// ---------- ④ 引用定位 + 预算 ----------
{
  const corpus = buildSyntheticCorpus()
  const known = new Set(corpus.rows.map(r => `${r.kind}::${r.refId}`))
  const strategies = [baselineStrategy, titleBoostStrategy(), bm25Strategy()]
  let unlocatable = 0
  for (const st of strategies) {
    for (const q of corpus.queries) {
      const hits = await st.run({ rows: corpus.rows, query: q, topK: 6, perRefCap: 2 })
      unlocatable += hits.filter(h => !known.has(`${h.kind}::${h.refId}`)).length
    }
  }
  ok('🔴 ④ 所有策略的命中都能定位到语料里真实的一块', unlocatable === 0, String(unlocatable))

  // 预算：同一来源最多 2 块；总数不超过 topK
  const multi = buildSyntheticCorpus({ bulk: 0 })
  // 造一个同来源多块的场景
  const rows = [...multi.rows]
  rows.push({ ...multi.rows[0], chunkIdx: 1, id: `${multi.rows[0].id}-1` })
  rows.push({ ...multi.rows[0], chunkIdx: 2, id: `${multi.rows[0].id}-2` })
  rows.push({ ...multi.rows[0], chunkIdx: 3, id: `${multi.rows[0].id}-3` })
  const q = multi.queries.find(x => x.id === 'q-short-word')!
  for (const st of strategies) {
    const hits = await st.run({ rows, query: q, topK: 3, perRefCap: 2 })
    const perRef = new Map<string, number>()
    for (const h of hits) perRef.set(h.refId, (perRef.get(h.refId) ?? 0) + 1)
    ok(`④ ${st.id}：单来源不超过 perRefCap 且总数不超 topK`,
      [...perRef.values()].every(n => n <= 2) && hits.length <= 3, JSON.stringify([...perRef]))
  }
}

// ---------- ⑤ 报告口径 ----------
{
  const corpus = buildSyntheticCorpus()
  const report = await runRetrievalBench(corpus, {
    strategies: [baselineStrategy, productionDefaultStrategy, titleBoostStrategy(), bm25Strategy()],
  })
  ok('⑤ 每个策略都给出召回/精确/噪声/MRR/延迟', report.strategies.every(s =>
    typeof s.recall === 'number' && typeof s.precision === 'number'
    && typeof s.noise === 'number' && typeof s.mrr === 'number' && typeof s.p50Ms === 'number'))
  ok('⑤ noise === 1 - precision（口径自洽）',
    report.strategies.every(s => Math.abs(s.noise - (1 - s.precision)) < 1e-9))
  ok('⑤ 报告标注确定性', report.deterministic === true)
  ok('🔴 ⑤ 没混入别项目行时，foreignLeaks 缺省（不写成 0 冒充「测过」）',
    report.foreignLeaks === undefined)
  ok('⑤ 平均字数分母是全部查询（不是只算有标注的）',
    Math.abs((report.strategies[0].avgChars * corpus.queries.length)
      - report.strategies[0].outcomes.reduce((n, o) => n + o.chars, 0)) < 1e-6)
  ok('⑤ 语料统计给出存储口径（文本字节 + 向量估算函数）',
    report.corpus.textBytes > 0 && report.corpus.vectorBytesIfDim(768) === 768 * 4 * report.corpus.chunks)
  ok('⑤ 基线能召回短词跨章（recall > 0）',
    (report.strategies.find(s => s.id === 'baseline')?.recall ?? 0) > 0)

  const base = report.strategies.find(s => s.id === 'baseline')!
  const boost = report.strategies.find(s => s.id.startsWith('title-boost'))!
  const bm25 = report.strategies.find(s => s.id.startsWith('bm25'))!
  console.log('\n【对照结果（合成语料）】')
  const prodDefault = report.strategies.find(s => s.id === 'production-default')!
  for (const s of [base, prodDefault, boost, bm25]) {
    console.log(`  ${s.label}`)
    console.log(`    recall ${(s.recall * 100).toFixed(1)}% · precision ${(s.precision * 100).toFixed(1)}%`
      + ` · MRR ${s.mrr.toFixed(3)} · 空结果正确 ${(s.emptyAccuracy * 100).toFixed(0)}%`
      + ` · 平均 ${Math.round(s.avgChars)} 字 · p50 ${s.p50Ms.toFixed(1)}ms`)
  }
  ok('⑤ 四个策略都跑出了结果', report.strategies.length === 4)

  // 🔴 生产默认（修正后）必须与基线（旧口径）至少在一处不同，否则「修了」只是说法
  let fixedSomething = false
  for (const q of corpus.queries) {
    const a = await baselineStrategy.run({ rows: corpus.rows, query: q, topK: 6, perRefCap: 2 })
    const b = await productionDefaultStrategy.run({ rows: corpus.rows, query: q, topK: 6, perRefCap: 2 })
    if (a.map(h => `${h.kind}:${h.refId}:${h.chunkIdx}`).join(',')
      !== b.map(h => `${h.kind}:${h.refId}:${h.chunkIdx}`).join(',')) fixedSomething = true
  }
  ok('🔴 ⑤ 生产默认与旧口径确实不同（修正已生效，不是空谈）', fixedSomething)

  // 生产默认必须比旧口径召回更多（这是修 IDF 口径的直接效果）
  const prod = report.strategies.find(s => s.id === 'production-default')
  if (prod) {
    ok('🔴 ⑤ 生产默认召回 ≥ 旧口径（修正带来实际收益）', prod.recall >= base.recall,
      `${prod.recall.toFixed(3)} vs ${base.recall.toFixed(3)}`)
  } else {
    ok('⑤ 报告中含生产默认策略', false)
  }
}

// ---------- ⑥ 跨项目隔离（纵深防御） ----------
{
  const corpus = buildSyntheticCorpus()
  const leaks = await probeForeignLeak(corpus, corpus.projectId)
  // 现状：生产靠 loader 的项目分区过滤；召回层自己没有项目校验。
  // 这里记录实测值——>0 说明「loader 一旦出偏差就会串味」，是应该补的一道闸。
  console.log(`\n【跨项目隔离】混入别项目行后，召回交出的别项目命中：${leaks}`)
  ok('⑥ 探查函数可运行并给出数字', typeof leaks === 'number')
  const leaked = await runRetrievalBench(corpus, {
    strategies: [baselineStrategy, productionDefaultStrategy],
    includeForeignRows: true,
  })
  ok('🔴 ⑥ 混入别项目行时才计算串味，且给出真实数字（不是写死 0）',
    typeof leaked.foreignLeaks === 'number', String(leaked.foreignLeaks))
  const leakProd = leaked.strategies.find(x => x.id === 'production-default')?.foreignLeaks
  const leakBase = leaked.strategies.find(x => x.id === 'baseline')?.foreignLeaks
  ok('🔴 ⑥ 生产默认在混入别项目行时一条都不交（项目校验生效）', leakProd === 0, `prod=${leakProd}`)
  ok('⑥ 旧口径会交（说明这道闸不是摆设）', (leakBase ?? 0) > 0, `base=${leakBase}`)
  ok('🔴 ⑥ 别项目内容不得被召回（纵深防御）', leaks === 0, `leaks=${leaks}`)
}

// ---------- ⑦-b 短词查询（只查一个专名） ----------
{
  const corpus = buildSyntheticCorpus()
  // 只查「玉牌」—— 一个二元词。旧口径固定要求 2 个二元命中，物理上过不去 ⇒ 永远空。
  const oneWord = await productionDefaultStrategy.run({
    rows: corpus.rows, topK: 6, perRefCap: 2,
    query: { id: 'q-one-word', text: '玉牌', expectRefIds: [], note: '单专名查询' },
  })
  ok('🔴 ⑦-b 只查一个专名也能召回（不再被「2 个二元命中」卡死）', oneWord.length > 0,
    JSON.stringify(oneWord.map(h => h.refId)))
  ok('⑦-b 召回的都是真的提到该专名的块',
    oneWord.every(h => /玉牌/.test(h.text)), JSON.stringify(oneWord.map(h => h.refId)))

  // 纯单字查询没有检索意义：直接返回空，不进噪声
  const oneChar = await productionDefaultStrategy.run({
    rows: corpus.rows, topK: 6, perRefCap: 2,
    query: { id: 'q-one-char', text: '的', expectRefIds: [], note: '单字查询' },
  })
  ok('⑦-b 纯单字查询返回空（不制造噪声）', oneChar.length === 0, String(oneChar.length))

  // 多词查询不放宽：仍然要求 2 个二元命中
  const twoWords = await productionDefaultStrategy.run({
    rows: corpus.rows, topK: 6, perRefCap: 2,
    query: { id: 'q-two', text: '玉牌 玄字', expectRefIds: [], note: '两个专名' },
  })
  ok('⑦-b 多词查询仍是「两个词都要沾」（精度不放宽）',
    twoWords.every(h => /玉牌/.test(h.text) && /玄/.test(h.text)),
    JSON.stringify(twoWords.map(h => h.refId)))
}

// ---------- ⑧ 来源删除与重建 ----------
{
  const corpus = buildSyntheticCorpus()
  const q = corpus.queries.find(x => x.id === 'q-short-word')!
  const before = await productionDefaultStrategy.run({ rows: corpus.rows, query: q, topK: 6, perRefCap: 2 })
  ok('⑧ 正常语料里能召回 ch-3', before.some(h => h.refId === 'ch-3'))

  // 删掉来源（模拟删除章节 / 条目后索引块被清理）
  const removed = corpus.rows.filter(r => r.refId !== 'ch-3')
  const afterDelete = await productionDefaultStrategy.run({ rows: removed, query: q, topK: 6, perRefCap: 2 })
  ok('🔴 ⑧ 来源删除后不再召回它（不会凭缓存硬凑）', afterDelete.every(h => h.refId !== 'ch-3'),
    JSON.stringify(afterDelete.map(h => h.refId)))

  // 重建（重新写入同样的块）⇒ 恢复召回
  const rebuilt = await productionDefaultStrategy.run({ rows: corpus.rows, query: q, topK: 6, perRefCap: 2 })
  ok('⑧ 重建后恢复召回（索引是可重建派生数据）', rebuilt.some(h => h.refId === 'ch-3'))
}

// ---------- ⑨ 大型项目耗时 ----------
{
  const corpus = buildSyntheticCorpus({ bulk: 2000 })
  const t0 = performance.now()
  const report = await runRetrievalBench(corpus, {
    strategies: [baselineStrategy, productionDefaultStrategy],
  })
  const total = performance.now() - t0
  const prod = report.strategies.find(s => s.id === 'production-default')!
  const base = report.strategies.find(s => s.id === 'baseline')!
  console.log(`\n【大型项目】${corpus.stats.chunks} 块 / ${corpus.stats.chars} 字`
    + ` · 生产 p50 ${prod.p50Ms.toFixed(1)}ms p95 ${prod.p95Ms.toFixed(1)}ms`
    + ` · 旧口径 p50 ${base.p50Ms.toFixed(1)}ms p95 ${base.p95Ms.toFixed(1)}ms`
    + ` · 全量评测 ${(total / 1000).toFixed(2)}s`)
  ok('⑨ 2000 块规模下单次召回仍在交互可接受范围（p95 < 500ms）', prod.p95Ms < 500, `${prod.p95Ms.toFixed(1)}ms`)
  ok('⑨ 生产口径没有比旧口径慢一个量级（p95 < 旧口径 × 5）',
    prod.p95Ms < Math.max(50, base.p95Ms * 5), `${prod.p95Ms.toFixed(1)} vs ${base.p95Ms.toFixed(1)}`)
  ok('⑨ 大语料下空结果查询仍然老实返回空',
    prod.emptyAccuracy === 1 && base.emptyAccuracy === 1)
}

// ---------- ⑦ 源码闸：G 不替换生产引擎 ----------
{
  const bench = read('src/lib/retrieval/bench.ts')
  ok('⑦ 评测层确实调用生产实现（生产默认策略走真代码）',
    /keywordRecallRelevant\(/.test(bench) && /productionDefaultStrategy/.test(bench))
  ok('⑦ 基线是**旧口径的本地复刻**并写明了两处差异（IDF 口径 / 项目校验）',
    /IDF 的 df\/N 算在\*\*过滤后的候选集\*\*上/.test(bench))
  ok('⑦ 评测层不写库、不改索引（纯读）', !/ops\.put|saveChapter|saveTableRow|saveCardRecord/.test(bench))
  const synth = read('src/lib/retrieval/synthetic.ts')
  ok('⑦ 合成语料不读用户数据（无 db / 无 fetch）', !/from '@\/lib\/db|fetch\(/.test(synth))
}

console.log(`\n———— retrievalBench：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
