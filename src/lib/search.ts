/**
 * 离线全文检索引擎（v1.3 新增 · P0 可用性缺口）
 * 纯前端、零依赖、可离线（便携版 / 桌面版均可用）。
 * 覆盖三类文档：章节正文（chapter）、角色卡（character）、设定表（setting）。
 * 中文采用「单字 + 二元」分词，英文/数字按词切分，兼顾召回与排名。
 *
 * 设计取舍：不引入 MiniSearch 等外部库，避免便携单文件构建的体积膨胀与版本漂移；
 * 自实现的倒排索引对小说体量（百万字级）足够轻快，且分词对中文友好。
 */
import * as db from './db'
import { TABS, tabVisible, type VisCtx } from './schema'
import type { CardRecord, TableRow } from './types'

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
}

export interface SearchResult extends SearchDoc {
  score: number
  /** 命中摘要（带省略号上下文） */
  snippet: string
}

/** 分词：CJK 拆成 单字 + 相邻二元；拉丁/数字按词 */
function tokenize(text: string): string[] {
  if (!text) return []
  const lower = text.toLowerCase()
  const tokens: string[] = []
  const latin = lower.match(/[a-z0-9]+/g)
  if (latin) for (const w of latin) tokens.push(w)
  const cjkRuns = lower.match(/[㐀-䶿ㆠ-㏿一-鿿豈-﫿]+/g)
  if (cjkRuns) {
    for (const run of cjkRuns) {
      for (let i = 0; i < run.length; i++) {
        tokens.push(run[i]) // 单字
        if (i + 1 < run.length) tokens.push(run[i] + run[i + 1]) // 二元
      }
    }
  }
  return tokens
}

/** 从命中位置截取带上下文的摘要 */
function makeSnippet(body: string, query: string): string {
  if (!body) return ''
  const q = query.trim()
  const lower = body.toLowerCase()
  const ql = q.toLowerCase()
  let pos = lower.indexOf(ql)
  if (pos < 0) {
    const runs = ql.match(/[㐀-䶿ㆠ-㏿一-鿿豈-﫿]+/g)
    if (runs) {
      for (const run of runs) {
        for (let i = 0; i + 1 < run.length; i++) {
          const p = lower.indexOf(run[i] + run[i + 1])
          if (p >= 0 && (pos < 0 || p < pos)) pos = p
        }
      }
    }
  }
  if (pos < 0) return body.slice(0, 60) + (body.length > 60 ? '…' : '')
  const start = Math.max(0, pos - 30)
  const end = Math.min(body.length, pos + 60)
  return (start > 0 ? '…' : '') + body.slice(start, end).replace(/\n/g, ' ') + (end < body.length ? '…' : '')
}

/** 采集当前项目的全部可搜索文档
 * @param projectType 项目形态；精简 / 极简项目下被隐藏的页签数据不纳入检索，避免搜出本该看不见的设定
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
  for (const tab of TABS) {
    if (tab.type !== 'table') continue
    if (!tabVisible(tab.id, ctx)) continue
    const rows: TableRow[] = await db.getTableRows(tab.id)
    const displayCol = tab.displayCol
    for (const r of rows) {
      const filled = Object.entries(r.data).filter(([, v]) => v && v.trim())
      if (filled.length === 0) continue
      let title = (displayCol && r.data[displayCol]) || filled[0][1] || '（未命名）'
      if (tab.id === 'relations') {
        const pair = `${r.data['人物A'] || ''} → ${r.data['人物B'] || ''}`.trim()
        if (pair) title = pair
      }
      const body = filled.map(([, v]) => v).join('\n')
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
      out.push({ ...d, score, snippet: makeSnippet(d.body, q) })
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
