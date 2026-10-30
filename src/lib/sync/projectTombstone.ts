// ============ 3.3.2 · P4-2 项目级删除墓碑 ============
//
// 【为什么必须有它】同步是"把本地整份内容推上去"。删掉一章之后推上去，
// 云端清单里没有它了 —— 看起来删成功了。但另一台设备手里还留着旧的那份，
// 它下一次提交会**把这一章又带回来**。这就是「删了复活」。
//
// 唯一的解法是：删除要留下一条**记录**（墓碑），随下一次提交一起发送，
// 对方设备看到墓碑就把本地那条也删掉。参考 `syncTombstone.ts`（那是全局内存版，
// 用于云端文件同步；本模块是**项目级、可持久**版，用于 v2 协议）。
//
// 🔴 墓碑只记 `kind + 主键`，**不记内容**：记内容等于把删掉的稿子又存了一份，
//    用户删了就是不想留。
// 🔴 墓碑 30 天过期（与协议 §5 一致）：足够覆盖"离线很久的设备回来一次"，
//    又不会让元数据无限增长。
// 🔴 存在队列那个独立 IDB（`-syncq`）里，**不进项目、不进整库、不进备份**：
//    它是本机待上报的执行状态，跟着项目走会让"墓碑被同步回来"变成新的复活路径。
import type { SnapshotTombstone } from '@/lib/sync/projectSnapshot'

/** 直接复用协议里的墓碑形状（`deletedAt`），省得两套字段来回翻译 */
export type Tombstone = SnapshotTombstone

/** 墓碑保留期：与协议 §5 的 30 天对齐 */
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 每个项目最多记多少条墓碑（防一条异常循环把存储撑爆） */
export const TOMBSTONE_MAX = 5000

/** 存取接口（单测注入内存实现；生产用 IDB 实现） */
export interface TombstoneStore {
  list(projectId: string): Promise<Tombstone[]>
  put(projectId: string, items: readonly Tombstone[]): Promise<void>
  clear(projectId: string): Promise<void>
}

export function createMemoryTombstoneStore(seed: Record<string, Tombstone[]> = {}): TombstoneStore {
  const m = new Map<string, Tombstone[]>()
  for (const [k, v] of Object.entries(seed)) m.set(k, v.map((t) => ({ ...t })))
  return {
    async list(pid) { return (m.get(pid) ?? []).map((t) => ({ ...t })) },
    async put(pid, items) { m.set(pid, items.map((t) => ({ ...t }))) },
    async clear(pid) { m.delete(pid) },
  }
}

/** 墓碑的身份键：同一条记录的墓碑只能有一条 */
export function tombstoneKey(t: Pick<Tombstone, 'kind' | 'id'>): string {
  return `${t.kind}\u0000${t.id}`
}

/**
 * 合并新墓碑进现有集合。
 *
 * 规则：同 kind + 同 id 只留一条，**保留最早的时间**（第一次删的时刻才是真实的）。
 * 超过上限时丢最旧的 —— 但正常项目远到不了 5000。
 */
export function mergeTombstones(
  existing: readonly Tombstone[],
  incoming: readonly Tombstone[],
  max = TOMBSTONE_MAX,
): Tombstone[] {
  const map = new Map<string, Tombstone>()
  for (const t of existing) {
    // 🔴 空串 id 也算无效：曾经漏掉这条，会造出一条 `""` 墓碑，服务端永远对不上任何记录
    if (!t || !t.kind || t.id === undefined || t.id === null || String(t.id) === '') continue
    const k = tombstoneKey(t)
    const prev = map.get(k)
    if (!prev || t.deletedAt < prev.deletedAt) map.set(k, { kind: t.kind, id: String(t.id), deletedAt: Number(t.deletedAt) || 0 })
  }
  for (const t of incoming) {
    // 🔴 空串 id 也算无效：曾经漏掉这条，会造出一条 `""` 墓碑，服务端永远对不上任何记录
    if (!t || !t.kind || t.id === undefined || t.id === null || String(t.id) === '') continue
    const k = tombstoneKey(t)
    const prev = map.get(k)
    if (!prev) map.set(k, { kind: t.kind, id: String(t.id), deletedAt: Number(t.deletedAt) || 0 })
    else if (t.deletedAt && t.deletedAt < prev.deletedAt) map.set(k, { ...prev, deletedAt: Number(t.deletedAt) })
  }
  const all = [...map.values()].sort((a, b) => (a.deletedAt - b.deletedAt) || (tombstoneKey(a) < tombstoneKey(b) ? -1 : 1))
  return all.length > max ? all.slice(all.length - max) : all
}

/** 去掉过期墓碑（超过 TTL） */
export function liveTombstones(list: readonly Tombstone[], now = Date.now(), ttlMs = TOMBSTONE_TTL_MS): Tombstone[] {
  return list.filter((t) => {
    const at = Number(t.deletedAt) || 0
    // at=0（老数据没时间）当作新鲜：宁可多带一条，也不要让删除失效
    return at === 0 || now - at <= ttlMs
  })
}

/**
 * 提交成功后清理墓碑。
 *
 * @param submittedAt 这次提交带走的墓碑时间上限（≤ 它的都被带走了）
 *
 * 🔴 只清"确实被这次提交带上去了"的那部分（`at <= submittedAt`）：
 *    提交期间用户可能又删了东西，那些墓碑必须留下。
 */
export async function clearSubmittedTombstones(
  store: TombstoneStore, projectId: string, submittedAt: number, now = Date.now(),
): Promise<number> {
  const all = await store.list(projectId)
  const remains = liveTombstones(all, now).filter((t) => (Number(t.deletedAt) || 0) > submittedAt)
  await store.put(projectId, remains)
  return all.length - remains.length
}

/**
 * 记下删除（业务侧删章 / 删卷 / 删卡片 / 删表格行时调用）。
 *
 * @returns 合并后的墓碑条数（便于调用方打日志）
 */
export async function noteDeletes(
  store: TombstoneStore, projectId: string,
  items: readonly { kind: string; id: unknown }[],
  now = Date.now(),
): Promise<number> {
  if (!items.length) return (await store.list(projectId)).length
  const incoming: Tombstone[] = items
    .filter((x) => x && x.kind && x.id !== undefined && x.id !== null && String(x.id))
    .map((x) => ({ kind: x.kind, id: String(x.id), deletedAt: now }))
  if (!incoming.length) return (await store.list(projectId)).length
  const existing = await store.list(projectId)
  const merged = mergeTombstones(liveTombstones(existing, now), incoming)
  await store.put(projectId, merged)
  return merged.length
}

/** 取要随下次提交发送的墓碑（已过期的不带） */
export async function tombstonesToSubmit(store: TombstoneStore, projectId: string, now = Date.now()): Promise<Tombstone[]> {
  return liveTombstones(await store.list(projectId), now)
}
