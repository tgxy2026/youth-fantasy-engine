// ============ 知识库 · 长期挂载的外部参考资料（2.8.0 · 台账 #017）============
//
// 与「拆书」的区别：拆书是**一次性**抽取设定、抽完即散；这里是**持续可用**的参考文档
// （设定集 / 资料 / 笔记），写作时按需召回片段注入上下文。
//
// 🔴🔴 存储策略（与 #013 的向量库同一套理由，逐条都是踩过才知道的）：
//   · **独立 IndexedDB 库 `youth-fantasy-engine-kb`**，不走 `lib/db` 门面 ⇒ 不进桌面整库 JSON
//     （长文档几 MB，塞进去等于每存一章就重写几 MB）、不进云同步、不进备份。
//   · **分两个 store**：`docs` 只放元数据、`bodies` 放正文。
//     不分开的话，列表页（要显示标题 / 字数 / 启用状态）就得把每篇正文都拉回来 —— 纯浪费。
//   · 主人 2026-10-04 拍板：**资料不随备份 / 导出走**（迁移包不因长文档膨胀；
//     与素材页「只读、不进项目数据」的口径一致）。
//
// 🔴 本模块**不 import `lib/db`**，`projectId` 一律由调用方传入。两个理由：
//   ① `db/projects.ts` 的 `deleteProject` 要调本模块清理（删项目须一并清资料），
//      本模块再 import `db` 就**成环**；
//   ② 与 `semantic/store.ts` 同思路 —— 纯参数化的存储层天然可单测（Node 无 IndexedDB）。
//   ⚠️ 同理也不 import `semantic/settings`（它 import db）—— 嵌入配置由调用方解析好传进来。
//
// 🔴 默认关闭：`importDoc` 落 `enabled: false` ⇒ **不切块、不嵌入**（省嵌入额度）。
//    作者在界面上勾选启用后才建索引、才进上下文 —— 这就是方案 §5.4 说的「不显式开启不生效」。

import { openDB, type IDBPDatabase } from 'idb'
import { idbDbExists, idbDeleteDatabase } from '@/lib/storage/idbMigrateUtil'
import { uid } from '@/lib/app/id'
import { tokenize } from '@/lib/editor/tokenize'
import { chunkChapter } from '@/lib/semantic/chunk'
import { indexOneDoc } from '@/lib/semantic/indexDoc'
import type { EmbedConfig } from '@/lib/semantic/embed'
import { recallRelevant, type RecallHit } from '@/lib/semantic/recall'
import { removeByRef } from '@/lib/semantic/store'

export type KbSourceType = 'txt' | 'md' | 'docx' | 'paste'

export interface KbDoc {
  id: string
  projectId: string
  title: string
  sourceType: KbSourceType
  /** 正文字符数 */
  chars: number
  /** 已索引块数（0 = 未建索引 或 正文为空） */
  chunkCount: number
  importedAt: number
  /** 🔴 默认 false：导入时不切块、不嵌入，作者显式开启才进上下文 */
  enabled: boolean
}

export interface KbStats {
  docs: number
  enabled: number
  chunks: number
}

/** 召回条数上限（参考资料是"补一层"，不该挤占正文写作预算） */
export const KB_TOP_K = 4
/** 单篇字符上限（约 40 万字）—— 超了截断，并**如实告知**作者（不静默丢） */
export const KB_MAX_CHARS = 400_000
/** 单项目文档数上限（防呆；纯本地库，但列表全量渲染也得有个头） */
export const KB_MAX_DOCS = 200

const KB_DB_NAME = 'youth-fantasy-engine-kb'
const KB_DB_VERSION = 1
const STORE_DOCS = 'docs'
const STORE_BODIES = 'bodies'

// ============ 存储后端（可注入，供单测）============

export interface KbBackend {
  list(projectId: string): Promise<KbDoc[]>
  put(doc: KbDoc): Promise<void>
  del(id: string): Promise<void>
  getBody(id: string): Promise<string>
  putBody(id: string, text: string): Promise<void>
  delBody(id: string): Promise<void>
  clearProject(projectId: string): Promise<void>
}

let kbDbPromise: Promise<IDBPDatabase<unknown>> | null = null

function getKbDB(): Promise<IDBPDatabase<unknown>> {
  if (!kbDbPromise) {
    kbDbPromise = openDB(KB_DB_NAME, KB_DB_VERSION, {
      upgrade(db) {
        // 与 db/core.ts 同款纪律：建表只在 upgrade 里、只跑一次，版本判断交给 openDB
        const docs = db.createObjectStore(STORE_DOCS, { keyPath: 'id' })
        docs.createIndex('projectId', 'projectId', { unique: false })
        db.createObjectStore(STORE_BODIES, { keyPath: 'id' })
      },
    }).catch(err => {
      // 失败时重置缓存，避免 rejected promise 被永久缓存（与 db/core.ts 同口径）
      kbDbPromise = null
      throw err
    })
  }
  return kbDbPromise
}

// 抽成具名函数而非对象方法：方法里的 `this` 一旦被解构调用就丢绑定
async function idbList(projectId: string): Promise<KbDoc[]> {
  const db = await getKbDB()
  return (await db.getAllFromIndex(STORE_DOCS, 'projectId', projectId)) as KbDoc[]
}

const idbKbBackend: KbBackend = {
  list: idbList,
  put: async doc => { (await getKbDB()).put(STORE_DOCS, doc) },
  del: async id => { (await getKbDB()).delete(STORE_DOCS, id) },
  getBody: async id => {
    const row = await (await getKbDB()).get(STORE_BODIES, id) as { id: string; text: string } | undefined
    return row?.text ?? ''
  },
  putBody: async (id, text) => { (await getKbDB()).put(STORE_BODIES, { id, text }) },
  delBody: async id => { (await getKbDB()).delete(STORE_BODIES, id) },
  clearProject: async projectId => {
    const db = await getKbDB()
    const ids = (await idbList(projectId)).map(d => d.id)
    for (const id of ids) {
      await db.delete(STORE_DOCS, id)
      await db.delete(STORE_BODIES, id)
    }
  },
}

let kbBackend: KbBackend = idbKbBackend

/**
 * 替换存储后端。**仅供单测**（Node 无 `indexedDB`）与将来的「内存模式」复用。
 * 与 `semantic/store.ts` 的 `setVecBackend` 同构。传 `null` 复位回默认 IndexedDB 后端。
 */
export function setKbBackend(b: KbBackend | null): void {
  kbBackend = b ?? idbKbBackend
}

// ============ 读接口（永不抛：资料读不出来不该阻断写作）============

/**
 * 列出项目内的参考资料（按导入时间倒序 —— 最近导入的排最前）。
 * **永不抛**：资料读不出来不该阻断写作，调用方拿到空数组即可（展示型调用用它）。
 */
export async function listDocs(projectId: string): Promise<KbDoc[]> {
  if (!projectId) return []
  try {
    return await listDocsStrict(projectId)
  } catch {
    return []
  }
}

/**
 * `listDocs` 的**严格版**：读不出来就抛。
 * 🔴 为什么必须有一份会抛的（2026-10-04 六维审计）：
 *    吞错版把「独立库读失败」和「这个项目确实没有资料」压成同一个结果（空数组），
 *    于是「还原后该不该重建索引」这类**判定型**调用会静默走错分支 —— 一次真实故障
 *    被当成「本来就没资料」。判定型调用一律用本函数、并把失败如实说出来。
 */
export async function listDocsStrict(projectId: string): Promise<KbDoc[]> {
  if (!projectId) return []
  const rows = await kbBackend.list(projectId)
  return rows.sort((a, b) => b.importedAt - a.importedAt)
}

/** 取某一篇的正文（**永不抛**：不存在 / 读失败都返回空串 —— 召回降级链路用） */
export async function getDocText(id: string): Promise<string> {
  if (!id) return ''
  try {
    return await getDocTextStrict(id)
  } catch {
    return ''
  }
}

/**
 * `getDocText` 的**严格版**：读不出来就抛。
 * 🔴 建索引必须用它：吞错版会把「读失败」伪装成「这篇正文是空的」，
 *    而 `reindexDoc` 拿到空文本会**清掉本篇已有向量块、还报成功** ——
 *    一次读取故障就此变成一次静默的数据降级。
 */
async function getDocTextStrict(id: string): Promise<string> {
  if (!id) throw new Error('资料 id 为空')
  return kbBackend.getBody(id)
}

/** 统计（界面状态行用） */
export async function kbStats(projectId: string): Promise<KbStats> {
  const docs = await listDocs(projectId)
  return {
    docs: docs.length,
    enabled: docs.filter(d => d.enabled).length,
    chunks: docs.reduce((n, d) => n + (d.chunkCount || 0), 0),
  }
}

// ============ 写接口 ============

export interface ImportDocInput {
  projectId: string
  title: string
  text: string
  sourceType: KbSourceType
  /**
   * 是否直接启用（默认 **false**）。
   * 界面上的「导入」一律不传 ⇒ 不切块、不嵌入，等作者显式勾选；
   * 只有**从导出包还原**（`restoreDocsFromBundle`）才按包里的原状态传 —— 还原要还原成一模一样。
   */
  enabled?: boolean
}

export interface ImportDocResult {
  ok: boolean
  doc?: KbDoc
  /** 正文被截断（超过 KB_MAX_CHARS）时为 true —— 界面须如实提示 */
  truncated?: boolean
  error?: string
}

/** 归一化正文：统一换行、去首尾空、压缩 3 连以上空行（长文档里常见的一堆空段） */
function normalizeText(raw: string): string {
  return (raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 导入一篇参考资料。
 * 🔴 **只落库，不切块、不嵌入**（`enabled: false`）—— 省额度，等作者显式勾选启用再建索引。
 */
export async function importDoc(input: ImportDocInput): Promise<ImportDocResult> {
  const { projectId } = input
  if (!projectId) return { ok: false, error: '缺少项目 id' }
  const existing = await listDocs(projectId)
  if (existing.length >= KB_MAX_DOCS) {
    return { ok: false, error: `单个项目最多挂载 ${KB_MAX_DOCS} 篇参考资料，请先删掉一些` }
  }
  const full = normalizeText(input.text)
  if (!full) return { ok: false, error: '内容是空的' }
  const truncated = full.length > KB_MAX_CHARS
  const text = truncated ? full.slice(0, KB_MAX_CHARS) : full

  const doc: KbDoc = {
    id: uid(),
    projectId,
    title: (input.title ?? '').trim() || '未命名资料',
    sourceType: input.sourceType,
    chars: text.length,
    chunkCount: 0,
    importedAt: Date.now(),
    enabled: input.enabled === true,
  }
  try {
    await kbBackend.put(doc)
    await kbBackend.putBody(doc.id, text)
  } catch (e) {
    return { ok: false, error: `写入失败：${e instanceof Error ? e.message : String(e)}` }
  }
  return { ok: true, doc, truncated }
}

/** 删除一篇：元数据 + 正文 + **它的全部向量块**（不删就会召回已删除的内容） */
export async function removeDoc(projectId: string, id: string): Promise<boolean> {
  if (!id) return false
  try {
    await kbBackend.del(id)
    await kbBackend.delBody(id)
  } catch {
    return false
  }
  // 向量块清理失败不该让"删除"看起来失败 —— 元数据已经没了，召回时也拿不到它
  try { if (projectId) await removeByRef(projectId, id) } catch { /* 忽略 */ }
  return true
}

/** 按 id 取一篇（文档数上限 KB_MAX_DOCS，全量 list 再 find 不贵） */
async function findDoc(projectId: string, id: string): Promise<KbDoc | null> {
  if (!id) return null
  const list = await listDocs(projectId)
  return list.find(d => d.id === id) ?? null
}

/**
 * 开启 / 关闭某一篇的「参与召回」。
 * 🔴 关闭时**不删索引** —— 再打开就不必重嵌一次（省额度）；召回侧按 `enabled` 过滤。
 */
export async function setDocEnabled(projectId: string, id: string, enabled: boolean): Promise<boolean> {
  const doc = await findDoc(projectId, id)
  if (!doc) return false
  try {
    await kbBackend.put({ ...doc, enabled })
    return true
  } catch {
    return false
  }
}

/** 改名（只动元数据；下次重建索引时新标题才会写进块里） */
export async function renameDoc(projectId: string, id: string, title: string): Promise<boolean> {
  const t = (title ?? '').trim()
  if (!t) return false
  const doc = await findDoc(projectId, id)
  if (!doc) return false
  try {
    await kbBackend.put({ ...doc, title: t })
    return true
  } catch {
    return false
  }
}

// ============ 索引（复用 #013 的向量层；正文为空 ⇒ 清掉旧块）============

/** 重写某一篇的索引。切块 / 嵌入 / 落库全程复用 `indexOneDoc`（与章节同一套实现） */
export async function reindexDoc(
  projectId: string,
  id: string,
  cfg: EmbedConfig,
  signal?: AbortSignal,
): Promise<{ ok: boolean; chunks: number; error?: string }> {
  const doc = await findDoc(projectId, id)
  if (!doc) return { ok: false, chunks: 0, error: '资料不存在' }
  // 🔴 用严格读（不用吞错的 `getDocText`）：读失败必须如实失败、**保留原索引**，
  //    否则空文本会被当成「这篇是空的」→ 清掉已有向量块还报 ok，静默降级。
  let text: string
  try {
    text = await getDocTextStrict(id)
  } catch (e) {
    return { ok: false, chunks: 0, error: `读取资料正文失败：${e instanceof Error ? e.message : String(e)}` }
  }
  const r = await indexOneDoc(
    { kind: 'kb', refId: id, title: doc.title, text, secret: false },
    projectId, cfg, signal,
  )
  // 计数没写上不影响召回（它只是状态行上的数字），所以不因它失败而判整次失败
  if (r.ok) {
    try { await kbBackend.put({ ...doc, chunkCount: r.chunks }) } catch { /* 忽略 */ }
  }
  return r
}

export interface ReindexProgress {
  done: number
  total: number
  /** 正在索引哪一篇（界面上说清楚，长文档时作者才知道没卡住） */
  title: string
}

/** 重建**所有已启用**资料的索引（界面上的「重建索引」按钮） */
export async function reindexAll(
  projectId: string,
  cfg: EmbedConfig,
  signal?: AbortSignal,
  onProgress?: (p: ReindexProgress) => void,
): Promise<{ ok: boolean; docs: number; chunks: number; failed: number; error?: string }> {
  const docs = (await listDocs(projectId)).filter(d => d.enabled)
  const out = { ok: true, docs: 0, chunks: 0, failed: 0 }
  if (docs.length === 0) return out
  for (let i = 0; i < docs.length; i++) {
    if (signal?.aborted) return { ...out, ok: false, error: '已取消' }
    onProgress?.({ done: i, total: docs.length, title: docs[i].title })
    const r = await reindexDoc(projectId, docs[i].id, cfg, signal)
    if (r.ok) {
      out.docs++
      out.chunks += r.chunks
    } else {
      out.failed++
    }
  }
  onProgress?.({ done: docs.length, total: docs.length, title: '' })
  return out
}

// ============ 召回 ============

export interface RecallKnowledgeOptions {
  projectId: string
  /** 嵌入配置。为 null / 不传 ⇒ 走关键词降级（#017 刻意**不硬依赖** #013） */
  cfg?: EmbedConfig | null
  topK?: number
  signal?: AbortSignal
  /** 单测注入点（生产不传） */
  deps?: {
    listFn?: (projectId: string) => Promise<KbDoc[]>
    bodyFn?: (id: string) => Promise<string>
    recallFn?: typeof recallRelevant
  }
}

/**
 * 从「已启用」的参考资料里召回与 `query` 最相关的片段。
 *
 * 🔴 **永不抛**：任何一步失败都返回 `[]`，调用方只需判断"有没有拿到东西"。
 * 🔴 两级降级：有嵌入配置走语义（复用 #013）→ 没捞到（多半是还没建索引）
 *    就往下降级到关键词 —— 不让作者白开一次「启用」。
 */
export async function recallKnowledge(
  query: string,
  opts: RecallKnowledgeOptions,
): Promise<RecallHit[]> {
  const q = (query ?? '').trim()
  if (!q || !opts.projectId) return []
  const topK = Math.max(1, opts.topK ?? KB_TOP_K)

  const docs = await (opts.deps?.listFn ?? listDocs)(opts.projectId).catch(() => [] as KbDoc[])
  const enabled = docs.filter(d => d.enabled)
  if (enabled.length === 0) return []

  if (opts.cfg) {
    const doRecall = opts.deps?.recallFn ?? recallRelevant
    const disabled = new Set(docs.filter(d => !d.enabled).map(d => d.id))
    const hits = await doRecall(q, {
      projectId: opts.projectId,
      cfg: opts.cfg,
      kinds: ['kb'],
      topK,
      // 未启用的整条排除（索引可能还在 —— 取消启用时故意不删，省一次重嵌）
      excludeRefIds: disabled,
      perRefCap: 2,
      signal: opts.signal,
    }).catch(() => [] as RecallHit[])
    if (hits.length > 0) return hits
  }
  return keywordHits(q, enabled, topK, opts.deps?.bodyFn ?? getDocText)
}

/**
 * 关键词降级（**不碰向量库**）。
 *
 * 🔴 为什么直接读正文现场切块，而不是去读已索引的块：这样它对 #013 **零依赖** ——
 *    作者没配嵌入模型也能用参考资料（只是排序靠字面命中数，比语义差）。
 *    代价是每次召回都要读正文 + 切块；但挂载篇数通常是个位数。
 */
async function keywordHits(
  query: string,
  docs: KbDoc[],
  topK: number,
  bodyFn: (id: string) => Promise<string>,
): Promise<RecallHit[]> {
  const q = new Set(tokenize(query))
  if (q.size === 0) return []
  const scored: { hit: RecallHit; hits: number }[] = []
  for (const d of docs) {
    const text = await bodyFn(d.id).catch(() => '')
    if (!text.trim()) continue
    for (const c of chunkChapter(text)) {
      const tokens = new Set(tokenize(c.text))
      let hit = 0
      for (const t of q) if (tokens.has(t)) hit++
      if (hit === 0) continue
      scored.push({
        hit: {
          kind: 'kb', refId: d.id, chunkIdx: c.idx, text: c.text,
          title: d.title, score: hit / q.size, secret: false,
        },
        hits: hit,
      })
    }
  }
  scored.sort((a, b) => b.hits - a.hits
    || a.hit.title.localeCompare(b.hit.title)
    || a.hit.chunkIdx - b.hit.chunkIdx)

  // 同一篇限流（防某一篇长文把名额刷满），与语义路径的 perRefCap 同口径
  const used = new Map<string, number>()
  const out: RecallHit[] = []
  for (const s of scored) {
    const n = used.get(s.hit.refId) ?? 0
    if (n >= 2) continue
    used.set(s.hit.refId, n + 1)
    out.push(s.hit)
    if (out.length >= topK) break
  }
  return out
}

/** 单条片段的硬上限：长文档的一段也可能很长，不能让它一个人吃掉整块预算 */
export const KB_HIT_CHARS = 700

/**
 * 渲染成可注入上下文的〖参考资料〗正文。
 *
 * 🔴 **只给片段**（方案 §5.6：长文档会吃掉大量预算 ⇒ 绝不整篇塞），
 *    且总长另受 `maxChars` 约束 —— 最终还会再过一遍 `aiContext.push` 的预算闸。
 */
export function renderKbHits(hits: RecallHit[], maxChars = 2400): string {
  if (!hits || hits.length === 0) return ''
  const head = '（以下是从你挂载的参考资料里、按与当前章节「意思相近」捞出的片段，仅供参照，不是必须遵循的设定）'
  const out: string[] = [head]
  let used = head.length
  for (const h of hits) {
    const t = (h.text ?? '').trim()
    if (!t) continue
    const body = t.length > KB_HIT_CHARS ? t.slice(0, KB_HIT_CHARS) + '…' : t
    const seg = `◆ ${h.title || '参考资料'}\n${body}`
    if (used + seg.length > maxChars && out.length > 1) break
    out.push(seg)
    used += seg.length + 1
  }
  return out.length > 1 ? out.join('\n\n') : ''
}

/**
 * 删项目时的清理（`db/projects.ts` 的 `deleteProject` 调它）。
 * ⚠️ 向量块由调用方一并 `clearProjectVectors(projectId)` —— 归属不同模块，各自清各自的。
 */
export async function clearProjectDocs(projectId: string): Promise<void> {
  if (!projectId) return
  try {
    await kbBackend.clearProject(projectId)
  } catch {
    /* 清理失败不阻断删除项目 */
  }
}

// ============ 随导出 / 备份搬运（可选功能，默认关闭）============
//
// 2026-10-04 主人拍板：参考资料**默认不随备份 / 导出走**（长文档几 MB，塞进迁移包会迅速膨胀），
// 但给一个**可选项** —— 作者在「我的参考资料」面板勾上，导出 / 导出备份文件时就一并带走。
// 🔴 **自动备份（每 5 分钟 / 每日）恒定不带**（与快照那条同口径），否则高频全量会迅速撑大本地数据文件。
//
// ⚠️ 为什么 `KbBundleDoc` 不复用 `KbDoc`：包里的资料**不带 id / projectId** ——
//    导入时必须换新 id（与 volumes / chapters / cardRecords 同一套纪律），
//    留着旧 id 会在「同一台机器导入两份」时互相覆盖。

/** 导出包里的单篇资料（含正文；id 由导入方重新生成） */
export interface KbBundleDoc {
  title: string
  sourceType: KbSourceType
  chars: number
  importedAt: number
  enabled: boolean
  text: string
}

/** 收集项目内全部资料（含正文），供「随导出 / 备份带走」用。读不出就返回空数组，永不抛。 */
export async function collectDocsForBundle(projectId: string): Promise<KbBundleDoc[]> {
  const docs = await listDocs(projectId)
  const out: KbBundleDoc[] = []
  for (const d of docs) {
    const text = await getDocText(d.id)
    out.push({
      title: d.title,
      sourceType: d.sourceType,
      chars: d.chars,
      importedAt: d.importedAt,
      enabled: d.enabled,
      text,
    })
  }
  return out
}

/**
 * 把导出包里的资料写回项目（导入项目 / 恢复备份时用）。
 *
 * 🔴 **先清空**：恢复的语义是「回到那一刻」，不清就会新旧混在一起。
 *    因此调用方**必须先确认 bundle 真的带了资料**才调它 —— 否则「没开开关的备份」
 *    会把作者现有的资料清干净（`applyBundleToProject` 里有这道守卫）。
 * 🔴 清空时**连向量块一起清**：正文都换了，旧块仍留在索引里就会变成"指向已删资料的幽灵块"，
 *    召回时混进上下文（且从界面上完全看不出原因）。
 * @returns 成功写回的篇数（单篇失败不中断 —— 走 `importDoc` 的上限 / 截断规则）
 */
export async function restoreDocsFromBundle(projectId: string, bundleDocs: KbBundleDoc[]): Promise<number> {
  if (!projectId) return 0
  const old = await listDocs(projectId)
  // 🔴 清空失败必须**中止**（不能吞掉继续往下写）：恢复的语义是「回到那一刻」，
  //    旧资料没清干净就写新的，两边会混在一起 —— 而且界面上完全看不出哪条是哪条。
  //    ⚠️ 与 `clearProjectDocs`（删项目用、刻意吞错）口径不同：那条路失败的代价只是残留占空间，
  //    这条路的代价是**数据可信度**，所以这里直接走 backend、让异常往上抛。
  await kbBackend.clearProject(projectId)
  for (const d of old) {
    // 逐篇按 ref 清（**不能**用 clearProjectVectors —— 那会连章节的语义索引一起清掉）
    try { await removeByRef(projectId, d.id) } catch { /* 清不掉也只是残留块，不阻断还原 */ }
  }
  let n = 0
  for (const d of bundleDocs ?? []) {
    const r = await importDoc({
      projectId,
      title: d.title,
      text: d.text,
      sourceType: d.sourceType,
      enabled: d.enabled === true,
    })
    if (r.ok) n++
  }
  return n
}

/**
 * 3.0 · W0-2 迁移：把旧品牌知识库（docs + bodies 两个 store）全量搬到当前库，然后删旧库。**仅供迁移调用**。
 * 与 `semantic/store.ts` 的 `migrateVecFromLegacy` 同构（见那里的 LevelDB 说明）。
 */
export async function migrateKbFromLegacy(
  legacyName = 'novel-studio-kb',
): Promise<{ ok: boolean; count: number; error?: string }> {
  if (!(await idbDbExists(legacyName))) return { ok: true, count: 0 }
  let docs: unknown[] = []
  let bodies: unknown[] = []
  try {
    const old = await openDB(legacyName, KB_DB_VERSION, {
      upgrade(db) {
        const d = db.createObjectStore(STORE_DOCS, { keyPath: 'id' })
        d.createIndex('projectId', 'projectId', { unique: false })
        db.createObjectStore(STORE_BODIES, { keyPath: 'id' })
      },
    })
    docs = await old.getAll(STORE_DOCS)
    bodies = await old.getAll(STORE_BODIES)
    old.close()
  } catch (e) {
    return { ok: false, count: 0, error: '读取旧知识库失败：' + String((e as Error)?.message ?? e) }
  }
  try {
    const db = await getKbDB()
    const tx = db.transaction([STORE_DOCS, STORE_BODIES], 'readwrite')
    for (const d of docs) await tx.objectStore(STORE_DOCS).put(d)
    for (const b of bodies) await tx.objectStore(STORE_BODIES).put(b)
    await tx.done
  } catch (e) {
    return { ok: false, count: 0, error: '写入新知识库失败：' + String((e as Error)?.message ?? e) }
  }
  await idbDeleteDatabase(legacyName)
  return { ok: true, count: docs.length }
}
