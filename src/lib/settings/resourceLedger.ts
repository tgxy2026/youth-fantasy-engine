// ============ 资源账本（3.7.0 · W3）============
//
// 解决的问题（规划 §3 W3）：
//   items 表的「当前持有者 / 流转轨迹」长期是**手填自由文本** —— 作者写「剑已赠人」，
//   后文却还写「他佩剑」，程序无从校验。本模块把「谁在第几章把什么给了谁」变成结构化记录。
//
// 🔴 三条铁律（与 `chapterPostProcess` 同一条）：
//   ① **只追加、不覆盖**：流转记录只增；items 的「当前持有者」是派生展示，轨迹列只追加一行；
//   ② **未登记物品不凭空建**：流转指向的条目不在 items 表 ⇒ 只提示「先登记物品」；
//   ③ **证据必须来自正文原句**：没有 evidence 的候选不进确认面板（由抽取层把关）。
//
// 存储：项目级 `settingsKV` 键 `resourceTransfers`（`<pid>::` 前缀由 db 自带）。
// 上限 200 条滚动保留；**超限不静默**——返回值里如实给出被移出本地的条数，界面提示导出。
import * as db from '@/lib/db'
import type { OwnedOperation } from '@/lib/storage/ownedOperation'
import type { TableRow } from '@/lib/types'

export const RESOURCE_TRANSFER_KEY = 'resourceTransfers'
export const RESOURCE_TRANSFER_LIMIT = 200

export type ResourceTransferKind = '获得' | '失去' | '转移' | '消耗'

export interface ResourceTransfer {
  id: string
  /** items 表行的 id（唯一落点依据） */
  itemId: string
  /** 物品名快照（条目被删后仍能读懂这笔记录） */
  itemName: string
  chapterId: string
  /** 叙事章号（0 = 未识别；只影响排序与按章推算） */
  chapterNo: number
  kind: ResourceTransferKind
  /** 从谁那里（获得时为空） */
  from: string
  /** 到谁那里（失去/消耗时为空） */
  to: string
  quantity?: number
  /** 正文原句（强制） */
  evidence: string
  createdAt: number
}

function usableNo(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0
}

function validTransfer(v: unknown): v is ResourceTransfer {
  if (!v || typeof v !== 'object') return false
  const t = v as Partial<ResourceTransfer>
  return typeof t.id === 'string' && typeof t.itemId === 'string'
    && typeof t.chapterId === 'string' && typeof t.evidence === 'string'
    && ['获得', '失去', '转移', '消耗'].includes(String(t.kind))
}

/** 读全部流转记录（损坏一律返回空数组，绝不抛） */
export async function readResourceTransfers(owner?: OwnedOperation): Promise<ResourceTransfer[]> {
  try {
    const raw = owner
      ? await db.getSettingFor<unknown>(owner.projectId, RESOURCE_TRANSFER_KEY, [], owner)
      : await db.getSetting<unknown>(RESOURCE_TRANSFER_KEY, [])
    if (!Array.isArray(raw)) return []
    return raw.filter(validTransfer)
  } catch {
    return []
  }
}

/** 追加串行锁：读-改-写不得交错（手动补登与章后整理可能并发写同一键） */
let appendChain: Promise<unknown> = Promise.resolve()
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = appendChain.then(task, task)
  appendChain = run.then(() => undefined, () => undefined)
  return run
}

/**
 * 追加一笔/多笔流转（纯追加，按 id 去重）。
 *
 * 🔴 读库失败 ⇒ 中止追加（appended:0）：绝不能拿空数组当基线，否则写成功会把整本旧账本覆盖掉。
 * @returns overflow 被移出本地存储的条数（>0 时界面必须提示作者导出后清理，见规划 §3 W3.2）
 */
export async function appendResourceTransfers(
  incoming: readonly ResourceTransfer[], owner?: OwnedOperation,
): Promise<{ appended: number; total: number; overflow: number }> {
  return serialized(async () => {
    let list: ResourceTransfer[]
    try {
      const raw = owner
        ? await db.getSettingFor<unknown>(owner.projectId, RESOURCE_TRANSFER_KEY, [], owner)
        : await db.getSetting<unknown>(RESOURCE_TRANSFER_KEY, [])
      list = Array.isArray(raw) ? raw.filter(validTransfer) : []
    } catch {
      return { appended: 0, total: 0, overflow: 0 }
    }
    const seen = new Set(list.map(t => t.id))
    const add = incoming.filter(t => validTransfer(t) && !seen.has(t.id))
    if (!add.length) return { appended: 0, total: list.length, overflow: 0 }
    const next = [...add, ...list]
    const kept = next.slice(0, RESOURCE_TRANSFER_LIMIT)
    try {
      if (owner) await db.setSettingFor(owner.projectId, RESOURCE_TRANSFER_KEY, kept, owner)
      else await db.setSetting(RESOURCE_TRANSFER_KEY, kept)
    } catch {
      return { appended: 0, total: list.length, overflow: 0 }
    }
    return { appended: add.length, total: kept.length, overflow: Math.max(0, next.length - kept.length) }
  })
}

/** 纯函数：某条目在「第 N 章结束时」的持有者（≤N 的最后一笔；没有任何记录返回 undefined） */
export function holderAt(transfers: readonly ResourceTransfer[], itemId: string, chapterNo: number): string | undefined {
  if (!usableNo(chapterNo)) return undefined
  const rows = transfers
    .filter(t => t.itemId === itemId && usableNo(t.chapterNo) && t.chapterNo <= chapterNo)
    .sort((a, b) => (a.chapterNo - b.chapterNo) || (a.createdAt - b.createdAt))
  const last = rows[rows.length - 1]
  if (!last) return undefined
  if (last.kind === '失去' || last.kind === '消耗') return undefined
  return last.to || undefined
}

/** 纯函数：某条目的全部流转（按章号升序，同章按登记时间） */
export function transfersOfItem(transfers: readonly ResourceTransfer[], itemId: string): ResourceTransfer[] {
  return transfers
    .filter(t => t.itemId === itemId)
    .sort((a, b) => (a.chapterNo - b.chapterNo) || (a.createdAt - b.createdAt))
}

/**
 * 纯函数：确定性持有冲突检测（供连续性检查调用）。
 *
 * 判据（宁缺毋滥，规划 §3 W3.2 ④）：
 *   · 只在正文出现「X 的 <物品名>」这种**明确归属句式**时才取样，X 必须是已登记人名/别称；
 *   · 与「该章时点账本持有者」不一致 ⇒ 报 warn；
 *   · 没有账本记录、或 X 就是账本持有者 ⇒ 不报（不知道就不猜）。
 */
/**
 * 纯函数：确定性持有冲突检测（供连续性检查调用）。
 *
 * 判据（宁缺毋滥，规划 §3 W3.2 ④）：
 *   · 按句（。！？；换行）切分；句中出现物品名 + **恰好一位**已登记人名时才取样；
 *   · 该人名 ≠ 账本「该章时点持有者」⇒ 报 warn（证据取该句）；
 *   · 句中出现多位人名 = 归属有歧义 ⇒ 跳过；没有账本记录 ⇒ 跳过（不知道就不猜）。
 */
export function detectHolderConflicts(input: {
  /** 按叙事序排列的已写章节 */
  chapters: readonly { id: string; chapterNo: number; title: string; content: string }[]
  /** items 表行的名称 + 别称 */
  items: readonly { id: string; name: string; aliases: readonly string[] }[]
  transfers: readonly ResourceTransfer[]
  /** 已登记人名（含别称） */
  personNames: ReadonlySet<string>
}): { chapterId: string; chapterNo: number; itemId: string; itemName: string; mentioned: string; holder?: string; evidence: string }[] {
  const out: { chapterId: string; chapterNo: number; itemId: string; itemName: string; mentioned: string; holder?: string; evidence: string }[] = []
  const withLedger = input.items.filter(i => input.transfers.some(t => t.itemId === i.id))
  const persons = [...input.personNames].filter(Boolean).sort((a, b) => b.length - a.length)
  for (const chapter of input.chapters) {
    if (!usableNo(chapter.chapterNo) || !chapter.content) continue
    const clauses = chapter.content.split(/[。！？；\n]/).map(c => c.trim()).filter(Boolean)
    for (const item of withLedger) {
      const holder = holderAt(input.transfers, item.id, chapter.chapterNo)
      if (!holder) continue
      const names = [item.name, ...item.aliases].filter(Boolean)
      for (const clause of clauses) {
        if (!names.some(n => clause.includes(n))) continue
        // 这一句就是账本记录的那句话（“甲把剑递给乙”）—— 转手当下不算冲突
        // 这一句是账本那一笔的现场（同时出现转出方与接收方，或就是记录的原句）—— 转手当下不算冲突
        const sameTurn = input.transfers.some(t => t.itemId === item.id && t.chapterNo === chapter.chapterNo
          && ((!!t.from && !!t.to && clause.includes(t.from) && clause.includes(t.to))
            || (!!t.evidence && (clause.includes(t.evidence) || t.evidence.includes(clause)))))
        if (sameTurn) continue
        const mentioned = persons.filter(p => clause.includes(p) && p !== holder)
        // 句里恰好一位「非持有者」的人名 ⇒ 归属确定，可判定；多位 = 有歧义，跳过
        if (mentioned.length !== 1) continue
        out.push({
          chapterId: chapter.id, chapterNo: chapter.chapterNo,
          itemId: item.id, itemName: item.name,
          mentioned: mentioned[0], holder, evidence: clause.slice(0, 60),
        })
      }
    }
  }
  return out
}

/**
 * 作者勾选后落库：追加流转记录 + 更新 items 行（当前持有者 = 最后状态；轨迹**追加**一行）。
 *
 * 🔴 只对**已登记条目**调用；未登记的由确认面板拦下（「先登记物品」）。
 */
export async function commitResourceTransfer(input: {
  itemRow: TableRow
  transfer: ResourceTransfer
  chapterLabel: string
  owner?: OwnedOperation
}): Promise<{ ok: boolean; overflow: number }> {
  const { itemRow, transfer, chapterLabel } = input
  const label = `（${chapterLabel}）${transfer.from || '—'}→${transfer.to || '—'}${transfer.evidence ? `：${transfer.evidence.slice(0, 40)}` : ''}`
  const nextTrail = [String(itemRow.data['流转轨迹'] ?? '').trim(), label].filter(Boolean).join('\n')
  const nextHolder = transfer.kind === '失去' || transfer.kind === '消耗' ? '' : (transfer.to || String(itemRow.data['当前持有者'] ?? ''))
  try {
    await db.saveTableRow({
      ...itemRow,
      data: { ...itemRow.data, 当前持有者: nextHolder, 流转轨迹: nextTrail },
    }, input.owner)
  } catch {
    return { ok: false, overflow: 0 }
  }
  const r = await appendResourceTransfers([transfer], input.owner)
  if (r.appended > 0) return { ok: true, overflow: r.overflow }
  // 账本没写进去 ⇒ 把表格行恢复原样，避免「持有者改了、账本没有」的半截状态（尽力而为）
  await db.saveTableRow(itemRow, input.owner).catch(() => undefined)
  return { ok: false, overflow: 0 }
}