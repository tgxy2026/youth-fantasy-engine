// ============ 设定状态演变记录（3.7.0 · W4）============
//
// 解决「第 N 章时某角色是什么状态」无法程序化回答的问题（规划 §3 W4）：
//   人物状态原本是单值覆盖写、关系演变是自由文本，旧值不留痕。
//   本模块把「某条目在某章的状态」变成可追加、可按章回溯的记录。
//
// 与「设定变更页签」的区别（手册要写清）：那是**作者改字段**的台账（编辑动作）；
// 这里是**剧情内演变**（故事里发生了什么）。
//
// 🔴 纪律：只追加、不覆盖；原「覆盖写当前值」行为保持不变；未登记条目不建记录。
// 存储：项目级 settingsKV 键 `stateRecords`，上限 500 条（超限如实报告 overflow）。
import * as db from '@/lib/db'
import type { OwnedOperation } from '@/lib/storage/ownedOperation'
import type { RecordRef } from '@/lib/revision/revisionTypes'

export const STATE_RECORD_KEY = 'stateRecords'
export const STATE_RECORD_LIMIT = 500

export interface StateRecord {
  id: string
  /** 任意设定条目（角色 / 物品 / 势力 / 地点 / 关系行），用稳定引用而不是名称 */
  ref: RecordRef
  chapterId: string
  /** 叙事章号（0 = 未识别；按章查询不参与） */
  chapterNo: number
  /** 该章结束时的状态（一句话） */
  state: string
  /** 改前值（覆盖写之前留痕；手填/老记录可能没有） */
  previous?: string
  trigger?: string
  evidence?: string
  createdAt: number
}

function usableNo(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0
}

function validRecord(v: unknown): v is StateRecord {
  if (!v || typeof v !== 'object') return false
  const r = v as Partial<StateRecord>
  return typeof r.id === 'string' && typeof r.state === 'string'
    && typeof r.chapterId === 'string' && !!r.ref && typeof r.ref === 'object'
}

export function stateRefKey(ref: RecordRef): string {
  return `${ref.kind}|${ref.tabId}|${ref.id}`
}

export async function readStateRecords(owner?: OwnedOperation): Promise<StateRecord[]> {
  try {
    const raw = owner
      ? await db.getSettingFor<unknown>(owner.projectId, STATE_RECORD_KEY, [], owner)
      : await db.getSetting<unknown>(STATE_RECORD_KEY, [])
    if (!Array.isArray(raw)) return []
    return raw.filter(validRecord)
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
 * 追加（按 id 去重）。超 500 条移动最旧并如实返回 overflow（界面提示导出）。
 * 🔴 读库失败 ⇒ 中止追加（appended:0）：绝不能拿空数组当基线覆盖掉整本旧记录。
 */
export async function appendStateRecords(
  incoming: readonly StateRecord[], owner?: OwnedOperation,
): Promise<{ appended: number; total: number; overflow: number }> {
  return serialized(async () => {
    let list: StateRecord[]
    try {
      const raw = owner
        ? await db.getSettingFor<unknown>(owner.projectId, STATE_RECORD_KEY, [], owner)
        : await db.getSetting<unknown>(STATE_RECORD_KEY, [])
      list = Array.isArray(raw) ? raw.filter(validRecord) : []
    } catch {
      return { appended: 0, total: 0, overflow: 0 }
    }
    const seen = new Set(list.map(r => r.id))
    const add = incoming.filter(r => validRecord(r) && !seen.has(r.id))
    if (!add.length) return { appended: 0, total: list.length, overflow: 0 }
    const next = [...add, ...list]
    const kept = next.slice(0, STATE_RECORD_LIMIT)
    try {
      if (owner) await db.setSettingFor(owner.projectId, STATE_RECORD_KEY, kept, owner)
      else await db.setSetting(STATE_RECORD_KEY, kept)
    } catch {
      return { appended: 0, total: list.length, overflow: 0 }
    }
    return { appended: add.length, total: kept.length, overflow: Math.max(0, next.length - kept.length) }
  })
}

/**
 * 纯函数：某条目「第 N 章结束时」的状态。
 * 排序口径：章号优先（≤N 的最后一条），同章按登记时间 —— 乱序 createdAt 不会翻车；
 * 章前没有记录返回 null（不拿未来记录倒推）。
 */
export function stateAt(records: readonly StateRecord[], ref: RecordRef, chapterNo: number): StateRecord | null {
  if (!usableNo(chapterNo)) return null
  const key = stateRefKey(ref)
  const hits = records
    .filter(r => stateRefKey(r.ref) === key && usableNo(r.chapterNo) && r.chapterNo <= chapterNo)
    .sort((a, b) => (a.chapterNo - b.chapterNo) || (a.createdAt - b.createdAt))
  return hits[hits.length - 1] ?? null
}

/** 某条目的全部演变（按章升序；「状态演变」列表与情感弧线用它） */
export function evolutionOf(records: readonly StateRecord[], ref: RecordRef): StateRecord[] {
  const key = stateRefKey(ref)
  return records
    .filter(r => stateRefKey(r.ref) === key)
    .sort((a, b) => (a.chapterNo - b.chapterNo) || (a.createdAt - b.createdAt))
}

/** 造一条可回溯记录（章后整理确认后 / 手动补登都用它） */
export function buildStateRecord(input: {
  ref: RecordRef
  chapterId: string
  chapterNo: number
  state: string
  previous?: string
  trigger?: string
  evidence?: string
  now?: number
}): StateRecord {
  const now = input.now ?? Date.now()
  return {
    id: `st-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    ref: input.ref,
    chapterId: input.chapterId,
    chapterNo: input.chapterNo,
    state: input.state,
    ...(input.previous ? { previous: input.previous } : {}),
    ...(input.trigger ? { trigger: input.trigger } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
    createdAt: now,
  }
}