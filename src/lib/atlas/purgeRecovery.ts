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
import { ops } from '@/lib/db/core'
import { captureStorageWriteOwner } from '@/lib/storage/writeOwner'
import { DESKTOP, flushDesktop, getDesktopState } from '@/lib/app/desktop'
import { PORTABLE, flushPortable, getPortableState } from '@/lib/storage/fileBackend'
import { captureOwnedOperation, type OwnedOperation } from '@/lib/storage/ownedOperation'
import { withAtlasSchemaLock } from '@/lib/atlas/schemaLock'

function capturePurgeStore(projectId: string) {
  const store = ops
  const owner = captureStorageWriteOwner(projectId)
  const check = () => {
    if (!owner.current() || store !== ops) throw new Error('存储空间已切换，字段恢复记录未继续写入。')
  }
  return { store, check }
}

async function persistPurgeList(projectId: string, list: PendingFieldPurge[], captured: ReturnType<typeof capturePurgeStore>) {
  const { store, check } = captured
  check()
  if (store.putStrict) await store.putStrict('meta', { key: keyOf(projectId), value: list })
  else await store.put('meta', { key: keyOf(projectId), value: list })
  check()
  if (DESKTOP || PORTABLE) {
    const state = DESKTOP ? getDesktopState : getPortableState
    const flush = DESKTOP ? flushDesktop : flushPortable
    const deadline = Date.now() + 10000
    while (state().saving && Date.now() < deadline) {
      check()
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    check()
    if (state().saving || !await flush()) throw new Error('字段恢复记录未能写盘，已停止操作。')
    check()
  }
}

async function readPurgeList(projectId: string, captured: ReturnType<typeof capturePurgeStore>): Promise<PendingFieldPurge[]> {
  captured.check()
  const row = await captured.store.get<{ key: string; value: unknown }>('meta', keyOf(projectId))
  captured.check()
  if (row && !Array.isArray(row.value)) throw new Error('字段恢复记录已损坏，请先检查备份。')
  const list = row?.value as PendingFieldPurge[] | undefined ?? []
  if (!list.every(p => p && typeof p.tabId === 'string' && !!p.tabId && typeof p.fieldId === 'string' && !!p.fieldId)) {
    throw new Error('字段恢复记录包含无法识别的条目，请先检查备份。')
  }
  return list
}

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
  return readPurgeList(projectId, capturePurgeStore(projectId))
}

/** 记录/更新一条待清理项（同一 tab+field 只保留一条，保留最早的时间） */
export async function recordPendingFieldPurge(projectId: string, item: Omit<PendingFieldPurge, 'at'>): Promise<void> {
  if (!projectId || !item.tabId || !item.fieldId) return
  const captured = capturePurgeStore(projectId)
  const list = await readPurgeList(projectId, captured)
  const idx = list.findIndex(p => p.tabId === item.tabId && p.fieldId === item.fieldId)
  const next: PendingFieldPurge = { ...item, at: idx >= 0 ? list[idx].at : Date.now() }
  const merged = idx >= 0 ? list.map((p, i) => (i === idx ? next : p)) : [...list, next]
  await persistPurgeList(projectId, merged, captured)
}

export async function clearPendingFieldPurge(projectId: string, tabId: string, fieldId: string): Promise<void> {
  const captured = capturePurgeStore(projectId)
  const list = await readPurgeList(projectId, captured)
  const next = list.filter(p => !(p.tabId === tabId && p.fieldId === fieldId))
  if (next.length === list.length) return
  // 用空数组表示"没有待清理项"：约束层只给 get/set，没有 delMeta 也能表达同一语义
  await persistPurgeList(projectId, next, captured)
}

/** Discard only an uncommitted deletion intent; never abandon orphaned values. */
export async function discardIntactFieldPurge(projectId: string, target: Pick<PendingFieldPurge, 'tabId' | 'fieldId'>): Promise<void> {
  return withAtlasSchemaLock(projectId, target.tabId, () => discardIntactFieldPurgeLocked(projectId, target))
}

async function discardIntactFieldPurgeLocked(projectId: string, target: Pick<PendingFieldPurge, 'tabId' | 'fieldId'>): Promise<void> {
  const owner = captureOwnedOperation(projectId)
  owner.assertCurrent()
  const raw = await db.getSettingFor<unknown>(projectId, `atlasSchema::${target.tabId}`, null, owner)
  if (!raw || typeof raw !== 'object') throw new Error('字段配置无法核验，不能移除记录。')
  const config = raw as { formatVersion?: unknown; fields?: unknown }
  if (config.formatVersion !== 1 || !Array.isArray(config.fields)
    || !config.fields.every(field => !!field && typeof field === 'object' && typeof (field as { id?: unknown }).id === 'string')
    || !config.fields.some(field => (field as { id: string }).id === target.fieldId)) {
    throw new Error('字段定义已不存在或配置无法核验，请先处理残留数据。')
  }
  owner.assertCurrent()
  await clearPendingFieldPurge(projectId, target.tabId, target.fieldId)
}

/** 行里还剩多少条该字段的值（重试前先核对，0 就直接收尾） */
export async function countFieldValues(projectId: string, tabId: string, fieldId: string, owner?: OwnedOperation): Promise<number> {
  const rows = await db.getTableRowsFor(projectId, tabId as Parameters<typeof db.getTableRowsFor>[1], owner)
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
  purge: (projectId: string, tabId: string, fieldId: string, owner: OwnedOperation) => Promise<number> = async (pid, tab, field, owner) => {
    const { purgeFieldValues } = await import('@/lib/atlas/fieldOps')
    return purgeFieldValues(pid, tab, field, owner)
  },
): Promise<PurgeRetryResult> {
  return withAtlasSchemaLock(projectId, target.tabId, () => retryPendingFieldPurgeLocked(projectId, target, purge))
}

async function retryPendingFieldPurgeLocked(
  projectId: string,
  target: Pick<PendingFieldPurge, 'tabId' | 'fieldId'>,
  purge: (projectId: string, tabId: string, fieldId: string, owner: OwnedOperation) => Promise<number>,
): Promise<PurgeRetryResult> {
  const owner = captureOwnedOperation(projectId)
  try {
    owner.assertCurrent()
    const raw = await db.getSettingFor<unknown>(projectId, `atlasSchema::${target.tabId}`, null, owner)
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { fields?: unknown }).fields)) {
      throw new Error('字段配置无法核验，未清理任何值。')
    }
    const config = raw as { formatVersion?: unknown; fields: unknown[] }
    if (config.formatVersion !== 1 || !config.fields.every(field =>
      !!field && typeof field === 'object' && typeof (field as { id?: unknown }).id === 'string')) {
      throw new Error('字段配置版本或结构无法核验，未清理任何值。')
    }
    if (config.fields.some(field => (field as { id: string }).id === target.fieldId)) {
      throw new Error('字段定义仍然存在，不能清理它的值；请先核对字段设置或从备份恢复。')
    }
    const before = await countFieldValues(projectId, target.tabId, target.fieldId, owner)
    if (before === 0) {
      owner.assertCurrent()
      await clearPendingFieldPurge(projectId, target.tabId, target.fieldId)
      return { ok: true, removed: 0, remaining: 0 }
    }
    const removed = await purge(projectId, target.tabId, target.fieldId, owner)
    const remaining = await countFieldValues(projectId, target.tabId, target.fieldId, owner)
    if (remaining === 0) {
      owner.assertCurrent()
      await clearPendingFieldPurge(projectId, target.tabId, target.fieldId)
      return { ok: true, removed, remaining }
    }
    return { ok: false, removed, remaining, error: `还有 ${remaining} 行的值没清掉` }
  } catch (e) {
    const remaining = await countFieldValues(projectId, target.tabId, target.fieldId, owner).catch(() => -1)
    return {
      ok: false, removed: 0, remaining,
      error: e instanceof Error ? e.message : '清理失败',
    }
  }
}
