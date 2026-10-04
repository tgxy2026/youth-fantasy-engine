// ============ 存储层 · 项目（CRUD / 统计 / 导出导入 / 全量装载）============
// 2026-09-19 结构优化 D2：自 db.ts 拆出。
import type { Project, Volume, Chapter, FormData, TableRow, CardRecord } from '../types'
import { uid } from '../id'
import type { TavernReport } from '../tavern/types'
import { ops, currentProjectId } from './core'
import { VOL_LEDGER_PREFIX } from './volumes'
import { type Snapshot, isAISnapshot } from './chapters'
import type { DailyStat } from './meta'
// 🔴 语义向量索引（#013）与知识库资料（#017）住在**独立 IDB 库**里，上面这批 store 管不到 ——
//    删项目时必须各自显式清理，否则会留下「界面上看不到、却一直占空间」的孤儿
//    （#013 当初就漏了这一步，2026-10-04 随 #017 一并补上）。
//    ⚠️ 依赖方向已核对：这两个模块都**不 import db**（`knowledgeBase` 的 projectId 由调用方传，
//       `semantic/store` 是纯存储层），故不会形成 `deleteProject → kb → db` 的环。
import { clearProjectVectors } from '../semantic/store'
import {
  clearProjectDocs, collectDocsForBundle, restoreDocsFromBundle, type KbBundleDoc,
} from '../knowledgeBase'

// ============ 项目 ============
// 旧版项目形态 'lite'(精简) / 'minimal'(极简) 已移除；把存储中残留的旧值归一化为 'full'
// （等同旧版"全功能可见"回退行为，避免神秘降级）。读取即归一化，写回迁移见 migrateProjectTypes。
function isLegacyProjectType(t: unknown): t is 'lite' | 'minimal' {
  return t === 'lite' || t === 'minimal'
}

/**
 * 导入 / 恢复备份时，重映射 `settingsKV` 里存的 **cardRecords id 数组**。
 *
 * 🔴 2026-10-02 六维审计 P0：备份里的 `settings` 含「子项活跃态」（键 `worldSubActive::<tabId>`，
 *    值是 cardRecords 的 id 数组）。而 cardRecords 落到新项目时**全部换新 id**（`uid()`）——
 *    若原样搬 value，数组里 100% 是悬空 id ⇒ `splitActive` 全部丢弃 ⇒
 *    所有多套条目（世界总览的子世界、力量体系的子体系、制度四页签的条目）
 *    **集体退化为「已完结」**，AI 上下文只剩一行「当前没有活跃的…」，且无任何报错。
 *
 * 只重映射**已知的活跃态键**；其余 settings 值原样搬（别去猜别的键里有没有 id）。
 * 映射表里没有的旧 id 一律丢弃（对应记录没进这次导入，留着也只是悬空）。
 */
export function remapSettingValue(
  key: string,
  value: unknown,
  cardIdMap: ReadonlyMap<string, string>,
): unknown {
  if (!key.startsWith('worldSubActive::')) return value
  if (!Array.isArray(value)) return value
  return value.map(id => (typeof id === 'string' ? cardIdMap.get(id) : undefined)).filter((v): v is string => !!v)
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
/**
 * 锁定项同步（2.8.0 · 2026-10-04）：把新增 / 升档的**必选模块**补进已有项目的 features。
 *
 * 【为什么需要】「关于打赏」由 default 升为 locked（必选、不可取消）。已经建好的项目 ——
 *   尤其是当初在「自定义项目」里**取消勾选**过它的 —— features 数组里没有 `about`。
 *   覆盖安装（保留旧数据、只换程序）之后，那个页签就永远不会出现，作者也无处可开。
 *
 * 口径：
 *  · **只补不改**：仅把 `lockedIds` 里尚未出现的 id 合进去，**不动**其余任何 feature
 *    （作者自己关掉的可选模块不会被强行打开）；
 *  · 只处理 `projectType === 'custom'` 的项目 —— 完整项目的 `tabVisible` 恒为 true，补了没意义；
 *  · **幂等**：已含全部锁定项的项目直接跳过（不写库、不计入返回值），可反复跑。
 *
 * ⚠️ `lockedIds` 由调用方（`App` 启动期）从 `schema.LOCKED_IDS` 传入，**本文件不 import schema** ——
 *    `schemaShared` 会 import `./db`，db 层反向引用 schema 会直接成环（`tests/importCycles` 会红）。
 */
export async function migrateLockedFeatures(lockedIds: string[]): Promise<number> {
  if (!lockedIds.length) return 0
  const all = await ops.getAll<Project>('projects')
  let changed = 0
  for (const p of all) {
    if (p.projectType !== 'custom') continue
    const cur = p.features ?? []
    const missing = lockedIds.filter(id => !cur.includes(id))
    if (!missing.length) continue
    // 锁定项前置，与 `resolveFeatures()` 产出的形态一致（`[...LOCKED_IDS, ...selected]`）
    await ops.put('projects', { ...p, features: [...missing, ...cur] })
    changed++
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

  // 独立库里的项目级数据：语义向量块（#013）+ 挂载的参考资料（#017）。
  // 上面那批走 `ops.bulkDel` 的 store 在同一个库里，这两个不是 —— 必须各自显式调。
  // 一律不抛：独立库暂时不可用不该让「删项目」失败（projects 记录已经删了，重删一遍也无害）。
  await clearProjectVectors(id).catch(() => { /* 忽略：删不掉也只是占空间，不影响已删除的事实 */ })
  await clearProjectDocs(id).catch(() => { /* 忽略 */ })
}

// ============ 项目统计（项目列表页用，不依赖 currentProjectId） ============
export type ProjectStats = { chapters: number; words: number; volumes: number }

export async function getProjectStats(id: string): Promise<ProjectStats> {
  return (await getProjectsStats([id]))[id] ?? { chapters: 0, words: 0, volumes: 0 }
}

/**
 * 批量统计（一次读全表 + 内存分组）。
 *
 * 🔴 2026-09-22 六维审计 P2：项目管理页原先是 `list.map(p => getProjectStats(p.id))` ——
 *    而单项目版**每次都要读全表 chapters + volumes**，N 个项目就是 **2N 次全表读**。
 *    项目一多（或库进了云盘目录）打开首页就会明显卡；改成一次全表读、内存里按 projectId 归组。
 */
export async function getProjectsStats(ids: string[]): Promise<Record<string, ProjectStats>> {
  const out: Record<string, ProjectStats> = {}
  for (const id of ids) out[id] = { chapters: 0, words: 0, volumes: 0 }
  if (!ids.length) return out

  const [chs, vols] = await Promise.all([ops.getAll<Chapter>('chapters'), ops.getAll<Volume>('volumes')])
  for (const c of chs) {
    const s = out[c.projectId]
    if (!s) continue
    s.chapters++
    s.words += c.wordCount || 0
  }
  for (const v of vols) {
    const s = out[v.projectId]
    if (s) s.volumes++
  }
  return out
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
  /**
   * 章节快照（2.4.0 · A3，可选字段：旧备份没有）。
   *
   * 🔴 **只带 AI 来源的快照**（改写 / 续写 / 生成前留的旧稿）。定时快照的价值主要在
   *    "本机写坏了能回退"，跨设备意义小；全带会让 300 章的书备份 JSON 胀到 20MB+、导入导出都变慢。
   */
  snapshots?: Snapshot[]
  /**
   * 挂载的参考资料（2.8.0 · #017，**可选字段**）。
   *
   * 🔴 默认**不带**（2026-10-04 主人拍板「加可选项」）：长文档单篇可到 40 万字，
   *    塞进迁移包 / 备份会迅速膨胀。作者在「素材资料 → 我的参考资料」里勾选后才随包走，
   *    该选择存**按项目**的设置键 `kbInBackup`（见 `kbInBackupOf`）。
   * 🔴 **自动备份恒定不带** —— 它是每 5 分钟一次的全量，带上长文档等于反复重写几 MB
   *    （与上面 `snapshots` 同一条理由，`createAutoBackup` 里显式传 false）。
   */
  knowledgeBase?: KbBundleDoc[]
}

/** 项目设置键：参考资料是否随导出 / 导出备份文件一起走（默认 false = 不带） */
export const KB_IN_BACKUP_KEY = 'kbInBackup'

/**
 * 读「参考资料随包走」开关。
 *
 * 🔴 这里用 `ops.get('settingsKV', …)` 而**不是** `db.getSetting` —— 后者读的是
 *    `currentProjectId`，而 `exportProject(id)` 的 id 是**任意**项目
 *    （项目管理页导出别的项目时，currentProjectId 根本不是它，开关会读错）。
 */
async function kbInBackupOf(projectId: string): Promise<boolean> {
  try {
    const rec = await ops.get<{ key: string; value: unknown }>('settingsKV', `${projectId}::${KB_IN_BACKUP_KEY}`)
    return rec?.value === true
  } catch {
    return false
  }
}

/**
 * 导出项目为备份包。
 *
 * ⚠️ `includeSnapshots`（2.4.0 · A3）：**自动备份必须传 false**。
 *    快照在 `backups.ts` 里会随全量备份每 5 分钟写一次，若带上 AI 快照（长篇可达几十 MB），
 *    高频备份会迅速把本地存储撑大。手动「导出备份」保持默认 true —— 那是给用户带走、换设备用的。
 * ⚠️ `includeKnowledgeBase`（2.8.0 · #017）：不传 ⇒ 读作者在该项目里勾的开关（`kbInBackup`）；
 *    自动备份**显式传 false**（同 `includeSnapshots` 的理由）。
 */
export async function exportProject(
  id: string,
  opts: { includeSnapshots?: boolean; includeKnowledgeBase?: boolean } = {},
): Promise<ProjectBundle> {
  const includeSnapshots = opts.includeSnapshots !== false
  const includeKb = opts.includeKnowledgeBase ?? await kbInBackupOf(id)
  const project = await ops.get<Project>('projects', id)
  if (!project) throw new Error('项目不存在')
  const [volumes, chapters, formData, tableRows, cardRecords, dailyStats, settingsKV, tavernReports] = await Promise.all([
    ops.getAll<Volume>('volumes'), ops.getAll<Chapter>('chapters'), ops.getAll<FormData>('formData'),
    ops.getAll<TableRow>('tableRows'), ops.getAll<CardRecord>('cardRecords'),
    ops.getAll<DailyStat>('dailyStats'), ops.getAll<{ key: string; value: unknown }>('settingsKV'),
    ops.getAll<TavernReport>('tavernReports'),
  ])
  // 快照按 projectId 索引取（不扫全表）
  const snapshots = includeSnapshots ? await ops.getAllByIndex<Snapshot>('snapshots', 'projectId', id) : []
  // 参考资料（#017）：勾了开关才收集正文（`collectDocsForBundle` 会逐篇读正文，不勾就别读）
  const kb = includeKb ? await collectDocsForBundle(id) : []
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
    // 只带 AI 快照（理由见 ProjectBundle.snapshots 的注释）
    snapshots: snapshots.filter(s => isAISnapshot(s)),
    // 参考资料（#017）：没勾开关 / 一篇都没有 ⇒ **整个字段不出现**（与 snapshots 同为可选字段，
    // 旧格式 / 老客户端读到的是"没有这个字段"，向后兼容零成本）
    ...(kb.length ? { knowledgeBase: kb } : {}),
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
  // 章节快照（2.4.0 · A3，可选字段）：chapterId **必须跟着换成新 id** ——
  // 否则导入后的快照指向已不存在的章节，表现为「时光机里一片空白」且从界面上查不出原因。
  if (bundle.snapshots) {
    for (const s of bundle.snapshots) {
      const ncid = map.get(s.chapterId)
      if (!ncid) continue // 该章没在这次导入里 → 跳过，别留孤儿快照
      await ops.put('snapshots', { ...s, id: uid(), projectId: newPid, chapterId: ncid })
    }
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
  // 🔴 cardRecords 换新 id 时**必须记下旧→新映射**：settingsKV 里的「子项活跃态」
  //    （`worldSubActive::<tabId>`，值是 cardRecords 的 id 数组）要跟着一起搬。
  //    否则导入后数组里全是悬空 id ⇒ splitActive 全部丢弃 ⇒ 所有条目退化为「已完结」，
  //    AI 上下文只剩一行「当前没有活跃的…」，且**无任何报错**（2026-10-02 六维审计 P0）。
  const cardIdMap = new Map<string, string>()
  for (const r of bundle.cardRecords) {
    const nid = uid()
    cardIdMap.set(r.id, nid)
    await ops.put('cardRecords', { ...r, id: nid, projectId: newPid })
  }
  // 每日统计与设置（可选字段，向后兼容旧备份）
  if (bundle.dailyStats) {
    for (const s of bundle.dailyStats) {
      await ops.put('dailyStats', { ...s, key: `${newPid}::${s.date}`, projectId: newPid })
    }
  }
  if (bundle.settings) {
    for (const s of bundle.settings) {
      await ops.put('settingsKV', { key: `${newPid}::${s.key}`, value: remapSettingValue(s.key, s.value, cardIdMap) })
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
  // 参考资料（2.8.0 · #017，可选字段）：随包带来的资料写进**独立知识库**。
  // ⚠️ 放在**最后**、且失败不阻断：它是另一个库，写不进去不该推翻"项目已经导进来了"。
  //    新项目本来没有资料，`restoreDocsFromBundle` 的"先清空"是空操作，直接写即可。
  if (bundle.knowledgeBase?.length) {
    await restoreDocsFromBundle(newPid, bundle.knowledgeBase).catch(() => 0)
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
