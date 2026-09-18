/**
 * 草稿层 —— 「抽取结果 → 待审阅草稿行」。
 *
 * 与 `settingLedger` 的分工（别搞混）：
 * - 「是否已在设定表里登记过」= `settingLedger.classify()` 的**确定性字符串比对**，本文件复用它，
 *   不另写一套 —— 两套判重口径必然漂移，会让同一实体在「一键续写补登」和「一键拆书」里表现不一致。
 * - 本文件负责的是「把抽取结果整理成可审阅的草稿」：同名跨章合并、置信度评分、原文引用核对、
 *   以及用 `fieldMap` 把语义字段解析成目标表的真实键。
 *
 * ⚠️ 本文件**不触达 db 写入**（除了读登记表做判重）—— 落库一律在 `commit.ts`，且必须经用户勾选。
 */
import type { ExtractedEntity, SettingEntityType } from '../aiTasks'
import { TABS } from '../schema'
import { classify, loadRegistry, normName, type EntityRegistry } from '../settingLedger'
import { KIND_MAP, resolveFieldPath, resolveSlot, targetTabOf } from './fieldMap'
import type { DraftBundle, DraftConflict, DraftField, DraftRow, DraftStatus } from './types'

/** 一批来自同一章节（或同一分块）的抽取结果 */
export interface EntityBatch {
  /** 来源标题（如「第3章 风起云州」）—— 会写进目标表的「首次出场」字段 */
  source: string
  /** 该标题的序号（1 起） */
  index: number
  entities: ExtractedEntity[]
}

export interface BuildDraftOptions {
  /** 原文全文（做「引用核对」用）。省略则不做核对、置信度不加「有证据」分。 */
  rawText?: string
  /** 复用已装载的登记表（多批次调用时省一次全项目扫描） */
  registry?: EntityRegistry
}

/** 默认勾选阈值：低于它的草稿在界面上默认不勾（用户仍可手动勾） */
export const DRAFT_PICK_THRESHOLD = 0.5

/** 判重结果的最小形状（`settingLedger.LedgerItem` 与本地降级分支的公共部分） */
interface Classified {
  status: 'registered' | 'duplicate' | 'new'
  matchedName?: string
  matchedTabId?: string
  matchedId?: string
}

/** 合并后的实体（同名跨章） */
interface Merged {
  type: SettingEntityType
  name: string
  aliases: string[]
  desc: string
  tier?: string
  /** 各来源（标题 + 序号） */
  from: { index: number; source: string }[]
  /** 原文证据（去重后） */
  quotes: string[]
}

/** tier 重要度：主要 > 次要 > NPC（合并时取最高） */
function tierRank(t?: string): number {
  return t === '主要' ? 3 : t === '次要' ? 2 : t === 'NPC' ? 1 : 0
}

function betterTier(a?: string, b?: string): string | undefined {
  return tierRank(a) >= tierRank(b) ? a : b
}

/** 同名同类型合并：描述取更长的一份（信息更全），证据去重，来源合并 */
function mergeEntities(batches: EntityBatch[]): Merged[] {
  const byKey = new Map<string, Merged>()
  for (const b of batches) {
    for (const e of b.entities) {
      const name = (e.name ?? '').trim()
      if (!name) continue
      const key = `${e.type}::${normName(name)}`
      const desc = (e.desc ?? '').trim()
      const quote = (e.evidence ?? '').trim()
      const cur = byKey.get(key)
      if (!cur) {
        byKey.set(key, {
          type: e.type,
          name,
          aliases: [],
          desc,
          ...(e.tier ? { tier: e.tier } : {}),
          from: [{ index: b.index, source: b.source }],
          quotes: quote ? [quote] : [],
        })
        continue
      }
      if (desc.length > cur.desc.length) cur.desc = desc
      cur.tier = betterTier(cur.tier, e.tier)
      if (quote && !cur.quotes.includes(quote)) cur.quotes.push(quote)
      if (!cur.from.some(f => f.index === b.index && f.source === b.source)) {
        cur.from.push({ index: b.index, source: b.source })
      }
    }
  }
  // 稳定顺序：按首次出现，便于界面渲染稳定
  return [...byKey.values()].sort((a, b) => (a.from[0]?.index ?? 0) - (b.from[0]?.index ?? 0))
}

function tabNameOf(tabId: string): string {
  return TABS.find(t => t.id === tabId)?.name ?? tabId
}

/**
 * 置信度启发式（照 `一键拆书-详细设计.md` §7.3 的 MVP 简化版）：
 * 基础 0.6 → 引用在原文中命中 +0.2 → 同一实体出现在 ≥2 个来源 +0.2 → 有冲突 −0.3。
 * 结果 clamp 到 [0,1]。
 */
function scoreOf(o: { quoteHit: boolean; sources: number; conflicts: number }): number {
  let c = 0.6
  if (o.quoteHit) c += 0.2
  if (o.sources >= 2) c += 0.2
  if (o.conflicts > 0) c -= 0.3
  return Math.max(0, Math.min(1, c))
}

/** 用 fieldMap 把合并结果落成「目标表真实键 → 值」（带显示名，UI 直接渲染） */
function fieldsOf(m: Merged, tabId: string): { fields: DraftField[]; nameKey: string; descKey?: string } {
  const map = KIND_MAP[m.type]
  const out: DraftField[] = []
  const put = (fieldName: string | undefined, value: string): string | undefined => {
    if (!fieldName || !value) return undefined
    const key = resolveSlot(tabId, fieldName)
    // 找不到落点就**不写**（写一个不存在的键 = 表里多出一列幽灵数据）
    if (key) out.push({ key, label: fieldName, value })
    return key ?? undefined
  }

  const nameKey = put(map.nameField, m.name) ?? ''
  if (map.aliasField && m.aliases.length) put(map.aliasField, m.aliases.join('、'))
  const desc = resolveFieldPath(tabId, map.descFields ?? [])
  const descKey = desc && m.desc ? put(desc.field, m.desc) : undefined
  const first = resolveFieldPath(tabId, map.firstFields ?? [])
  if (first && m.from[0]?.source) put(first.field, m.from[0].source)
  if (map.statusValue) put('人物状态', map.statusValue)
  return { fields: out, nameKey, ...(descKey ? { descKey } : {}) }
}

/**
 * 由抽取批次构建草稿。
 * @param batches 各章节（或分块）的抽取结果
 */
export async function buildDraftBundle(
  batches: EntityBatch[],
  opts: BuildDraftOptions = {},
): Promise<DraftBundle> {
  const merged = mergeEntities(batches)
  const reg = opts.registry ?? await loadRegistry().catch(() => null)

  // 复用 settingLedger 的三档判重（registered / duplicate / new）—— 口径只此一处
  // 取双方共有的最小形状：登记表缺失时（离线/读失败）退化为「全部视作新建」，不阻断拆书
  const items: Classified[] = reg
    ? classify(merged.map(m => ({
        type: m.type,
        name: m.name,
        desc: m.desc,
        evidence: m.quotes[0] ?? '',
        ...(m.tier ? { tier: m.tier as '主要' | '次要' | 'NPC' } : {}),
      })), reg)
    : merged.map(m => ({
        type: m.type,
        name: m.name,
        desc: m.desc,
        evidence: m.quotes[0] ?? '',
        key: `${m.type}::${m.name}`,
        status: 'new' as const,
      }))

  const raw = opts.rawText ?? ''
  const rows: DraftRow[] = []
  merged.forEach((m, i) => {
    const it = items[i]
    const tabId = targetTabOf(m.type, m.tier)
    const fo = fieldsOf(m, tabId)
    // 主名落点不存在（schema 改过字段名 / 目标表无此字段）→ 这条草稿根本落不了库。
    // 宁可少一条，也不给界面一条"点写入什么都不会发生"的死条目。
    if (!fo.nameKey) return

    // registered / duplicate 都归入 duplicate（界面语：疑似已存在），点明命中的是谁
    const status: DraftStatus = it.status === 'new' ? 'new' : 'duplicate'
    const conflicts: DraftConflict[] = [] // B1 的现成抽取不产出字段值，无从比对；B2 全字段抽取时在此填充
    const quoteHit = raw
      ? m.quotes.some(q => q && raw.includes(q))
      : m.quotes.length > 0
    const matched = it.matchedName && it.matchedTabId && it.matchedId
      ? { name: it.matchedName, tabId: it.matchedTabId, id: it.matchedId }
      : undefined
    rows.push({
      key: `${m.type}::${normName(m.name)}`,
      tabId,
      tabName: tabNameOf(tabId),
      kindLabel: KIND_MAP[m.type].label,
      name: m.name,
      aliases: m.aliases,
      fields: fo.fields,
      nameKey: fo.nameKey,
      ...(fo.descKey ? { descKey: fo.descKey } : {}),
      status,
      ...(matched ? { matched } : {}),
      ...(conflicts.length ? { conflicts } : {}),
      confidence: scoreOf({ quoteHit, sources: m.from.length, conflicts: conflicts.length }),
      quotes: m.quotes,
      chapters: [...new Set(m.from.map(f => f.index))].sort((a, b) => a - b),
    })
  })

  return bundleOf(rows)
}

/** 把草稿行整理成分组 + 统计（界面直接消费） */
export function bundleOf(rows: DraftRow[]): DraftBundle {
  const groups: DraftBundle['groups'] = []
  const byTab = new Map<string, DraftBundle['groups'][number]>()
  for (const r of rows) {
    let g = byTab.get(r.tabId)
    if (!g) { g = { tabId: r.tabId, tabName: r.tabName, rows: [] }; byTab.set(r.tabId, g); groups.push(g) }
    g.rows.push(r)
  }
  const byStatus: Record<DraftStatus, number> = { new: 0, duplicate: 0, conflict: 0 }
  const byKind: Record<string, number> = {}
  for (const r of rows) {
    byStatus[r.status]++
    byKind[r.kindLabel] = (byKind[r.kindLabel] ?? 0) + 1
  }
  return { rows, groups, stats: { total: rows.length, byStatus, byKind } }
}

/** 默认勾选判定：新建 + 置信度达标（重复项默认不勾，避免重复登记） */
export function defaultPicked(r: DraftRow): boolean {
  return r.status === 'new' && r.confidence >= DRAFT_PICK_THRESHOLD
}
