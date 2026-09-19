// ============ 存储层 · 项目（CRUD / 统计 / 导出导入 / 全量装载）============
// 2026-09-19 结构优化 D2：自 db.ts 拆出。
import type { Project, Volume, Chapter, FormData, TableRow, CardRecord } from '../types'
import { uid } from '../id'
import type { TavernReport } from '../tavern/types'
import { ops, currentProjectId } from './core'
import { VOL_LEDGER_PREFIX } from './volumes'
import type { Snapshot } from './chapters'
import type { DailyStat } from './meta'

// ============ 项目 ============
// 旧版项目形态 'lite'(精简) / 'minimal'(极简) 已移除；把存储中残留的旧值归一化为 'full'
// （等同旧版"全功能可见"回退行为，避免神秘降级）。读取即归一化，写回迁移见 migrateProjectTypes。
function isLegacyProjectType(t: unknown): t is 'lite' | 'minimal' {
  return t === 'lite' || t === 'minimal'
}
function normalizeProject(p: Project): Project {
  if (isLegacyProjectType(p.projectType)) return { ...p, projectType: 'full' }
  return p
}
export async function getAllProjects(): Promise<Project[]> {
  const all = (await ops.getAll<Project>('projects')).map(normalizeProject)
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}
export async function getProject(id: string): Promise<Project | undefined> {
  const p = await ops.get<Project>('projects', id)
  return p ? normalizeProject(p) : undefined
}
/** 一次性迁移：把存储中所有残留的 lite/minimal 项目形态写回为 'full'，真正清理历史数据（幂等，无旧值则不写库） */
export async function migrateProjectTypes(): Promise<number> {
  const all = await ops.getAll<Project>('projects')
  let changed = 0
  for (const p of all) {
    if (isLegacyProjectType(p.projectType)) {
      await ops.put('projects', { ...p, projectType: 'full' })
      changed++
    }
  }
  return changed
}
export async function createProject(name: string, genre = '', intro = '', cover = '', projectType: 'full' | 'custom' = 'full', features?: string[]): Promise<Project> {
  const now = Date.now()
  const p: Project = { id: uid(), name, genre, intro, ...(cover ? { cover } : {}), projectType, ...(features ? { features } : {}), createdAt: now, updatedAt: now }
  await ops.put('projects', p)
  return p
}
export async function updateProject(patch: Partial<Project> & { id: string }) {
  const old = await ops.get<Project>('projects', patch.id)
  if (!old) return
  await ops.put('projects', { ...old, ...patch, updatedAt: Date.now() })
}

/** 删除项目及其全部数据 */
export async function deleteProject(id: string) {
  // 章节行在下面那轮按 projectId 批量删，这里不必先全表读一遍 chapters（曾只为快照守卫而读）
  await ops.del('projects', id)
  /**
   * 🔴 删项目后要把「上次打开的项目」指针一并清掉（老大 2026-09-19 遇到的怪事：
   *    删掉的项目，下次启动又被自动打开）。
   *
   * 为什么光删 projects 记录不够：`lastProject` 是**随云盘同步的 meta**
   * （不在 EXCLUDED_META_KEYS 里），而启动时那条读有可能落在「本地镜像」一侧 ——
   * 镜像里还留着删除前的旧状态（甚至 projects 记录也还在），于是指针 + 陈旧记录
   * 一起把「已删除的项目」重新拼了出来。指针不清，就等于给陈旧数据留着一扇门。
   *
   * ⚠️ 2026-09-19 起启动**不再自动打开上次项目**（默认停项目管理首页），这条是第二道闸：
   *    即便将来又有人加回"自动打开"的逻辑，也不会再打开一个被删掉的项目。
   */
  const last = await ops.get<{ key: string; value: unknown }>('meta', 'lastProject')
  if (last?.value === id) await ops.del('meta', 'lastProject')
  // 收集各 store 待删主键，统一批量删除
  const delKeys: Record<string, string[]> = {}
  // tavernReports 也是项目级数据（报告随项目走），务必一并清理，否则项目删了报告还在
  for (const name of ['volumes', 'chapters', 'tableRows', 'cardRecords', 'trash', 'tavernReports'] as const) {
    const all = await ops.getAll<{ id: string; projectId?: string }>(name)
    const keys = all.filter(r => r.projectId === id).map(r => r.id)
    if (keys.length) delKeys[name] = keys
  }
  const forms = await ops.getAll<FormData>('formData')
  const formKeys = forms.filter(f => f.tabId.startsWith(`${id}::`)).map(f => f.tabId)
  // 快照按 projectId 索引批量取。
  // 🔴 不能挂 `chapterIds.size` 这个前提：章节全在回收站时 chapters 为空 → 该项目的快照
  //    一份都不删，成了界面上永远看不到、却持续进云载荷的孤儿。
  const snapKeys = (await ops.getAllByIndex<Snapshot>('snapshots', 'projectId', id)).map(s => s.id)
  // 每日统计与设置按 projectId 前缀（含项目独立自定义下拉选项 customOption::<projectId>::...）
  const statKeys: string[] = []
  const setKeys: string[] = []
  const daily = await ops.getAll<{ key: string }>('dailyStats')
  for (const r of daily) if (r.key.startsWith(`${id}::`)) statKeys.push(r.key)
  const settings = await ops.getAll<{ key: string }>('settingsKV')
  for (const r of settings) if (r.key.startsWith(`${id}::`) || r.key.startsWith(`customOption::${id}::`)) setKeys.push(r.key)

  for (const [name, keys] of Object.entries(delKeys)) await ops.bulkDel(name, keys)
  if (formKeys.length) await ops.bulkDel('formData', formKeys)
  if (snapKeys.length) await ops.bulkDel('snapshots', snapKeys)
  if (statKeys.length) await ops.bulkDel('dailyStats', statKeys)
  if (setKeys.length) await ops.bulkDel('settingsKV', setKeys)
}

// ============ 项目统计（项目列表页用，不依赖 currentProjectId） ============
export async function getProjectStats(id: string): Promise<{ chapters: number; words: number; volumes: number }> {
  const [chs, vols] = await Promise.all([ops.getAll<Chapter>('chapters'), ops.getAll<Volume>('volumes')])
  const mine = chs.filter(c => c.projectId === id)
  return {
    chapters: mine.length,
    words: mine.reduce((s, c) => s + (c.wordCount || 0), 0),
    volumes: vols.filter(v => v.projectId === id).length,
  }
}

// ============ 导出 / 导入（JSON 备份） ============
export interface ProjectBundle {
  app: 'youth-fantasy-engine'
  version: number
  exportedAt: number
  project: Project
  volumes: Volume[]
  chapters: Chapter[]
  formData: { tabId: string; data: Record<string, string> }[]
  tableRows: TableRow[]
  cardRecords: CardRecord[]
  dailyStats?: DailyStat[]
  settings?: { key: string; value: unknown }[]
  /** 自定义下拉选项（人物状态等）：key 为 `<tabId>::<colName>`，不含项目前缀 */
  customOptions?: { key: string; value: unknown }[]
  /** 酒馆模式 · 推演报告（可选字段：旧备份没有，导入时按向后兼容处理） */
  tavernReports?: TavernReport[]
}

export async function exportProject(id: string): Promise<ProjectBundle> {
  const project = await ops.get<Project>('projects', id)
  if (!project) throw new Error('项目不存在')
  const [volumes, chapters, formData, tableRows, cardRecords, dailyStats, settingsKV, tavernReports] = await Promise.all([
    ops.getAll<Volume>('volumes'), ops.getAll<Chapter>('chapters'), ops.getAll<FormData>('formData'),
    ops.getAll<TableRow>('tableRows'), ops.getAll<CardRecord>('cardRecords'),
    ops.getAll<DailyStat>('dailyStats'), ops.getAll<{ key: string; value: unknown }>('settingsKV'),
    ops.getAll<TavernReport>('tavernReports'),
  ])
  const prefix = `${id}::`
  const customOptPrefix = `customOption::${id}::`
  return {
    app: 'youth-fantasy-engine',
    version: 3,
    exportedAt: Date.now(),
    project,
    volumes: volumes.filter(v => v.projectId === id),
    chapters: chapters.filter(c => c.projectId === id),
    formData: formData
      .filter(f => f.tabId.startsWith(prefix))
      .map(f => ({ tabId: f.tabId.slice(prefix.length), data: f.data })),
    tableRows: tableRows.filter(r => r.projectId === id),
    cardRecords: cardRecords.filter(r => r.projectId === id),
    dailyStats: dailyStats.filter(s => s.projectId === id),
    settings: settingsKV
      .filter(s => s.key.startsWith(prefix))
      .map(s => ({ key: s.key.slice(prefix.length), value: s.value })),
    customOptions: settingsKV
      .filter(s => s.key.startsWith(customOptPrefix))
      .map(s => ({ key: s.key.slice(customOptPrefix.length), value: s.value })),
    tavernReports: tavernReports.filter(r => r.projectId === id),
  }
}

/** 导入项目：生成全新 projectId / 内部 id，避免与现有数据冲突；返回新项目 id */
export async function importProject(bundle: ProjectBundle): Promise<string> {
  if (!bundle || bundle.app !== 'youth-fantasy-engine' || !bundle.project) {
    throw new Error('不是有效的项目备份文件')
  }
  const newPid = uid()
  const now = Date.now()
  const map = new Map<string, string>() // 旧 chapterId -> 新 id（章节总表联动行名需要同步换）

  await ops.put('projects', {
    ...bundle.project, id: newPid,
    name: bundle.project.name,
    createdAt: now, updatedAt: now,
  } as Project)

  const volMap = new Map<string, string>()
  for (const v of bundle.volumes) {
    const nid = uid()
    volMap.set(v.id, nid)
    await ops.put('volumes', { ...v, id: nid, projectId: newPid })
  }
  for (const c of bundle.chapters) {
    const nid = uid()
    map.set(c.id, nid)
    await ops.put('chapters', { ...c, id: nid, projectId: newPid, volumeId: volMap.get(c.volumeId) ?? c.volumeId })
  }
  for (const f of bundle.formData) {
    await ops.put('formData', { tabId: `${newPid}::${f.tabId}`, data: f.data })
  }
  for (const r of bundle.tableRows) {
    // 联动行（id 形如 ch-xxx）重定向到新章节 id；普通行换新 id
    const m = r.id.match(/^ch-(.+)$/)
    const nid = m && map.has(m[1]) ? `ch-${map.get(m[1])}` : uid()
    // ⚠️ 卷台账行的 tabId 内嵌卷 id（chapter-vol-<volumeId>），必须重映射到新卷 id——
    // 否则导入后台账行指向不存在的卷，章节总表/连续性检查/搜索/AI 上下文的台账数据全部丢失
    const rawTab = String(r.tabId)
    const tabId = rawTab.startsWith(VOL_LEDGER_PREFIX)
      ? `${VOL_LEDGER_PREFIX}${volMap.get(rawTab.slice(VOL_LEDGER_PREFIX.length)) ?? rawTab.slice(VOL_LEDGER_PREFIX.length)}`
      : r.tabId
    await ops.put('tableRows', { ...r, id: nid, tabId, projectId: newPid })
  }
  for (const r of bundle.cardRecords) {
    await ops.put('cardRecords', { ...r, id: uid(), projectId: newPid })
  }
  // 每日统计与设置（可选字段，向后兼容旧备份）
  if (bundle.dailyStats) {
    for (const s of bundle.dailyStats) {
      await ops.put('dailyStats', { ...s, key: `${newPid}::${s.date}`, projectId: newPid })
    }
  }
  if (bundle.settings) {
    for (const s of bundle.settings) {
      await ops.put('settingsKV', { key: `${newPid}::${s.key}`, value: s.value })
    }
  }
  if (bundle.customOptions) {
    for (const s of bundle.customOptions) {
      await ops.put('settingsKV', { key: `customOption::${newPid}::${s.key}`, value: s.value })
    }
  }
  // 酒馆模式报告：换新 id 与新 projectId。
  // sessionId 无需重映射——会话本身存在 settingsKV 里（value 整体搬运、会话 id 不变），
  // 故报告仍能指回原会话。
  if (bundle.tavernReports) {
    for (const r of bundle.tavernReports) {
      await ops.put('tavernReports', { ...r, id: uid(), projectId: newPid })
    }
  }
  return newPid
}

/** 供 SettingSearch 使用：读取当前项目全部数据 */
export async function loadAllData() {
  const [formData, tableRows, cardRecords] = await Promise.all([
    ops.getAll<FormData>('formData'), ops.getAll<TableRow>('tableRows'), ops.getAll<CardRecord>('cardRecords'),
  ])
  const prefix = `${currentProjectId}::`
  return {
    formData: formData
      .filter(f => f.tabId.startsWith(prefix))
      .map(f => ({ tabId: f.tabId.slice(prefix.length), data: f.data as Record<string, string> })),
    tableRows: tableRows.filter(r => r.projectId === currentProjectId),
    cardRecords: cardRecords.filter(r => r.projectId === currentProjectId),
  }
}
