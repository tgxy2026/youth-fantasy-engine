import type { Chapter, Project, Volume } from '@/lib/types'
import { CONFLICT_KEY_PREFIX } from '@/lib/sync/desktopCloudSync'
import { currentProjectId, ops, persistAfterRestore } from '@/lib/db/core'
import { createAutoBackup } from '@/lib/db/backups'
import { createSnapshot } from '@/lib/db/chapters'
import { addDailyWords } from '@/lib/db/meta'
import { getDesktopCloudStatus, isDesktopCloudUnavailable } from '@/lib/sync/desktopCloudSync'

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

export interface ConflictRestoreResult {
  warnings: string[]
  /** 仅确认本机持久化，不代表远端已同步。未确认时界面禁止刷新。 */
  persisted: boolean
}

const chapterFields: (keyof Chapter)[] = ['id', 'projectId', 'volumeId', 'order', 'title', 'content', 'summary',
  'status', 'wordCount', 'createdAt', 'updatedAt', 'excludeFromNumbering', 'aiAssist']
const sameChapter = (a: Partial<Chapter>, b: Partial<Chapter>) =>
  chapterFields.every(key => JSON.stringify(a[key]) === JSON.stringify(b[key]))

/** 仅恢复当前项目的章节；项目或后端在异步等待期间变化时中止。 */
export async function restoreServerChapterFromConflict(metaKey: string): Promise<ConflictRestoreResult> {
  const projectId = currentProjectId
  const store = ops
  const assertContext = () => {
    if (currentProjectId !== projectId || ops !== store) throw new Error('项目或存储已切换，本次没有覆盖章节，请回到原项目后重试')
  }
  if (getDesktopCloudStatus() === 'syncing') throw new Error('同步仍在进行，请等待同步结束后再恢复')
  const c = await getConflict(metaKey)
  assertContext()
  if (c.store !== 'chapters' || !c.server || typeof c.server !== 'object') throw new Error('这类冲突暂不支持直接恢复，请先导出双方数据')
  const server = c.server as Partial<Chapter>
  if (typeof c.key !== 'string' || server.id !== c.key || !server.projectId || server.projectId !== projectId) {
    throw new Error('冲突章节不属于当前项目，请打开对应项目后恢复')
  }
  if (typeof server.content !== 'string' || typeof server.title !== 'string' || typeof server.summary !== 'string'
    || typeof server.wordCount !== 'number' || typeof server.volumeId !== 'string'
    || typeof server.order !== 'number' || !['构思', '细纲', '草稿', '修改', '完稿', '已发布'].includes(String(server.status))) {
    throw new Error('冲突副本缺少章节必需字段，请先导出双方数据')
  }
  const volume = await store.get<Volume>('volumes', server.volumeId)
  assertContext()
  if (!volume || volume.projectId !== projectId) throw new Error('冲突章节所属分卷不存在，请先导出双方数据手工核对')
  const current = await store.get<Chapter>('chapters', server.id)
  assertContext()
  if (!current || current.projectId !== projectId) throw new Error('当前章节已不存在，请先导出双方数据手工核对')
  const local = c.local as Partial<Chapter> | null
  if (!local || !sameChapter(current, local)) {
    throw new Error('冲突发生后本机章节已有新改动，请先导出双方数据，避免覆盖后续写作')
  }
  const backup = await createAutoBackup(projectId, 'manual', `恢复同步冲突前 · ${current.title}`)
  assertContext()
  if (!backup) throw new Error('未能创建恢复前备份，本次没有改动章节')
  const snapshot = await createSnapshot(current, 'manual-restore')
  assertContext()
  if (getDesktopCloudStatus() === 'syncing') throw new Error('备份期间开始了新一轮同步，本次没有改动章节，请稍后重试')
  const latest = await store.get<Chapter>('chapters', server.id)
  assertContext()
  if (!latest || !sameChapter(latest, current)) {
    throw new Error('备份期间章节发生了变化，本次没有覆盖，请核对最新内容')
  }
  const restored = { ...server, projectId, updatedAt: Date.now() } as Chapter
  await store.put('chapters', restored)
  const records: { store: string; value: unknown }[] = [
    { store: 'chapters', value: restored }, { store: 'snapshots', value: snapshot },
  ]
  // 🔴 侧信道失败不再只 console.warn：主操作（章节已恢复）成功、下游动作没跟上时，
  //    必须如实回给界面 —— 否则作者看到「已恢复」，却发现字数统计没变、冲突还标着「待处理」。
  const warnings: string[] = []
  try {
    const stat = await addDailyWords(server.wordCount - current.wordCount, projectId, store)
    if (stat) records.push({ store: 'dailyStats', value: stat })
  }
  catch (e) { console.warn('[sync] 恢复章节成功，但每日字数统计更新失败：', e); warnings.push('每日字数统计未更新') }
  try {
    const project = await store.get<Project>('projects', projectId)
    if (project) {
      const updated = { ...project, updatedAt: Date.now() }
      await store.put('projects', updated)
      records.push({ store: 'projects', value: updated })
    }
  } catch (e) { console.warn('[sync] 恢复章节成功，但项目更新时间更新失败：', e); warnings.push('项目更新时间未更新') }
  const persisted = await persistAfterRestore(records)
  if (!persisted) warnings.push('恢复结果尚未确认写入磁盘，请勿刷新或关闭应用，请先导出数据或重试保存')
  // 先确认章节保存，再把冲突标为已处理；保存失败时保留待处理入口。
  if (persisted) {
    try {
      const resolved = { key: metaKey, value: { store: c.store, key: c.key, at: c.at,
        local: c.local, server: c.server, resolvedAt: Date.now() } }
      await store.put('meta', resolved)
      if (!(await persistAfterRestore([{ store: 'meta', value: resolved }]))) warnings.push('冲突处理状态尚未确认写入磁盘')
    } catch (e) { console.warn('[sync] 恢复章节成功，但冲突处理状态更新失败：', e); warnings.push('冲突记录未标记为已处理') }
  }
  if (isDesktopCloudUnavailable() || getDesktopCloudStatus() === 'error') warnings.push('云端同步尚未完成，请在连接恢复后检查同步状态')
  return { warnings, persisted }
}
