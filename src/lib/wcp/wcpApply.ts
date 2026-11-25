// ============ WCP 网页资料包 · 候选直连（3.7.3 · W2）============
//
// 把 `wcpParser` 归一化出的 6 类候选，**原样**送进 `chapterPostProcess.ts` 的确定性比对器：
//   matchForeshadows / matchRelations / matchStatuses / matchResources / matchBiographies
//   以及 `settingLedger.classify`（实体三档比对）。
//
// 🔴 为什么要「直连」而不是另写一套：
//   比对口径（按编号/归一化名匹配、同对关系优先同类型、未登记只提示不建条目、
//   小传节点去重）全部已在该模块里被单测钉住。重写一遍必然漂移（规划 §0.1 R3）。
// 🔴 因此本模块**只做三件事**：读比对所需的库内现状、把实体比对结果转成统一条目、调用落库函数。
//   不新增任何「AI 说了算」的判断。
// 🔴 落库仍是 `applyPostProcess`：只追加不覆盖、未登记不凭空建、作者勾选后才写。
import * as db from '@/lib/db'
import {
  applyPostProcess,
  matchBiographies,
  matchForeshadows,
  matchRelations,
  matchResources,
  matchStatuses,
  type ApplyResult,
  type PostProcessInput,
  type PostProcessItem,
} from '@/lib/outline/chapterPostProcess'
import { classify, loadRegistry } from '@/lib/settings/settingLedger'
import { readAllBiographies } from '@/lib/settings/charBiography'
import { readResourceTransfers } from '@/lib/settings/resourceLedger'
import { chapterSeqMap } from '@/lib/outline/chapterSeq'
import type { WcpParsedChanges } from '@/lib/wcp/wcpParser'
import type { CardRecord, TableRow } from '@/lib/types'

export interface WcpCandidateInput extends PostProcessInput {
  /** 解析器归一化后的 6 类候选 */
  changes: WcpParsedChanges
}

export interface WcpCandidateResult {
  chapterNo: number
  items: PostProcessItem[]
  /** 读取失败的类别（如实告知，不假装「本章没有变化」） */
  notes: string[]
}

/** 实体候选 → 统一条目（与 `chapterPostProcess.entityItems` 同口径的薄映射） */
function entityItems(entities: WcpParsedChanges['entities'], reg: Awaited<ReturnType<typeof loadRegistry>>): PostProcessItem[] {
  return classify(entities, reg).map(li => ({
    kind: 'entity' as const,
    key: `en::${li.key}`,
    status: li.status === 'duplicate' ? 'duplicate' as const : li.status === 'registered' ? 'registered' as const : 'new' as const,
    label: `${li.type} · ${li.name}`,
    detail: li.desc || '',
    evidence: li.evidence || '',
    targetTabId: li.targetTabId,
    matchedId: li.matchedId,
    raw: li,
  }))
}

async function cardListsOf(tabIds: readonly string[]): Promise<{ tabId: string; list: CardRecord[] }[]> {
  const out: { tabId: string; list: CardRecord[] }[] = []
  for (const tabId of tabIds) {
    try {
      out.push({ tabId, list: await db.getCardRecords(tabId) })
    } catch {
      out.push({ tabId, list: [] })
    }
  }
  return out
}

/**
 * 生成候选条目（**纯比对，不落库**）。
 *
 * 🔴 任一类读取失败只记 `notes`，其余类别照常比对 —— 与 `collectPostProcess` 的容错口径一致。
 */
export async function buildWcpCandidates(input: WcpCandidateInput): Promise<WcpCandidateResult> {
  const notes: string[] = []
  const items: PostProcessItem[] = []
  const changes = input.changes
  const chapterId = input.chapterId

  let chapterNo = 0
  try {
    const [vols, chs] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
    chapterNo = chapterSeqMap(vols, chs).get(chapterId) ?? 0
  } catch {
    notes.push('读取章节叙事序失败，章号按 0 处理（记录仍可按章 id 定位）。')
  }

  if (changes.entities.length) {
    try {
      const reg = await loadRegistry()
      items.push(...entityItems(changes.entities, reg))
    } catch {
      notes.push('设定登记表读取失败，实体候选本次跳过。')
    }
  }

  const [foreRows, relRows, cardLists, itemRows, transfers, bios] = await Promise.all([
    db.getTableRows('foreshadow').catch(() => [] as TableRow[]),
    db.getTableRows('relations').catch(() => [] as TableRow[]),
    cardListsOf(['char-main', 'char-secondary', 'char-npc']),
    db.getTableRows('items').catch(() => [] as TableRow[]),
    readResourceTransfers(),
    readAllBiographies(),
  ])

  if (changes.foreshadows.length) items.push(...matchForeshadows(changes.foreshadows, foreRows))
  if (changes.relations.length) items.push(...matchRelations(changes.relations, relRows))
  if (changes.statuses.length) items.push(...matchStatuses(changes.statuses, cardLists))
  if (changes.resources.length) items.push(...matchResources(changes.resources, itemRows, chapterNo, chapterId, transfers))
  if (changes.biographies.length) {
    const bioCards = cardLists.filter(c => c.tabId === 'char-main' || c.tabId === 'char-secondary')
    items.push(...matchBiographies(changes.biographies, bioCards, chapterNo, chapterId, bios))
  }

  return { chapterNo, items, notes }
}

/** 作者勾选后落库（复用既有提交链：只追加、不覆盖、未登记不建） */
export async function applyWcpCandidates(
  input: PostProcessInput,
  items: PostProcessItem[],
  chapterNo = 0,
): Promise<ApplyResult> {
  return applyPostProcess(input, items, chapterNo)
}

/**
 * 是否允许勾选入库。
 *
 * 🔴 这里必须比「status !== registered」更严：
 *   · 伏笔 / 关系未登记时，比对器给的是 `new`（detail 已写「请先去登记」）——
 *     绝不能因为状态名是 new 就允许落库，那等于**凭空建条目**；
 *   · 角色状态找不到卡、物品 / 小传未登记，同样是只提示；
 *   · 只有「实体」的 `new` 是既有「补登」语义（`commitEntities` 会新建实体，仍由作者逐条勾选）。
 */
export function isWcpItemSelectable(item: PostProcessItem): boolean {
  if (item.kind === 'entity') return item.status === 'new' || item.status === 'changed'
  return item.status === 'changed'
}

/** 统计（UI 头部「N 条可写入 / M 条仅提示」） */
export function summarizeWcpCandidates(items: readonly PostProcessItem[]): {
  selectable: number
  hintOnly: number
  registered: number
} {
  let selectable = 0
  let hintOnly = 0
  let registered = 0
  for (const item of items) {
    if (isWcpItemSelectable(item)) selectable++
    else if (item.status === 'registered' || item.status === 'duplicate') registered++
    else hintOnly++
  }
  return { selectable, hintOnly, registered }
}