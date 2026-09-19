// ============ 存储层 · 卷 / 卷台账 ============
// 2026-09-19 结构优化 D2：自 db.ts 拆出。
// ⚠️ `VOL_LEDGER_PREFIX`（卷台账表的 tabId 前缀）定义在本文件，projects / migrations / backups 都从这里取。
import type { Volume, Chapter, TableRow } from '../types'
import { ops, currentProjectId, touchProject } from './core'
import type { Snapshot } from './chapters'
import { getTableRows } from './tabs'

// ============ 卷 ============
export async function getAllVolumes(): Promise<Volume[]> {
  const all = await ops.getAll<Volume>('volumes')
  return all.filter(v => v.projectId === currentProjectId).sort((a, b) => a.order - b.order)
}
export async function saveVolume(v: Volume) {
  await ops.put('volumes', { ...v, projectId: v.projectId || currentProjectId })
  touchProject(currentProjectId)
}
export async function deleteVolume(id: string) {
  const allCh = await ops.getAll<Chapter>('chapters')
  const now = Date.now()
  await ops.del('volumes', id)
  for (const c of allCh) {
    if (c.projectId === currentProjectId && c.volumeId === id) {
      await ops.put('trash', { ...c, deletedAt: now, kind: 'chapter' })
      await ops.del('chapters', c.id)
      await ops.del('tableRows', `ch-${c.id}`)
      // 级联清理该章的「时光机」快照，避免删除后孤儿快照在库里无限堆积
      const volSnaps = await ops.getAllByIndex<Snapshot>('snapshots', 'chapterId', c.id)
      if (volSnaps.length) await ops.bulkDel('snapshots', volSnaps.map(s => s.id))
    }
  }
}

// ============ 卷台账（按卷建表） ============
/** 卷台账表的 tabId 前缀（与 schema.getVolumeLedgerTabId 保持一致，避免循环依赖此处直接拼） */
export const VOL_LEDGER_PREFIX = 'chapter-vol-'

/**
 * 聚合所有卷的章节台账行（按卷建表后，章节台账分散在 chapter-vol-<volumeId> 各表中）。
 * 返回打平的 TableRow[]，供伏笔引擎 / 一致性核查 / 全文检索 / 情节推演等需要"全卷视角"的地方使用。
 */
export async function getAllChapterLedgerRows(): Promise<TableRow[]> {
  const vols = await getAllVolumes()
  const out: TableRow[] = []
  for (const v of vols) {
    const rows = await getTableRows(`${VOL_LEDGER_PREFIX}${v.id}`)
    out.push(...rows)
  }
  return out
}

/** 章节移动卷后，清理其在"其它卷台账表"里的孤儿行（行 id 形如 ch-<chapterId>，跨表唯一） */
export async function purgeLedgerRowEverywhere(chId: string, exceptVolumeId: string) {
  const rid = `ch-${chId}`
  const all = await ops.getAll<TableRow>('tableRows')
  const targets = all.filter(
    r => r.projectId === currentProjectId && r.id === rid && r.tabId !== `${VOL_LEDGER_PREFIX}${exceptVolumeId}`,
  )
  if (targets.length) await ops.bulkDel('tableRows', targets.map(t => t.id))
}
