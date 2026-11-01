/**
 * 3.3.3 · B6：永久删除字段后**清值失败**的恢复记录（本机专属 meta）。
 *
 * 顺序是"先删定义、再清各行的值"：定义一删，残留值就变成不可见的孤儿键（不会造成类型不兼容）。
 * 但若清值中途失败（存储切换 / 单项写失败 / 强杀），只弹一次 toast 就再也找不到这些孤儿了。
 * 这里把待清理项记下来，字段设置面板给出「重试清理」；清到 0 才删记录。
 *
 * 🔴 记录是本机的：孤儿值本身在 TableRow 里会随作品同步，但"这台机器上没清完"这件事
 *    另一台设备没有上下文（它可能根本没有那条备份），故登记进 LOCAL_ONLY_META_KEY_PREFIXES。
 * 🔴 不自动重试：清理是破坏性操作，只在作者点「重试清理」时执行。
 */
import * as db from '@/lib/db'

export interface PendingFieldPurge {
  tabId: string
  fieldId: string
  fieldLabel: string
  /** 删除前建的自动备份（找不到时可用它恢复） */
  backupId: string
  /** 上次已知的残留行数；重试后再核对 */
  remaining: number
  at: number
}

function keyOf(projectId: string): string {
  return `atlasPurgePending::${projectId}`
}

export async function listPendingFieldPurges(projectId: string): Promise<PendingFieldPurge[]> {
  if (!projectId) return []
  const list = await db.getMeta<PendingFieldPurge[]>(keyOf(projectId), [])
  if (!Array.isArray(list)) return []
  return list.filter(p => p && p.tabId && p.fieldId)
}

/** 记录/更新一条待清理项（同一 tab+field 只保留一条，保留最早的时间） */
export async function recordPendingFieldPurge(projectId: string, item: Omit<PendingFieldPurge, 'at'>): Promise<void> {
  if (!projectId || !item.tabId || !item.fieldId) return
  const list = await listPendingFieldPurges(projectId)
  const idx = list.findIndex(p => p.tabId === item.tabId && p.fieldId === item.fieldId)
  const next: PendingFieldPurge = { ...item, at: idx >= 0 ? list[idx].at : Date.now() }
  const merged = idx >= 0 ? list.map((p, i) => (i === idx ? next : p)) : [...list, next]
  await db.setMeta(keyOf(projectId), merged)
}

export async function clearPendingFieldPurge(projectId: string, tabId: string, fieldId: string): Promise<void> {
  const list = await listPendingFieldPurges(projectId)
  const next = list.filter(p => !(p.tabId === tabId && p.fieldId === fieldId))
  if (next.length === list.length) return
  // 用空数组表示"没有待清理项"：约束层只给 get/set，没有 delMeta 也能表达同一语义
  await db.setMeta(keyOf(projectId), next)
}

/** 行里还剩多少条该字段的值（重试前先核对，0 就直接收尾） */
export async function countFieldValues(projectId: string, tabId: string, fieldId: string): Promise<number> {
  const rows = await db.getTableRowsFor(projectId, tabId as Parameters<typeof db.getTableRowsFor>[1])
  let n = 0
  for (const row of rows) if (row.data && fieldId in row.data) n++
  return n
}

export interface PurgeRetryResult {
  ok: boolean
  removed: number
  remaining: number
  error?: string
}

/**
 * 重试清理：成功且残留归零才删记录；失败保留记录并返回剩余数。
 * 🔴 「写成功了几行」不代表完成 —— 以**回读后的剩余数为准**。
 */
export async function retryPendingFieldPurge(
  projectId: string,
  target: Pick<PendingFieldPurge, 'tabId' | 'fieldId'>,
  purge: (projectId: string, tabId: string, fieldId: string) => Promise<number> = async (pid, tab, field) => {
    const { purgeFieldValues } = await import('@/lib/atlas/fieldOps')
    return purgeFieldValues(pid, tab, field)
  },
): Promise<PurgeRetryResult> {
  try {
    const before = await countFieldValues(projectId, target.tabId, target.fieldId)
    if (before === 0) {
      await clearPendingFieldPurge(projectId, target.tabId, target.fieldId)
      return { ok: true, removed: 0, remaining: 0 }
    }
    const removed = await purge(projectId, target.tabId, target.fieldId)
    const remaining = await countFieldValues(projectId, target.tabId, target.fieldId)
    if (remaining === 0) {
      await clearPendingFieldPurge(projectId, target.tabId, target.fieldId)
      return { ok: true, removed, remaining }
    }
    return { ok: false, removed, remaining, error: `还有 ${remaining} 行的值没清掉` }
  } catch (e) {
    const remaining = await countFieldValues(projectId, target.tabId, target.fieldId).catch(() => -1)
    return {
      ok: false, removed: 0, remaining,
      error: e instanceof Error ? e.message : '清理失败',
    }
  }
}