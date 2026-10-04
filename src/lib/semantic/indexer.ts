// ============ 语义检索 · 索引构建 ============
//
// 🔴🔴 本文件最重要的一条：**S / D 剔除必须发生在切块之前**。
//    `isPrunedForAI`（D 级＝终结/弃用，**任何视角**都不进 AI）与 `isSecretRow`（S 级＝绝密，
//    角色视角不进）在**取数阶段**就把不合格的行挡掉 —— D 级**根本不会被嵌入**
//    （"先嵌入再过滤"等于已经把内容送给嵌入模型了，那不叫过滤，叫泄漏）。
//
//    ⚠️ S 级的处理比 D 级细一层，理由如下：
//      · D 级：不进索引，**任何情况都不召回**（与 `aiContext` 的口径逐字一致）。
//      · S 级：**进索引**，但行上打 `secret: true`；召回时若 `hideSecretRows`
//        （＝角色视角）则整条剔除。
//      为什么 S 级不干脆也不进索引：S 级是「**角色**不能知道」，而作者视角本来就要用
//      （`buildProjectContext` 作者视角照带 S 级行，这是既有口径）。若把 S 级整类踢出索引，
//      作者会失去最有价值的召回源（底牌章节 / 结局伏笔），而那本该是他自己的工具。
//      嵌入模型是**作者自己的模型**（本地 Ollama 或他自己配的云 API），发给它 ≠ 让角色知道。
//      ⚠️ 这条与方案文档里「S 级在角色视角下整行不切」的**字面**说法有出入，
//        是刻意选择，已在交付说明里点出 —— 若作者要求严格照字面来，改这一处即可。
//
// 另一条纪律：**增量以「来源」为粒度**（一个章节 / 一条设定 = 一个来源）。
//    不做块级复用是有意的：块级复用要把旧行的 vec 全读进来（十几 MB）再写回去，
//    省下的只是"章节末尾加了几句话时少嵌一段"；而按来源重写既省内存、又不会留下
//    因块序号错位而产生的残留块。小说的修订单位本来就是"一章"，这个粒度正合适。

import * as db from '../db'
import { isPrunedForAI, isSecretRow } from '../aiContext'
import { TABS } from '../schema'
import { chunkChapter, hashOf, toVectorBuffer, type Chunk } from './chunk'
import { embedTexts, EMBED_BATCH, type EmbedConfig } from './embed'
import {
  makeVecRow, putVectors, removeByRef, clearProjectVectors, vectorIndex, vectorStats,
  refKeyOf, splitRefKey,
  type VecIndex, type VecKind, type VecRow, type VecStats,
} from './store'
// ⚠️ 方向：indexer → settings → aiCore/session → db，不回头 import indexer ⇒ 不成环。
import { loadEmbeddingSettings, resolveEmbedConfig } from './settings'

/** 一个「来源」：一章正文 / 一条设定行 / 一张角色卡 */
export interface IndexDoc {
  kind: VecKind
  refId: string
  /** 展示用标题（UI 里说"正在索引哪一条"） */
  title: string
  text: string
  /** 来源行被标为 S 级（绝密）—— 角色视角召回时整条剔除 */
  secret: boolean
}

export interface CollectInput {
  chapters: { id: string; title: string; summary?: string; content: string }[]
  tables: { tabId: string; tabName: string; rows: { id: string; data: Record<string, string> }[] }[]
  cards: { tabId: string; tabName: string; rows: { id: string; name: string; data: Record<string, string> }[] }[]
}

/** 行 → 可嵌入文本。**带列名**（"身份：剑修"）比只拼值（"剑修"）更容易被语义匹配到 */
function renderRow(data: Record<string, string> | undefined, head?: string): string {
  const lines: string[] = []
  if (head && head.trim()) lines.push(head.trim())
  for (const [k, v] of Object.entries(data ?? {})) {
    const val = (v ?? '').trim()
    if (!val) continue
    // 内部字段（子集标记之类）不参与语义 —— 它们只是结构占位
    if (!k.trim() || k.endsWith('::')) continue
    lines.push(`${k}：${val}`)
  }
  return lines.join('\n').trim()
}

/**
 * 章节 → 可索引文本（**唯一口径**）。
 *
 * 三处依赖同一口径，所以必须只在这里定义一次：
 *   · `collectIndexDocs`（整库重建时切块）、
 *   · `autoIndexChapter`（保存后增量更新）、
 *   · 编辑器保存路径的「内容变没变」指纹（`useNovelEditorModel`）。
 * 🔴 若哪一处自己另拼一串（比如漏掉 `summary`），指纹就会与真实索引内容错开：
 *    要么每次保存都误判成"变了"（白烧嵌入额度），要么真变了却判成"没变"（索引停在旧版）。
 */
export function chapterIndexText(c: { title?: string; summary?: string; content?: string }): string {
  return [c.title?.trim() ?? '', c.summary?.trim() ?? '', c.content ?? '']
    .filter(x => x.trim())
    .join('\n')
    .trim()
}

/**
 * 章节内容的「变没变」指纹（＝ `chapterIndexText` 的哈希）。
 *
 * 给保存路径做**廉价首道闸**用：改状态 / 调排序 / 重复存同一份稿时，正文其实没动，
 * 不该为此去查一次索引库（一次拖拽排序会落库几十章，各查一遍全表游标就白烧时间）。
 * 用哈希而不是原文，是为了不把整章正文常驻在内存里（几千章就是几 MB）。
 */
export function chapterFingerprint(c: { title?: string; summary?: string; content?: string }): string {
  return hashOf(chapterIndexText(c))
}

/**
 * 把原始数据收敛成索引条目（**纯函数**，可单测）。
 *
 * 🔴 这里是 S/D 剔除的**唯一入口** —— 无论将来新增哪种来源（知识库 #017 等），
 *    都必须从这里过一道，别在别处另开一条"直接切块"的路。
 */
export function collectIndexDocs(input: CollectInput): IndexDoc[] {
  const out: IndexDoc[] = []

  // 章节正文：章节不是"行"，没有保密等级字段 —— S/D 判定不适用
  for (const c of input.chapters ?? []) {
    const text = chapterIndexText(c)
    if (!text) continue
    out.push({ kind: 'chapter', refId: c.id, title: c.title?.trim() || '未命名章节', text, secret: false })
  }

  // 表格行
  for (const t of input.tables ?? []) {
    for (const r of t.rows ?? []) {
      if (isPrunedForAI(r.data)) continue // 🔴 D 级：根本不进索引
      const text = renderRow(r.data)
      if (!text) continue
      out.push({ kind: 'setting', refId: r.id, title: t.tabName, text, secret: isSecretRow(r.data) })
    }
  }

  // 角色卡
  for (const t of input.cards ?? []) {
    for (const r of t.rows ?? []) {
      if (isPrunedForAI(r.data)) continue // 🔴 D 级：根本不进索引
      const text = renderRow(r.data, r.name)
      if (!text) continue
      out.push({ kind: 'setting', refId: r.id, title: r.name || t.tabName, text, secret: isSecretRow(r.data) })
    }
  }

  return out
}

/**
 * 从库里取数并收敛成索引条目。
 * 🔴 任一步读失败都**不吞**该来源之外的东西 —— 单个页签读失败跳过它，整体照常进行
 *    （索引是全量重建的活，不该因为一张表的异常就整件事失败）。
 */
export async function loadIndexDocs(): Promise<IndexDoc[]> {
  const chapters = (await db.getAllChapters().catch(() => [])) as CollectInput['chapters']

  const tables: CollectInput['tables'] = []
  const cards: CollectInput['cards'] = []
  for (const tab of TABS) {
    if (tab.type === 'table') {
      const rows = await db.getTableRows(tab.id).catch(() => [])
      if (rows.length) tables.push({ tabId: tab.id, tabName: tab.name, rows: rows.map(r => ({ id: r.id, data: r.data })) })
    } else if (tab.type === 'card') {
      const rows = await db.getCardRecords(tab.id).catch(() => [])
      if (rows.length) cards.push({ tabId: tab.id, tabName: tab.name, rows: rows.map(r => ({ id: r.id, name: r.name, data: r.data })) })
    }
  }
  // 章节台账（按卷分表存在 chapter-vol-*）单独取一次 —— 它不在 TABS 的 table 里
  const ledger = await db.getAllChapterLedgerRows().catch(() => [])
  if (ledger.length) {
    tables.push({
      tabId: 'chapter-master',
      tabName: '章节总表',
      rows: ledger.map(r => ({ id: r.id, data: r.data })),
    })
  }

  return collectIndexDocs({ chapters, tables, cards })
}

export interface IndexProgress {
  phase: '收集' | '嵌入' | '写入'
  done: number
  total: number
}

export interface RebuildResult {
  ok: boolean
  /** 本次参与索引的来源数 */
  docs: number
  /** 写入的块数 */
  chunks: number
  /** 因内容未变而跳过的块数 */
  skipped: number
  /** 清理掉的孤儿来源数（章节/条目已删） */
  removed: number
  error?: string
}

export interface RebuildOptions {
  projectId: string
  cfg: EmbedConfig
  signal?: AbortSignal
  onProgress?: (p: IndexProgress) => void
  /** 先整库清空再建（换嵌入模型后必须用它 —— 旧向量维度多半不一样） */
  full?: boolean
  /** 单测注入点（生产不传） */
  deps?: {
    collectDocs?: () => Promise<IndexDoc[]>
    embed?: typeof embedTexts
    index?: (projectId: string) => Promise<VecIndex>
    clear?: (projectId: string) => Promise<void>
    removeRef?: (projectId: string, refId: string) => Promise<void>
    put?: (rows: VecRow[]) => Promise<void>
  }
}

/** 某来源在旧索引里的块哈希（按块序号归位；无法解析的块直接忽略） */
function chunksOfRef(idx: VecIndex, kind: VecKind, refId: string): string[] {
  const prefix = `${kind}::${refId}::`
  const out: string[] = []
  for (const [k, h] of idx.hashes) {
    if (!k.startsWith(prefix)) continue
    const n = Number(k.slice(prefix.length))
    if (Number.isInteger(n) && n >= 0) out[n] = h
  }
  return out
}

/** 来源内容是否与旧索引完全一致（块数一致且逐块 hash 相同） */
function sameAsOld(idx: VecIndex, doc: IndexDoc, chunks: Chunk[]): boolean {
  const old = chunksOfRef(idx, doc.kind, doc.refId)
  if (old.length !== chunks.length) return false
  for (let i = 0; i < chunks.length; i++) {
    if (old[i] !== hashOf(chunks[i].text)) return false
  }
  return true
}

/**
 * 建索引（全量或增量）。
 *
 * 🔴 永不抛：失败收敛成 `{ ok: false, error }` —— 调用方（任务中心）据此提示，
 *    作者可以只重建一次就重试，不必担心把库搞坏（下一次 `full: true` 会清干净重来）。
 */
export async function rebuildIndex(opts: RebuildOptions): Promise<RebuildResult> {
  const { projectId, cfg, signal, onProgress } = opts
  const full = opts.full === true
  const empty: RebuildResult = { ok: false, docs: 0, chunks: 0, skipped: 0, removed: 0 }
  if (!projectId) return { ...empty, error: '缺少项目 id' }
  if (!(cfg.model ?? '').trim()) return { ...empty, error: '未配置嵌入模型名' }

  const collectDocs = opts.deps?.collectDocs ?? loadIndexDocs
  const doEmbed = opts.deps?.embed ?? embedTexts
  const doIndex = opts.deps?.index ?? vectorIndex
  const doClear = opts.deps?.clear ?? clearProjectVectors
  const doRemoveRef = opts.deps?.removeRef ?? removeByRef
  const doPut = opts.deps?.put ?? putVectors

  onProgress?.({ phase: '收集', done: 0, total: 0 })
  let docs: IndexDoc[] = []
  try {
    docs = await collectDocs()
  } catch (e) {
    return { ...empty, error: `收集待索引资料失败：${e instanceof Error ? e.message : String(e)}` }
  }
  if (docs.length === 0) return { ok: true, docs: 0, chunks: 0, skipped: 0, removed: 0 }

  const old: VecIndex = full ? { hashes: new Map(), refs: new Set() } : await doIndex(projectId)

  // 切块 + 增量比对（🔴 切块只在过滤之后发生，见文件头说明）
  const pending: { doc: IndexDoc; chunks: Chunk[] }[] = []
  const liveRefs = new Set<string>()
  let skipped = 0
  for (const doc of docs) {
    const chunks = chunkChapter(doc.text)
    if (chunks.length === 0) continue
    liveRefs.add(refKeyOf(doc.kind, doc.refId))
    if (!full && sameAsOld(old, doc, chunks)) {
      skipped += chunks.length
      continue
    }
    pending.push({ doc, chunks })
  }

  // 孤儿清理：旧索引里有、本次已不存在的来源（章节被删 / 条目被删）
  // 🔴 不清理的后果是**召回已删除的内容** —— 那是真 bug，不是浪费空间。
  let removed = 0
  if (!full) {
    for (const ref of old.refs) {
      if (liveRefs.has(ref)) continue
      const { kind, refId } = splitRefKey(ref)
      if (!kind || !refId) continue
      try {
        await doRemoveRef(projectId, refId)
        removed++
      } catch {
        /* 单条清理失败不阻断整体 */
      }
    }
  }

  // 嵌入（按批次走，便于报真实进度）
  const texts: string[] = []
  const slots: { doc: IndexDoc; chunk: Chunk }[] = []
  for (const p of pending) {
    for (const c of p.chunks) {
      texts.push(c.text)
      slots.push({ doc: p.doc, chunk: c })
    }
  }
  const total = texts.length
  const rows: VecRow[] = []
  let embedded = 0
  for (let i = 0; i < total; i += EMBED_BATCH) {
    if (signal?.aborted) return { ok: false, docs: docs.length, chunks: rows.length, skipped, removed, error: '已取消' }
    const batch = texts.slice(i, i + EMBED_BATCH)
    let r
    try {
      r = await doEmbed(batch, cfg, signal)
    } catch (e) {
      return { ok: false, docs: docs.length, chunks: rows.length, skipped, removed, error: e instanceof Error ? e.message : String(e) }
    }
    if (!r.ok || !r.vectors) {
      return { ok: false, docs: docs.length, chunks: rows.length, skipped, removed, error: r.error ?? '嵌入失败' }
    }
    for (let j = 0; j < batch.length; j++) {
      const slot = slots[i + j]
      const vec = r.vectors[j]
      if (!slot || !vec || vec.length === 0) continue
      rows.push(makeVecRow({
        projectId,
        kind: slot.doc.kind,
        refId: slot.doc.refId,
        chunkIdx: slot.chunk.idx,
        text: slot.chunk.text,
        title: slot.doc.title,
        hash: hashOf(slot.chunk.text),
        vec: toVectorBuffer(vec),
        dim: vec.length,
        model: cfg.model.trim(),
        secret: slot.doc.secret,
      }))
    }
    embedded = Math.min(i + EMBED_BATCH, total)
    onProgress?.({ phase: '嵌入', done: embedded, total })
  }

  onProgress?.({ phase: '写入', done: 0, total: rows.length })
  try {
    if (full) await doClear(projectId)
    // 逐来源先删后写：章节变短时，旧的长块不会被留成孤儿
    const refsToRewrite = new Set(pending.map(p => refKeyOf(p.doc.kind, p.doc.refId)))
    for (const ref of refsToRewrite) {
      const { refId } = splitRefKey(ref)
      if (refId) await doRemoveRef(projectId, refId)
    }
    await doPut(rows)
  } catch (e) {
    return { ok: false, docs: docs.length, chunks: rows.length, skipped, removed, error: `写入索引失败：${e instanceof Error ? e.message : String(e)}` }
  }
  onProgress?.({ phase: '写入', done: rows.length, total: rows.length })

  return { ok: true, docs: docs.length, chunks: rows.length, skipped, removed }
}

/**
 * 单条来源的索引重写（章节保存后增量更新它用）。
 *
 * 与 `rebuildIndex` 共用同一套切块 / 建行逻辑，只是范围收窄到一条来源。
 * 🔴 内部先 `removeByRef` 再 `putVectors`：章节被改短时旧的长块不会被留成孤儿
 *    （孤儿 = 召回得到**已经删掉的内容**，那是真 bug，见 `rebuildIndex` 的同类说明）。
 */
export async function indexOneDoc(
  doc: IndexDoc,
  projectId: string,
  cfg: EmbedConfig,
  signal?: AbortSignal,
): Promise<{ ok: boolean; chunks: number; error?: string }> {
  const chunks = chunkChapter(doc.text)
  if (chunks.length === 0) {
    // 正文被清空 ⇒ 把旧块一并清掉，否则会一直召回那段不存在的文字
    try { await removeByRef(projectId, doc.refId) } catch { /* 清理失败不影响保存 */ }
    return { ok: true, chunks: 0 }
  }
  let r
  try {
    r = await embedTexts(chunks.map(c => c.text), cfg, signal)
  } catch (e) {
    return { ok: false, chunks: 0, error: e instanceof Error ? e.message : String(e) }
  }
  if (!r.ok || !r.vectors) return { ok: false, chunks: 0, error: r.error ?? '嵌入失败' }

  const rows: VecRow[] = []
  for (let i = 0; i < chunks.length; i++) {
    const vec = r.vectors[i]
    if (!vec || vec.length === 0) continue
    rows.push(makeVecRow({
      projectId,
      kind: doc.kind,
      refId: doc.refId,
      chunkIdx: chunks[i].idx,
      text: chunks[i].text,
      title: doc.title,
      hash: hashOf(chunks[i].text),
      vec: toVectorBuffer(vec),
      dim: vec.length,
      model: cfg.model.trim(),
      secret: doc.secret,
    }))
  }
  await removeByRef(projectId, doc.refId)
  await putVectors(rows)
  return { ok: true, chunks: rows.length }
}

/** `autoIndexChapter` 的注入点（生产不传；单测用来绕开真实库与真实嵌入） */
export interface AutoIndexDeps {
  loadSettings?: typeof loadEmbeddingSettings
  resolveConfig?: typeof resolveEmbedConfig
  /** 索引导读（**只读轻量游标字段**，不碰 vec）—— 兼作「索引建过没有」与「内容变没变」两个判据 */
  index?: typeof vectorIndex
  chapters?: typeof db.getAllChapters
  indexOne?: typeof indexOneDoc
  /** 当前项目 id（默认读库；单测注入，否则 Node 环境拿不到项目会直接早退） */
  projectId?: () => string
}

// 同一章的自动索引**串行跑**，在飞期间的重复请求合并成「跑完再补一次」。
// 🔴 为什么必须串行：两轮 `indexOneDoc` 并发时，各自的 `removeByRef` / `putVectors` 会交错，
//    真出事的那种排布是「A 删 → B 删 → B 写 → A 写」—— 后写的 A 带着**更旧**的正文，
//    索引就停在旧内容上。同时跑两遍也等于白烧一次嵌入额度。
// 「尾随补跑一次」而不是简单丢弃：丢弃会让**最后一次**保存的内容永远进不了索引。
const autoRunning = new Set<string>()
const autoDirty = new Set<string>()

/**
 * 「章节保存后自动更新本章索引」（方案 §1.4 第 4 点，**默认关**）。
 *
 * 🔴 四重守卫，缺一不可 —— 每一条都是在防「作者被意外烧掉嵌入额度」：
 *   ① 设置里 `autoIndexOnSave` 为真（出厂默认 false，作者主动开才有）；
 *   ② 已配好嵌入模型；
 *   ③ **索引已经建立过** —— 这一条最关键：作者从没点过「建立索引」，说明他还没决定用这个功能，
 *      此时即使开关被误开也绝不自动动手。没这道闸，一个误开的开关会让每次保存都发一次嵌入请求；
 *   ④ **本章文本没变就早退** —— 作者改的是状态 / 标签 / 排序时正文照旧，
 *      没有这一条，一次拖拽排序（几十章一起落库）就会白跑几十轮。
 *
 * 另：**永不抛、不阻塞保存** —— 它跑在保存路径的尾巴上（fire-and-forget），
 *    失败只留一行 `console.warn`，绝不让索引问题影响作者存稿。
 */
export async function autoIndexChapter(chapterId: string, deps?: AutoIndexDeps): Promise<void> {
  if (!chapterId) return
  if (autoRunning.has(chapterId)) { autoDirty.add(chapterId); return }
  autoRunning.add(chapterId)
  try {
    do {
      autoDirty.delete(chapterId)
      await autoIndexChapterOnce(chapterId, deps)
    } while (autoDirty.has(chapterId))
  } finally {
    autoRunning.delete(chapterId)
    autoDirty.delete(chapterId)
  }
}

/** 单轮：守卫 → 早退 → 真正重建这一章的索引（**永不抛**，见 `autoIndexChapter` 说明） */
async function autoIndexChapterOnce(chapterId: string, deps?: AutoIndexDeps): Promise<void> {
  try {
    const s = await (deps?.loadSettings ?? loadEmbeddingSettings)()
    if (!s.autoIndexOnSave) return
    const cfg = await (deps?.resolveConfig ?? resolveEmbedConfig)(s)
    if (!cfg) return
    const projectId = (deps?.projectId ?? db.getCurrentProjectId)()
    if (!projectId) return

    // ③ 没建过索引就不自作主张 —— 用 `vectorIndex`（游标只带 id / hash / refId 这类轻量字段）
    //    而**不是** `vectorStats`：后者走 `idbLoad`，会把整个项目的 vec buffer 全读回来反序列化
    //    （大库十几 MB），而这里要回答的只是「索引存在吗」。
    const idx = await (deps?.index ?? vectorIndex)(projectId)
    if (idx.refs.size === 0) return

    const chapters = await (deps?.chapters ?? db.getAllChapters)().catch(() => [])
    const ch = chapters.find(c => c.id === chapterId)
    if (!ch) return
    const text = chapterIndexText(ch)
    const doc: IndexDoc = {
      kind: 'chapter', refId: ch.id, title: ch.title?.trim() || '未命名章节', text, secret: false,
    }

    // ④ 内容与旧索引逐块一致 ⇒ **一个嵌入请求都不发**（改状态 / 改排序 / 重存同一份稿都走这条）
    const chunks = chunkChapter(text)
    if (chunks.length > 0 && sameAsOld(idx, doc, chunks)) return

    await (deps?.indexOne ?? indexOneDoc)(doc, projectId, cfg)
  } catch (e) {
    // 索引坏了绝不影响存稿 —— 作者甚至不该知道这件事失败了
    console.warn('[semantic] 自动更新本章索引失败（不影响保存）：', e)
  }
}

export interface IndexStatus {
  stats: VecStats | null
  /** 索引与当前嵌入模型是否匹配（不匹配 ⇒ 召回会整体返回空） */
  fresh: boolean
  reason: string
}

/**
 * 索引状态（界面用）。
 * ⚠️ 只比对 `stats.model`（最近一次写入的模型名）而**不逐行扫** —— 逐行扫要读全部行，
 *    对一个"打开面板就要显示"的查询来说太贵。行级守卫仍然在 `recall.checkIndexFreshness`，
 *    两道加起来：界面提示靠这里，实际召回安全靠那边。
 */
export async function indexStatus(projectId: string, cfg: EmbedConfig | null): Promise<IndexStatus> {
  const stats = await vectorStats(projectId)
  if (!stats || stats.chunks === 0) return { stats: stats, fresh: false, reason: '尚未建立索引' }
  if (!cfg) return { stats, fresh: false, reason: '未选择嵌入模型' }
  if (stats.model !== (cfg.model ?? '').trim()) return { stats, fresh: false, reason: '嵌入模型已变更，请重建索引' }
  return { stats, fresh: true, reason: '' }
}
