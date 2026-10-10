// ============ 章后整理（W2-1 · §10.3 #3 · 统一入口闭环）============
//
// 「每章写完后，把本章带来的『事实 / 人物状态 / 关系 / 伏笔』变化整理出来，作者确认后才落库」。
//
// 现状与分工（重要）：
//   · **实体（事实）**一类早已完整 —— `settingLedger` 的「抽 → 确定性比对 → 写」+ 颉文姬「补登」模式，
//     本模块**直接复用**，不重写（改口径等于把已有行为再实现一遍，必有漂移）；
//   · **伏笔 / 关系 / 人物状态**三类此前只有表、没有「章后整理」入口（伏笔埋设/回收靠作者
//     手填章节总表），本模块补上。
//
// 🔴 铁律（与 settingLedger 同一条）：**AI 只抽候选，「是否已登记 / 是否真变了」一律由本文件做
//    确定性比对** —— 模型不知道作者的登记现状，也容易把没变的说成变了（或反过来）。
// 🔴 落库一律**只追加、不覆盖**（关系「演变轨迹」、章节总表「伏笔编号」），属性列绝不自动改。
// 🔴 **不凭空建条目**：伏笔 / 关系未登记时只**提示**，不自动新建（与 `backfillOutlineEvent`
//    的「绝不新建细纲卡」同口径）。
import * as db from './db'
import {
  aiExtractChapterChanges, aiExtractSettingEntities,
  type ExtractedEntity, type ExtractedForeshadow, type ExtractedRelation, type ExtractedStatus,
} from './aiTasks'
import { loadRegistry, classify, commitEntities, cardFieldPath, normName, type LedgerItem, type EntityRegistry } from './settingLedger'
import { splitCodes } from './audit'
import { chapterFingerprint } from './aiRunLedger'
import { countWords } from './textStats'
import { TABS } from './schema'
import type { CardRecord, TableRow } from './types'

/**
 * 编排输入 —— **刻意用轻量形状**（不是整个 `Chapter`）：
 * 调用方（颉文姬面板）手上只有这仨，`volumeId` / `wordCount` / `updatedAt` 由本模块内部补。
 * 🔴 `content` / `chapterTitle` 用**编辑器里的最新态**（作者可能还没保存），不读库里的滞后版本。
 */
export interface PostProcessInput {
  chapterId: string
  content: string
  chapterTitle: string
}

/** 从库里补出落库与指纹所需的元信息（拿不到就退化，绝不抛） */
async function resolveMeta(input: PostProcessInput): Promise<{ volumeId: string; wordCount: number; updatedAt: number }> {
  try {
    const ch = (await db.getAllChapters()).find(c => c.id === input.chapterId)
    if (ch) return { volumeId: ch.volumeId, wordCount: ch.wordCount, updatedAt: ch.updatedAt }
  } catch { /* 落退化值 */ }
  return { volumeId: '', wordCount: countWords(input.content ?? ''), updatedAt: Date.now() }
}

export type PostProcessKind = 'entity' | 'foreshadow' | 'relation' | 'status'
export type PostProcessStatus = 'new' | 'changed' | 'registered' | 'duplicate'

export interface PostProcessItem {
  kind: PostProcessKind
  /** 列表 key（稳定） */
  key: string
  status: PostProcessStatus
  /** 展示名 */
  label: string
  /** 一句话说明 */
  detail: string
  /** 原文证据（可溯源） */
  evidence?: string
  /** 目标表 / 卡页签（界面可改；实体用） */
  targetTabId?: string
  /** 命中的已有条目 id */
  matchedId?: string
  /** 落库载荷（内存态，**存账本时须剥离**） */
  raw?: unknown
}

export interface PostProcessReport {
  chapterId: string
  chapterTitle: string
  /** 本章正文指纹 —— 结果绑定正文（正文再变即作废重跑） */
  fingerprint: string
  at: number
  items: PostProcessItem[]
  notes: string[]
}

/** 参与「人物状态」比对与写入的角色卡页签 */
const STATUS_TABS = ['char-main', 'char-secondary', 'char-npc'] as const
/** 章节总表里伏笔列 */
const COL_PLANT = '埋设伏笔编号'
const COL_RECYCLE = '回收伏笔编号'

// ============ ① 确定性比对（纯函数 · 好测） ============

/** 伏笔：按编号（大写）或内容归一化名匹配登记表 */
export function matchForeshadows(found: ExtractedForeshadow[], rows: TableRow[]): PostProcessItem[] {
  const byCode = new Map<string, TableRow>()
  const byName = new Map<string, TableRow>()
  for (const r of rows) {
    const code = (r.data['编号'] ?? '').trim().toUpperCase()
    if (code) byCode.set(code, r)
    const nm = normName(r.data['伏笔内容'] ?? '')
    if (nm) byName.set(nm, r)
  }
  return found.map((f, i) => {
    const code = (f.code ?? '').trim().toUpperCase()
    const hit = (code ? byCode.get(code) : undefined) ?? byName.get(normName(f.content))
    const act = f.action === '回收' ? '回收' : '埋设'
    const base = {
      kind: 'foreshadow' as const,
      key: `fs::${f.action}::${f.content}::${i}`,
      label: `${hit ? (code || hit.data['编号'] || '').trim() : (code || '未编号')} · ${act}`,
      detail: f.content,
      evidence: f.content,
      matchedId: hit?.id,
      raw: { ...f, code: (code || hit?.data['编号'] || '').trim() } as ExtractedForeshadow,
    }
    return hit
      ? { ...base, status: 'changed' as const }
      : { ...base, status: 'new' as const, detail: `${f.content}（伏笔追踪里还没有这一条，请先去登记再回来）` }
  })
}

/** 人物对的无序 key（AI 抽出的 A/B 顺序未必与登记一致） */
const pairKeyOf = (x: string, y: string) => [normName(x), normName(y)].sort().join('::')

/** 关系：按人物对（无序）匹配登记表 */
export function matchRelations(found: ExtractedRelation[], rows: TableRow[]): PostProcessItem[] {
  const byPair = new Map<string, TableRow[]>()
  for (const r of rows) {
    const k = pairKeyOf(r.data['人物A'] ?? '', r.data['人物B'] ?? '')
    if (!k || k === '::') continue
    const list = byPair.get(k) ?? []
    list.push(r)
    byPair.set(k, list)
  }
  return found.map((rel, i) => {
    const k = pairKeyOf(rel.a, rel.b)
    const hits = k ? (byPair.get(k) ?? []) : []
    // 同对多条时优先取「关系类型」一致的那条（作者按类型区分多条关系）
    const hit = (rel.type ? hits.find(h => (h.data['关系类型'] ?? '').trim() === rel.type) : undefined) ?? hits[0]
    const label = `${rel.a} × ${rel.b}${rel.type ? ` · ${rel.type}` : ''}`
    const base = {
      kind: 'relation' as const,
      key: `rel::${rel.a}::${rel.b}::${rel.type}::${i}`,
      label,
      detail: rel.change || '（模型未给变化说明）',
      matchedId: hit?.id,
      raw: { rel, rowId: hit?.id } as { rel: ExtractedRelation; rowId?: string },
    }
    return hit
      ? { ...base, status: 'changed' as const }
      : { ...base, status: 'new' as const, detail: `${rel.change || ''}（人物关系表里还没有「${rel.a} × ${rel.b}」这条，请先去登记再回来）`.trim() }
  })
}

/** 角色卡索引项（名 + 别称 → 卡） */
interface CardHit { tabId: string; rec: CardRecord }
function indexCards(cards: { tabId: string; list: CardRecord[] }[]): Map<string, CardHit> {
  const byName = new Map<string, CardHit>()
  for (const { tabId, list } of cards) {
    for (const rec of list) {
      const nm = normName(rec.name ?? '')
      if (nm) byName.set(nm, { tabId, rec })
      const aliases = rec.data['别称'] ?? ''
      for (const a of String(aliases).split(/[、,，;；/／|]+/)) {
        const an = normName(a)
        if (an && !byName.has(an)) byName.set(an, { tabId, rec })
      }
    }
  }
  return byName
}

/** 人物状态：按人物名找角色卡，比对「人物状态」字段当前值 */
export function matchStatuses(found: ExtractedStatus[], cards: { tabId: string; list: CardRecord[] }[]): PostProcessItem[] {
  const idx = indexCards(cards)
  return found.map((st, i) => {
    const hit = idx.get(normName(st.name))
    const label = `${st.name} · 状态`
    if (!hit) {
      return {
        kind: 'status' as const, key: `st::${st.name}::${i}`, status: 'new' as const,
        label, detail: `${st.state}（角色卡里找不到「${st.name}」，请先建卡或确认姓名）`,
        evidence: st.evidence, raw: { st, tabId: '', cardId: '', fieldKey: '' },
      }
    }
    const fieldKey = cardFieldPath(hit.tabId, ['人物状态'])
    const cur = fieldKey ? (hit.rec.data[fieldKey] ?? '').trim() : ''
    const next = st.state.trim()
    const same = normName(cur) === normName(next)
    return {
      kind: 'status' as const, key: `st::${st.name}::${i}`,
      status: same ? 'registered' as const : 'changed' as const,
      label, detail: next, evidence: st.evidence,
      matchedId: hit.rec.id,
      raw: { st, tabId: hit.tabId, cardId: hit.rec.id, fieldKey: fieldKey ?? '' },
    }
  })
}

/** 实体（事实）：复用 settingLedger 的三档比对，转成统一条目 */
export function entityItems(entities: ExtractedEntity[], reg: EntityRegistry): PostProcessItem[] {
  return classify(entities, reg).map(li => ({
    kind: 'entity' as const,
    key: `en::${li.key}`,
    status: li.status === 'duplicate' ? 'duplicate' : li.status === 'registered' ? 'registered' : 'new',
    label: `${li.type} · ${li.name}`,
    detail: li.desc || '',
    evidence: li.evidence || '',
    targetTabId: li.targetTabId,
    matchedId: li.matchedId,
    raw: li,
  }))
}

// ============ ② 编排：一次跑完四类 ============

/**
 * 跑一次章后整理，产出报告（**纯收集，不落库**）。
 * 正文为空 ⇒ 返回空报告（不发请求）。
 */
export async function collectPostProcess(
  input: PostProcessInput,
  opts?: { signal?: AbortSignal },
): Promise<PostProcessReport> {
  const chapterTitle = input.chapterTitle ?? ''
  const meta = await resolveMeta(input)
  const fingerprint = chapterFingerprint({
    title: chapterTitle, content: input.content ?? '', wordCount: meta.wordCount, updatedAt: meta.updatedAt,
  })
  const notes: string[] = []
  const items: PostProcessItem[] = []
  const body = (input.content ?? '').trim()
  if (!body) {
    return { chapterId: input.chapterId, chapterTitle, fingerprint, at: Date.now(), items, notes: ['本章还没有正文，已跳过整理。'] }
  }

  // 四类素材并行读（都是本地库读，不涉及 AI）
  const [reg, foreRows, relRows, cardLists] = await Promise.all([
    loadRegistry().catch(() => null),
    db.getTableRows('foreshadow').catch(() => [] as TableRow[]),
    db.getTableRows('relations').catch(() => [] as TableRow[]),
    Promise.all(STATUS_TABS.map(t => db.getCardRecords(t).then(list => ({ tabId: t as string, list })))).catch(() => []),
  ])

  // 一次 AI 调用覆盖三类（伏笔 / 关系 / 状态）
  let changes: Awaited<ReturnType<typeof aiExtractChapterChanges>>
  try {
    changes = await aiExtractChapterChanges(body, chapterTitle, { signal: opts?.signal })
  } catch {
    changes = { foreshadows: [], relations: [], statuses: [] }
    notes.push('AI 抽取失败，本次只做设定实体比对。')
  }

  // 实体：复用既有链路（同一份正文再抽一次实体 —— 与「补登」模式同口径）
  if (reg) {
    try {
      const entities = await aiExtractSettingEntities(body, chapterTitle, { signal: opts?.signal })
      items.push(...entityItems(entities, reg))
    } catch {
      notes.push('设定实体抽取失败，本次跳过该类。')
    }
  }

  items.push(...matchForeshadows(changes.foreshadows, foreRows))
  items.push(...matchRelations(changes.relations, relRows))
  items.push(...matchStatuses(changes.statuses, cardLists))

  const actionable = items.filter(i => i.status !== 'registered').length
  if (!actionable) notes.push('本章没有需要整理的条目。')
  return { chapterId: input.chapterId, chapterTitle, fingerprint, at: Date.now(), items, notes }
}

// ============ ③ 落库（作者勾选后） ============

/** 追加以「、」分隔的编号串（去重、保序） */
function appendCode(existing: string | undefined, code: string): string {
  const parts = splitCodes(existing)
  if (!code) return parts.join('、')
  if (parts.includes(code)) return parts.join('、')
  return [...parts, code].join('、')
}
/** 追加以换行分隔的备注 */
function appendNote(existing: string | undefined, note: string): string {
  const t = (note ?? '').trim()
  if (!t) return existing ?? ''
  const e = (existing ?? '').trim()
  return e ? `${e}\n${t}` : t
}

export interface ApplyResult { created: number; failed: string[] }

/**
 * 把**作者勾选**的条目落库。各类落点：
 *   · entity   → 复用 `commitEntities`（设定表 / 角色卡，只填安全字段）
 *   · foreshadow → 本章在「章节总表」的 `埋设/回收伏笔编号`（**追加**）
 *   · relation  → `relations` 表 `演变轨迹（按卷）` / `演变触发事件`（**追加**）
 *   · status    → 角色卡「人物状态」字段
 */
export async function applyPostProcess(
  input: PostProcessInput, items: PostProcessItem[], chapterNo = 0,
): Promise<ApplyResult> {
  const failed: string[] = []
  let created = 0

  // 实体批量走既有提交器
  const entityRaws = items.filter(i => i.kind === 'entity' && i.raw).map(i => i.raw as LedgerItem)
  if (entityRaws.length) {
    const r = await commitEntities(entityRaws, input.chapterTitle ?? '').catch(() => ({ created: 0, failed: entityRaws.map(e => e.name) }))
    created += r.created
    failed.push(...r.failed)
  }

  const tabId = `chapter-vol-${(await resolveMeta(input)).volumeId}`
  const rid = `ch-${input.chapterId}`
  for (const item of items) {
    if (item.kind === 'entity') continue
    try {
      if (item.kind === 'foreshadow') {
        const raw = item.raw as ExtractedForeshadow | undefined
        if (!raw?.code) { failed.push(item.label); continue }
        const rows = await db.getTableRows(tabId)
        const row = rows.find(r => r.id === rid)
        if (!row) { failed.push(item.label); continue }
        const col = raw.action === '回收' ? COL_RECYCLE : COL_PLANT
        await db.saveTableRow({ ...row, data: { ...row.data, [col]: appendCode(row.data[col], raw.code) } })
      } else if (item.kind === 'relation') {
        const raw = item.raw as { rel: ExtractedRelation; rowId?: string } | undefined
        if (!raw?.rowId) { failed.push(item.label); continue }
        const rows = await db.getTableRows('relations')
        const row = rows.find(r => r.id === raw.rowId)
        if (!row) { failed.push(item.label); continue }
        const note = [
          raw.rel.change,
          chapterNo > 0 ? `（第${chapterNo}章）` : (input.chapterTitle ? `（${input.chapterTitle}）` : ''),
        ].filter(Boolean).join('')
        await db.saveTableRow({
          ...row,
          data: {
            ...row.data,
            ...(row.data['演变轨迹（按卷）'] !== undefined ? { '演变轨迹（按卷）': appendNote(row.data['演变轨迹（按卷）'], note) } : {}),
            ...(row.data['演变触发事件'] !== undefined ? { '演变触发事件': appendNote(row.data['演变触发事件'], note) } : {}),
          },
        })
      } else if (item.kind === 'status') {
        const raw = item.raw as { st: ExtractedStatus; tabId: string; cardId: string; fieldKey: string } | undefined
        if (!raw?.cardId || !raw.fieldKey) { failed.push(item.label); continue }
        const cards = await db.getCardRecords(raw.tabId)
        const rec = cards.find(c => c.id === raw.cardId)
        if (!rec) { failed.push(item.label); continue }
        await db.saveCardRecord({ ...rec, data: { ...rec.data, [raw.fieldKey]: raw.st.state } })
      }
      created++
    } catch {
      failed.push(item.label)
    }
  }
  return { created, failed }
}

/** 目标表 / 卡页签是否存在于 schema（界面改归属后校验用） */
export function tabExists(tabId: string): boolean {
  return TABS.some(t => t.id === tabId)
}
