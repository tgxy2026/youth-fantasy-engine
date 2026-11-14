// ============ 语义检索 · 嵌入不可用时的关键词降级（3.5.5）============
//
// 背景：ACP 模式下所有模型请求都经 Agent，引擎**发不出** `/embeddings` 请求。
// 在加降级之前，这里的表现是「界面说语义检索就绪 / 注入里永远没有召回段」——
// 作者无法分辨是「库里没相关内容」还是「这个模式根本做不了」。
//
// 本用例盯五件事：
//   ① 能力探测只此一处（语义 / 关键词 / 关闭三态，ACP 一定降级）；
//   ② `keywordRecallRelevant` 在**同一道权限闸**下工作（S 级 / 焦点章 / 来源白名单）；
//   ③ 降级路径**不需要 cfg**（否则 ACP 用户即便有索引也永远拿不到召回段）；
//   ④ 分数名与表头必须说实话（「相似度」→「匹配度」），不能给虚假置信；
//   ⑤ 自动索引在 ACP 下早退（否则每次保存都白跑一遍注定失败的流程）。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { hashOf, toVectorBuffer } from '../src/lib/semantic/chunk'
import { makeVecRow, type VecRow, type VecIndex } from '../src/lib/semantic/store'
import { keywordRecallRelevant } from '../src/lib/semantic/recall'
import { renderRecallHits, buildSemanticRecallBlock } from '../src/lib/semantic/inject'
import { semanticCapability, __resetSemanticCapabilityCache } from '../src/lib/semantic/capability'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
function read(rel: string): string {
  try { return readFileSync(path.join(process.cwd(), rel), 'utf8') } catch { return '' }
}

interface RowInput {
  refId: string
  chunkIdx?: number
  text: string
  kind?: 'chapter' | 'setting' | 'summary' | 'kb' | 'tavern'
  title?: string
  secret?: boolean
  projectId?: string
}

function row(input: RowInput): VecRow {
  return makeVecRow({
    projectId: input.projectId ?? 'p1',
    kind: input.kind ?? 'chapter',
    refId: input.refId,
    chunkIdx: input.chunkIdx ?? 0,
    text: input.text,
    title: input.title ?? '某章',
    hash: hashOf(input.text),
    vec: toVectorBuffer([1, 0]),
    dim: 2,
    model: 'm',
    secret: input.secret ?? false,
  })
}

function idxOf(rows: VecRow[]): VecIndex {
  const hashes = new Map<string, string>()
  const refs = new Set<string>()
  for (const r of rows) {
    hashes.set(`${r.refId}#${r.chunkIdx}`, r.hash)
    refs.add(r.refId)
  }
  return { hashes, refs }
}

function fakeStore(rows: VecRow[]) {
  return {
    loadFn: async () => rows,
    indexFn: async (): Promise<VecIndex> => idxOf(rows),
  }
}

async function main() {
  // ---------------------------------------------------------------- 1. 能力探测
  console.log('--- 1. 能力探测（唯一判据所在）---')
  {
    // Node 测试环境没有 window ⇒ WEB / DESKTOP / PORTABLE 全 false ⇒ 不判 ACP，按语义处理
    __resetSemanticCapabilityCache()
    const cap = await semanticCapability()
    ok('无本机模式宿主 ⇒ 视为语义可用', cap.mode === 'semantic' && cap.byAcp === false && cap.reason === '', JSON.stringify(cap))

    const src = read('src/lib/semantic/capability.ts')
    ok('能力探测对 ACP 明确降级', /mode === 'acp'[\s\S]{0,200}mode: 'keyword'/.test(src))
    ok('ACP 降级说明里提示可以切回 API 模式', src.includes('切回 API 模式可恢复完整召回'))
    ok('模式未就绪时保守降级（不假装语义可用）', src.includes("st.phase !== 'stable'") && src.includes("mode: 'keyword'"))
    ok('读模式失败时也降级（探针绝不抛）', src.includes('读不到当前连接模式'))

    // 缓存：同一时刻连问两次只探一次（便携版的模式查询是一次 HTTP 往返）
    const a1 = await semanticCapability()
    const a2 = await semanticCapability()
    ok('🔴 探测结果有短 TTL 缓存（同一轮不重复打模式接口）', a1 === a2, '应为同一对象引用')
    __resetSemanticCapabilityCache()
    const a3 = await semanticCapability()
    ok('清缓存后重新探测（避免用例间污染）', a3 !== a1)
    ok('缓存 TTL 有上限（切模式后不会长期停在旧判据）', /CACHE_TTL_MS\s*=\s*\d{3,4}/.test(src))
  }

  // ---------------------------------------------------------------- 2. 关键词召回：能力与边界
  console.log('--- 2. 关键词召回：能命中什么、命中不了什么 ---')
  {
    const rows = [
      row({ refId: 'c1', text: '林昭握紧断剑，剑锋上的裂纹在月光下泛着冷光。他知道这一剑若递出去，便再无回头路。' }),
      row({ refId: 'c2', text: '苏婉在药庐里煎药，炉火映着她的侧脸。她听见院外脚步，手一抖，药汁洒在袖口。' }),
      row({ refId: 'c3', text: '断剑归鞘，林昭回头看了一眼山门，终于没有再说话。' }),
    ]
    const store = fakeStore(rows)

    const byWord = await keywordRecallRelevant('林昭 断剑 裂纹', { projectId: 'p1', ...store })
    ok('用词相同 ⇒ 能召回（c1 排第一）', byWord.length >= 1 && byWord[0].refId === 'c1', JSON.stringify(byWord.map(h => [h.refId, h.score.toFixed(3)])))
    ok('不相关的 c2 不被召回', !byWord.some(h => h.refId === 'c2'), JSON.stringify(byWord.map(h => h.refId)))

    // 这是降级的**已知代价**，必须钉住：语义能中、关键词不能中
    const paraphrase = await keywordRecallRelevant('他攥着那把残刃，心里明白一旦出手就完了', { projectId: 'p1', ...store })
    ok('🔴 换种说法就召回不到（降级的真实代价，如实承认）', paraphrase.length === 0, JSON.stringify(paraphrase.map(h => h.refId)))

    // 只命中单字不算命中（「的」「了」满篇都是）
    const stopwordsOnly = await keywordRecallRelevant('的了是在这那', { projectId: 'p1', ...store })
    ok('🔴 只命中单字/虚词 ⇒ 不入选（bigram 门槛）', stopwordsOnly.length === 0, JSON.stringify(stopwordsOnly.map(h => [h.refId, h.score])))

    const empty = await keywordRecallRelevant('   ', { projectId: 'p1', ...store })
    ok('空查询 ⇒ 空结果', empty.length === 0)
  }

  // ---------------------------------------------------------------- 3. 权限闸与语义路径同源
  console.log('--- 3. 权限闸：降级不许绕过任何一条 ---')
  {
    const rows = [
      row({ refId: 'c1', text: '断剑归鞘，林昭没有说话。' }),
      row({ refId: 'c2', text: '断剑归鞘，苏婉也没有说话。', secret: true }),
      row({ refId: 'c3', text: '断剑归鞘，长老沉默良久。' }),
      row({ refId: 't1', text: '断剑归鞘，这一句来自别的会话。', kind: 'tavern' }),
    ]
    const store = fakeStore(rows)

    const all = await keywordRecallRelevant('断剑归鞘 说话', { projectId: 'p1', ...store })
    ok('不设闸时三条章节都进候选', all.some(h => h.refId === 'c1') && all.some(h => h.refId === 'c2'), JSON.stringify(all.map(h => h.refId)))

    const hideSecret = await keywordRecallRelevant('断剑归鞘 说话', { projectId: 'p1', hideSecretRows: true, ...store })
    ok('🔴 角色视角下 S 级块被剔除（与语义路径同一道闸）', !hideSecret.some(h => h.refId === 'c2'), JSON.stringify(hideSecret.map(h => h.refId)))

    const exclude = await keywordRecallRelevant('断剑归鞘 说话', { projectId: 'p1', excludeRefIds: new Set(['c1']), ...store })
    ok('焦点章自己不自召回（excludeRefIds）', !exclude.some(h => h.refId === 'c1'))

    const allow = await keywordRecallRelevant('断剑归鞘 说话', { projectId: 'p1', allowRefIds: new Set(['t1']), ...store })
    ok('来源白名单生效（自由对话只本场）', allow.length > 0 && allow.every(h => h.refId === 't1'), JSON.stringify(allow.map(h => h.refId)))

    const kinds = await keywordRecallRelevant('断剑归鞘 说话', { projectId: 'p1', kinds: ['chapter'], ...store })
    ok('类别白名单生效', kinds.every(h => h.kind === 'chapter'))

    const src = read('src/lib/semantic/recall.ts')
    ok('🔴 两条路径共用同一份 passesFilters（不会各写一份漂移）',
      (src.match(/passesFilters\(/g) ?? []).length >= 3)
    ok('🔴 关键词路径不看 r.dim（降级时不用向量）', src.includes('// 关键词路径**不看 `r.dim`**'))
  }

  // ---------------------------------------------------------------- 4. 永不抛 / 空索引零开销
  console.log('--- 4. 永不抛、空索引零开销 ---')
  {
    const noIndex = await keywordRecallRelevant('断剑', {
      projectId: 'p1',
      loadFn: async () => { throw new Error('不该被调用') },
      indexFn: async (): Promise<VecIndex> => ({ hashes: new Map(), refs: new Set() }),
    })
    ok('🔴 索引为空 ⇒ 空串且**不读全量向量**（与语义路径同序）', noIndex.length === 0)

    const brokenLoad = await keywordRecallRelevant('断剑归鞘', {
      projectId: 'p1',
      ...fakeStore([row({ refId: 'c1', text: '断剑归鞘' })]),
      loadFn: async () => { throw new Error('库坏了') },
    })
    ok('读向量失败 ⇒ 返回空数组，不抛', brokenLoad.length === 0)

    const brokenIndex = await keywordRecallRelevant('断剑归鞘', {
      projectId: 'p1',
      ...fakeStore([row({ refId: 'c1', text: '断剑归鞘' })]),
      indexFn: async () => { throw new Error('游标坏了') },
    })
    ok('读游标失败 ⇒ 返回空数组，不抛', brokenIndex.length === 0)

    const aborted = new AbortController()
    aborted.abort()
    const cancelled = await keywordRecallRelevant('断剑归鞘', {
      projectId: 'p1', signal: aborted.signal, ...fakeStore([row({ refId: 'c1', text: '断剑归鞘' })]),
    })
    ok('已取消 ⇒ 空数组（不返回半份结果）', cancelled.length === 0)
  }

  // ---------------------------------------------------------------- 5. 降级路径不需要 cfg
  console.log('--- 5. 降级不依赖嵌入配置 ---')
  {
    const cap = { mode: 'keyword' as const, label: '关键词降级', reason: 'ACP 模式下…', byAcp: true }
    let resolveCalled = false
    let keywordCalled = 0

    const block = await buildSemanticRecallBlock({
      projectId: 'p1', focusChapterId: 'c1',
      deps: {
        capability: async () => cap,
        // 🔴 关键：即便嵌入配置是 null，降级路径也必须能出结果
        resolveConfig: async () => { resolveCalled = true; return null },
        loadChapters: async () => [{ id: 'c1', title: '断剑', summary: '', content: '林昭握着断剑，剑锋裂纹泛着冷光。' }],
        keywordRecall: async (_q, opts) => {
          keywordCalled++
          // 焦点章不自召回这条语义必须仍然成立
          if (opts.excludeRefIds?.has('c1')) return []
          return []
        },
        filterHits: async hits => hits,
      },
    })
    ok('降级路径能出结果（不因缺嵌入配置早退）', block === '')
    ok('🔴 降级时不读嵌入配置（resolveConfig 未被调用）', resolveCalled === false)
    ok('降级时走的是 keywordRecall', keywordCalled === 1)

    let captured: { header: string; scoreLabel: string } | null = null
    const rendered = await buildSemanticRecallBlock({
      projectId: 'p1', focusChapterId: 'c1',
      deps: {
        capability: async () => cap,
        resolveConfig: async () => null,
        loadChapters: async () => [{ id: 'c1', title: '断剑', summary: '', content: '林昭握着断剑。' }],
        keywordRecall: async () => ([{ kind: 'chapter' as const, refId: 'c9', chunkIdx: 0, text: '断剑归鞘', title: '第九章', score: 0.21, secret: false }]),
        filterHits: async hits => hits,
      },
    })
    captured = rendered.includes('匹配度') ? { header: 'ok', scoreLabel: '匹配度' } : null
    ok('🔴 降级段标的分数名是「匹配度」而不是「相似度」', rendered.includes('匹配度 0.21') && !rendered.includes('相似度'), rendered.slice(0, 120))
    ok('🔴 降级段表头明说「关键词降级、只命中用词相近」',
      rendered.includes('字面用词') && rendered.includes('关键词降级'), rendered.slice(0, 160))
    ok('降级段仍带来源标题与正文片段', rendered.includes('第九章') && rendered.includes('断剑归鞘'))
    ok('渲染分支确实按降级选用（captured 非空）', captured !== null)

    // capability = off ⇒ 直接空串，连章节都不读
    let loaded = false
    const off = await buildSemanticRecallBlock({
      projectId: 'p1', focusChapterId: 'c1',
      deps: {
        capability: async () => ({ mode: 'off' as const, label: '不可用', reason: 'x', byAcp: false }),
        loadChapters: async () => { loaded = true; return [] },
      },
    })
    ok('capability=off ⇒ 空串且不读库', off === '' && loaded === false)
  }

  // ---------------------------------------------------------------- 6. 语义路径行为未被改动
  console.log('--- 6. 语义路径回归（不能被降级改动带偏）---')
  {
    const cap = { mode: 'semantic' as const, label: '语义检索', reason: '', byAcp: false }
    let embedUsed = 0
    const block = await buildSemanticRecallBlock({
      projectId: 'p1', focusChapterId: 'c1',
      deps: {
        capability: async () => cap,
        resolveConfig: async () => ({ type: 'openai', baseUrl: 'http://x', apiKey: '', model: 'm', headers: {} }),
        loadChapters: async () => [{ id: 'c1', title: '断剑', summary: '', content: '林昭握着断剑。' }],
        recall: async (_q, opts) => { embedUsed++; ok('语义路径照旧传 cfg', !!opts.cfg && opts.cfg.model === 'm'); return [] },
        filterHits: async hits => hits,
      },
    })
    ok('语义路径仍走 recallRelevant', embedUsed === 1)
    ok('无命中 ⇒ 空串（与原行为一致）', block === '')

    // 未配嵌入模型 ⇒ 语义路径仍早退（不降级、不硬撑）
    let called = false
    const noCfg = await buildSemanticRecallBlock({
      projectId: 'p1', focusChapterId: 'c1',
      deps: {
        capability: async () => cap,
        resolveConfig: async () => null,
        recall: async () => { called = true; return [] },
      },
    })
    ok('🔴 语义模式下未配嵌入模型 ⇒ 空串且不召回（不擅自降级）', noCfg === '' && called === false)

    // 分数名可换（渲染层唯一出口）
    const hit = { kind: 'chapter' as const, refId: 'c1', chunkIdx: 0, text: '正文', title: '第一章', score: 0.42, secret: false }
    ok('默认渲染写「相似度」', renderRecallHits([hit]).includes('相似度 0.42'))
    ok('可换成「匹配度」', renderRecallHits([hit], '（表头）', '匹配度').includes('匹配度 0.42'))
  }

  // ---------------------------------------------------------------- 7. 自动索引在 ACP 下早退
  console.log('--- 7. 自动索引不在 ACP 下白跑 ---')
  {
    const src = read('src/lib/semantic/indexer.ts')
    ok('🔴 autoIndexChapter 在非语义模式下早退', /cap\.mode !== 'semantic'\)\s*return/.test(src))
    ok('自动索引早退发生在读嵌入配置之前（省掉一次无用的配置解析）',
      src.indexOf("cap.mode !== 'semantic'") < src.indexOf('resolveConfig ?? resolveEmbedConfig'))

    /**
     * 🔴 2026-11-14 真机发现的告知缺口：`AIConfigPanel` 是**按模式切换整块内容**的，
     *    ACP 模式下「模型配置」（含 EmbeddingIndexPanel）整个不渲染 ——
     *    降级提示原本只写在那块里，等于**作者永远看不到**，而降级恰恰只发生在 ACP。
     *    所以 ACP 分支必须单独挂一个提示块。
     */
    const cfgPanel = read('src/components/settings/AIConfigPanel.tsx')
    ok('🔴 ACP 分支单独挂了语义降级提示（否则提示落在永不渲染的区块里）',
      cfgPanel.includes('AcpSemanticNotice'))
    const notice = read('src/components/settings/AcpSemanticNotice.tsx')
    ok('🔴 提示块只在 keyword（降级）时渲染，其余模式不打扰',
      notice.includes("cap.mode !== 'keyword'") && notice.includes('return null'))
    ok('提示块写明可恢复方式（切回 API 模式重建索引）', notice.includes('切回 API 模式重建一次索引'))
    ok('提示块说明分数名会变成「匹配度」（与注入段一致）', notice.includes('匹配度'))

    const panel = read('src/components/settings/EmbeddingIndexPanel.tsx')
    ok('设置面板读取能力探测', panel.includes('semanticCapability'))
    ok('🔴 降级时建索引按钮置灰（不让作者点了才发现不能跑）', panel.includes('const embedBlocked = cap != null && cap.mode !== \'semantic\''))
    ok('降级时面板写明原因与恢复方式', panel.includes('重建索引需要先切回 API 模式'))
  }

  console.log(`\n=== semanticFallback：${pass} passed, ${fail} failed ===`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
