// ============ 知识库 · 长期挂载参考资料（2.8.0 · 台账 #017）============
//
// 本用例盯六件事（对齐方案 §5.7，并补齐实现里新增的编排逻辑）：
//   ① 导入只落库、**默认不启用**（`enabled: false` ⇒ 不切块、不嵌入、不进上下文）；
//   ② 列表 / 取正文 / 统计三条读路径 + 新建项目的隔离；
//   ③ 删除时**文档 + 正文 + 向量块一起清**（漏了向量块 = 会召回已删内容，真 bug）；
//   ④ 🔴🔴 `enabled` 负面对照：关着不进上下文、**打开才进**（含 `buildKbBlock` 全链路）——
//      这是「不显式开启不生效」这条产品承诺的唯一守卫；
//   ⑤ 超长文档**只注入片段**，条数与总长都受预算约束（绝不整篇塞，方案 §5.6）；
//   ⑥ 未配置 embedding ⇒ 关键词降级；任何一步失败都不抛（资料读不出来不该阻断写作）。
//
// 另附一组**源码闸**（本项目惯例：结构假设一旦漂移会静默失明，必须显式钉住）：
//   · 知识库模块对 `lib/db` **零依赖** —— 否则 `deleteProject → knowledgeBase → db` 成环；
//   · `tokenize` 单一真源 —— 防「全文检索搜得到、语义召回却召回不到」这类最难查的不一致；
//   · `aiContext` 把资料块 push 成〖参考资料〗、且**排在〖语义召回〗之后**。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as db from '../src/lib/db'
import {
  setKbBackend, listDocs, getDocText, kbStats, importDoc, removeDoc,
  setDocEnabled, renameDoc, reindexAll, recallKnowledge, renderKbHits,
  clearProjectDocs,
  KB_TOP_K, KB_MAX_CHARS, KB_MAX_DOCS, KB_HIT_CHARS,
  type KbDoc, type KbBackend,
} from '../src/lib/knowledgeBase'
import { memoryOps, __resetMockStores } from './mock-memory'
import { resetTaskCenter, tasksSnapshot } from '../src/lib/aiTaskCenter'
import { rebuildKbIndexAfterRestore } from '../src/lib/kbRestoreIndex'
import { buildKbBlock } from '../src/lib/kbInject'
import {
  setVecBackend, makeVecRow, putVectors, loadVectors, summarize, refKeyOf,
  type VecBackend, type VecRow,
} from '../src/lib/semantic/store'
import { toVectorBuffer, chunkKey } from '../src/lib/semantic/chunk'
import { recallRelevant } from '../src/lib/semantic/recall'
import type { EmbedConfig } from '../src/lib/semantic/embed'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
function read(rel: string): string {
  try { return readFileSync(path.join(process.cwd(), rel), 'utf8') } catch { return '' }
}

const CFG: EmbedConfig = { type: 'ollama', baseUrl: 'http://localhost:11434', model: 'nomic-embed-text' }

// ============ 内存后端（Node 无 indexedDB，与 semanticRecall 同手法）============

/** 内存 KB 后端：`docs` + `bodies` 两个 Map，模拟 `novel-studio-kb` 的两个 store */
function memKb(): KbBackend & { docs: KbDoc[]; bodies: Map<string, string> } {
  const docs: KbDoc[] = []
  const bodies = new Map<string, string>()
  return {
    docs, bodies,
    async list(projectId) { return docs.filter(d => d.projectId === projectId).map(d => ({ ...d })) },
    async put(doc) {
      const i = docs.findIndex(d => d.id === doc.id)
      if (i >= 0) docs[i] = doc
      else docs.push(doc)
    },
    async del(id) {
      const i = docs.findIndex(d => d.id === id)
      if (i >= 0) docs.splice(i, 1)
    },
    async getBody(id) { return bodies.get(id) ?? '' },
    async putBody(id, text) { bodies.set(id, text) },
    async delBody(id) { bodies.delete(id) },
    async clearProject(projectId) {
      for (let i = docs.length - 1; i >= 0; i--) {
        if (docs[i].projectId === projectId) { bodies.delete(docs[i].id); docs.splice(i, 1) }
      }
    },
  }
}

/** 内存向量后端 + `delRefLog`（证明"删资料确实触发了向量清理"） */
function memVec(): VecBackend & { rows: VecRow[]; delRefLog: string[] } {
  const rows: VecRow[] = []
  const delRefLog: string[] = []
  return {
    rows, delRefLog,
    async load(projectId) { return rows.filter(r => r.projectId === projectId).map(r => ({ ...r })) },
    async bulkPut(list) {
      for (const r of list) {
        const i = rows.findIndex(x => x.id === r.id)
        if (i >= 0) rows[i] = r
        else rows.push(r)
      }
    },
    async delByRef(projectId, refId) {
      delRefLog.push(`${projectId}::${refId}`)
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].projectId === projectId && rows[i].refId === refId) rows.splice(i, 1)
      }
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

/** 一条 kb 来源的向量行 */
const kbRow = (projectId: string, refId: string, chunkIdx: number, text = ''): VecRow => makeVecRow({
  projectId, kind: 'kb', refId, chunkIdx, text,
  title: '资料', hash: `h${chunkIdx}`,
  vec: toVectorBuffer(Float32Array.from([1, 0])), dim: 2, model: CFG.model, secret: false,
})

/** 造 n 段、每段约 180 字的正文（保证能切成多块） */
const multiPara = (n: number): string =>
  Array.from({ length: n }, (_, i) => `第${i}段${'字'.repeat(178)}`).join('\n\n')

// ============ ① 导入 / 读接口 / 默认关闭 ============
{
  setKbBackend(memKb())
  setVecBackend(memVec())

  const r = await importDoc({
    projectId: 'p1', title: '世界观设定集',
    text: '  黑暗之门纪年 \r\n\r\n\r\n 剑修在雪山闭关。  ', sourceType: 'txt',
  })
  ok('导入成功且回传文档', r.ok && !!r.doc)
  ok('🔴 默认不启用（enabled:false ⇒ 不切块、不嵌入）', r.doc?.enabled === false)
  ok('默认未建索引（chunkCount = 0）', r.doc?.chunkCount === 0)
  ok('未超长 ⇒ truncated 为 false', r.truncated === false)
  ok('记住来源类型', r.doc?.sourceType === 'txt')

  const body = await getDocText(r.doc!.id)
  ok('正文归一化：无 \\r', !body.includes('\r'))
  ok('正文归一化：无 3 连空行', !/\n{3,}/.test(body))
  ok('正文归一化：首尾无空白', body === body.trim())
  ok('chars 与落库正文长度一致', r.doc!.chars === body.length)

  const list = await listDocs('p1')
  ok('listDocs 列出刚导入的一篇', list.length === 1 && list[0].id === r.doc!.id)
  ok('🔴 别的项目看不到（项目隔离）', (await listDocs('p2')).length === 0)
  const st = await kbStats('p1')
  ok('kbStats：1 篇 / 0 启用 / 0 块', st.docs === 1 && st.enabled === 0 && st.chunks === 0)
}

// ============ ② 导入守卫（空内容 / 缺项目 / 截断 / 篇数上限）============
{
  setKbBackend(memKb())
  const empty = await importDoc({ projectId: 'p1', title: '空', text: '   \n\n\t ', sourceType: 'paste' })
  ok('空内容不导入（返回可读原因）', !empty.ok && !!empty.error)

  const noPid = await importDoc({ projectId: '', title: 'x', text: 'abc', sourceType: 'txt' })
  ok('缺项目 id 不导入', !noPid.ok)

  const huge = '字'.repeat(KB_MAX_CHARS + 500)
  const tr = await importDoc({ projectId: 'p1', title: '超长', text: huge, sourceType: 'txt' })
  ok('🔴 超长文档：截断并**如实告知**（不静默丢）', tr.ok && tr.truncated === true)
  ok('超长文档：只存 KB_MAX_CHARS 个字符', tr.doc?.chars === KB_MAX_CHARS)

  // 篇数上限：直接把后端填到上限，避免真跑 200 次导入
  const be = memKb()
  setKbBackend(be)
  for (let i = 0; i < KB_MAX_DOCS; i++) {
    be.docs.push({ id: `d${i}`, projectId: 'p1', title: 't', sourceType: 'txt', chars: 1, chunkCount: 0, importedAt: i, enabled: false })
  }
  const over = await importDoc({ projectId: 'p1', title: '第 201 篇', text: 'abc', sourceType: 'txt' })
  ok('篇数达上限后拒绝，且原因里带出上限数字', !over.ok && !!over.error?.includes(String(KB_MAX_DOCS)))
}

// ============ ③ 删除：文档 + 正文 + 向量块一起清 ============
{
  const kb = memKb()
  const vec = memVec()
  setKbBackend(kb)
  setVecBackend(vec)

  const r = await importDoc({ projectId: 'p1', title: '设定集', text: '剑修在雪山闭关修炼。'.repeat(20), sourceType: 'txt' })
  const id = r.doc!.id
  await putVectors([kbRow('p1', id, 0, 'a'), kbRow('p1', id, 1, 'b'), kbRow('p1', 'other-doc', 0, 'c')])

  ok('删除前：有正文', (await getDocText(id)).length > 0)
  ok('删除前：有该来源的向量块', (await loadVectors('p1')).filter(v => v.refId === id).length === 2)

  ok('removeDoc 返回成功', (await removeDoc('p1', id)) === true)
  ok('删除后：文档不在列表里', (await listDocs('p1')).length === 0)
  ok('删除后：正文被清空', (await getDocText(id)) === '')
  ok('🔴 删除后：该来源向量块被一并清（否则会召回已删内容）',
    (await loadVectors('p1')).every(v => v.refId !== id))
  ok('删除后：别的来源的块未受牵连',
    (await loadVectors('p1')).some(v => v.refId === 'other-doc'))
  ok('删除确实触发了向量清理（delByRef 被调用）', vec.delRefLog.includes(`p1::${id}`))

  ok('removeDoc 对空 id 直接 false（不误删）', (await removeDoc('p1', '')) === false)
}

// ============ ④ 🔴🔴 enabled 负面对照 + buildKbBlock 全链路 ============
{
  const kb = memKb()
  setKbBackend(kb)
  setVecBackend(memVec())

  const text = '剑修在雪山闭关，修炼的是寒冰剑意。\n\n市集上人声鼎沸，商贩叫卖着灵果。'
  const r = await importDoc({ projectId: 'p1', title: '设定集', text, sourceType: 'txt' })
  const id = r.doc!.id

  // —— 关闭态 ——
  ok('未启用：召回为空（不进上下文）', (await recallKnowledge('剑修闭关修炼', { projectId: 'p1' })).length === 0)

  db.setCurrentProject('p1')
  const deps = {
    loadChapters: async () => [{ id: 'ch1', title: '第一章', content: '剑修在雪山闭关修炼寒冰剑意' }],
    resolveConfig: async () => null,
  }
  ok('🔴 未启用：buildKbBlock 返回空串（⇒ 不会 push 任何段）',
    (await buildKbBlock({ focusChapterId: 'ch1', deps })) === '')

  // —— 打开 ——
  ok('setDocEnabled 打开成功', (await setDocEnabled('p1', id, true)) === true)
  const on = await recallKnowledge('剑修闭关修炼', { projectId: 'p1' })
  ok('启用后：召回非空', on.length > 0)
  ok('启用后：命中都来自该资料且类别为 kb', on.every(h => h.refId === id && h.kind === 'kb'))

  const blockOn = await buildKbBlock({ focusChapterId: 'ch1', deps })
  ok('🔴 启用后：buildKbBlock 产出非空块（⇒ aiContext 会 push〖参考资料〗）', blockOn.length > 0)
  ok('块内含条目标记「◆」与来源标题', blockOn.includes('◆') && blockOn.includes('设定集'))

  // —— 关掉索引不删：再开仍能召回（省一次重嵌）——
  ok('setDocEnabled 关闭成功', (await setDocEnabled('p1', id, false)) === true)
  ok('关闭后：立刻不进上下文', (await recallKnowledge('剑修闭关修炼', { projectId: 'p1' })).length === 0)
  await setDocEnabled('p1', id, true)
  ok('再次打开：无需重建索引即可召回（关闭时未删索引）',
    (await recallKnowledge('剑修闭关修炼', { projectId: 'p1' })).length > 0)

  // 焦点章不存在 ⇒ 拿不出查询文本 ⇒ 不发请求
  ok('焦点章不存在 ⇒ 空串（没有"当前写到哪"就不检索）',
    (await buildKbBlock({ focusChapterId: 'ghost', deps })) === '')

  db.setCurrentProject('')
}

// ============ ⑤ 超长文档：只注入片段、总长受预算约束 ============
{
  // renderKbHits —— 裁剪 + 预算双重约束
  const hits = Array.from({ length: 10 }, (_, i) => ({
    kind: 'kb' as const, refId: `d${i}`, chunkIdx: 0,
    text: '字'.repeat(KB_HIT_CHARS + 200), title: `资料${i}`, score: 0.9, secret: false,
  }))
  const rendered = renderKbHits(hits)
  ok('renderKbHits：单条片段被裁到 KB_HIT_CHARS 内',
    !rendered.includes('字'.repeat(KB_HIT_CHARS + 1)))
  ok('renderKbHits：总长受默认预算（2400）约束', rendered.length <= 2400)
  const segCount = rendered.split('\n\n').length - 1
  ok('renderKbHits：不是把所有命中都塞进去', segCount > 0 && segCount < hits.length)
  ok('renderKbHits：空命中 → 空串', renderKbHits([]) === '')
  ok('renderKbHits：预算变小时结果更短', renderKbHits(hits, 1000).length <= 1000)

  // recallKnowledge —— 条数受 KB_TOP_K 约束
  const kb = memKb()
  setKbBackend(kb)
  for (let i = 0; i < 5; i++) {
    const d = await importDoc({ projectId: 'p1', title: `资料${i}`, text: '剑修在雪山闭关修炼寒冰剑意', sourceType: 'txt' })
    await setDocEnabled('p1', d.doc!.id, true)
  }
  const many = await recallKnowledge('剑修闭关修炼', { projectId: 'p1' })
  ok('多篇命中：至少捞到几条', many.length > 0)
  ok('多篇命中：总条数不超过 KB_TOP_K', many.length <= KB_TOP_K)
  const perDoc = new Map<string, number>()
  for (const h of many) perDoc.set(h.refId, (perDoc.get(h.refId) ?? 0) + 1)
  ok('单篇最多贡献 2 条（防一篇长文刷满名额）', [...perDoc.values()].every(n => n <= 2))
}

// ============ ⑥ 未配置 embedding ⇒ 关键词降级；任何失败都不抛 ============
{
  const kb = memKb()
  setKbBackend(kb)
  const r = await importDoc({ projectId: 'p1', title: '设定集', text: '剑修在雪山闭关修炼寒冰剑意。', sourceType: 'txt' })
  await setDocEnabled('p1', r.doc!.id, true)

  const hits = await recallKnowledge('剑修闭关修炼', { projectId: 'p1', cfg: null })
  ok('🔴 未配嵌入：关键词降级仍能召回', hits.length > 0)
  ok('未配嵌入：返回数组而非抛出', Array.isArray(hits))
  ok('降级命中带出处与类别', hits.every(h => h.kind === 'kb' && h.refId === r.doc!.id))

  // ⚠️ 查询词要用**真正零交集**的：CJK 单字 token 的召回面很广（如「关」能在「闭关」里命中），
  //    所以拿中文写"无关词"很容易误判成命中。这里用纯拉丁串，文档里一个字母都没有。
  ok('查询词完全无交集 → 空数组（不抛）',
    (await recallKnowledge('zzzqqq', { projectId: 'p1', cfg: null })).length === 0)
  ok('空查询 → 空数组', (await recallKnowledge('   ', { projectId: 'p1', cfg: null })).length === 0)
  ok('缺项目 id → 空数组', (await recallKnowledge('剑修', { projectId: '', cfg: null })).length === 0)

  // 有嵌入配置、但语义召回失败 ⇒ 仍然降级关键词（不让作者白开一次「启用」）
  const fallback = await recallKnowledge('剑修闭关修炼', {
    projectId: 'p1', cfg: CFG,
    deps: { recallFn: (async () => { throw new Error('boom') }) as unknown as typeof recallRelevant },
  })
  ok('🔴 有嵌入配置但语义失败 → 降级关键词', fallback.length > 0)

  // 资料列表读失败 ⇒ 也不抛
  const listThrow = await recallKnowledge('剑修', {
    projectId: 'p1', cfg: null,
    deps: { listFn: async () => { throw new Error('db down') } },
  })
  ok('资料列表读失败 → 空数组（不抛）', listThrow.length === 0)
}

// ============ ⑦ 索引（reindexAll）+ 改名 + 删项目清理 ============
{
  const kb = memKb()
  const vec = memVec()
  setKbBackend(kb)
  setVecBackend(vec)

  const r = await importDoc({ projectId: 'p1', title: '旧名', text: multiPara(6), sourceType: 'txt' })
  const id = r.doc!.id

  ok('reindexAll：没有启用资料 → 什么都不做', (await reindexAll('p1', CFG)).docs === 0)

  await setDocEnabled('p1', id, true)

  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_u: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string[] }
    return new Response(JSON.stringify({ embeddings: (body.input ?? []).map(() => [1, 0]) }), { status: 200 })
  }) as unknown as typeof fetch

  let progressed = 0
  const rr = await reindexAll('p1', CFG, undefined, () => { progressed++ })
  ok('reindexAll：成功索引 1 篇', rr.ok && rr.docs === 1)
  ok('reindexAll：长文切出多块', rr.chunks >= 2)
  ok('reindexAll：有进度回调（界面据此显示"正在索引哪一篇"）', progressed > 0)
  ok('reindexAll：块真的写进向量库',
    (await loadVectors('p1')).filter(v => v.refId === id).length === rr.chunks)
  ok('reindexAll：chunkCount 回写进元数据',
    (await listDocs('p1')).find(d => d.id === id)?.chunkCount === rr.chunks)

  globalThis.fetch = realFetch

  // 带 cfg 的语义召回走真实路径（向量已在库里）—— 只要求不抛，有无命中都算通过
  const sem = await recallKnowledge('第0段', { projectId: 'p1', cfg: CFG })
  ok('配了嵌入且已建索引：语义召回不抛（有无命中都算通过）', Array.isArray(sem))

  ok('renameDoc 改名成功', (await renameDoc('p1', id, '新名')) === true)
  ok('改名只动元数据', (await listDocs('p1')).find(d => d.id === id)?.title === '新名')
  ok('renameDoc 拒绝空名', (await renameDoc('p1', id, '   ')) === false)

  await clearProjectDocs('p1')
  ok('clearProjectDocs：清掉项目内全部资料', (await listDocs('p1')).length === 0)
  ok('clearProjectDocs：正文也一并清', (await getDocText(id)) === '')
}

// ============ ⑧ 源码闸（结构假设必须显式钉住）============
{
  const kbSrc = read('src/lib/knowledgeBase.ts')
  ok('🔴 知识库模块不 import lib/db（否则 deleteProject → knowledgeBase → db 成环）',
    kbSrc.length > 0
    && !/from\s+['"]\.\.?\/db['"]/.test(kbSrc)
    && !/from\s+['"]\.\.?\/db\//.test(kbSrc))
  ok('知识库走独立 IndexedDB 库（不进桌面整库 JSON / 不参与云同步）',
    kbSrc.includes('youth-fantasy-engine-kb'))

  const ctx = read('src/lib/aiContext.ts')
  ok('aiContext 接入了 buildKbBlock', ctx.includes('buildKbBlock'))
  ok('aiContext 把资料块 push 成「参考资料」段', ctx.includes("push('参考资料'"))
  const iSem = ctx.indexOf("push('语义召回'")
  const iKb = ctx.indexOf("push('参考资料'")
  ok('🔴 参考资料段排在语义召回之后（语义是主线，资料是补一层）', iSem >= 0 && iKb > iSem)

  const tok = read('src/lib/tokenize.ts')
  ok('tokenize 已抽出为独立纯函数模块', tok.includes('export function tokenize'))
  const search = read('src/lib/search.ts')
  ok('🔴 search.ts 不再自己定义 tokenize（单一真源，防"搜得到但召回不到"）',
    !/export\s+function\s+tokenize/.test(search))
  ok('search.ts 从 tokenize.ts 取用', search.includes("from './tokenize'"))

  const panel = read('src/components/KnowledgeBasePanel.tsx')
  ok('界面挂了 kb-recall 数据源说明（作者才看得到"会读什么"）',
    panel.includes('feature="kb-recall"'))

  const proj = read('src/lib/db/projects.ts')
  ok('删项目时清理了知识库资料', proj.includes('clearProjectDocs'))
  ok('🔴 删项目时同时清理向量索引（补 #013 遗漏的孤儿清理）',
    proj.includes('clearProjectVectors'))
}

// ============ ⑨ 随导出 / 备份搬运（#017 的**可选项**，2026-10-04 主人拍板）============
//
// 盯四件事：
//   · 默认**不带**（开关没开时导出包里根本没有 knowledgeBase 字段）；
//   · 开关打开后带**正文 + 启用态**，且**自动备份恒定不带**（源码断言，同快照口径）；
//   · 导入 / 恢复后资料跟着回来、id 换新、启用态保持；
//   · 🔴🔴 负面对照：**不带资料的包去恢复时，现有资料一根汗毛都不能动**
//     （否则"恢复一份没开开关的旧备份"会静默清空作者全部资料 —— 这是本组最重要的一条）。
{
  __resetMockStores()
  const kb = memKb(); const vec = memVec()
  setKbBackend(kb); setVecBackend(vec)
  db.setCurrentProject('p1')
  await memoryOps.put('projects', { id: 'p1', name: '测试书', projectType: 'full', createdAt: 1, updatedAt: 1 })
  await memoryOps.put('volumes', { id: 'v1', projectId: 'p1', name: '卷一', order: 0 })
  await memoryOps.put('chapters', {
    id: 'c1', projectId: 'p1', volumeId: 'v1', title: '第1章', content: '正文内容',
    wordCount: 4, order: 0, number: 1,
  })

  const da = await importDoc({ projectId: 'p1', title: '设定集', text: '雪山剑修设定。'.repeat(30), sourceType: 'txt' })
  const db2 = await importDoc({ projectId: 'p1', title: '随手笔记', text: '写作用的小笔记。'.repeat(30), sourceType: 'md' })
  await setDocEnabled('p1', da.doc!.id, true)
  ok('准备：项目里 2 篇资料（1 篇启用）',
    (await listDocs('p1')).length === 2 && (await listDocs('p1')).filter(d => d.enabled).length === 1)

  // ① 默认不带
  const noKb = await db.exportProject('p1', { includeSnapshots: false })
  ok('🔴 开关未开 ⇒ 导出包里**没有** knowledgeBase 字段（老格式完全兼容）', noKb.knowledgeBase === undefined)

  // ② 打开开关 ⇒ 带上正文与启用态
  await db.setSetting(db.KB_IN_BACKUP_KEY, true)
  const withKb = await db.exportProject('p1', { includeSnapshots: false })
  ok('开关打开 ⇒ 包里有 2 篇资料', (withKb.knowledgeBase?.length ?? 0) === 2)
  ok('包里带的是**正文**（不是只有元数据）',
    (withKb.knowledgeBase ?? []).every(d => d.text.length > 0))
  ok('启用态随包带走', (withKb.knowledgeBase ?? []).filter(d => d.enabled).length === 1)
  ok('包里不带旧 id（导入时另生成，防同机二次导入互相覆盖）',
    (withKb.knowledgeBase ?? []).every(d => !('id' in (d as object))))

  // ③ 自动备份恒定不带（源码断言 —— 走全链路太重，且这条是"口径"而非"行为"）
  const bsrc = read('src/lib/db/backups.ts')
  ok('🔴 自动备份显式传 includeKnowledgeBase: false（同快照口径）',
    /includeKnowledgeBase:\s*false/.test(bsrc))
  ok('🔴 恢复备份时只在包带了资料才动（否则会清空作者现有资料）',
    /if\s*\(bundle\.knowledgeBase\)/.test(bsrc))

  // ④ 导入成新项目 ⇒ 资料跟着回来
  const newPid = await db.importProject(withKb)
  const imported = await listDocs(newPid)
  ok('导入项目后资料跟着回来（2 篇）', imported.length === 2)
  ok('🔴 导入后 id 全部换新（不覆盖本机已有资料）',
    imported.every(d => d.id !== da.doc!.id && d.id !== db2.doc!.id))
  ok('导入后启用态保持（1 篇启用）', imported.filter(d => d.enabled).length === 1)
  ok('导入后正文完好',
    (await getDocText(imported.find(d => d.title === '设定集')!.id)).includes('雪山剑修设定'))

  // ⑤ 🔴 负面对照：不带资料的包，恢复后现有资料**一根汗毛都不动**
  const beforeCount = (await listDocs('p1')).length
  const beforeIds = (await listDocs('p1')).map(d => d.id).sort().join(',')
  await db.restoreBundleToProject('p1', noKb)
  const afterCount = (await listDocs('p1')).length
  ok('🔴🔴 不带资料的包恢复时**不清**现有资料', afterCount === beforeCount, `${beforeCount} → ${afterCount}`)
  ok('🔴🔴 且资料 id 完全没变（是"没碰"，不是"删了又建"）',
    (await listDocs('p1')).map(d => d.id).sort().join(',') === beforeIds)

  // ⑥ 包带资料 ⇒ 恢复 = 回到包里那一刻（先清后写）
  await removeDoc('p1', (await listDocs('p1'))[0].id) // 先人为删一篇，制造"现状与包不同"
  await db.restoreBundleToProject('p1', withKb)
  const restored = await listDocs('p1')
  ok('带资料的包恢复 ⇒ 还原成包里的样子（2 篇）', restored.length === 2)
  ok('恢复后启用态按包走', restored.filter(d => d.enabled).length === 1)
  ok('恢复后标题都在', ['设定集', '随手笔记'].every(t => restored.some(d => d.title === t)))

  // ⑦ 界面：勾选与文案
  const panel = read('src/components/KnowledgeBasePanel.tsx')
  ok('面板提供「随导出 / 备份带走」勾选（读同一设置键）', panel.includes('db.KB_IN_BACKUP_KEY'))
  ok('面板写明「自动备份不含资料」（否则作者会以为备份也带上了）', panel.includes('自动备份'))
  ok('源码闸：导出侧读的是**按项目**的设置键，不是全局',
    read('src/lib/db/projects.ts').includes('kbInBackup'))

  db.setCurrentProject('')
}

// ============ ⑩ 还原 / 导入后**自动重建索引**（#017 收尾，2026-10-04）============
//
// 背景：`restoreDocsFromBundle` 恢复时会把旧资料连同向量块一起清空（正确），写回的新文档
//   `enabled` 按包还原但 `chunkCount: 0` ⇒ 「界面显示已启用、检索却捞不到」的**静默降级**。
// 本组盯三件事：
//   · 没有「已启用」资料 ⇒ **不起任务**（静默 no-op，不给作者添噪音）；
//   · 有「已启用」资料但未配嵌入模型 ⇒ 起一条任务并**如实说明**（静默失败＝本项目 P0）；
//   · 任务挂在素材页同一 (ownerTab, kind) ⇒ 与手动「重建索引」天然互斥，不白烧两遍额度。
{
  __resetMockStores()
  setKbBackend(memKb()); setVecBackend(memVec())
  db.setCurrentProject('p2')
  await memoryOps.put('projects', { id: 'p2', name: '还原测试', projectType: 'full', createdAt: 1, updatedAt: 1 })

  /** 等任务中心跑空（`startTask` 是同步建记录 + 异步执行，这里轮询到没有 running 为止） */
  const waitIdle = async (ms = 3000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (!tasksSnapshot().some(t => t.status === 'running')) return
      await new Promise(r => setTimeout(r, 10))
    }
  }

  // ① 无启用资料 ⇒ 静默 no-op
  resetTaskCenter()
  await rebuildKbIndexAfterRestore('p2')
  await waitIdle()
  ok('⑩① 没有已启用资料 ⇒ 不产生任何任务（静默 no-op）', tasksSnapshot().length === 0, `tasks=${tasksSnapshot().length}`)

  // ② 有启用资料 + 未配嵌入模型 ⇒ 起一条任务并如实说明
  const d = await importDoc({ projectId: 'p2', title: '设定集', text: '雪山剑修的设定。'.repeat(50), sourceType: 'txt' })
  await setDocEnabled('p2', d.doc!.id, true)
  resetTaskCenter()
  await rebuildKbIndexAfterRestore('p2')
  await waitIdle()
  const ts = tasksSnapshot()
  ok('⑩② 有已启用资料 ⇒ 起了一条任务', ts.length === 1, `tasks=${ts.length}`)
  ok('⑩② 任务挂在素材页的 kb-index 槽位（同键 ⇒ 与手动重建互斥）',
    ts[0]?.ownerTab === 'material-library' && ts[0]?.kind === 'kb-index')
  const r2 = (ts[0]?.result ?? null) as { ok?: boolean; error?: string } | null
  ok('⑩② 🔴 未配嵌入模型时**如实报**（不假装成功、不静默）',
    ts[0]?.status === 'done' && r2?.ok === false && /未配置嵌入模型/.test(String(r2?.error ?? '')),
    `status=${ts[0]?.status} ok=${r2?.ok}`)
  ok('⑩② 如实说明里给了下一步（去哪配 / 去哪重建）',
    /语义检索/.test(String(r2?.error ?? '')) && /重建索引/.test(String(r2?.error ?? '')))

  // ③ 空 projectId ⇒ 直接返回（防「没开项目也去建索引」）
  resetTaskCenter()
  await rebuildKbIndexAfterRestore('')
  await waitIdle()
  ok('⑩③ 空 projectId ⇒ 不起任务', tasksSnapshot().length === 0)

  // ④ 独立库**读失败** ⇒ 不能当成「没有资料」静默跳过（2026-10-04 六维审计）
  //    吞错版把「读失败」和「确实没资料」压成同一个空数组 ⇒ 一次真实的库故障会被伪装成
  //    「这次还原没有资料要建索引」，作者永远不知道索引没建上。必须**如实起一条任务说明**。
  resetTaskCenter()
  setKbBackend({ ...memKb(), list: async () => { throw new Error('独立库损坏') } })
  await rebuildKbIndexAfterRestore('p2')
  await waitIdle()
  const ts4 = tasksSnapshot()
  ok('⑩④ 🔴 库读失败 ⇒ 起一条任务如实报（不静默跳过）', ts4.length === 1, `tasks=${ts4.length}`)
  const r4 = (ts4[0]?.result ?? null) as { ok?: boolean; error?: string } | null
  ok('⑩④ 说明里点明「读不到库」+ 给了下一步（去哪重建）',
    ts4[0]?.status === 'done' && r4?.ok === false
      && /读不到参考资料库/.test(String(r4?.error ?? ''))
      && /重建索引/.test(String(r4?.error ?? '')),
    `status=${ts4[0]?.status} err=${String(r4?.error ?? '')}`)
  setKbBackend(memKb()) // 还原后端，免得影响后续用例

  resetTaskCenter()
  db.setCurrentProject('')
}

// ============ ⑪ 源码闸：自动重建的接线与边界 ============
{
  const helper = read('src/lib/kbRestoreIndex.ts')
  ok('⑪ 自动重建模块存在', helper.length > 0)
  ok('🔴 复用素材页同一任务槽位（同 ownerTab/kind ⇒ 与手动重建互斥）',
    helper.includes('material-library') && helper.includes('kb-index'))
  // 🔴 2026-10-04 六维审计后改版：从吞错的 `kbStats` 换成 `listDocsStrict`。
  //    原因是「读失败」和「本来就没资料」在吞错版里是同一个结果，判定型调用会静默走错分支。
  ok('自动重建先读**严格版**列表、按启用数判断（没有启用资料就不起任务）',
    helper.includes('listDocsStrict') && helper.includes('d.enabled') && helper.includes('if (!enabled) return'))
  ok('🔴 读失败不静默跳过 —— 起 info 任务如实说明（不把故障伪装成「没资料」）',
    helper.includes('catch') && helper.includes('读不到参考资料库'))
  ok('🔴 未配嵌入模型时走「如实说明」分支（不静默失败）',
    helper.includes('embeddingStatus') && helper.includes('未配置嵌入模型'))
  ok('🔴 全量重建走 reindexAll 且透传 ctx.signal（可中止）',
    helper.includes('reindexAll') && helper.includes('ctx.signal'))
  ok('🔴 本模块不 import lib/db（否则 db → kbRestoreIndex → semantic/settings → db 成环）',
    !/from\s+['"]\.\.?\/db['"]/.test(helper) && !/from\s+['"]\.\.\/db\//.test(helper))
  ok('🔴 也没有反向：lib/db 下任何文件都不 import kbRestoreIndex（环的另一半）',
    ['projects', 'backups', 'chapters', 'tabs', 'migrations', 'worldSets', 'tavernReports']
      .every(f => !read(`src/lib/db/${f}.ts`).includes('kbRestoreIndex')))

  for (const [file, n, why] of [
    ['src/components/BackupManager.tsx', 3, '恢复历史备份 / 从备份文件恢复 / 导入迁移包'],
    ['src/components/ProjectHub.tsx', 1, '项目管理页导入迁移包'],
    ['src/components/WelcomeWizard.tsx', 1, '首启向导导入备份'],
  ] as const) {
    const src = read(file)
    const hits = (src.match(/rebuildKbIndexAfterRestore\(/g) ?? []).length
    ok(`🔴 ${file}：${why} 都接上了自动重建`, hits === n, `实际 ${hits} / 期望 ${n}`)
  }
}

console.log(`\n—— knowledgeBase 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
