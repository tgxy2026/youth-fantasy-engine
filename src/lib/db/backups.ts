// ============ 存储层 · 自动备份 ============
// 2026-09-19 结构优化 D2：自 db.ts 拆出。
// 🔴 备份是**本地专属**数据（不参与云盘同步），见 makeCloudStoreWrapper 的短路逻辑。
import type { Project, FormData } from '../types'
import { uid } from '../id'
import { ops, touchProject } from './core'
import { exportProject, type ProjectBundle } from './projects'
import { VOL_LEDGER_PREFIX } from './volumes'
import type { Snapshot } from './chapters'

// ============ 自动备份（v1.3 备份策略加固） ============
// 每个项目一份独立「备份夹」（逻辑上按 projectId 归组），删除项目不掉备份；
// 三类：'auto5min'（打开项目时每 5 分钟滚动，最多保留 MAX_AUTO_BACKUPS 份）、
//       'daily'（每天首次打开自动 1 份，最多保留 MAX_DAILY_BACKUPS 份）、
//       'manual'（用户手动「立即备份」，不设上限 —— 主动留档不该被系统删掉）。
// #012：每日备份此前不限量，写一年即 365 份全量快照，便携版（单 JSON 全量写盘）会持续膨胀。
export type BackupKind = 'auto5min' | 'daily' | 'manual'

export interface BackupRecord {
  id: string
  projectId: string
  kind: BackupKind
  label: string
  createdAt: number
  bundle: ProjectBundle
}

/** 5 分钟自动备份滚动保留上限（#012：60 → 30） */
export const MAX_AUTO_BACKUPS = 30
/** 每日自动备份保留上限（#012：原先不限量 → 30，约一个月） */
export const MAX_DAILY_BACKUPS = 30
/** 保留上限查表：手动备份为 0，表示不限制 */
function backupLimit(kind: BackupKind): number {
  if (kind === 'auto5min') return MAX_AUTO_BACKUPS
  if (kind === 'daily') return MAX_DAILY_BACKUPS
  return 0 // manual：用户主动留档，永不自动删
}

/** 创建一次全量自动备份（默认上限由调用方保证） */
export async function createAutoBackup(projectId: string, kind: BackupKind, label?: string): Promise<BackupRecord> {
  // 🔴 自动备份**不带**章节快照（2.4.0 · A3）：它是每 5 分钟一次的高频全量，
  //    快照随它走会把本地存储迅速撑大。要带走快照的是「手动导出备份」，那条路径走默认值。
  const bundle = await exportProject(projectId, { includeSnapshots: false })
  const now = Date.now()
  const rec: BackupRecord = {
    id: uid(),
    projectId,
    kind,
    label: label ?? (kind === 'daily' ? `每日自动备份` : `自动备份`),
    createdAt: now,
    bundle,
  }
  await ops.put('backups', rec)
  // 滚动淘汰：超过该类型上限则删除最早的。手动备份（limit=0）不淘汰。
  const limit = backupLimit(kind)
  if (limit > 0) {
    const all = (await ops.getAll<BackupRecord>('backups'))
      .filter(b => b.projectId === projectId && b.kind === kind)
      .sort((a, b) => b.createdAt - a.createdAt)
    if (all.length > limit) {
      for (const drop of all.slice(limit)) await ops.del('backups', drop.id)
    }
  }
  return rec
}

/** 列出某项目的全部备份（按时间倒序） */
export async function listBackups(projectId: string): Promise<BackupRecord[]> {
  const all = await ops.getAll<BackupRecord>('backups')
  return all.filter(b => b.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt)
}

async function getBackup(id: string): Promise<BackupRecord | undefined> {
  return ops.get<BackupRecord>('backups', id)
}

export async function deleteBackup(id: string) {
  await ops.del('backups', id)
}

/** 孤儿备份：备份记录存在但其项目已被删除（删除项目时按约定保留备份，导致此类记录积累） */
export async function listOrphanBackups(): Promise<BackupRecord[]> {
  const [all, projs] = await Promise.all([ops.getAll<BackupRecord>('backups'), ops.getAll<{ id: string }>('projects')])
  const pids = new Set(projs.map(p => p.id))
  return all.filter(b => !pids.has(b.projectId)).sort((a, b) => b.createdAt - a.createdAt)
}

/** 删除全部孤儿备份，返回删除条数 */
export async function deleteOrphanBackups(): Promise<number> {
  const orphans = await listOrphanBackups()
  for (const o of orphans) await ops.del('backups', o.id)
  return orphans.length
}

/**
 * 将一份项目数据包「覆盖写回」到目标项目（恢复历史版本用）。
 * 保留目标项目 id，但用备份包的内容替换其全部数据（卷/章/表/卡/表单/统计/设置），
 * 并将书名、封面、类型、简介同步为备份当时的快照。
 */
export async function restoreBackup(id: string): Promise<void> {
  const rec = await getBackup(id)
  if (!rec) throw new Error('备份不存在')
  await applyBundleToProject(rec.projectId, rec.bundle)
}

async function applyBundleToProject(targetPid: string, bundle: ProjectBundle): Promise<void> {
  // 1. 收集该项目现有的键 —— ⚠️ 只收集，**先不删**。
  //    🔴 旧实现是「先清空、再写回」：写到一半失败（配额满、断网、用户关窗），
  //    项目就变半空且无从恢复。改成「先写后删」之后，任一步失败最多留下些
  //    可以再清理的多余记录 —— **原数据自始至终完好**。
  const delKeys: Record<string, string[]> = {}
  for (const name of ['volumes', 'chapters', 'tableRows', 'cardRecords', 'trash', 'tavernReports'] as const) {
    const all = await ops.getAll<{ id: string; projectId?: string }>(name)
    const keys = all.filter(r => r.projectId === targetPid).map(r => r.id)
    if (keys.length) delKeys[name] = keys
  }
  const prefix = `${targetPid}::`
  const forms = await ops.getAll<FormData>('formData')
  const formKeys = forms.filter(f => f.tabId.startsWith(prefix)).map(f => f.tabId)
  // 快照按 projectId 索引取，避免全表扫
  const snapKeys = (await ops.getAllByIndex<Snapshot>('snapshots', 'projectId', targetPid)).map(s => s.id)
  const statKeys: string[] = []
  const setKeys: string[] = []
  const daily = await ops.getAll<{ key: string }>('dailyStats')
  for (const r of daily) if (r.key.startsWith(prefix)) statKeys.push(r.key)
  const settings = await ops.getAll<{ key: string }>('settingsKV')
  for (const r of settings) {
    if (r.key.startsWith(prefix)) setKeys.push(r.key)
    // 自定义下拉选项 key 形如 customOption::<pid>::…，需用专属前缀清理，否则恢复会残留旧项目选项
    else if (r.key.startsWith(`customOption::${targetPid}::`)) setKeys.push(r.key)
  }
  // 2. 写入备份包数据（内部 id 全部重生成，避免与残留/冲突）
  const volMap = new Map<string, string>()
  for (const v of bundle.volumes) {
    const nid = uid()
    volMap.set(v.id, nid)
    await ops.put('volumes', { ...v, id: nid, projectId: targetPid })
  }
  const chMap = new Map<string, string>()
  for (const c of bundle.chapters) {
    const nid = uid()
    chMap.set(c.id, nid)
    await ops.put('chapters', { ...c, id: nid, projectId: targetPid, volumeId: volMap.get(c.volumeId) ?? c.volumeId })
  }
  for (const f of bundle.formData) {
    await ops.put('formData', { tabId: `${targetPid}::${f.tabId}`, data: f.data })
  }
  for (const r of bundle.tableRows) {
    const m = r.id.match(/^ch-(.+)$/)
    const nid = m && chMap.has(m[1]) ? `ch-${chMap.get(m[1])}` : uid()
    // 卷台账行的 tabId 内嵌卷 id（chapter-vol-<volumeId>），须随新卷 id 重映射，
    // 否则恢复后台账行指向不存在的卷，卷台账数据全部丢失（与 importProject 的写法一致）
    const rawTab = String(r.tabId)
    const tabId = rawTab.startsWith(VOL_LEDGER_PREFIX)
      ? `${VOL_LEDGER_PREFIX}${volMap.get(rawTab.slice(VOL_LEDGER_PREFIX.length)) ?? rawTab.slice(VOL_LEDGER_PREFIX.length)}`
      : r.tabId
    await ops.put('tableRows', { ...r, id: nid, tabId, projectId: targetPid })
  }
  for (const r of bundle.cardRecords) {
    await ops.put('cardRecords', { ...r, id: uid(), projectId: targetPid })
  }
  if (bundle.dailyStats) {
    for (const s of bundle.dailyStats) {
      await ops.put('dailyStats', { ...s, key: `${targetPid}::${s.date}`, projectId: targetPid })
    }
  }
  if (bundle.settings) {
    for (const s of bundle.settings) {
      await ops.put('settingsKV', { key: `${targetPid}::${s.key}`, value: s.value })
    }
  }
  if (bundle.customOptions) {
    for (const s of bundle.customOptions) {
      await ops.put('settingsKV', { key: `customOption::${targetPid}::${s.key}`, value: s.value })
    }
  }
  // 酒馆模式报告：随备份一并恢复（换新 id；sessionId 不需重映射，理由同 importProject）
  if (bundle.tavernReports) {
    for (const r of bundle.tavernReports) {
      await ops.put('tavernReports', { ...r, id: uid(), projectId: targetPid })
    }
  }

  // 3. 写入已全部成功 —— 这才删除旧记录。
  //    ⚠️ 以 key 为标识的存储（formData / settingsKV / dailyStats）新旧键**可能同名**：
  //       同名时上面的 put 已就地覆盖，无需再删；若不过滤掉它们，会把刚写好的新数据一起删掉。
  const newFormKeys = new Set(bundle.formData.map(f => `${targetPid}::${f.tabId}`))
  const newStatKeys = new Set((bundle.dailyStats ?? []).map(s => `${targetPid}::${s.date}`))
  const newSetKeys = new Set<string>([
    ...(bundle.settings ?? []).map(s => `${targetPid}::${s.key}`),
    ...(bundle.customOptions ?? []).map(s => `customOption::${targetPid}::${s.key}`),
  ])
  for (const [name, keys] of Object.entries(delKeys)) await ops.bulkDel(name, keys)
  const staleForms = formKeys.filter(k => !newFormKeys.has(k))
  if (staleForms.length) await ops.bulkDel('formData', staleForms)
  if (snapKeys.length) await ops.bulkDel('snapshots', snapKeys)
  const staleStats = statKeys.filter(k => !newStatKeys.has(k))
  if (staleStats.length) await ops.bulkDel('dailyStats', staleStats)
  const staleSets = setKeys.filter(k => !newSetKeys.has(k))
  if (staleSets.length) await ops.bulkDel('settingsKV', staleSets)

  // 4. 同步项目元数据（成为该历史版本）
  const old = await ops.get<Project>('projects', targetPid)
  if (old) {
    await ops.put('projects', {
      ...old,
      name: bundle.project.name,
      genre: bundle.project.genre ?? '',
      intro: bundle.project.intro ?? '',
      ...(bundle.project.cover !== undefined ? { cover: bundle.project.cover } : {}),
      updatedAt: Date.now(),
    })
  }
  await touchProject(targetPid)
}
