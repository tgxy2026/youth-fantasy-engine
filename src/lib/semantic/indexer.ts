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

import * as db from '@/lib/db'
import { isPrunedForAI, isSecretRow, SYSTEM_META_FIELDS } from '@/lib/ai/aiContext'
import { TABS } from '@/lib/schema'
import { isAtlasTab, resolveAtlasFields } from '@/lib/atlas/schema'
import { loadAtlasSchema } from '@/lib/atlas/persistence'
import { chunkChapter, hashOf, toVectorBuffer, type Chunk } from '@/lib/semantic/chunk'
import { embedTexts, EMBED_BATCH, type EmbedConfig } from '@/lib/semantic/embed'
import {
  makeVecRow, putVectors, removeByRef, clearProjectVectors, vectorIndex, vectorIndexStrict, vectorStats,
  refKeyOf, splitRefKey,
  type VecIndex, type VecKind, type VecRow, type VecStats,
} from '@/lib/semantic/store'
// ⚠️ 方向：indexer → settings → aiCore/session → db，不回头 import indexer ⇒ 不成环。
import { loadEmbeddingSettings, resolveEmbedConfig } from '@/lib/semantic/settings'
// 单来源索引的编排住在 `indexDoc.ts` —— 它对 `lib/db` **零依赖**，
// 好让知识库（#017）在不 import db 的前提下复用它（否则 deleteProject → knowledgeBase → db 成环）。
// 这里**原样再导出**，既有的 `from './indexer'` 调用点一个都不用改。
import { indexOneDoc, type IndexDoc } from '@/lib/semantic/indexDoc'
export { indexOneDoc }
export type { IndexDoc }

export interface CollectInput {
  chapters: { id: string; title: string; summary?: string; content: string }[]
  /**
   * `hiddenCols` ＝ 该表的隐藏列名（调用方从 schema 取）—— 不进索引文本，见 renderRow。
   * `fieldRules` ＝ 自定义字段的索引规则（图鉴页签才有）——
   *   `cf_*` 这种内部键**绝不能**写进向量文本，且**作者关掉的字段不许进索引**，见 renderRow。
   */
  tables: {
    tabId: string
    tabName: string
    rows: { id: string; data: Record<string, string> }[]
    hiddenCols?: string[]
    fieldRules?: Record<string, AtlasIndexFieldRule>
  }[]
  cards: { tabId: string; tabName: string; rows: { id: string; name: string; data: Record<string, string> }[]; hiddenCols?: string[] }[]
}

/**
 * 自定义字段进索引的规则（3.1.3 · R04）。
 *
 * 🔴 为什么不只是「键→名字」的映射：索引文本会经〖语义召回〗原样注回提示词，
 *    所以作者在图鉴里关掉的每一个开关，在这里**必须同样生效** —— 否则就成了
 *    "提示词里看不到，但语义召回能捞出来"的绕行通道（验收 R04 已复现：
 *    `aiReadable=false` + `archived=true` 的字段内容照样进了索引文本）。
 */
export interface AtlasIndexFieldRule {
  /** 作者起的字段名（`cf_*` 键绝不进索引文本） */
  label: string
  /** 作者关掉「允许 AI 参考」⇒ 不进索引；与提示词侧 `purpose:'aiRead'` 同一口径 */
  aiReadable: boolean
  /** 类别适用范围：`'*'` = 不限；数组 = 只对这几个类别生效 */
  appliesTo: '*' | string[]
}

/** 条目类别所在的列（图鉴四页签一致） */
const CATEGORY_COL = '类别'

/**
 * 行 → 可嵌入文本。**带列名**（"身份：剑修"）比只拼值（"剑修"）更容易被语义匹配到。
 *
 * 🔴 自定义字段的存储键是 `cf_<uid>`，**必须换成作者起的字段名**：
 *    索引文本会经〖语义召回〗原样注回提示词（`inject.renderRecallHits`），
 *    留着 `cf_mvdjsuz400001sletxf：…` 等于给模型看一串无意义字符，还稀释向量。
 *    这与 `aiContext.renderTable` 的 `labelOf` 是**同一口径**（3.1.3 补上，此前只有提示词那边换了）。
 *    拿不到规则时（配置读失败）退化成「自定义字段」—— 宁可重名，也不露内部键。
 *
 * 🔴🔴 `fieldRules` 一旦给了就是**权威**（3.1.3 · R04）：
 *      · 规则里**没有**这个 `cf_` 键 ⇒ 字段已归档或已删除 ⇒ 值一律不进索引。
 *        这些值只是历史残留，不是作者当下想让 AI 看到的东西（"我归档了却还能被召回"最伤信任）。
 *      · `aiReadable=false` ⇒ 不进索引（与提示词同一口径）。
 *      · `appliesTo` 不含本行类别 ⇒ 不进索引（同上，跨类别的旧值不算数）。
 */
function renderRow(
  data: Record<string, string> | undefined,
  head?: string,
  hiddenCols?: Set<string>,
  fieldRules?: Record<string, AtlasIndexFieldRule>,
  category?: string,
): string {
  const lines: string[] = []
  if (head && head.trim()) lines.push(head.trim())
  for (const [k, v] of Object.entries(data ?? {})) {
    const val = (v ?? '').trim()
    if (!val) continue
    // 内部字段（子集标记之类）不参与语义 —— 它们只是结构占位
    if (!k.trim() || k.endsWith('::')) continue
    // 🔴 隐藏列（坐标串之类）与系统元数据列（保密等级）不进索引文本 ——
    //    与 `aiContext.renderTable` 同一口径。索引文本会经〖语义召回〗注回提示词，
    //    所以「不进提示词」的列在这里同样要挡（2026-10-08 修）。
    if (hiddenCols?.has(k) || SYSTEM_META_FIELDS.has(k)) continue
    const rule = fieldRules?.[k]
    if (k.startsWith('cf_')) {
      if (fieldRules && !rule) continue            // 已归档 / 已删除
      if (rule && !rule.aiReadable) continue       // 作者关了「允许 AI 参考」
      if (rule && rule.appliesTo !== '*' && !rule.appliesTo.includes((category ?? '').trim())) continue
    }
    const label = rule?.label ?? (k.startsWith('cf_') ? '自定义字段' : k)
    lines.push(`${label}：${val}`)
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
    const hidden = t.hiddenCols?.length ? new Set(t.hiddenCols) : undefined
    for (const r of t.rows ?? []) {
      if (isPrunedForAI(r.data)) continue // 🔴 D 级：根本不进索引
      // 逐行取类别：类别限定的字段只对匹配的条目进索引（R04）
      const category = typeof r.data?.[CATEGORY_COL] === 'string' ? r.data[CATEGORY_COL] : ''
      const text = renderRow(r.data, undefined, hidden, t.fieldRules, category)
      if (!text) continue
      out.push({ kind: 'setting', refId: r.id, title: t.tabName, text, secret: isSecretRow(r.data) })
    }
  }

  // 角色卡
  for (const t of input.cards ?? []) {
    const hidden = t.hiddenCols?.length ? new Set(t.hiddenCols) : undefined
    for (const r of t.rows ?? []) {
      if (isPrunedForAI(r.data)) continue // 🔴 D 级：根本不进索引
      const text = renderRow(r.data, r.name, hidden)
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
 *
 * 🔴🔴 但「读失败」必须与「确实没有数据」区分开 —— `incomplete` 就是那个信号。
 *    把读失败直接当成空数组喂给孤儿清理，等于把**读不到**判成**已删除**、
 *    静默删掉一整个来源的向量（详见 `rebuildIndex` 里孤儿清理那段）。
 */
export interface LoadDocsResult {
  docs: IndexDoc[]
  /** 只要有一个来源读失败就为 true —— 此时调用方**绝不能做孤儿清理** */
  incomplete: boolean
}

export async function loadIndexDocsDetailed(): Promise<LoadDocsResult> {
  let incomplete = false
  const onFail = (e: unknown): never[] => {
    incomplete = true
    console.warn('[semantic] 读取待索引来源失败（本轮视为「不确定」，不做孤儿清理）：', e)
    return []
  }

  const chapters = (await db.getAllChapters().catch(onFail)) as CollectInput['chapters']

  const tables: CollectInput['tables'] = []
  const cards: CollectInput['cards'] = []
  // 隐藏列（如《地理风物》的「地图格子」坐标串）不进索引文本 —— 与 aiContext 同一口径
  const hiddenColsOf = (tab: (typeof TABS)[number]) => (tab.columns ?? []).filter(c => c.hidden).map(c => c.name)

  /**
   * 图鉴页签的自定义字段**索引规则**（存储键 → 名字 / AI 可读 / 类别范围）。
   *
   * 🔴🔴 走 `resolveAtlasFields`（字段解析的唯一入口），不自己遍历配置原文里的字段数组 ——
   *    否则"提示词一套口径、索引另一套"会再次出现（R04 就是这么来的）。
   *    `ignoreAppliesTo: true` 是**故意**的：这里要的是**全表字段结构**，
   *    类别是否匹配由 `renderRow` 拿每行的 `类别` 逐行判（全表视图不该先砍掉再判）。
   *
   * 🔴 读配置失败**不影响索引**：退化成 `undefined` ⇒ renderRow 把 `cf_*` 叫「自定义字段」，
   *    条照常入库，只是那条字段的可读名丢了（比整表跳过好）。
   */
  const fieldRulesOf = async (tab: (typeof TABS)[number]): Promise<Record<string, AtlasIndexFieldRule> | undefined> => {
    if (!isAtlasTab(tab.id)) return undefined
    try {
      const cfg = (await loadAtlasSchema(db.getCurrentProjectId(), tab.id)).config
      const fields = resolveAtlasFields(tab, { config: cfg, purpose: 'aiRead', ignoreAppliesTo: true })
      const map: Record<string, AtlasIndexFieldRule> = {}
      for (const f of fields) {
        if (f.source !== 'custom') continue
        map[f.key] = { label: f.label, aiReadable: f.aiReadable, appliesTo: f.appliesTo }
      }
      return Object.keys(map).length > 0 ? map : undefined
    } catch {
      return undefined
    }
  }

  for (const tab of TABS) {
    if (tab.type === 'table') {
      const rows = await db.getTableRows(tab.id).catch(onFail)
      if (rows.length) {
        tables.push({
          tabId: tab.id,
          tabName: tab.name,
          rows: rows.map(r => ({ id: r.id, data: r.data })),
          hiddenCols: hiddenColsOf(tab),
          fieldRules: await fieldRulesOf(tab),
        })
      }
    } else if (tab.type === 'card') {
      const rows = await db.getCardRecords(tab.id).catch(onFail)
      if (rows.length) cards.push({ tabId: tab.id, tabName: tab.name, rows: rows.map(r => ({ id: r.id, name: r.name, data: r.data })), hiddenCols: hiddenColsOf(tab) })
    }
  }
  // 章节台账（按卷分表存在 chapter-vol-*）单独取一次 —— 它不在 TABS 的 table 里
  const ledger = await db.getAllChapterLedgerRows().catch(onFail)
  if (ledger.length) {
    tables.push({
      tabId: 'chapter-master',
      tabName: '章节总表',
      rows: ledger.map(r => ({ id: r.id, data: r.data })),
    })
  }

  return { docs: collectIndexDocs({ chapters, tables, cards }), incomplete }
}

/**
 * 字段的 AI 可见性变了 ⇒ **作废旧索引**（3.1.3 · R04）。
 *
 * 🔴 为什么必须整库清：向量是早就算好的文本快照，作者把某字段改成"不给 AI 参考"之后，
 *    旧向量里那段内容**还在**，语义检索照样能把它捞出来注回提示词 ——
 *    "我明明关了开关，AI 还是知道"是最伤信任的一类问题，宁可让作者重建一次。
 *    （只改名字 / 顺序不该走到这里，判定的活交给 `atlasAiVisibilityChanged`。）
 *
 * 清完之后 `indexStatus` 会回到「尚未建立索引」，界面自然会提示重建。
 */
export async function invalidateIndex(projectId: string): Promise<void> {
  if (!projectId) return
  try {
    await clearProjectVectors(projectId)
  } catch (e) {
    // 清不掉也要让作者知道（否则他还以为旧索引已经废了）
    console.warn('[semantic] 作废旧索引失败（旧内容可能仍会被召回）：', e)
    throw e
  }
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
  /** 非致命提醒（如「有来源读失败，本轮跳过了孤儿清理」）—— 界面据此提示作者稍后重跑 */
  warning?: string
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
    /** 收集；返回数组＝视为「完整」，返回 `LoadDocsResult` 可带 `incomplete` 标记 */
    collectDocs?: () => Promise<IndexDoc[] | LoadDocsResult>
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
  rebuildRunning = true
  try {
    return await rebuildIndexInner(opts)
  } finally {
    rebuildRunning = false
  }
}

/**
 * 是否有一次「重建索引」正在跑 —— 与「保存后自动索引」互斥用（见 `autoIndexChapterOnce`）。
 * 🔴 两者并发时各自的 `removeByRef` / `putVectors` 会交错（`full` 时还会整库清空），
 *    最终索引可能停在**旧内容**上；同时跑两遍也等于白烧一次嵌入额度。
 */
let rebuildRunning = false

async function rebuildIndexInner(opts: RebuildOptions): Promise<RebuildResult> {
  const { projectId, cfg, signal, onProgress } = opts
  const full = opts.full === true
  const empty: RebuildResult = { ok: false, docs: 0, chunks: 0, skipped: 0, removed: 0 }
  if (!projectId) return { ...empty, error: '缺少项目 id' }
  if (!(cfg.model ?? '').trim()) return { ...empty, error: '未配置嵌入模型名' }

  const injectedCollect = opts.deps?.collectDocs
  const doEmbed = opts.deps?.embed ?? embedTexts
  // 🔴 增量重建读旧索引用**严格版**：`vectorIndex` 读失败会吞成空表 ⇒「读不到」被当成
  //    「没有旧索引」⇒ 全书逐块重新嵌入（白烧配额、毫无提示）。严格版失败即抛，下面如实报错。
  const doIndex = opts.deps?.index ?? vectorIndexStrict
  const doClear = opts.deps?.clear ?? clearProjectVectors
  const doRemoveRef = opts.deps?.removeRef ?? removeByRef
  const doPut = opts.deps?.put ?? putVectors

  onProgress?.({ phase: '收集', done: 0, total: 0 })
  let docs: IndexDoc[] = []
  let incomplete = false
  try {
    if (injectedCollect) {
      const rr = await injectedCollect()
      if (Array.isArray(rr)) docs = rr
      else { docs = rr.docs; incomplete = rr.incomplete }
    } else {
      const r = await loadIndexDocsDetailed()
      docs = r.docs
      incomplete = r.incomplete
    }
  } catch (e) {
    return { ...empty, error: `收集待索引资料失败：${e instanceof Error ? e.message : String(e)}` }
  }
  // 一条都没读到、而且确实有读失败 ⇒ 别谎报「这本书是空的」
  if (docs.length === 0) {
    return incomplete
      ? { ...empty, error: '读取待索引资料时出错（没能读到任何来源），请重试' }
      : { ok: true, docs: 0, chunks: 0, skipped: 0, removed: 0 }
  }

  let old: VecIndex
  if (full) {
    old = { hashes: new Map(), refs: new Set() }
  } else {
    try {
      old = await doIndex(projectId)
    } catch (e) {
      return { ...empty, error: `读取旧索引失败，已中止重建（避免全书重新嵌入）：${e instanceof Error ? e.message : String(e)}` }
    }
  }

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
  // 🔴🔴 但清理的前提是「本轮收集是完整的」：有来源读失败时 liveRefs 不完整，
  //    此时清理 = 把「读不到」当成「已删除」，会静默删掉整章 / 整表的向量。宁可这轮不清。
  let removed = 0
  const skippedOrphanClean = !full && incomplete
  if (!full && !incomplete) {
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

  return {
    ok: true, docs: docs.length, chunks: rows.length, skipped, removed,
    warning: skippedOrphanClean
      ? '部分来源读取失败：本轮已跳过「清理已删除来源」，索引可能残留已删内容，建议稍后重跑一次'
      : undefined,
  }
}

// （`indexOneDoc` 已移到 `indexDoc.ts` —— 它对 db 零依赖，供知识库 #017 复用；
//   本文件顶部已 import 并原样再导出，调用点无需改动。）

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
    // 🔴 有「重建索引」在跑就跳过这一轮：两者并发会交错写同一批向量块（见 `rebuildRunning`）。
    //    重建本就是全书的活，跑完再存一次即入索引，不值得冒「索引停在旧内容」的险。
    if (rebuildRunning) return
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
