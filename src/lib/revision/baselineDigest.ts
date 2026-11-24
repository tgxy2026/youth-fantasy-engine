// ============ 基准摘要（3.7.0 · W2 · R2 口径）============
//
// 为什么单独一个模块（见规划 §0.2 R2）：
//   `candidateRunner.jobForCandidate` 是**纯函数、不落库** —— 崩溃恢复时它靠候选自身携带的字段
//   重建 baseline。若摘要取自「生成那一刻的临时快照」，恢复时就重算不出同一个值，候选会被误判过期。
//
// 所以取数口径必须写成**可确定性重算**的函数：
//   给定「章 id + 当前库状态」⇒ 同一 hash。生成时算一次写进候选；恢复时只读候选字段，
//   两边口径由本模块唯一决定。
//
// 🔴 一号纪律：取不到数据（章不存在 / 没有细纲卡 / 没固定资料）就返回 undefined，
//   让 `isBaselineStale` 跳过这一维 —— **不知道基准时不许假装知道**，否则会把好候选误标过期。
import * as db from '@/lib/db'
import type { OwnedOperation } from '@/lib/storage/ownedOperation'
import type { RecordRef } from '@/lib/revision/revisionTypes'
import { normalizeChapterContextBinding } from '@/lib/revision/chapterContext'
import { OUTLINE_TAB_ID, chapterNoOf } from '@/lib/outline/outlineCard'
import { chapterSeqMap } from '@/lib/outline/chapterSeq'
import { hashOf } from '@/lib/semantic/chunk'

/** 章节资料绑定（本章固定资料）的 settingsKV 键前缀（与 db/projects.ts 同口径） */
export const CHAPTER_CONTEXT_PREFIX = 'chapterContext32:'

/** 一行资料值的规范化文本：卡名 / 字段表都按「键=值」排序后拼 */
function canonicalOf(name: string | undefined, data: Record<string, string> | undefined): string {
  const keys = Object.keys(data ?? {}).sort()
  return `${name ?? ''}\n${keys.map(k => `${k}=${data?.[k] ?? ''}`).join('\n')}`
}

/** 纯函数：细纲卡摘要（卡名 + 全部字段值，排序后 hash） */
export function outlineDigestOf(card: { name?: string; data?: Record<string, string> } | null | undefined): string | undefined {
  if (!card) return undefined
  return hashOf(canonicalOf(card.name, card.data))
}

/** 纯函数：一组「固定资料」当前值的摘要（引用身份 + 值；排序后 hash） */
export function settingsDigestOf(entries: readonly { key: string; value: string }[]): string {
  return hashOf(entries.map(e => `${e.key}\n${e.value}`).sort().join('\n---\n'))
}

/** 章号（叙事序号；0 = 不占号 / 找不到），与细纲卡名解析同口径 */
async function chapterNoOfId(chapterId: string, owner?: OwnedOperation): Promise<number> {
  const vols = owner ? await db.getAllVolumes(owner) : await db.getAllVolumes()
  const chs = owner ? await db.getAllChapters(owner) : await db.getAllChapters()
  return chapterSeqMap(vols, chs).get(chapterId) ?? 0
}

/** 该章对应的细纲卡：按「卡名解析出的章号 === 叙事序号」唯一匹配；匹配不到返回 undefined */
export async function outlineCardForChapter(
  chapterId: string, owner?: OwnedOperation,
): Promise<{ name: string; data: Record<string, string> } | undefined> {
  const no = await chapterNoOfId(chapterId, owner)
  if (!(no > 0)) return undefined
  const pid = owner?.projectId ?? db.getCurrentProjectId()
  const cards = owner ? await db.getCardRecordsFor(pid, OUTLINE_TAB_ID, owner) : await db.getCardRecords(OUTLINE_TAB_ID)
  const hit = cards.find(c => chapterNoOf(c.name) === no)
  return hit ? { name: hit.name, data: hit.data } : undefined
}

/** 细纲摘要：章 id ⇒ 当前细纲卡摘要；没有卡/章号判不出 → undefined（不参与过期判定） */
export async function outlineDigestForChapter(chapterId: string, owner?: OwnedOperation): Promise<string | undefined> {
  try {
    return outlineDigestOf(await outlineCardForChapter(chapterId, owner))
  } catch {
    return undefined
  }
}

/**
 * 读一条固定引用的当前值。条目已删 ⇒ 规范化空值占位（删除资料本身也是一次变化，可确定性重算）；
 * 🔴 读库失败 ⇒ 异常上抛，由 settingsDigestForChapter 返 undefined 跳过这一维 ——
 *    绝不让「读失败」伪装成「资料已删」，否则会把好候选误标过期（一号纪律）。
 */
async function valueOfRef(ref: RecordRef, pid: string, owner?: OwnedOperation): Promise<string> {
  if (ref.kind === 'card' || ref.kind === 'outline') {
    const rows = owner ? await db.getCardRecordsFor(pid, ref.tabId, owner) : await db.getCardRecords(ref.tabId)
    const hit = rows.find(r => r.id === ref.id)
    return canonicalOf(hit?.name, hit?.data)
  }
  if (ref.kind === 'row') {
    const rows = owner ? await db.getTableRowsFor(pid, ref.tabId, owner) : await db.getTableRows(ref.tabId)
    const hit = rows.find(r => r.id === ref.id)
    return canonicalOf(undefined, hit?.data)
  }
  if (ref.kind === 'form') {
    const data = owner ? await db.getFormDataFor(pid, ref.tabId, owner) : await db.getFormData(ref.tabId)
    return canonicalOf(undefined, data)
  }
  if (ref.kind === 'chapter') {
    const chs = owner ? await db.getAllChapters(owner) : await db.getAllChapters()
    return canonicalOf(undefined, { 正文: chs.find(c => c.id === ref.id)?.content ?? '' })
  }
  return ''
}

/** 依赖设定摘要：章 id ⇒ 该章「本章资料」固定引用的当前值；没有固定项 → 空集摘要（稳定值） */
export async function settingsDigestForChapter(chapterId: string, owner?: OwnedOperation): Promise<string | undefined> {
  try {
    const pid = owner?.projectId ?? db.getCurrentProjectId()
    const raw = owner
      ? await db.getSettingFor<unknown>(pid, `${CHAPTER_CONTEXT_PREFIX}${chapterId}`, undefined, owner)
      : await db.getSetting<unknown>(`${CHAPTER_CONTEXT_PREFIX}${chapterId}`, undefined)
    const binding = normalizeChapterContextBinding(raw, pid)
    const entries: { key: string; value: string }[] = []
    for (const ref of binding.pinnedRefs) {
      entries.push({ key: `${ref.kind}|${ref.tabId}|${ref.id}`, value: await valueOfRef(ref, pid, owner) })
    }
    return settingsDigestOf(entries)
  } catch {
    return undefined
  }
}

/** 章序（叙事序号）；用于章序重排导致的过期判定 */
export async function chapterOrderForChapter(chapterId: string, owner?: OwnedOperation): Promise<number | undefined> {
  try {
    const no = await chapterNoOfId(chapterId, owner)
    return no > 0 ? no : undefined
  } catch {
    return undefined
  }
}