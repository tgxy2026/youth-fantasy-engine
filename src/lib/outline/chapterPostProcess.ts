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
import * as db from '@/lib/db'
import {
  aiExtractChapterChangesWithStatus, aiExtractSettingEntitiesWithStatus,
  type ExtractedEntity, type ExtractedForeshadow, type ExtractedRelation, type ExtractedStatus, type ExtractedResource,
} from '@/lib/ai/aiTasks'
import { loadRegistry, classify, commitEntities, cardFieldPath, normName, type LedgerItem, type EntityRegistry } from '@/lib/settings/settingLedger'
import { splitCodes } from '@/lib/audit/audit'
import { chapterSeqMap } from '@/lib/outline/chapterSeq'
import { readAliases } from '@/lib/settings/aliases'
import { commitResourceTransfer, readResourceTransfers, RESOURCE_TRANSFER_LIMIT, type ResourceTransfer } from '@/lib/settings/resourceLedger'
import { appendStateRecords, buildStateRecord, STATE_RECORD_LIMIT } from '@/lib/settings/stateTrack'
import { hashOf } from '@/lib/semantic/chunk'
import type { CallRequestContext } from '@/lib/ai/callTracking'
import { chapterFingerprint } from '@/lib/ai/aiRunLedger'
import { countWords } from '@/lib/editor/textStats'
import type { CardRecord, TableRow } from '@/lib/types'

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

/** 章号（叙事序）：取不到按 0 处理（账本记录仍可用章 id 定位） */
async function chapterNoFor(chapterId: string): Promise<number> {
  try {
    return chapterSeqMap(await db.getAllVolumes(), await db.getAllChapters()).get(chapterId) ?? 0
  } catch {
    return 0
  }
}

/** 从库里补出落库与指纹所需的元信息（拿不到就退化，绝不抛） */
async function resolveMeta(input: PostProcessInput): Promise<{ volumeId: string; wordCount: number; updatedAt: number }> {
  try {
    const ch = (await db.getAllChapters()).find(c => c.id === input.chapterId)
    if (ch) return { volumeId: ch.volumeId, wordCount: ch.wordCount, updatedAt: ch.updatedAt }
  } catch { /* 落退化值 */ }
  return { volumeId: '', wordCount: countWords(input.content ?? ''), updatedAt: Date.now() }
}

export type PostProcessKind = 'entity' | 'foreshadow' | 'relation' | 'status' | 'resource'
export type PostProcessStatus = 'new' | 'changed' | 'registered' | 'duplicate' | 'unregistered'

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
function entityItems(entities: ExtractedEntity[], reg: EntityRegistry): PostProcessItem[] {
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
  opts?: {
    signal?: AbortSignal
    /**
     * 请求归属（3.2.0 · WQ7）。
     * 🔴 后处理由编辑器助手直接触发，**没有父任务** —— 调用方应传 `{ scope: 'independent' }`，
     *    否则它会被算到「当时恰好有唯一在跑任务」的账上（统计与重试次数都会虚高）。
     */
    request?: CallRequestContext
    /**
     * 3.5.5 · ACP 分支：本次整理会连做两次 AI 调用（变化候选 + 设定实体），
     * 两者共用同一个 `acpText`（作者只需授权一次）。
     */
    acpText?: (prompt: string) => Promise<string>
  },
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
  // WQ1-4：走带状态版本 —— 请求失败与**解析失败**都写 notes，
  // 不再把「JSON 坏了」假装成「本章没有需要整理的条目」（假绿）。
  const chRun = await aiExtractChapterChangesWithStatus(body, chapterTitle, { signal: opts?.signal, acpText: opts?.acpText })
  const changes = chRun.result?.data ?? { foreshadows: [], relations: [], statuses: [], resources: [] }
  if (chRun.state === 'cancelled') notes.push('AI 抽取已取消，以下仅为已完成的比对。')
  else if (chRun.state !== 'completed') {
    notes.push('AI 抽取未完整完成（' + (chRun.errorCode ?? chRun.state) + '），伏笔/关系/状态三类可能漏检；本次只做已成功的设定实体比对。')
  }

  // 实体：复用既有链路（同一份正文再抽一次实体 —— 与「补登」模式同口径）
  if (reg) {
    const entRun = await aiExtractSettingEntitiesWithStatus(body, chapterTitle, {
    signal: opts?.signal,
    ...(opts?.request ? { request: opts.request } : {}),
    ...(opts?.acpText ? { acpText: opts.acpText } : {}),
  })
    if (entRun.state === 'completed') {
      items.push(...entityItems(entRun.result?.data ?? [], reg))
    } else if (entRun.state === 'cancelled') {
      notes.push('设定实体抽取已取消，本次跳过该类。')
    } else {
      notes.push('设定实体抽取未完整完成（' + (entRun.errorCode ?? entRun.state) + '），本次跳过该类。')
    }
  }

  items.push(...matchForeshadows(changes.foreshadows, foreRows))
  items.push(...matchRelations(changes.relations, relRows))
  items.push(...matchStatuses(changes.statuses, cardLists))
  // 3.7.0 · W3：物品流转（未登记只提示，不建条目）
  const itemRows = await db.getTableRows('items')
  items.push(...matchResources(changes.resources ?? [], itemRows, await chapterNoFor(input.chapterId), input.chapterId, await readResourceTransfers()))

  const actionable = items.filter(i => i.status !== 'registered').length
  if (!actionable) notes.push('本章没有需要整理的条目。')
  return { chapterId: input.chapterId, chapterTitle, fingerprint, at: Date.now(), items, notes }
}

// ============ 3.7.0 · W3：物品流转比对（纯函数） ============

/**
 * 把抽出的物品流转候选与 items 表现状比对。
 *
 * 🔴 未登记物品 → `unregistered`（界面只提示「先登记物品」，**不凭空建条目**）。
 * 🔴 同一笔（物品 + 章 + 动作 + 双方 + 证据）已在账本里 ⇒ `registered`（重跑整理不重复记）。
 */
export function matchResources(
  found: readonly ExtractedResource[],
  itemRows: readonly TableRow[],
  chapterNo: number,
  chapterId: string,
  existing: readonly ResourceTransfer[] = [],
): PostProcessItem[] {
  const byName = new Map<string, TableRow>()
  for (const row of itemRows) {
    const name = String(row.data['名称'] ?? '').trim()
    if (name) byName.set(normName(name), row)
    for (const alias of readAliases('items', row.data)) byName.set(normName(alias), row)
  }
  const items: PostProcessItem[] = []
  for (const r of found) {
    const item = (r.item ?? '').trim()
    const evidence = (r.evidence ?? '').trim()
    if (!item || !evidence) continue
    const row = byName.get(normName(item))
    const from = (r.from ?? '').trim()
    const to = (r.to ?? '').trim()
    const transferId = `rt-${hashOf(`${chapterId}|${row?.id ?? item}|${r.action}|${from}|${to}|${evidence}`).slice(0, 16)}`
    const label = `${row ? String(row.data['名称'] ?? item) : item}：${r.action}${from || to ? `（${from || '—'}→${to || '—'}）` : ''}`
    const detail = [r.action, r.quantity ? `×${r.quantity}` : '', `第${chapterNo || '?'}章`].filter(Boolean).join(' · ')
    if (!row) {
      items.push({
        kind: 'resource', key: `res-${transferId}`, status: 'unregistered', label, detail,
        evidence, raw: { transfer: null, item },
      })
      continue
    }
    const transfer: ResourceTransfer = {
      id: transferId, itemId: row.id, itemName: String(row.data['名称'] ?? item),
      chapterId, chapterNo, kind: r.action, from, to,
      ...(r.quantity ? { quantity: r.quantity } : {}), evidence, createdAt: Date.now(),
    }
    const exists = existing.some(t => t.id === transfer.id
      || (t.itemId === transfer.itemId && t.chapterId === chapterId && t.kind === transfer.kind
        && t.from === transfer.from && t.to === transfer.to && t.evidence === transfer.evidence))
    items.push({
      kind: 'resource', key: `res-${transferId}`, status: exists ? 'registered' : 'changed',
      label, detail, evidence, matchedId: row.id, raw: { transfer, item },
    })
  }
  return items
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

export interface ApplyResult { created: number; failed: string[]; /** 3.7.0 · W3：需要作者知道但不算失败的提醒（如账本超限） */ warnings?: string[] }

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
  let warnings: string[] | undefined
  // 调用方（颉文姬面板）不带章号 ⇒ 这里现算叙事序，避免把记录都记成「第 0 章」
  const no = chapterNo > 0 ? chapterNo : await chapterNoFor(input.chapterId)

  // 实体批量走既有提交器
  const entityRaws = items.filter(i => i.kind === 'entity' && i.raw).map(i => i.raw as LedgerItem)
  if (entityRaws.length) {
    const r = await commitEntities(entityRaws, input.chapterTitle ?? '', { pid: db.getCurrentProjectId() }).catch(() => ({ created: 0, failed: entityRaws.map(e => e.name) }))
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
          no > 0 ? `（第${no}章）` : (input.chapterTitle ? `（${input.chapterTitle}）` : ''),
        ].filter(Boolean).join('')
        await db.saveTableRow({
          ...row,
          data: {
            ...row.data,
            ...(row.data['演变轨迹（按卷）'] !== undefined ? { '演变轨迹（按卷）': appendNote(row.data['演变轨迹（按卷）'], note) } : {}),
            ...(row.data['演变触发事件'] !== undefined ? { '演变触发事件': appendNote(row.data['演变触发事件'], note) } : {}),
          },
        })
        // 3.7.0 · W4：关系演变同时落一条结构化记录（按章可回溯）
        const st = await appendStateRecords([buildStateRecord({
          ref: { kind: 'row', tabId: 'relations', id: raw.rowId, projectId: db.getCurrentProjectId() },
          chapterId: input.chapterId, chapterNo: no, state: note, trigger: '关系变化',
        })])
        if (st.overflow > 0) (warnings ??= []).push(`状态演变记录已超过 ${STATE_RECORD_LIMIT} 条上限，最早的 ${st.overflow} 条已不在本机账本里 —— 建议先导出备份再清理。`)
      } else if (item.kind === 'resource') {
        const raw = item.raw as { transfer: ResourceTransfer | null; item: string } | undefined
        // 未登记物品只提示、不凭空建（UI 也不允许勾选）
        if (!raw?.transfer) { failed.push(item.label); continue }
        const rows = await db.getTableRows('items')
        const row = rows.find(r => r.id === raw.transfer!.itemId)
        if (!row) { failed.push(item.label); continue }
        const r = await commitResourceTransfer({
          itemRow: row, transfer: raw.transfer, chapterLabel: no > 0 ? `第${no}章` : (input.chapterTitle || '本章'),
        })
        if (!r.ok) { failed.push(item.label); continue }
        if (r.overflow > 0) (warnings ??= []).push(`流转记录已超过 ${RESOURCE_TRANSFER_LIMIT} 条上限，最早的 ${r.overflow} 条已不在本机账本里 —— 建议先导出备份再清理。`)
      } else if (item.kind === 'status') {
        const raw = item.raw as { st: ExtractedStatus; tabId: string; cardId: string; fieldKey: string } | undefined
        if (!raw?.cardId || !raw.fieldKey) { failed.push(item.label); continue }
        const cards = await db.getCardRecords(raw.tabId)
        const rec = cards.find(c => c.id === raw.cardId)
        if (!rec) { failed.push(item.label); continue }
        // 3.7.0 · W4：覆盖写之前先把「旧值 → 新值」写成可回溯记录（当前值行为不变）
        const previous = String(rec.data[raw.fieldKey] ?? '')
        await db.saveCardRecord({ ...rec, data: { ...rec.data, [raw.fieldKey]: raw.st.state } })
        const st = await appendStateRecords([buildStateRecord({
          ref: { kind: 'card', tabId: raw.tabId, id: raw.cardId, projectId: db.getCurrentProjectId() },
          chapterId: input.chapterId, chapterNo: no, state: raw.st.state,
          ...(previous ? { previous } : {}),
          trigger: '章后整理',
          ...(raw.st.evidence ? { evidence: raw.st.evidence } : {}),
        })])
        if (st.overflow > 0) (warnings ??= []).push(`状态演变记录已超过 ${STATE_RECORD_LIMIT} 条上限，最早的 ${st.overflow} 条已不在本机账本里 —— 建议先导出备份再清理。`)
      }
      created++
    } catch {
      failed.push(item.label)
    }
  }
  return { created, failed, ...(warnings ? { warnings } : {}) }
}

