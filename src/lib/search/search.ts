/**
 * 离线全文检索引擎（v1.3 新增 · P0 可用性缺口）
 * 纯前端、零依赖、可离线（便携版 / 桌面版均可用）。
 * 覆盖三类文档：章节正文（chapter）、角色卡（character）、设定表（setting）。
 * 中文采用「单字 + 二元」分词，英文/数字按词切分，兼顾召回与排名。
 *
 * 设计取舍：不引入 MiniSearch 等外部库，避免便携单文件构建的体积膨胀与版本漂移；
 * 自实现的倒排索引对小说体量（百万字级）足够轻快，且分词对中文友好。
 */
import * as db from '@/lib/db'
import { TABS, tabVisible, type VisCtx } from '@/lib/schema'
import { tokenize } from '@/lib/editor/tokenize'
import { contentRevision } from '@/lib/editor/editorViewMath'
import { atlasFieldsForCategory, isAtlasTab, resolveAtlasFields, atlasSearchText } from '@/lib/atlas/schema'
import { loadAtlasSchema } from '@/lib/atlas/persistence'
import type { AtlasSchemaConfig } from '@/lib/atlas/types'
import type { CardRecord, TableRow } from '@/lib/types'

// 🔬 分词口径的**单一真源**已移到 `./tokenize`（纯函数，不 import db）——
//    好让「知识库」的关键词降级召回也能用它而不与 db 成环。
//    这里原样再导出，既有的 `from './search'` 调用点无需改动。
export { tokenize }

export type SearchDocType = 'chapter' | 'character' | 'setting'

export interface SearchDoc {
  id: string
  type: SearchDocType
  title: string
  body: string
  tabId?: string
  chapterId?: string
  /** 来源页签名（用于结果徽标，如「主要角色」「名词术语」） */
  source?: string
  /**
   * 章节文档的 `body` = 标题 + 摘要 + 正文，而正文编辑器只认**正文**坐标。
   * 这里记下正文在 `body` 里的起始下标，命中位置落在这之前（标题/摘要里）就无法定位到正文。
   */
  contentStart?: number
  /** 索引那一刻**正文**的指纹；打开时与当前正文比对，对不上就只开章节、不瞎定位 */
  contentRevision?: string
}

export interface SearchResult extends SearchDoc {
  score: number
  /** 命中摘要（带省略号上下文） */
  snippet: string
  /**
   * 命中处在**正文**里的字符偏移（UTF-16）。
   *
   * 🔴 只有章节正文且命中确实落在正文段里才有值：命中在标题/摘要里时打开章节就好，
   *    给一个假偏移会把作者丢到无关的句子（3.3.1 · T1 的验收口径要求「不落到错误位置」）。
   */
  matchAt?: number
  /** 命中长度，用来在正文里选中这一句 */
  matchLength?: number
  /** 同一章里第几处命中（1 起）与总计；只有一章命中多次才会拆成多行 */
  hitIndex?: number
  hitCount?: number
}


/**
 * 找第一个命中位置（整段短语优先，找不到再退到「任一二元组」）。
 * 摘要与定位共用它 —— 两处各写一套时，摘要指向的句子和真正跳过去的句子就会不一致。
 */
function firstMatchPos(body: string, query: string): number {
  const ql = query.trim().toLowerCase()
  if (!ql) return -1
  const lower = body.toLowerCase()
  const exact = lower.indexOf(ql)
  if (exact >= 0) return exact
  let pos = -1
  const runs = ql.match(/[㐀-䶿ㆠ-㏿一-鿿豈-﫿]+/g)
  if (runs) {
    for (const run of runs) {
      for (let i = 0; i + 1 < run.length; i++) {
        const p = lower.indexOf(run[i] + run[i + 1])
        if (p >= 0 && (pos < 0 || p < pos)) pos = p
      }
    }
  }
  return pos
}

/** 从命中位置截取带上下文的摘要（`pos` 缺省用首个命中） */
function makeSnippet(body: string, query: string, pos = firstMatchPos(body, query)): string {
  if (!body) return ''
  if (pos < 0) return body.slice(0, 60) + (body.length > 60 ? '…' : '')
  const start = Math.max(0, pos - 30)
  const end = Math.min(body.length, pos + 60)
  return (start > 0 ? '…' : '') + body.slice(start, end).replace(/\n/g, ' ') + (end < body.length ? '…' : '')
}

/** 一章内最多拆几行结果（再多只是把列表刷屏，作者要的是「跳过去看」） */
const MAX_HITS_PER_CHAPTER = 3

/**
 * 章节文档里「整段短语」出现的全部位置，并换算成**正文坐标**。
 *
 * 🔴 只认整段短语：二元组那套近似匹配拿来定位，会把作者丢到只含其中一个字的句子。
 *    命中落在标题/摘要段（`contentStart` 之前）时直接丢弃 —— 那一处没法在正文里定位。
 */
export function chapterHitOffsets(doc: SearchDoc, query: string): number[] {
  const ql = query.trim().toLowerCase()
  if (!ql || doc.type !== 'chapter' || doc.contentStart == null) return []
  const lower = doc.body.toLowerCase()
  const out: number[] = []
  for (let at = lower.indexOf(ql); at >= 0 && out.length < MAX_HITS_PER_CHAPTER; at = lower.indexOf(ql, at + ql.length)) {
    const inContent = at - doc.contentStart
    if (inContent >= 0) out.push(inContent)
  }
  return out
}

/** 采集当前项目的全部可搜索文档
 * @param ctx 可见性上下文；自定义项目下未启用功能对应的页签数据不纳入检索，避免搜出本该看不见的设定
 */
async function buildDocs(ctx: VisCtx = { type: 'full', features: [] }): Promise<SearchDoc[]> {
  const docs: SearchDoc[] = []
  const chapters = await db.getAllChapters()
  for (const c of chapters) {
    docs.push({
      id: `ch-${c.id}`,
      type: 'chapter',
      title: c.title || '（未命名章节）',
      body: `${c.title}\n${c.summary}\n${c.content}`,
      chapterId: c.id,
      source: '章节正文',
      // 正文在 body 里的起点 = 标题 + 换行 + 摘要 + 换行；打开章节时用它把 body 坐标换算成正文坐标
      contentStart: c.title.length + 1 + c.summary.length + 1,
      contentRevision: contentRevision(c.content),
    })
  }
  // 角色卡（主要 / 次要 / NPC）—— 隐藏形态下跳过
  for (const tabId of ['char-main', 'char-secondary', 'char-npc']) {
    const tab = TABS.find(t => t.id === tabId)
    if (!tab || !tabVisible(tab.id, ctx)) continue
    const recs: CardRecord[] = await db.getCardRecords(tabId)
    for (const rec of recs) {
      const body = Object.values(rec.data).filter(Boolean).join('\n')
      docs.push({ id: `card-${rec.id}`, type: 'character', title: rec.name, body, tabId, source: tab?.name })
    }
  }
  // 表格型设定（含人物关系、名词术语、国家势力等）—— 隐藏形态下跳过
  // 3.1.3：图鉴页签（races / items）的字段配置先加载一次，供下面的正文构造用
  const atlasCfgs = new Map<string, AtlasSchemaConfig | null>()
  {
    const pid = db.getCurrentProjectId()
    for (const id of ['races', 'items'] as const) {
      try {
        atlasCfgs.set(id, (await loadAtlasSchema(pid, id)).config)
      } catch {
        // 读配置失败不该让整份检索崩：退回原口径（全部有值字段）
        atlasCfgs.set(id, null)
      }
    }
  }
  for (const tab of TABS) {
    if (tab.type !== 'table') continue
    if (!tabVisible(tab.id, ctx)) continue
    const rows: TableRow[] = await db.getTableRows(tab.id)
    const displayCol = tab.displayCol
    /**
     * 🔴 检索也按**每行自己的类别**解析（3.1.3 · R02）。
     *    这里原先整表只解析一次且不带类别 ⇒ "只适用某类别"的字段在所有行上都被排除，
     *    作者填了值却搜不到。做法与表格列一致：先取全量，再逐行过滤。
     */
    const allAtlasFields = isAtlasTab(tab.id)
      ? resolveAtlasFields(tab, { config: atlasCfgs.get(tab.id) ?? null, purpose: 'search', ignoreAppliesTo: true })
      : null
    for (const r of rows) {
      const atlasFields = allAtlasFields ? atlasFieldsForCategory(allAtlasFields, r.data?.['类别']) : null
      const body = atlasFields
        ? atlasSearchText(atlasFields, r.data)
        : Object.entries(r.data).filter(([, v]) => v && v.trim()).map(([, v]) => v).join('\n')
      if (!body.trim()) continue
      const filled = Object.entries(r.data).filter(([, v]) => v && v.trim())
      let title = (displayCol && r.data[displayCol]) || filled[0]?.[1] || '（未命名）'
      if (tab.id === 'relations') {
        const pair = `${r.data['人物A'] || ''} → ${r.data['人物B'] || ''}`.trim()
        if (pair) title = pair
      }
      docs.push({ id: `row-${r.id}`, type: 'setting', title, body, tabId: tab.id, source: tab.name })
    }
  }
  // 卷台账（按卷建表）：聚合所有 chapter-vol-<vid> 表，作为「设定」类检索源
  if (tabVisible('chapter-master', ctx)) {
    const vols = await db.getAllVolumes()
    for (const v of vols) {
      const rows = await db.getTableRows(`chapter-vol-${v.id}`)
      for (const r of rows) {
        const filled = Object.entries(r.data).filter(([, val]) => val && val.trim())
        if (filled.length === 0) continue
        const title = (r.data['章节标题']) || filled[0][1] || '（未命名）'
        const body = filled.map(([, val]) => val).join('\n')
        docs.push({ id: `row-${r.id}`, type: 'setting', title, body, tabId: `chapter-vol-${v.id}`, source: `${v.title || '未命名卷'}·章节台账` })
      }
    }
  }
  return docs
}

export class SearchEngine {
  private docs: SearchDoc[] = []
  private inv = new Map<string, Map<number, number>>()
  private titleTok = new Map<number, Set<string>>()
  private _built = false
  private _building: Promise<void> | null = null

  get built() { return this._built }

  /** 构建索引（可重复调用，内部去重）
   * @param ctx 可见性上下文；精简 / 极简项目下被隐藏的页签数据不纳入检索，自定义项目按启用功能集过滤
   */
  build(ctx: VisCtx = { type: 'full', features: [] }): Promise<void> {
    if (this._building) return this._building
    this._building = (async () => {
      const docs = await buildDocs(ctx)
      this.docs = docs
      this.inv.clear()
      this.titleTok.clear()
      docs.forEach((d, i) => {
        const tt = new Set(tokenize(d.title))
        this.titleTok.set(i, tt)
        const tf = new Map<string, number>()
        for (const t of tokenize(d.body)) tf.set(t, (tf.get(t) ?? 0) + 1)
        for (const [t, c] of tf) {
          let m = this.inv.get(t)
          if (!m) { m = new Map(); this.inv.set(t, m) }
          m.set(i, (m.get(i) ?? 0) + c)
        }
      })
      this._built = true
    })()
    return this._building
  }

  /** 检索：返回按相关度降序排列的结果（OR 语义，命中任一 token 即召回） */
  search(raw: string, limit = 60): SearchResult[] {
    const q = raw.trim()
    if (!q || !this._built) return []
    const qTok = tokenize(q)
    if (qTok.length === 0) return []
    const scoreMap = new Map<number, number>()
    for (const t of qTok) {
      const m = this.inv.get(t)
      if (!m) continue
      for (const [i, tf] of m) {
        let s = tf
        if (this.titleTok.get(i)?.has(t)) s += 5 // 标题命中加权
        scoreMap.set(i, (scoreMap.get(i) ?? 0) + s)
      }
    }
    const out: SearchResult[] = []
    for (const [i, score] of scoreMap) {
      const d = this.docs[i]
      const hits = chapterHitOffsets(d, q)
      // 一章命中多次 ⇒ 拆成多行：作者要能选「第 2 处」，否则还得自己在整章里翻
      if (hits.length > 1) {
        hits.forEach((at, n) => out.push({
          ...d, id: `${d.id}#${n + 1}`, score,
          snippet: makeSnippet(d.body, q, d.contentStart! + at),
          matchAt: at, matchLength: q.trim().length, hitIndex: n + 1, hitCount: hits.length,
        }))
        continue
      }
      out.push({
        ...d, score, snippet: makeSnippet(d.body, q),
        ...(hits.length === 1 ? { matchAt: hits[0], matchLength: q.trim().length } : {}),
      })
    }
    out.sort((a, b) => b.score - a.score)
    return out.slice(0, limit)
  }
}

export const SEARCH_TYPE_LABEL: Record<SearchDocType, string> = {
  chapter: '章节正文',
  character: '角色',
  setting: '设定',
}
