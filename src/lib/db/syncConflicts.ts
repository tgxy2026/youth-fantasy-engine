import type { Chapter, Volume } from '@/lib/types'
import { CONFLICT_KEY_PREFIX } from '@/lib/sync/desktopCloudSync'
import { currentProjectId, ops, touchProject, persistAfterRestore } from '@/lib/db/core'
import { createAutoBackup } from '@/lib/db/backups'
import { createSnapshot } from '@/lib/db/chapters'
import { addDailyWords } from '@/lib/db/meta'
import { getDesktopCloudStatus } from '@/lib/sync/desktopCloudSync'

export interface StoredSyncConflict {
  metaKey: string
  store: string
  key: unknown
  at: number
  local: unknown
  server: unknown
  resolvedAt?: number
}

type MetaRow = { key: string; value: Partial<StoredSyncConflict> }

/** 冲突副本属于本机 meta，不参与云同步；老记录没有处理状态时视为未处理。 */
export async function listSyncConflicts(): Promise<StoredSyncConflict[]> {
  const rows = await ops.getAll<MetaRow>('meta')
  return rows.filter(r => typeof r.key === 'string' && r.key.startsWith(CONFLICT_KEY_PREFIX))
    .map(r => ({
      metaKey: r.key,
      store: String(r.value?.store ?? ''), key: r.value?.key,
      at: Number(r.value?.at ?? 0), local: r.value?.local, server: r.value?.server,
      resolvedAt: typeof r.value?.resolvedAt === 'number' ? r.value.resolvedAt : undefined,
    }))
    .sort((a, b) => b.at - a.at)
}

async function getConflict(metaKey: string): Promise<StoredSyncConflict> {
  if (!metaKey.startsWith(CONFLICT_KEY_PREFIX)) throw new Error('无效的冲突记录')
  const row = await ops.get<MetaRow>('meta', metaKey)
  if (!row?.value) throw new Error('冲突副本已不存在，请刷新列表')
  return { metaKey, store: String(row.value.store ?? ''), key: row.value.key,
    at: Number(row.value.at ?? 0), local: row.value.local, server: row.value.server,
    resolvedAt: row.value.resolvedAt }
}

export async function markSyncConflictResolved(metaKey: string): Promise<void> {
  const c = await getConflict(metaKey)
  await ops.put('meta', { key: metaKey, value: { store: c.store, key: c.key, at: c.at,
    local: c.local, server: c.server, resolvedAt: Date.now() } })
}

export async function deleteSyncConflict(metaKey: string): Promise<void> {
  await getConflict(metaKey)
  await ops.del('meta', metaKey)
}

/**
 * 仅恢复当前项目的章节。其它 store 先由作者导出双方数据，避免破坏记录关联。
 *
 * @returns 主操作已成功、但下游动作没跟上的**如实告警**清单（空数组 = 全部顺利）。
 *   界面据此提示「章节已恢复，但……」，不再让侧信道失败只躺在控制台里。
 */
export async function restoreServerChapterFromConflict(metaKey: string): Promise<string[]> {
  if (getDesktopCloudStatus() === 'syncing') throw new Error('同步仍在进行，请等待同步结束后再恢复')
  const c = await getConflict(metaKey)
  if (c.store !== 'chapters' || !c.server || typeof c.server !== 'object') throw new Error('这类冲突暂不支持直接恢复，请先导出双方数据')
  const server = c.server as Partial<Chapter>
  if (typeof c.key !== 'string' || server.id !== c.key || !server.projectId || server.projectId !== currentProjectId) {
    throw new Error('冲突章节不属于当前项目，请打开对应项目后恢复')
  }
  if (typeof server.content !== 'string' || typeof server.title !== 'string' || typeof server.summary !== 'string'
    || typeof server.wordCount !== 'number' || typeof server.volumeId !== 'string'
    || typeof server.order !== 'number' || !['构思', '细纲', '草稿', '修改', '完稿', '已发布'].includes(String(server.status))) {
    throw new Error('冲突副本缺少章节必需字段，请先导出双方数据')
  }
  const volume = await ops.get<Volume>('volumes', server.volumeId)
  if (!volume || volume.projectId !== currentProjectId) throw new Error('冲突章节所属分卷不存在，请先导出双方数据手工核对')
  const current = await ops.get<Chapter>('chapters', server.id)
  if (!current || current.projectId !== currentProjectId) throw new Error('当前章节已不存在，请先导出双方数据手工核对')
  const local = c.local as Partial<Chapter> | null
  if (!local || current.content !== local.content || current.title !== local.title || current.status !== local.status) {
    throw new Error('冲突发生后本机章节已有新改动，请先导出双方数据，避免覆盖后续写作')
  }
  const backup = await createAutoBackup(currentProjectId, 'manual', `恢复同步冲突前 · ${current.title}`)
  if (!backup) throw new Error('未能创建恢复前备份，本次没有改动章节')
  await createSnapshot(current, 'manual-restore')
  if (getDesktopCloudStatus() === 'syncing') throw new Error('备份期间开始了新一轮同步，本次没有改动章节，请稍后重试')
  const latest = await ops.get<Chapter>('chapters', server.id)
  if (!latest || latest.content !== current.content || latest.title !== current.title || latest.status !== current.status || latest.updatedAt !== current.updatedAt) {
    throw new Error('备份期间章节发生了变化，本次没有覆盖，请核对最新内容')
  }
  await ops.put('chapters', { ...server, projectId: currentProjectId, updatedAt: Date.now() } as Chapter)
  // 🔴 侧信道失败不再只 console.warn：主操作（章节已恢复）成功、下游动作没跟上时，
  //    必须如实回给界面 —— 否则作者看到「已恢复」，却发现字数统计没变、冲突还标着「待处理」。
  const warnings: string[] = []
  try { await addDailyWords(server.wordCount - current.wordCount) }
  catch (e) { console.warn('[sync] 恢复章节成功，但每日字数统计更新失败：', e); warnings.push('每日字数统计未更新') }
  void touchProject(currentProjectId)
  try { await markSyncConflictResolved(metaKey) }
  catch (e) { console.warn('[sync] 恢复章节成功，但冲突处理状态更新失败：', e); warnings.push('冲突记录未标记为已处理') }
  // 🔴 收尾必须排在最后：把恢复结果（含上面的每日字数）推云端 + 镜像回本机 + 落盘。
  //    否则界面随后的 reload 会让三路合并拿「冻结的旧本机文件」按「本地优先」把恢复盖回去。
  if (!(await persistAfterRestore())) warnings.push('恢复结果可能尚未写入磁盘，请稍后确认已生效')
  return warnings
}
