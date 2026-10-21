// ============ 语义检索 / 向量 RAG（2.8.0 · 台账 #013）============
//
// 本用例盯六件事（对齐方案 §1.7，并补齐实现里新增的编排逻辑）：
//   ① `cosine` 边界（正交 = 0、同向 = 1、**零向量不 NaN**）；
//   ② `chunkChapter`：覆盖完整、不产空块、相邻块重叠、超长单段不丢内容；
//   ③ `hashOf` 稳定，内容一变 hash 就变（增量判据的地基）；
//   ④ 🔴🔴 **D 级内容不进任何块；S 级打标记、角色视角不召回** ——
//      这是全模块最重要的一条，附**源码断言**钉住"剔除必须早于切块"；
//   ⑤ `recallRelevant` 全路径不抛，且索引为空时**零嵌入请求**；
//   ⑥ `rebuildIndex` 的增量跳过 / 孤儿清理 / 失败收敛。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  chunkChapter, hashOf, vectorRowId, chunkKey, toVectorBuffer, fromVectorBuffer,
  CHUNK_TARGET, CHUNK_OVERLAP,
} from '../src/lib/semantic/chunk'
import { cosine, recallRelevant, checkIndexFreshness, type RecallHit } from '../src/lib/semantic/recall'
import {
  embedPath, embedBaseOf, embedConfigError, buildEmbedRequest, parseEmbedResponse,
  embedTexts, EMBED_BATCH,
} from '../src/lib/semantic/embed'
import {
  summarize, setVecBackend, refKeyOf, splitRefKey, makeVecRow,
  loadVectors, putVectors, removeByRef, clearProjectVectors, vectorStats, vectorIndex,
  type VecBackend, type VecRow, type VecBasis,
} from '../src/lib/semantic/store'
import { filterRecallHitsByPermission } from '../src/lib/semantic/gate'
import { loadFieldRules, type FieldRules } from '../src/lib/semantic/fieldRules'
import { __resetTemplateCacheForTests } from '../src/lib/templates/cache'
import type { IndexFieldRule } from '../src/lib/templates/consumers'
import type { TemplateDef } from '../src/lib/templates/definition'
import type { FieldDefinitionDoc } from '../src/lib/templates/fieldDefinition'
import { TABS } from '../src/lib/schema'
import {
  collectIndexDocs, rebuildIndex, indexStatus, indexOneDoc, autoIndexChapter,
  chapterIndexText, chapterFingerprint, type IndexDoc, type AutoIndexDeps,
} from '../src/lib/semantic/indexer'
import { focusQueryOf, renderRecallHits, buildSemanticRecallBlock } from '../src/lib/semantic/inject'
import {
  normalizeEmbeddingSettings, resolveEmbedConfig, embeddingStatus, DEFAULT_EMBEDDING,
} from '../src/lib/semantic/settings'
import type { AIProvider } from '../src/lib/ai'
import type { EmbedConfig } from '../src/lib/semantic/embed'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
function read(rel: string): string {
  try { return readFileSync(path.join(process.cwd(), rel), 'utf8') } catch { return '' }
}

const f32 = (nums: number[]): Float32Array => Float32Array.from(nums)
const buf = (nums: number[]): ArrayBuffer => toVectorBuffer(Float32Array.from(nums))

const CFG: EmbedConfig = { type: 'ollama', baseUrl: 'http://localhost:11434', model: 'nomic-embed-text' }

// ============ ① cosine 边界 ============
{
  ok('cosine 同向 = 1', Math.abs(cosine(f32([1, 2, 3]), f32([2, 4, 6])) - 1) < 1e-6)
  ok('cosine 正交 = 0', Math.abs(cosine(f32([1, 0]), f32([0, 1]))) < 1e-6)
  ok('cosine 反向 = -1', Math.abs(cosine(f32([1, 2]), f32([-1, -2])) + 1) < 1e-6)

  const zero = cosine(f32([0, 0, 0]), f32([1, 2, 3]))
  ok('cosine 零向量不 NaN（返回 0）', zero === 0 && !Number.isNaN(zero))

  const zeroBoth = cosine(f32([0, 0]), f32([0, 0]))
  ok('cosine 双零向量返回 0', zeroBoth === 0)

  ok('cosine 长度不等不崩（按短的一侧算）', Number.isFinite(cosine(f32([1, 1]), f32([1, 1, 1]))))
  ok('cosine 空向量返回 0', cosine(f32([]), f32([])) === 0)
}

// ============ ② chunkChapter ============
{
  ok('chunk 空串 → []', chunkChapter('').length === 0)
  ok('chunk 全空白 → []', chunkChapter('   \n\n  \t ').length === 0)

  const short = '他从巷口走进来，身上带着雨气。'
  const one = chunkChapter(short)
  ok('chunk 短文本 → 1 块且逐字保留', one.length === 1 && one[0].text === short && one[0].idx === 0)

  // 5 段 × 100 字 ≈ 500 字 ⇒ 应切成 2 块（target = 400）
  const paras = Array.from({ length: 5 }, (_, i) => `第${i + 1}段${'字'.repeat(96)}`)
  const longText = paras.join('\n')
  const many = chunkChapter(longText)

  ok('chunk 长文本切成多块', many.length >= 2)
  ok('chunk idx 从 0 起连续', many.every((c, i) => c.idx === i))
  ok('chunk 无空块', many.every(c => c.text.trim().length > 0))
  ok('chunk 单块不超 target 太多', many.every(c => c.text.length <= CHUNK_TARGET * 1.2), `实际：${many.map(c => c.text.length).join(',')}`)

  // 覆盖完整：每个非空段落都应被某个块包含（段落 ≤ target 时不被硬切）
  const covered = paras.every(p => many.some(c => c.text.includes(p)))
  ok('chunk 覆盖完整（每段都出现在某块里）', covered)

  // 重叠：后一块的开头来自前一块的结尾
  const overlapped = many.length > 1 && many[0].text.includes(many[1].text.slice(0, 12))
  ok('chunk 相邻块有重叠', overlapped)

  // 超长单段必须硬切，不能整段被丢掉
  const huge = '超'.repeat(CHUNK_TARGET * 3 + 37)
  const cut = chunkChapter(huge)
  ok('chunk 超长单段被硬切且不丢内容', cut.length >= 3 && cut.map(c => c.text).join('').replace(/\n/g, '').length >= huge.length)

  // 参数钳制：overlap 不得超过 target 的一半（否则块永远推进不了）
  const clamped = chunkChapter(longText, { target: 100, overlap: 999 })
  ok('chunk overlap 被钳制到 target 的一半内', clamped.length >= 2 && clamped.length < 50)

  const emptyTarget = chunkChapter(short, { target: 0, overlap: -5 })
  ok('chunk target / overlap 非法值被兜住', emptyTarget.length === 1)

  ok('CHUNK_TARGET / OVERLAP 是正数且重叠小于目标', CHUNK_TARGET > 0 && CHUNK_OVERLAP > 0 && CHUNK_OVERLAP < CHUNK_TARGET)
}

// ============ ③ hashOf ============
{
  const a = hashOf('同一段文字')
  ok('hash 稳定（两次一致）', hashOf('同一段文字') === a)
  ok('hash 内容变则变', hashOf('同一段文字。') !== a)
  ok('hash 不同文本不同', hashOf('甲') !== hashOf('乙'))
  ok('hash 非空且是短串', a.length > 0 && a.length < 32)
}

// ============ 向量行 / 主键 ============
{
  ok('vectorRowId 含四段', vectorRowId('p1', 'chapter', 'c1', 2) === 'p1::chapter::c1::2')
  ok('chunkKey 含三段', chunkKey('chapter', 'c1', 2) === 'chapter::c1::2')
  ok('refKeyOf / splitRefKey 往返', (() => {
    const k = refKeyOf('chapter', 'a::b')
    const s = splitRefKey(k)
    return s.kind === 'chapter' && s.refId === 'a::b'
  })())

  const round = fromVectorBuffer(buf([1.5, -2, 0]))
  ok('toVectorBuffer / fromVectorBuffer 往返', round.length === 3 && round[0] === 1.5 && round[1] === -2)

  // 🔴 buffer 必须是独立拷贝（直接取 .buffer 会带上整个底层缓冲）
  const src = f32([1, 2, 3, 4])
  const view = src.subarray(1, 3)
  const isolated = toVectorBuffer(view)
  ok('toVectorBuffer 对子视图做独立拷贝', isolated.byteLength === 8 && fromVectorBuffer(isolated)[0] === 2)
}

// ============ ④ 🔴 D / S 剔除（前置于切块）============
{
  const normalRow = { id: 'r1', data: { 姓名: '云舒', 身份: '剑修' } }
  const dRow = { id: 'r2', data: { 姓名: '旧设', 身份: '废弃路线', 保密等级: 'D' } }
  const sRow = { id: 'r3', data: { 姓名: '幕后', 身份: '真正的执棋者', 保密等级: 'S' } }
  const cardD = { id: 'k1', name: '弃案', data: { '一、基础::保密等级': 'D', '一、基础::姓名': '弃案' } }
  const cardS = { id: 'k2', name: '暗手', data: { '一、基础::保密等级': 'S', '一、基础::姓名': '暗手' } }

  const docs: IndexDoc[] = collectIndexDocs({
    chapters: [{ id: 'c1', title: '第一章', summary: '开篇', content: '他推门进来。' }],
    tables: [{ tabId: 'char-main', tabName: '主要角色', rows: [normalRow, dRow, sRow] }],
    cards: [{ tabId: 'char-secondary', tabName: '次要角色', rows: [cardD, cardS] }],
  })

  const refs = docs.map(d => d.refId)
  ok('🔴 D 级表格行不进索引', !refs.includes('r2'))
  ok('🔴 D 级角色卡不进索引', !refs.includes('k1'))
  ok('S 级表格行进索引且标记 secret', docs.find(d => d.refId === 'r3')?.secret === true)
  ok('S 级角色卡进索引且标记 secret', docs.find(d => d.refId === 'k2')?.secret === true)
  ok('普通行 secret = false', docs.find(d => d.refId === 'r1')?.secret === false)
  ok('章节进索引且 kind = chapter', docs.find(d => d.refId === 'c1')?.kind === 'chapter' && docs.find(d => d.refId === 'c1')?.secret === false)
  ok('章节文本含标题与正文', (docs.find(d => d.refId === 'c1')?.text ?? '').includes('第一章'))

  // 空行 / 全空数据不产条目
  const emptyDocs = collectIndexDocs({
    chapters: [],
    tables: [{ tabId: 't', tabName: 'T', rows: [{ id: 'e1', data: {} }, { id: 'e2', data: { 名称: '   ' } }] }],
    cards: [],
  })
  ok('空数据行不产索引条目', emptyDocs.length === 0)

  // 章节无标题无正文也不产条目
  const blankCh = collectIndexDocs({ chapters: [{ id: 'c9', title: '  ', content: '' }], tables: [], cards: [] })
  ok('空章节不产索引条目', blankCh.length === 0)

  // 🔴🔴 源码断言：剔除必须在切块之前
  const idxSrc = read('src/lib/semantic/indexer.ts')
  const pruneAt = idxSrc.indexOf('isPrunedForAI(r.data)')
  const chunkCallAt = idxSrc.indexOf('chunkChapter(doc.text)')
  ok('🔴 源码：isPrunedForAI 出现在切块调用之前', pruneAt > 0 && chunkCallAt > 0 && pruneAt < chunkCallAt,
    `prune@${pruneAt} chunk@${chunkCallAt}`)
  ok('🔴 源码：collectIndexDocs 是 D 级剔除的唯一入口（有注释声明）',
    idxSrc.includes('S / D 剔除') && idxSrc.includes('唯一入口'))

  // 负面对照：同样形状、只是**没有** 保密等级 的一行**必须**能进索引 ——
  // 否则说明"过滤"其实是把整类行都吞了（那种过度过滤同样会让语义召回静默失效）
  const plainRow = collectIndexDocs({ chapters: [], tables: [{ tabId: 't', tabName: 'T', rows: [{ id: 'r9', data: { 姓名: 'x' } }] }], cards: [] })
  ok('负面对照：无等级标记的行照常进索引（过滤没误伤）', plainRow.length === 1 && plainRow[0].refId === 'r9')
}

// ============ embed 纯函数 ============
{
  ok('embedPath ollama', embedPath({ type: 'ollama', baseUrl: 'http://localhost:11434/' }) === 'http://localhost:11434/api/embed')
  ok('embedPath openai', embedPath({ type: 'openai', baseUrl: 'https://api.x.com/v1/' }) === 'https://api.x.com/v1/embeddings')
  ok('embedBaseOf 剥 /chat/completions', embedBaseOf({ type: 'openai', baseUrl: 'https://api.x.com/v1/chat/completions' }) === 'https://api.x.com/v1')
  ok('embedBaseOf 剥 /embeddings', embedBaseOf({ type: 'openai', baseUrl: 'https://api.x.com/v1/embeddings' }) === 'https://api.x.com/v1')

  ok('embedConfigError 空配置', embedConfigError(null) !== '')
  ok('embedConfigError 缺模型名', embedConfigError({ type: 'ollama', baseUrl: 'http://localhost:11434', model: '' }) !== '')
  ok('embedConfigError 缺地址', embedConfigError({ type: 'ollama', baseUrl: '', model: 'm' }) !== '')
  ok('embedConfigError 本机 openai 免密钥', embedConfigError({ type: 'openai', baseUrl: 'http://localhost:8080/v1', model: 'm' }) === '')
  ok('embedConfigError 远程 openai 缺密钥要报错', embedConfigError({ type: 'openai', baseUrl: 'https://api.x.com/v1', model: 'm' }) !== '')
  ok('embedConfigError 完整 ollama 通过', embedConfigError(CFG) === '')

  const req = buildEmbedRequest(CFG, ['甲', '乙'])
  const body = JSON.parse(String(req.init.body)) as { model: string; input: string[] }
  ok('buildEmbedRequest body 形状', body.model === 'nomic-embed-text' && body.input.length === 2)
  ok('buildEmbedRequest ollama 不带 Authorization', !(req.init.headers as Record<string, string>).Authorization)

  const oReq = buildEmbedRequest({ type: 'openai', baseUrl: 'https://api.x.com/v1', apiKey: 'sk-1', model: 'm' }, ['甲'])
  ok('buildEmbedRequest openai 带 Authorization', (oReq.init.headers as Record<string, string>).Authorization === 'Bearer sk-1')
  ok('buildEmbedRequest openai 带 encoding_format', String(oReq.init.body).includes('encoding_format'))

  ok('parseEmbedResponse ollama 形态', (parseEmbedResponse('ollama', { embeddings: [[1, 2], [3, 4]] }) ?? []).length === 2)
  const ordered = parseEmbedResponse('openai', { data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }] })
  ok('parseEmbedResponse openai 按 index 排序', ordered?.[0]?.[0] === 1 && ordered?.[1]?.[0] === 3)
  ok('parseEmbedResponse 坏数据返回 null', parseEmbedResponse('ollama', { nope: 1 }) === null)
  ok('parseEmbedResponse null 返回 null', parseEmbedResponse('openai', null) === null)
  ok('EMBED_BATCH 是 32', EMBED_BATCH === 32)
}

// embedTexts：配置不全时不发请求；失败永不抛
{
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => { calls++; return new Response('{}', { status: 200 }) }) as typeof fetch

  const bad = await embedTexts(['x'], { type: 'ollama', baseUrl: '', model: '' })
  ok('embedTexts 配置不全 → ok:false 且不发请求', bad.ok === false && calls === 0 && !!bad.error)

  const empty = await embedTexts([], CFG)
  ok('embedTexts 空输入 → ok:false', empty.ok === false && calls === 0)

  globalThis.fetch = (async () => { throw new Error('boom') }) as typeof fetch
  const netErr = await embedTexts(['x'], CFG)
  ok('embedTexts 网络异常 → ok:false 不抛', netErr.ok === false && !!netErr.error)

  globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch
  const httpErr = await embedTexts(['x'], CFG)
  ok('embedTexts HTTP 500 → ok:false 带状态码', httpErr.ok === false && (httpErr.error ?? '').includes('500'))

  globalThis.fetch = (async () => new Response(JSON.stringify({ embeddings: [[1, 0], [0, 1]] }), { status: 200 })) as typeof fetch
  const good = await embedTexts(['甲', '乙'], CFG)
  ok('embedTexts 成功 → 向量与维度', good.ok === true && good.vectors?.length === 2 && good.dim === 2)

  globalThis.fetch = (async () => new Response(JSON.stringify({ embeddings: [[1, 0], [0, 1, 2]] }), { status: 200 })) as typeof fetch
  const mismatch = await embedTexts(['甲', '乙'], CFG)
  ok('embedTexts 维度不一致 → ok:false', mismatch.ok === false)

  globalThis.fetch = realFetch
}

// ============ ⑤ 存储后端（内存桩）+ recallRelevant ============
function memBackend(): VecBackend & { rows: VecRow[] } {
  const rows: VecRow[] = []
  return {
    rows,
    async load(projectId) { return rows.filter(r => r.projectId === projectId).map(r => ({ ...r })) },
    async bulkPut(list) {
      for (const r of list) {
        const i = rows.findIndex(x => x.id === r.id)
        if (i >= 0) rows[i] = r
        else rows.push(r)
      }
    },
    async delByRef(projectId, refId) {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].projectId === projectId && rows[i].refId === refId) rows.splice(i, 1)
    },
    async clearProject(projectId) {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].projectId === projectId) rows.splice(i, 1)
    },
    async stats(projectId) { return summarize(rows.filter(r => r.projectId === projectId)) },
    async index(projectId) {
      const sel = rows.filter(r => r.projectId === projectId)
      return {
        hashes: new Map(sel.map(r => [chunkKey(r.kind, r.refId, r.chunkIdx), r.hash])),
        refs: new Set(sel.map(r => refKeyOf(r.kind, r.refId))),
      }
    },
  }
}

function row(input: {
  projectId?: string; kind?: VecRow['kind']; refId: string; chunkIdx?: number;
  text?: string; vec: number[]; model?: string; secret?: boolean; title?: string;
}): VecRow {
  return makeVecRow({
    projectId: input.projectId ?? 'p1',
    kind: input.kind ?? 'chapter',
    refId: input.refId,
    chunkIdx: input.chunkIdx ?? 0,
    text: input.text ?? '正文片段',
    title: input.title ?? '某章',
    hash: hashOf(input.text ?? '正文片段'),
    vec: buf(input.vec),
    dim: input.vec.length,
    model: input.model ?? CFG.model,
    secret: input.secret ?? false,
  })
}

{
  const be = memBackend()
  setVecBackend(be)

  ok('summarize 空 → null', summarize([]) === null)

  await putVectors([row({ refId: 'c1', vec: [1, 0] }), row({ refId: 'c1', chunkIdx: 1, vec: [0, 1], text: '第二块' })])
  const st = await vectorStats('p1')
  ok('vectorStats 统计章节与块数', st?.chapters === 1 && st?.chunks === 2 && st?.model === CFG.model)

  const idxView = await vectorIndex('p1')
  ok('vectorIndex 返回 hash 与 refs', idxView.hashes.size === 2 && idxView.refs.size === 1)

  await removeByRef('p1', 'c1')
  ok('removeByRef 清掉该来源全部块', (await loadVectors('p1')).length === 0)

  await putVectors([row({ refId: 'c9', vec: [1, 0] })])
  await clearProjectVectors('p1')
  ok('clearProjectVectors 清空项目', (await loadVectors('p1')).length === 0)

  // ---- recallRelevant ----
  const emptyRecall = await recallRelevant('任何', { projectId: 'p1', cfg: CFG, embedFn: async () => [1, 0] })
  ok('🔴 索引为空 → [] 且零嵌入请求', emptyRecall.length === 0)

  let embedCalls = 0
  const trackEmbed = async () => { embedCalls++; return [1, 0] }
  await recallRelevant('任何', { projectId: 'p1', cfg: CFG, embedFn: trackEmbed })
  ok('🔴 索引为空时连嵌入函数都没被调用', embedCalls === 0)

  // 造一点数据
  await putVectors([
    row({ refId: 'c1', vec: [1, 0], text: '剑修在雪山闭关' }),
    row({ refId: 'c2', vec: [0, 1], text: '酒楼里谈生意' }),
    row({ refId: 'r1', kind: 'setting', vec: [1, 0], text: '剑冢：上古剑修埋骨地' }),
    row({ refId: 's1', kind: 'setting', vec: [1, 0], text: '幕后黑手', secret: true }),
  ])

  const hits = await recallRelevant('剑修', { projectId: 'p1', cfg: CFG, embedFn: async () => [1, 0], minScore: 0 })
  ok('recall 能召回同向行', hits.length > 0 && hits.every(h => h.kind !== undefined))

  const withSecret = await recallRelevant('幕后', { projectId: 'p1', cfg: CFG, embedFn: async () => [1, 0], minScore: 0 })
  ok('recall 默认带上 S 级', withSecret.some(h => h.secret))

  const hidden = await recallRelevant('幕后', { projectId: 'p1', cfg: CFG, embedFn: async () => [1, 0], minScore: 0, hideSecretRows: true })
  ok('🔴 recall hideSecretRows=true 剔除 S 级', !hidden.some(h => h.secret))

  const onlySetting = await recallRelevant('剑', { projectId: 'p1', cfg: CFG, embedFn: async () => [1, 0], minScore: 0, kinds: ['setting'] })
  ok('recall kinds 过滤生效', onlySetting.every(h => h.kind === 'setting'))

  const excluded = await recallRelevant('剑', { projectId: 'p1', cfg: CFG, embedFn: async () => [1, 0], minScore: 0, excludeRefIds: new Set(['c1']) })
  ok('recall excludeRefIds 排除焦点章', !excluded.some(h => h.refId === 'c1'))

  const anchored = await recallRelevant('剑', { projectId: 'p1', cfg: CFG, embedFn: async () => [1, 0], minScore: 0, allowChapterIds: new Set(['c2']) })
  ok('recall 锚点白名单只裁章节（设定类不受影响）',
    !anchored.some(h => h.kind === 'chapter' && h.refId === 'c1') && anchored.some(h => h.kind === 'setting'))

  const noEmbed = await recallRelevant('剑', { projectId: 'p1', cfg: CFG, embedFn: async () => null, minScore: 0 })
  ok('🔴 嵌入失败 → [] 不抛', noEmbed.length === 0)

  const throwEmbed = await recallRelevant('剑', { projectId: 'p1', cfg: CFG, embedFn: async () => { throw new Error('x') }, minScore: 0 })
  ok('🔴 嵌入抛异常 → [] 不抛', throwEmbed.length === 0)

  // minScore：同向块（余弦 1）留下、正交块（余弦 0）被剔 —— 断言"全部返回值都过线"才是有意义的判据
  const highBar = await recallRelevant('剑', { projectId: 'p1', cfg: CFG, embedFn: async () => [1, 0], minScore: 0.99 })
  ok('recall minScore 过滤生效（只留满分项、正交项被剔）',
    highBar.length > 0 && highBar.every(h => h.score >= 0.99) && !highBar.some(h => h.refId === 'c2'))

  const capped = await recallRelevant('剑', { projectId: 'p1', cfg: CFG, embedFn: async () => [1, 0], minScore: 0, topK: 1 })
  ok('recall topK 生效', capped.length <= 1)

  // 维度不匹配 → 整体失效
  const wrongDim = await recallRelevant('剑', { projectId: 'p1', cfg: CFG, embedFn: async () => [1, 0, 0], minScore: 0 })
  ok('🔴 查询维度与索引不符 → []', wrongDim.length === 0)

  // 模型不符 → 整体失效
  const wrongModel = await recallRelevant('剑', { projectId: 'p1', cfg: { ...CFG, model: 'other' }, embedFn: async () => [1, 0], minScore: 0 })
  ok('🔴 嵌入模型已换 → []', wrongModel.length === 0)

  const fresh = checkIndexFreshness([row({ refId: 'c1', vec: [1, 0] })], CFG)
  ok('checkIndexFreshness 匹配为 fresh', fresh.fresh === true)
  ok('checkIndexFreshness 空索引不 fresh', checkIndexFreshness([], CFG).fresh === false)
  ok('checkIndexFreshness 模型不符给中文原因', checkIndexFreshness([row({ refId: 'c1', vec: [1, 0], model: 'old' })], CFG).reason.includes('重建'))

  const noProject = await recallRelevant('剑', { projectId: '', cfg: CFG, embedFn: async () => [1, 0] })
  ok('recall 缺 projectId → []', noProject.length === 0)
  const emptyQuery = await recallRelevant('   ', { projectId: 'p1', cfg: CFG, embedFn: async () => [1, 0] })
  ok('recall 空查询 → []', emptyQuery.length === 0)

  // perRefCap：同一来源最多 2 块
  const be2 = memBackend()
  setVecBackend(be2)
  await putVectors([
    row({ refId: 'same', chunkIdx: 0, vec: [1, 0], text: 'a' }),
    row({ refId: 'same', chunkIdx: 1, vec: [1, 0], text: 'b' }),
    row({ refId: 'same', chunkIdx: 2, vec: [1, 0], text: 'c' }),
    row({ refId: 'same', chunkIdx: 3, vec: [1, 0], text: 'd' }),
  ])
  const capHits = await recallRelevant('a', { projectId: 'p1', cfg: CFG, embedFn: async () => [1, 0], minScore: 0 })
  ok('recall 同一来源默认最多 2 块', capHits.length === 2)

  setVecBackend(null) // 复位（避免影响后续用例）
  setVecBackend(memBackend())
}

// ============ ⑥ rebuildIndex ============
{
  const be = memBackend()
  setVecBackend(be)

  const doc = (id: string, text: string, secret = false): IndexDoc =>
    ({ kind: 'chapter', refId: id, title: id, text, secret })

  const makeDeps = (docs: IndexDoc[], opts: { failAt?: number } = {}) => {
    let embedCount = 0
    const removed: string[] = []
    const cleared: string[] = []
    const putRows: VecRow[] = []
    return {
      removed, cleared, putRows,
      get embedCount() { return embedCount },
      deps: {
        collectDocs: async () => docs,
        embed: async (texts: string[]) => {
          embedCount++
          if (opts.failAt && embedCount >= opts.failAt) return { ok: false, error: '模拟嵌入失败' }
          return { ok: true, vectors: texts.map(() => [1, 0]), dim: 2 }
        },
        clear: async (pid: string) => { cleared.push(pid); await clearProjectVectors(pid) },
        removeRef: async (pid: string, refId: string) => { removed.push(refId); await removeByRef(pid, refId) },
        put: async (rows: VecRow[]) => { putRows.push(...rows); await putVectors(rows) },
      },
    }
  }

  // 首次全量
  {
    const d = makeDeps([doc('c1', '第一章正文'), doc('c2', '第二章正文')])
    const r = await rebuildIndex({ projectId: 'p1', cfg: CFG, deps: d.deps })
    ok('rebuild 首次成功', r.ok === true && r.docs === 2 && r.chunks === 2 && r.error === undefined)
    ok('rebuild 首次写入落库', (await loadVectors('p1')).length === 2)
  }

  // 同内容再跑 ⇒ 全部跳过，零嵌入
  {
    const d = makeDeps([doc('c1', '第一章正文'), doc('c2', '第二章正文')])
    const r = await rebuildIndex({ projectId: 'p1', cfg: CFG, deps: d.deps })
    ok('🔴 增量：内容未变 → chunks 0、skipped 2', r.ok === true && r.chunks === 0 && r.skipped === 2)
    ok('🔴 增量：未变的块一个都没重嵌', d.embedCount === 0)
  }

  // 只改一章 ⇒ 只重嵌那一章
  {
    const d = makeDeps([doc('c1', '第一章改过了'), doc('c2', '第二章正文')])
    const r = await rebuildIndex({ projectId: 'p1', cfg: CFG, deps: d.deps })
    ok('增量：只重嵌改动的那一章', r.ok === true && r.chunks === 1 && r.skipped === 1)
    const rows = await loadVectors('p1')
    const c1 = rows.find(x => x.refId === 'c1')
    ok('增量：新内容已落库', (c1?.text ?? '').includes('改过了'))
    ok('增量：旧块没有残留（c1 只有 1 块）', rows.filter(x => x.refId === 'c1').length === 1)
  }

  // 删掉一章 ⇒ 孤儿清理
  {
    const d = makeDeps([doc('c1', '第一章改过了')])
    const r = await rebuildIndex({ projectId: 'p1', cfg: CFG, deps: d.deps })
    ok('🔴 增量：已删章节被清理', r.ok === true && r.removed >= 1 && d.removed.includes('c2'))
    ok('🔴 孤儿块不出现在库里（否则会召回已删内容）', !(await loadVectors('p1')).some(x => x.refId === 'c2'))
  }

  // 🔴🔴 来源读失败（incomplete）⇒ **不得做孤儿清理**
  //    （否则把「读不到」当「已删除」，静默删掉整章 / 整表的向量）
  {
    // 先回到「c1 + c2 都在库里」的干净状态
    const seed = makeDeps([doc('c1', '第一章正文'), doc('c2', '第二章正文')])
    await rebuildIndex({ projectId: 'p1', cfg: CFG, full: true, deps: seed.deps })
    ok('前置：库里 c1 / c2 都在', (await loadVectors('p1')).length === 2)

    // 本次收集：c1 正常、c2「读失败」⇒ 详细结果带 incomplete
    const d = makeDeps([])
    const deps2 = {
      ...d.deps,
      collectDocs: async () => ({ docs: [doc('c1', '第一章正文')], incomplete: true }),
    }
    const r = await rebuildIndex({ projectId: 'p1', cfg: CFG, deps: deps2 })
    ok('🔴 读失败 ⇒ 一个孤儿都不清（removed 0）', r.ok === true && r.removed === 0 && !d.removed.includes('c2'))
    ok('🔴 读失败 ⇒ c2 的向量仍在库里（没被误删）', (await loadVectors('p1')).some(x => x.refId === 'c2'))
    ok('🔴 读失败 ⇒ 结果带 warning 让作者稍后重跑', typeof r.warning === 'string' && r.warning.includes('重跑'))

    // 对照：完整收集 ⇒ 孤儿照常清理（证明上面不是「清理整体失灵」）
    const d3 = makeDeps([doc('c1', '第一章正文')])
    const r3 = await rebuildIndex({ projectId: 'p1', cfg: CFG, deps: d3.deps })
    ok('对照：完整收集时孤儿照常被清（清理没失灵）', r3.removed >= 1 && d3.removed.includes('c2'))
  }

  // 🔴 一条来源都没读到、而且确实有读失败 ⇒ 不谎报「这本书是空的」
  {
    const d = makeDeps([])
    const deps2 = { ...d.deps, collectDocs: async () => ({ docs: [], incomplete: true }) }
    const r = await rebuildIndex({ projectId: 'p1', cfg: CFG, deps: deps2 })
    ok('🔴 全读失败 → ok:false（不谎报空书）', r.ok === false && (r.error ?? '').includes('出错'))
  }

  // 🔴 读旧索引失败 ⇒ 中止，**不得**退化成全书重新嵌入（白烧配额）
  {
    const d = makeDeps([doc('c1', '读索引失败测试')])
    const deps2 = { ...d.deps, index: async () => { throw new Error('索引库读失败') } }
    const r = await rebuildIndex({ projectId: 'p1', cfg: CFG, deps: deps2 })
    ok('🔴 读旧索引失败 → ok:false 且一次嵌入都没发',
      r.ok === false && (r.error ?? '').includes('读取旧索引失败') && d.embedCount === 0)
  }

  // 🔴 同上，但走**真实默认路径**（不注入 deps.index）—— 这一条才有判别力地钉住 `vectorIndexStrict`
  {
    const d = makeDeps([doc('c1', '默认路径严格读')])
    const bad = { ...be, index: async () => { throw new Error('后端读失败') } }
    setVecBackend(bad)
    const r = await rebuildIndex({ projectId: 'p1', cfg: CFG, deps: { ...d.deps, index: undefined } })
    ok('🔴 默认走严格版：读旧索引失败 → ok:false / 不嵌入',
      r.ok === false && (r.error ?? '').includes('读取旧索引失败') && d.embedCount === 0)
    setVecBackend(be)
  }

  // 源码闸（这几条都是「改坏了测试也能立刻响」的判据）
  {
    const src = read('src/lib/semantic/indexer.ts')
    ok('🔴 收集读失败有 incomplete 信号（不再静默吞成空数组）',
      src.includes('loadIndexDocsDetailed') && src.includes('incomplete'))
    ok('🔴 孤儿清理受 incomplete 保护', src.includes('if (!full && !incomplete)'))
    ok('🔴 增量读旧索引用严格版（失败不再退化成全书重嵌）',
      src.includes('opts.deps?.index ?? vectorIndexStrict'))
    ok('🔴 自动索引与重建互斥（rebuildRunning）', src.includes('if (rebuildRunning) return'))
  }

  // full = true ⇒ 清空重建
  {
    const d = makeDeps([doc('c1', '第一章改过了')])
    const r = await rebuildIndex({ projectId: 'p1', cfg: CFG, full: true, deps: d.deps })
    ok('full 重建走清空', r.ok === true && d.cleared.includes('p1') && r.chunks >= 1)
  }

  // 嵌入失败 ⇒ ok:false 带原因，不抛
  {
    const d = makeDeps([doc('cX', '新内容')], { failAt: 1 })
    const r = await rebuildIndex({ projectId: 'p1', cfg: CFG, deps: d.deps })
    ok('🔴 嵌入失败 → ok:false 带原因，不抛', r.ok === false && (r.error ?? '').includes('模拟嵌入失败'))
  }

  // 空资料 ⇒ ok:true 且什么都没做
  {
    const d = makeDeps([])
    const r = await rebuildIndex({ projectId: 'p1', cfg: CFG, deps: d.deps })
    ok('无待索引资料 → ok:true / 0 块', r.ok === true && r.chunks === 0 && r.docs === 0)
  }

  // 参数校验
  {
    const d = makeDeps([doc('c1', 'x')])
    const noProj = await rebuildIndex({ projectId: '', cfg: CFG, deps: d.deps })
    ok('rebuild 缺 projectId → ok:false', noProj.ok === false)
    const noModel = await rebuildIndex({ projectId: 'p1', cfg: { ...CFG, model: '' }, deps: d.deps })
    ok('rebuild 缺模型名 → ok:false', noModel.ok === false)
  }

  // 取消
  {
    const d = makeDeps([doc('c1', 'x'), doc('c2', 'y')])
    const ac = new AbortController()
    ac.abort()
    const r = await rebuildIndex({ projectId: 'p1', cfg: CFG, signal: ac.signal, deps: d.deps })
    ok('rebuild 已取消 → ok:false / 已取消', r.ok === false && r.error === '已取消')
  }

  // 进度回调
  {
    const d = makeDeps([doc('c1', '进度测试正文')])
    const phases: string[] = []
    await rebuildIndex({ projectId: 'p1', cfg: CFG, deps: d.deps, onProgress: p => phases.push(p.phase) })
    ok('rebuild 上报 收集/嵌入/写入 三个阶段', phases.includes('收集') && phases.includes('嵌入') && phases.includes('写入'))
  }

  // indexStatus
  {
    await clearProjectVectors('p1')
    const st0 = await indexStatus('p1', CFG)
    ok('indexStatus 空索引 → 未建立', st0.fresh === false && st0.reason.includes('尚未'))

    const d = makeDeps([doc('c1', '状态测试')])
    await rebuildIndex({ projectId: 'p1', cfg: CFG, deps: d.deps })
    const st1 = await indexStatus('p1', CFG)
    ok('indexStatus 建好且模型一致 → fresh', st1.fresh === true && st1.stats?.chunks === 1)

    const st2 = await indexStatus('p1', { ...CFG, model: 'other' })
    ok('indexStatus 模型不符 → 提示重建', st2.fresh === false && st2.reason.includes('重建'))

    const st3 = await indexStatus('p1', null)
    ok('indexStatus 未配模型 → 不 fresh', st3.fresh === false)
  }
}

// ============ ⑦ autoIndexChapter（章节保存后自动更新本章索引）============
{
  const be = memBackend()
  setVecBackend(be)

  const realFetch = globalThis.fetch
  const realWarn = console.warn
  console.warn = () => { /* 本组会故意造失败路径，静音以免污染输出 */ }
  // 嵌入桩：有几个输入就回几个向量（成功路径）
  globalThis.fetch = (async (_u: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string[] }
    return new Response(JSON.stringify({ embeddings: (body.input ?? []).map(() => [1, 0]) }), { status: 200 })
  }) as unknown as typeof fetch

  const V1 = { id: 'c1', title: '第一章', summary: '夜袭', content: '旧版本正文，风雪扑面。' }
  const V2 = { ...V1, content: '全新版本正文，剑光如练。' }
  const docOf = (c: { id: string; title: string; summary?: string; content: string }): IndexDoc =>
    ({ kind: 'chapter', refId: c.id, title: c.title, text: chapterIndexText(c), secret: false })

  /** 造一份 deps；`calls` 记录**真正发起索引**的次数（守卫是否生效看它） */
  const mk = (opts: { auto?: boolean; cfg?: EmbedConfig | null; chapters?: unknown[]; projectId?: string } = {}) => {
    let calls = 0
    const deps: AutoIndexDeps = {
      projectId: () => opts.projectId ?? 'p1',
      loadSettings: async () => ({ ...DEFAULT_EMBEDDING, providerId: 'pr1', autoIndexOnSave: opts.auto !== false }),
      resolveConfig: async () => (opts.cfg === undefined ? CFG : opts.cfg),
      chapters: async () => (opts.chapters ?? [V1]) as never,
      indexOne: async (doc, pid, cfg2, signal) => { calls++; return indexOneDoc(doc, pid, cfg2, signal) },
    }
    return { deps, get calls() { return calls } }
  }

  // 指纹口径（保存路径首道闸用的就是它）
  ok('chapterFingerprint 同内容同值', chapterFingerprint(V1) === chapterFingerprint({ ...V1 }))
  ok('chapterFingerprint 改正文立刻变', chapterFingerprint(V1) !== chapterFingerprint(V2))
  ok('chapterFingerprint 只改标题也变（标题进索引文本）', chapterFingerprint(V1) !== chapterFingerprint({ ...V1, title: '第一章·改' }))
  ok('chapterIndexText 空字段被滤掉', chapterIndexText({ title: 'A', summary: '', content: '' }) === 'A')
  ok('chapterIndexText 与章节来源同口径（含摘要与正文）', chapterIndexText(V1) === '第一章\n夜袭\n旧版本正文，风雪扑面。')

  // 守卫③：索引从未建立过 ⇒ 一步都不走（哪怕开关是开的）
  {
    await clearProjectVectors('p1')
    const m = mk()
    await autoIndexChapter('c1', m.deps)
    ok('🔴 索引从未建立 → 自动索引一步都不走', m.calls === 0)
  }

  // 建好索引（用 V1 的内容）
  await indexOneDoc(docOf(V1), 'p1', CFG)
  ok('前置：索引已含 c1', (await loadVectors('p1')).some(r => r.refId === 'c1'))

  // 守卫①：开关关闭
  {
    const m = mk({ auto: false })
    await autoIndexChapter('c1', m.deps)
    ok('开关关闭 → 零调用', m.calls === 0)
  }
  // 守卫②：未配嵌入模型
  {
    const m = mk({ cfg: null })
    await autoIndexChapter('c1', m.deps)
    ok('未配嵌入模型 → 零调用', m.calls === 0)
  }
  // 无当前项目
  {
    const m = mk({ projectId: '' })
    await autoIndexChapter('c1', m.deps)
    ok('无当前项目 → 零调用', m.calls === 0)
  }
  // 章节不存在
  {
    const m = mk({ chapters: [] })
    await autoIndexChapter('c1', m.deps)
    ok('章节不存在 → 零调用', m.calls === 0)
  }
  // 守卫④：内容没变（只改了状态 / 调了排序的场景）
  {
    const m = mk()
    await autoIndexChapter('c1', m.deps)
    ok('🔴 内容未变 → 早退，一次嵌入都不发', m.calls === 0)
  }

  // 内容真变了 ⇒ 重建，且旧块不残留
  {
    const m = mk({ chapters: [V2] })
    await autoIndexChapter('c1', m.deps)
    ok('内容变了 → 重建本章索引一次', m.calls === 1)
    const rows = (await loadVectors('p1')).filter(r => r.refId === 'c1')
    ok('重建后索引落到新内容', rows.length > 0 && rows.every(r => !r.text.includes('旧版本')))
    ok('🔴 新块里能读到新内容（没有留旧块）', rows.some(r => r.text.includes('全新版本')))
  }
  // 之后再存同一份 ⇒ 又早退
  {
    const m = mk({ chapters: [V2] })
    await autoIndexChapter('c1', m.deps)
    ok('重建后再存同内容 → 又早退', m.calls === 0)
  }

  // 🔴 同章串行 + 尾随合并：在飞期间的第二次请求不得并发进入 indexOne
  {
    await clearProjectVectors('p1')
    await indexOneDoc(docOf(V1), 'p1', CFG)

    let cur: unknown = { ...V1, content: 'v2 版本正文' }
    let calls = 0
    const seen: string[] = []
    let release: () => void = () => { /* 占位，随后立即被真正的 resolve 覆盖 */ }
    const gate = new Promise<void>(res => { release = res })
    const deps: AutoIndexDeps = {
      projectId: () => 'p1',
      loadSettings: async () => ({ ...DEFAULT_EMBEDDING, providerId: 'pr1', autoIndexOnSave: true }),
      resolveConfig: async () => CFG,
      chapters: async () => [cur] as never,
      indexOne: async (doc, pid, cfg2, signal) => {
        calls++
        seen.push(doc.text)
        if (calls === 1) await gate // 第一次卡住，制造"在飞"窗口
        return indexOneDoc(doc, pid, cfg2, signal)
      },
    }

    const p1 = autoIndexChapter('c1', deps)
    await new Promise(r => setTimeout(r, 0)) // 让第一次推进到 indexOne
    cur = { ...V1, content: 'v3 版本正文' }   // 在飞期间又保存了一次
    const p2 = autoIndexChapter('c1', deps)
    ok('🔴 在飞期间的第二次请求被合并（没有并发进 indexOne）', calls === 1)
    release()
    await Promise.all([p1, p2])
    ok('🔴 合并后仍尾随补跑一次（不丢最后一次保存）', calls === 2)
    ok('🔴 补跑用的是最新内容 v3', (seen[seen.length - 1] ?? '').includes('v3'))
    const rows = (await loadVectors('p1')).filter(r => r.refId === 'c1')
    ok('🔴 索引最终停在最新内容上（不是被旧那轮覆盖）', rows.some(r => r.text.includes('v3')) && !rows.some(r => r.text.includes('v2 版本')))
  }

  // 永不抛：读设置就炸
  {
    let threw = false
    try {
      await autoIndexChapter('c1', { projectId: () => 'p1', loadSettings: async () => { throw new Error('设置读不出来') } })
    } catch { threw = true }
    ok('🔴 内部抛错 → autoIndexChapter 不抛（绝不影响存稿）', threw === false)
  }
  // 空 chapterId 直接返回
  {
    const m = mk()
    await autoIndexChapter('', m.deps)
    ok('空 chapterId → 零调用', m.calls === 0)
  }

  globalThis.fetch = realFetch
  console.warn = realWarn
}

// ============ 源码断言：保存路径挂钩（自动索引）============
{
  const hook = read('src/components/editor/useNovelEditorModel.ts')
  ok('保存路径已接自动索引', hook.includes('autoIndexChapter(chapter.id)'))
  ok('🔴 挂钩在 `db.saveChapter` 之后（否则会读到改动前的旧正文）',
    hook.indexOf('const p = db.saveChapter(chapter)') >= 0 &&
    hook.indexOf('const p = db.saveChapter(chapter)') < hook.indexOf('autoIndexChapter(chapter.id)'))
  ok('🔴 自动索引 fire-and-forget（不 await 落库）', /void\s+p\.then\(\(\)\s*=>\s*autoIndexChapter/.test(hook))
  ok('保存路径按指纹挡重复触发（省一次查库）', hook.includes('chapterFingerprint'))

  const panel = read('src/components/settings/EmbeddingIndexPanel.tsx')
  ok('面板提供「保存后自动索引」开关', panel.includes('autoIndexOnSave'))

  const idxSrc = read('src/lib/semantic/indexer.ts')
  ok('🔴 自动索引用 vectorIndex 判存在（不读 vec，避免每次保存拉十几 MB）',
    idxSrc.includes('(deps?.index ?? vectorIndex)(projectId)'))
  ok('🔴 自动索引有同章串行闸', idxSrc.includes('autoRunning') && idxSrc.includes('autoDirty'))
}

// ============ inject ============
{
  ok('focusQueryOf 空章 → 空串', focusQueryOf(null) === '')
  ok('focusQueryOf 全空 → 空串', focusQueryOf({ title: '  ', content: '' }) === '')
  const q = focusQueryOf({ title: '第三章', summary: '夜袭', content: '他提剑而起。' })
  ok('focusQueryOf 含标题/摘要/正文', q.includes('第三章') && q.includes('夜袭') && q.includes('提剑'))

  ok('renderRecallHits 空 → 空串', renderRecallHits([]) === '')
  const rendered = renderRecallHits([
    { kind: 'chapter', refId: 'c1', chunkIdx: 0, text: '雪山之上', title: '第二章', score: 0.81, secret: false },
    { kind: 'setting', refId: 'r1', chunkIdx: 0, text: '剑冢设定', title: '剑冢', score: 0.62, secret: false },
  ])
  ok('renderRecallHits 标注来源类型与相似度', rendered.includes('章节｜第二章') && rendered.includes('设定｜剑冢') && rendered.includes('0.81'))

  // buildSemanticRecallBlock：四条静默跳过路径
  const notConfigured = await buildSemanticRecallBlock({
    projectId: 'p1', focusChapterId: 'c1',
    deps: { resolveConfig: async () => null },
  })
  ok('🔴 未配嵌入模型 → 空串（不读库、不召回）', notConfigured === '')

  let recallCalled = false
  const noChapter = await buildSemanticRecallBlock({
    projectId: 'p1', focusChapterId: 'nope',
    deps: {
      resolveConfig: async () => CFG,
      loadChapters: async () => [],
      recall: async () => { recallCalled = true; return [] },
    },
  })
  ok('🔴 焦点章不存在 → 空串且不发起召回', noChapter === '' && recallCalled === false)

  const hitBlock = await buildSemanticRecallBlock({
    projectId: 'p1', focusChapterId: 'c1',
    deps: {
      resolveConfig: async () => CFG,
      // Q2：注入前会按当前章节集合复核来源存在性 ⇒ 命中章也必须在集合里
      loadChapters: async () => [
        { id: 'c1', title: '第一章', summary: '', content: '正文' },
        { id: 'c2', title: '第二章', summary: '', content: '别处的内容' },
      ],
      recall: async () => [{ kind: 'chapter', refId: 'c2', chunkIdx: 0, text: '别处的内容', title: '第二章', score: 0.7, secret: false }],
    },
  })
  ok('有命中 → 产出可注入文本', hitBlock.includes('第二章') && hitBlock.includes('别处的内容'))

  const throws = await buildSemanticRecallBlock({
    projectId: 'p1', focusChapterId: 'c1',
    deps: {
      resolveConfig: async () => CFG,
      loadChapters: async () => [{ id: 'c1', title: 't', content: 'c' }],
      recall: async () => { throw new Error('boom') },
    },
  })
  ok('🔴 召回抛异常 → 空串不抛', throws === '')
}

// ============ Q2 · 权限、索引与召回同源（3.2.0 §16.3）============
//
// 验收口径（方案原文）：先索引含唯一标记值的字段，再关闭参考权限，
// 在**不重建 / 重建失败 / 重启 / 缓存命中**四种情况下均不能发送该值。
{
  const RACES = TABS.find(t => t.id === 'races')!
  const CARD_TAB = TABS.find(t => t.type === 'card')!
  const MARK = '唯一标记-ZQ77'

  const fieldRule = (id: string, over: Partial<IndexFieldRule> = {}): IndexFieldRule => ({
    id,
    source: id.startsWith('cf_') ? 'custom' : 'builtin',
    label: id === 'cf_secret' ? '密文' : id,
    aiReadable: true,
    appliesTo: '*',
    archived: false,
    ...over,
  })

  /** 权限正常：三个字段都可读 */
  const rulesOn = (over: Partial<IndexFieldRule> = {}): Extract<FieldRules, { kind: 'rules' }> => ({
    kind: 'rules',
    rules: {
      名称: fieldRule('名称'),
      类别: fieldRule('类别'),
      cf_secret: fieldRule('cf_secret', over),
    },
    templateDigest: 'tpl:on',
    authoritative: true,
  })
  /** 字段被归档 / 删除后：规则里**没有** cf_secret（模板解析会把它过滤掉） */
  const rulesOff: FieldRules = {
    kind: 'rules',
    rules: { 名称: fieldRule('名称'), 类别: fieldRule('类别') },
    templateDigest: 'tpl:off',
    authoritative: true,
  }

  const rowOn = (over: Record<string, string> = {}) => ({
    id: 'r1',
    data: { 名称: '霜狼', 类别: '魔兽', 保密等级: 'C', cf_secret: MARK, ...over },
  })

  const indexDocs = (
    rules: FieldRules,
    rows: { id: string; data: Record<string, string> }[] = [rowOn()],
  ) => collectIndexDocs({
    chapters: [],
    tables: [{ tabId: 'races', tabName: '种族生物', rows, rules }],
    cards: [],
  })

  // ---- Q2-1：索引块带上字段依据 ----
  const doc = indexDocs(rulesOn())[0]
  ok('Q2 索引块记录依据（v / tabId / 模板摘要 / 字段表）',
    doc.basis?.v === 1 && doc.basis.tabId === 'races' && doc.basis.templateDigest === 'tpl:on')
  ok('Q2 依据里逐字段记了值摘要', doc.basis?.fields.some(f => f.key === 'cf_secret' && f.digest === hashOf(MARK)) === true)
  ok('Q2 依据里记下当时的显示名（T3-05 改名判定用）',
    doc.basis?.fields.find(f => f.key === 'cf_secret')?.label === '密文')
  ok('Q2 建索引时受权字段确实进了文本（正控）', doc.text.includes(MARK))
  ok('Q2 规则里没有的 cf_ 字段不进索引', indexDocs(rulesOff)[0].text.includes(MARK) === false)

  const vecRow = makeVecRow({
    projectId: 'p1', kind: 'setting', refId: 'r1', chunkIdx: 0,
    text: doc.text, title: doc.title, hash: hashOf(doc.text),
    vec: buf([1, 0]), dim: 2, model: CFG.model, secret: false,
    basis: doc.basis,
  })
  ok('Q2 向量行保留依据（落库不会丢）', vecRow.basis?.templateDigest === 'tpl:on')

  const beQ2 = memBackend()
  setVecBackend(beQ2)
  await putVectors([vecRow])
  const rawHits = await recallRelevant('霜狼', { projectId: 'p1', cfg: CFG, embedFn: async () => [1, 0], minScore: 0 })
  ok('Q2 召回命中透传依据', rawHits.length === 1 && rawHits[0].basis?.templateDigest === 'tpl:on')

  // ---- Q2-3/4：注入前的权限闸 ----
  type GateRowLike = { id: string; data: Record<string, string>; name?: string }
  const gateHits = (
    hits: RecallHit[],
    rules: FieldRules,
    rows: GateRowLike[] = [rowOn()],
    extra: { hideSecretRows?: boolean; chapterIds?: Set<string> | null } = {},
  ) => filterRecallHitsByPermission(hits, {
    projectId: 'p1',
    hideSecretRows: extra.hideSecretRows,
    chapterIds: extra.chapterIds === undefined ? null : extra.chapterIds,
    deps: {
      loadRows: async () => rows,
      loadRules: async () => rules,
    },
  })
  const rebase = (hit: RecallHit, over: Partial<VecBasis>): RecallHit => ({
    ...hit, basis: { ...(hit.basis as VecBasis), ...over },
  })

  ok('Q2 权限未变 ⇒ 命中保留（闸不是一律清空）', (await gateHits(rawHits, rulesOn())).length === 1)
  ok('Q2 字段显式不可读 ⇒ 整块丢弃', (await gateHits(rawHits, rulesOn({ aiReadable: false }))).length === 0)
  ok('Q2 字段归档/删除（规则里缺席）⇒ 整块丢弃', (await gateHits(rawHits, rulesOff)).length === 0)
  ok('Q2 类别不再适用 ⇒ 整块丢弃', (await gateHits(rawHits, rulesOn({ appliesTo: ['灵兽'] }))).length === 0)
  ok('Q2 类别仍适用 ⇒ 保留', (await gateHits(rawHits, rulesOn({ appliesTo: ['魔兽'] }))).length === 1)
  ok('Q2 来源行被删 ⇒ 丢弃', (await gateHits(rawHits, rulesOn(), [])).length === 0)
  ok('Q2 字段值已变（索引未重建）⇒ 丢弃',
    (await gateHits(rawHits, rulesOn(), [rowOn({ cf_secret: MARK + 'X' })])).length === 0)
  ok('Q2 D 级 ⇒ 任何视角都不给',
    (await gateHits(rawHits, rulesOn(), [rowOn({ 保密等级: 'D' })])).length === 0)
  ok('Q2 S 级 + 角色视角 ⇒ 丢弃',
    (await gateHits(rawHits, rulesOn(), [rowOn({ 保密等级: 'S' })], { hideSecretRows: true })).length === 0)
  ok('Q2 S 级 + 作者视角 ⇒ 保留',
    (await gateHits(rawHits, rulesOn(), [rowOn({ 保密等级: 'S' })])).length === 1)
  ok('Q2 无依据的旧块 ⇒ 隔离', (await gateHits([rebase(rawHits[0], {})], rulesOn())).length === 1
    && (await gateHits(rawHits.map(h => ({ ...h, basis: undefined })), rulesOn())).length === 0)
  ok('Q2 配置读失败 ⇒ 含 cf_ 的块丢弃',
    (await gateHits(rawHits, { kind: 'unavailable', reason: '读不到配置' })).length === 0)

  const builtinDoc = collectIndexDocs({
    chapters: [],
    tables: [{ tabId: 'races', tabName: '种族生物', rows: [{ id: 'r2', data: { 名称: '冰狼', 类别: '魔兽' } }], rules: rulesOn() }],
    cards: [],
  })[0]
  const builtinHit: RecallHit = {
    kind: 'setting', refId: 'r2', chunkIdx: 0, text: builtinDoc.text,
    title: '种族生物', score: 0.8, secret: false, basis: builtinDoc.basis,
  }
  ok('Q2 配置读失败 ⇒ 纯内置字段的块保留（配置坏了不该让整表失忆）',
    (await gateHits([builtinHit], { kind: 'unavailable', reason: '读不到配置' },
      [{ id: 'r2', data: { 名称: '冰狼', 类别: '魔兽' } }])).length === 1)

  const chapterHit: RecallHit = { kind: 'chapter', refId: 'c2', chunkIdx: 0, text: '别处', title: '第二章', score: 0.9, secret: false }
  ok('Q2 章节已删 ⇒ 丢弃', (await gateHits([chapterHit], rulesOn(), [], { chapterIds: new Set(['c1']) })).length === 0)
  ok('Q2 章节仍在 ⇒ 保留', (await gateHits([chapterHit], rulesOn(), [], { chapterIds: new Set(['c1', 'c2']) })).length === 1)

  ok('Q2 未知页签的依据不可信 ⇒ 丢弃',
    (await gateHits([rebase(rawHits[0], { tabId: 'no-such-tab' })], rulesOn())).length === 0)
  ok('Q2 卷台账（chapter-master）没有 TabDef 也按来源校验',
    (await gateHits([rebase(rawHits[0], { tabId: 'chapter-master' })], rulesOn())).length === 1)

  const cardDoc = collectIndexDocs({
    chapters: [], tables: [],
    cards: [{
      tabId: CARD_TAB.id, tabName: CARD_TAB.name,
      rows: [{ id: 'k1', name: '霜狼', data: { cf_secret: MARK } }],
      rules: rulesOn(),
    }],
  })[0]
  const cardHit: RecallHit = {
    kind: 'setting', refId: 'k1', chunkIdx: 0, text: cardDoc.text,
    title: '霜狼', score: 0.9, secret: false, basis: cardDoc.basis,
  }
  ok('Q2 角色卡标题未变 ⇒ 保留',
    (await gateHits([cardHit], rulesOn(), [{ id: 'k1', name: '霜狼', data: { cf_secret: MARK } }])).length === 1)
  ok('Q2 角色卡改名（索引未重建）⇒ 旧标题快照不许注入',
    (await gateHits([cardHit], rulesOn(), [{ id: 'k1', name: '改名了', data: { cf_secret: MARK } }])).length === 0)

  // ---- T3-05：另一台设备同步来新定义（改名 / 同键重建）后，旧块不可注入 ----
  // 场景：块是在旧定义下建的（label「密文」），当前快照已把它改名。键与值都没变，
  // 只比存储键 / 字段 ID 抓不到 —— 必须用块里记下的旧显示名比对。
  ok('🔴 T3-05 字段改名（键与值未变）⇒ 旧块整块丢弃',
    (await gateHits(rawHits, rulesOn({ label: '绝密' }))).length === 0)
  ok('T3-05 字段 ID 换了（存储键复用重建）⇒ 旧块丢弃',
    (await gateHits(rawHits, {
      ...rulesOn(),
      rules: { ...rulesOn().rules, cf_secret: fieldRule('cf_reborn') },
    })).length === 0)
  {
    const un = rulesOn()
    const unrelated: FieldRules = {
      ...un,
      rules: { ...un.rules, cf_other: fieldRule('cf_other', { label: '另一个字段改了名' }) },
    }
    ok('T3-05 与块无关的字段改名 ⇒ 不连带作废', (await gateHits(rawHits, unrelated)).length === 1)
    ok('T3-05 布局重排（label 不变）⇒ 块仍有效', (await gateHits(rawHits, rulesOn())).length === 1)
  }
  {
    const legacy = rawHits.map(h => ({
      ...h,
      basis: h.basis ? { ...h.basis, fields: h.basis.fields.map(f => ({ id: f.id, key: f.key, digest: f.digest })) } : undefined,
    }))
    ok('T3-05 历史块没记显示名 ⇒ 不凭空判失效（旧口径照常）',
      (await gateHits(legacy, rulesOn())).length === 1)
  }

  // ---- 验收之一：不重建 ----
  ok('Q2 场景「不重建」：旧块原样留在库里，但闸不发送标记值',
    (await loadVectors('p1')).some(r => r.text.includes(MARK))
    && (await gateHits(rawHits, rulesOff)).length === 0)

  // ---- 验收之二：重建失败（旧块仍在）----
  const failed = await rebuildIndex({
    projectId: 'p1', cfg: CFG,
    deps: {
      collectDocs: async () => indexDocs(rulesOff),
      embed: async () => ({ ok: false, error: '模拟嵌入失败' }),
    },
  })
  ok('Q2 场景「重建失败」：如实返回失败', failed.ok === false && (failed.error ?? '').includes('模拟嵌入失败'))
  ok('Q2 场景「重建失败」：旧索引没有被清掉', (await loadVectors('p1')).some(r => r.text.includes(MARK)))
  ok('Q2 场景「重建失败」：闸仍不发送标记值', (await gateHits(rawHits, rulesOff)).length === 0)

  // 重建成功 ⇒ 新索引里本来就没有这个字段
  const rebuilt = await rebuildIndex({
    projectId: 'p1', cfg: CFG,
    deps: {
      collectDocs: async () => indexDocs(rulesOff),
      embed: async (texts: string[]) => ({ ok: true, vectors: texts.map(() => [1, 0]), dim: 2 }),
    },
  })
  ok('Q2 重建成功 ⇒ 新索引不再含唯一标记值',
    rebuilt.ok === true && !(await loadVectors('p1')).some(r => r.text.includes(MARK)))

  // ---- 验收之三/四：重启 / 缓存命中（规则来源是当前快照，不是记忆里的旧口径）----
  const defOf = (readable: boolean, revision = 1): TemplateDef => ({
    formatVersion: 1,
    templateId: 'tpl_q2',
    name: 'Q2 测试模板',
    tabId: 'races',
    origin: { kind: 'builtin' },
    groups: [{ id: 'g1', label: '基础', order: 0 }],
    fields: [
      {
        id: '名称', sourceKey: '名称', source: 'builtin', label: '名称', type: 'text',
        groupId: 'g1', order: 0, appliesTo: '*', archived: false,
        permissions: { table: true, detail: true, search: true, aiRead: true, aiWrite: false },
      },
      {
        id: 'cf_secret', sourceKey: 'cf_secret', source: 'custom', label: '密文', type: 'text',
        groupId: 'g1', order: 1, appliesTo: '*', archived: false,
        permissions: { table: true, detail: true, search: true, aiRead: readable, aiWrite: false },
      },
    ],
    nameFieldId: '名称',
    semanticDigest: readable ? 'f1:on' : 'f1:off',
    revision,
    updatedAt: 0,
  })

  __resetTemplateCacheForTests()
  let storedDef = defOf(true, 1)
  const loadRulesNow = async () => loadFieldRules('p1', RACES, { loadDef: async () => storedDef })
  const warm = await loadRulesNow()
  ok('Q2 快照权限开启 ⇒ 规则里有 cf_secret（正控）',
    warm.kind === 'rules' && warm.rules['cf_secret']?.aiReadable === true)
  const cached = await loadRulesNow()
  ok('Q2 场景「缓存命中」：同一快照再次读取仍按当前规则', cached.kind === 'rules' && cached.rules['cf_secret']?.aiReadable === true)

  storedDef = defOf(false, 2)
  const changed = await loadRulesNow()
  ok('Q2 场景「缓存命中」：revision 变了 ⇒ 不吃旧缓存，cf_secret 已不可读',
    changed.kind === 'rules' && changed.rules['cf_secret'] === undefined)
  ok('Q2 场景「缓存命中」：用当前规则过闸 ⇒ 标记值不发送', (await gateHits(rawHits, changed)).length === 0)

  __resetTemplateCacheForTests() // 模拟重启：内存缓存清空，快照仍在
  const afterRestart = await loadRulesNow()
  ok('Q2 场景「重启」：清空缓存后仍读到收紧后的规则',
    afterRestart.kind === 'rules' && afterRestart.rules['cf_secret'] === undefined)
  ok('Q2 场景「重启」：闸仍不发送标记值', (await gateHits(rawHits, afterRestart)).length === 0)

  // 导入/恢复可能保留 revision 却换了内容 ⇒ 摘要必须参与缓存身份（Q2-7）
  __resetTemplateCacheForTests()
  storedDef = defOf(true, 7)
  const beforeImport = await loadRulesNow()
  storedDef = defOf(false, 7)
  const afterImport = await loadRulesNow()
  ok('Q2 同 revision 但摘要变了 ⇒ 缓存未命中，规则随快照收紧',
    beforeImport.kind === 'rules' && beforeImport.rules['cf_secret']?.aiReadable === true
    && afterImport.kind === 'rules' && afterImport.rules['cf_secret'] === undefined)

  const unavailable = await loadFieldRules('p1', RACES, {
    loadDef: async () => null,
    loadConfig: async () => ({ config: null as unknown as never, error: '磁盘读取失败' }),
  })
  ok('Q2 配置读取失败 ⇒ unavailable（不把读失败当空配置）',
    unavailable.kind === 'unavailable' && unavailable.reason.includes('磁盘读取失败'))

  // ---- 注入链路：闸必须真的接在 inject 上 ----
  const injected = await buildSemanticRecallBlock({
    projectId: 'p1', focusChapterId: 'c1',
    deps: {
      resolveConfig: async () => CFG,
      loadChapters: async () => [{ id: 'c1', title: '第一章', summary: '', content: '正文' }],
      recall: async () => rawHits,
      filterHits: (hits, opts) => filterRecallHitsByPermission(hits, {
        ...opts,
        deps: { loadRows: async () => [rowOn()], loadRules: async () => rulesOff },
      }),
    },
  })
  ok('Q2 注入链路：权限收紧后唯一标记值不会出现在提示词段', injected === '' || !injected.includes(MARK))

  // 索引状态要把「没有依据的旧索引」报成需重建
  setVecBackend(memBackend())
  await putVectors([row({ kind: 'setting', refId: 'legacy1', vec: [1, 0], text: '旧索引内容' })])
  ok('Q2 无依据旧块计入 baseless', (await vectorStats('p1'))?.baseless === 1)
  const ist = await indexStatus('p1', CFG)
  ok('Q2 状态提示重建（不谎报可用）', ist.fresh === false && ist.reason.includes('缺少字段权限依据'))

  setVecBackend(memBackend())
}

// ============ settings ============
{
  ok('normalizeEmbeddingSettings 脏数据兜底', (() => {
    const s = normalizeEmbeddingSettings({ providerId: 5, model: null, autoIndexOnSave: 'yes' })
    return s.providerId === '' && s.model === '' && s.autoIndexOnSave === false
  })())
  ok('normalizeEmbeddingSettings 正常数据保留', (() => {
    const s = normalizeEmbeddingSettings({ providerId: 'a', model: 'm', autoIndexOnSave: true })
    return s.providerId === 'a' && s.model === 'm' && s.autoIndexOnSave === true
  })())
  ok('DEFAULT_EMBEDDING 默认关闭', DEFAULT_EMBEDDING.providerId === '' && DEFAULT_EMBEDDING.autoIndexOnSave === false)

  const P: AIProvider = {
    id: 'a', name: '本地', type: 'ollama', baseUrl: 'http://localhost:11434',
    apiKey: '', model: 'qwen3', local: true, contextWindow: 32768,
  }

  const none = await resolveEmbedConfig({ providerId: '', model: '', autoIndexOnSave: false }, [P])
  ok('resolveEmbedConfig 未选 provider → null', none === null)

  const gone = await resolveEmbedConfig({ providerId: 'zzz', model: '', autoIndexOnSave: false }, [P])
  ok('resolveEmbedConfig provider 已删 → null', gone === null)

  const useModel = await resolveEmbedConfig({ providerId: 'a', model: 'nomic-embed-text', autoIndexOnSave: false }, [P])
  ok('resolveEmbedConfig 用单独填的嵌入模型名', useModel?.model === 'nomic-embed-text' && useModel.type === 'ollama')

  const fallbackModel = await resolveEmbedConfig({ providerId: 'a', model: '', autoIndexOnSave: false }, [P])
  ok('resolveEmbedConfig 模型留空回落 provider 的 model', fallbackModel?.model === 'qwen3')

  const noBase = await resolveEmbedConfig({ providerId: 'a', model: '', autoIndexOnSave: false }, [{ ...P, baseUrl: '' }])
  ok('resolveEmbedConfig 缺地址 → null', noBase === null)

  const st1 = await embeddingStatus({ providerId: '', model: '', autoIndexOnSave: false }, [P])
  ok('embeddingStatus 未选 → 不 ready 带原因', st1.ready === false && st1.reason.length > 0)
  const st2 = await embeddingStatus({ providerId: 'a', model: 'nomic-embed-text', autoIndexOnSave: false }, [P])
  ok('embeddingStatus 配好 → ready + label', st2.ready === true && st2.label.includes('nomic-embed-text'))
  const st3 = await embeddingStatus({ providerId: 'a', model: '', autoIndexOnSave: false }, [{ ...P, model: '' }])
  ok('embeddingStatus 缺模型名 → 不 ready', st3.ready === false && st3.reason.includes('模型名'))

  // 🔴 密钥不落进 aiEmbedding（EXCLUDED_META_KEYS 无需收纳它）
  const setSrc = read('src/lib/semantic/settings.ts')
  ok('🔴 源码：aiEmbedding 不存密钥（无 apiKey 字段）', !setSrc.includes('apiKey') || setSrc.includes('不新增密钥载体'))
}

// ============ T3-B3：含义未确认 ⇒ 索引不可读（快照 / 轻量定义两条来源）============
{
  const races = TABS.find(t => t.id === 'races')!
  const mkDef = (status: 'pending' | 'confirmed'): TemplateDef => ({
    formatVersion: 1,
    templateId: 'tpl_pending',
    name: '待确认测试',
    tabId: 'races',
    origin: { kind: 'builtin' },
    groups: [{ id: 'g1', label: '基础', order: 0 }],
    fields: [{
      id: '名称', sourceKey: '名称', source: 'builtin', label: '种族名', type: 'text',
      groupId: 'g1', order: 0, appliesTo: '*', archived: false, meaningStatus: status,
      permissions: { table: true, detail: true, search: true, aiRead: true, aiWrite: true },
    }],
    nameFieldId: '名称',
    semanticDigest: `pending:${status}`,
    revision: 1,
    updatedAt: 0,
  })
  __resetTemplateCacheForTests()
  const pend = await loadFieldRules('p1', races, { loadDef: async () => mkDef('pending') })
  ok('T3-B3 快照里含义未确认 ⇒ 索引规则不可读',
    pend.kind === 'rules' && pend.rules['名称']?.aiReadable === false)
  const okd = await loadFieldRules('p1', races, { loadDef: async () => mkDef('confirmed') })
  ok('T3-B3 快照里确认后 ⇒ 索引规则恢复可读',
    okd.kind === 'rules' && okd.rules['名称']?.aiReadable === true)

  const card = TABS.find(t => t.type === 'card')!
  const mod = card.modules![0]
  const key = `${mod.name}::${mod.fields[0].name}`
  const mkDoc = (status: 'pending' | 'confirmed'): FieldDefinitionDoc => ({
    formatVersion: 1,
    tabId: card.id,
    // 两次写入必须是不同的修订 / 时间戳（真实 saveFieldDefinition 也如此），
    // 否则缓存签名相同，会把「待确认」那份结果端给「已确认」的读取。
    revision: status === 'pending' ? 1 : 2,
    updatedAt: status === 'pending' ? 1 : 2,
    fields: { [key]: { label: '作者起的名字', meaningStatus: status, source: 'author', updatedAt: 1 } },
  })

  const none = await loadFieldRules('p1', card, { loadDefs: async () => null })
  ok('T3-B3 卡片页签没有轻量定义 ⇒ 仍为 none（老行为不变）', none.kind === 'none')

  const cp = await loadFieldRules('p1', card, { loadDefs: async () => mkDoc('pending') })
  ok('T3-B3 卡片待确认字段 ⇒ 非权威规则里标不可读',
    cp.kind === 'rules' && cp.authoritative === false && cp.rules[key]?.aiReadable === false)
  const cc = await loadFieldRules('p1', card, { loadDefs: async () => mkDoc('confirmed') })
  ok('T3-B3 卡片确认后 ⇒ 恢复可读', cc.kind === 'rules' && cc.rules[key]?.aiReadable === true)

  const failRead = await loadFieldRules('p1', card, {
    loadDefs: async () => { throw new Error('定义库坏了') },
  })
  ok('T3-B3 轻量定义读取失败 ⇒ unavailable（不静默放行）',
    failRead.kind === 'unavailable' && failRead.reason.includes('定义库坏了'))
}

// ============ 源码断言：分层与红线 ============
{
  const storeSrc = read('src/lib/semantic/store.ts')
  ok('🔴 向量库走独立 IndexedDB（不碰 db 门面）', storeSrc.includes('youth-fantasy-engine-vec') && !storeSrc.includes("from '../db'") && !storeSrc.includes("from '@/lib/db'"))

  const recallSrc = read('src/lib/semantic/recall.ts')
  ok('🔴 recall 不 import aiContext（防成环）', !recallSrc.includes("from '../aiContext'") && !recallSrc.includes("from '@/lib/ai/aiContext'"))

  const injectSrc = read('src/lib/semantic/inject.ts')
  ok('🔴 inject 不 import aiContext', !injectSrc.includes("from '../aiContext'") && !injectSrc.includes("from '@/lib/ai/aiContext'"))

  const idxSrc = read('src/lib/semantic/indexer.ts')
  ok('indexer 明确引用 isPrunedForAI 与 isSecretRow', idxSrc.includes('isPrunedForAI') && idxSrc.includes('isSecretRow'))

  const ctxSrc = read('src/lib/ai/aiContext.ts')
  const relatedPushAt = ctxSrc.indexOf('相关章节召回')
  const semanticCallAt = ctxSrc.indexOf('buildSemanticRecallBlock(')
  ok('aiContext 在相关章节召回之后接入语义召回',
    relatedPushAt > 0 && semanticCallAt > relatedPushAt, `related@${relatedPushAt} semantic@${semanticCallAt}`)
  ok('aiContext 语义召回受 semantic !== false 与 focusChapterId 双闸', ctxSrc.includes('opts.semantic !== false && opts.focusChapterId'))

  // 五个模块都在 semantic 目录下（与方案 §1.3 一致）
  for (const f of ['embed.ts', 'store.ts', 'chunk.ts', 'recall.ts', 'settings.ts']) {
    ok(`semantic/${f} 存在`, read(`src/lib/semantic/${f}`).length > 0)
  }
}

console.log(`\n=== semanticRecall：${pass} passed, ${fail} failed ===`)
if (fail > 0) process.exit(1)
