// ============ 存储层 · 数据迁移（台账 / 章节号 / 地图）与统一入口 ============
// 2026-09-19 结构优化 D2：自 db.ts 拆出。
// ⚠️ 这里跑的是**运行时数据迁移**（打开项目后执行），与 ./idbMigrations 的 IndexedDB schema 迁移是两件事。
// 🔴 runMigrations 里的调用次序＝依赖次序（types → ledger → numbering → geomaps），不可调换。
import type { TableRow } from '../types'
import { uid } from '../id'
import { chapterSeqMap, flattenChapters } from '../chapterSeq'
import { ops, currentProjectId } from './core'
import { migrateProjectTypes } from './projects'
import { getAllVolumes, VOL_LEDGER_PREFIX } from './volumes'
import { getAllChapters } from './chapters'
import { getTableRows, saveTableRow } from './tabs'
import { getSetting } from './meta'

/**
 * 旧版「单张章节总表 + 所属卷自引用」迁移到「按卷建表」。
 * 幂等：若 chapter-master 已无行则直接返回。迁移前不删原数据，成功后再清空旧表。
 * 卷定义行（所属卷为空）转为 volumes 库记录；章行按所属卷归入对应卷台账表，并剥离「所属卷」列。
 */
export async function migrateChapterLedger() {
  const pid = currentProjectId
  if (!pid) return
  const old = (await ops.getAll<TableRow>('tableRows'))
    .filter(r => r.projectId === pid && r.tabId === 'chapter-master')
  if (old.length === 0) return
  const vols = await getAllVolumes()
  const titleToVolId = new Map<string, string>()
  const ensureVolume = async (title: string): Promise<string | null> => {
    const t = title.trim()
    if (!t) return null
    const hit = vols.find(v => v.title === t)
    if (hit) return hit.id
    const vol = { id: uid(), projectId: pid, order: vols.length, title: t, description: '', createdAt: Date.now() }
    await ops.put('volumes', vol)
    vols.push(vol)
    return vol.id
  }
  // 1) 先处理卷定义行，建立 卷名→卷id 映射
  for (const r of old) {
    if ((r.data['所属卷'] ?? '').trim() === '') {
      const vid = await ensureVolume(r.data['章节标题'] ?? '')
      if (vid) titleToVolId.set(r.data['章节标题'] ?? '', vid)
    }
  }
  // 2) 章行按所属卷归入对应卷台账表
  const movedIds = new Set<string>()
  for (const r of old) {
    const volTitle = (r.data['所属卷'] ?? '').trim()
    if (volTitle === '') continue
    let vid: string | null = titleToVolId.get(volTitle) ?? null
    if (!vid) {
      vid = await ensureVolume(volTitle)
      if (vid) titleToVolId.set(volTitle, vid)
    }
    if (!vid) continue
    const { '所属卷': _drop, ...data } = r.data
    // 行 id 保持不变（编辑器用 ch-<chapterId> 定位台账行），原地改 tabId 覆盖写
    await ops.put('tableRows', { ...r, tabId: `${VOL_LEDGER_PREFIX}${vid}`, data })
    movedIds.add(r.id)
  }
  // 3) 清空旧表：只删「未被迁移覆盖写」的行（卷定义行等）。
  //    ⚠️ 迁移走的行 id 未变，若按旧 id 全删会把刚写入新表的行一起删掉（数据丢失，1.9.2 审计修复）
  const stale = old.filter(r => !movedIds.has(r.id)).map(r => r.id)
  if (stale.length) await ops.bulkDel('tableRows', stale)
}

/**
 * 1.9.2：把各卷台账的「章节号」重算为**全局连续**号（此前是卷内独立编号）。
 * 序号本身是派生的，这里只是把显示用的字符串刷成最新值；
 * 幂等——跑第二次时每行都已是目标值，不会重复写库。
 * 「不计入序号」的章保持作者手填的原值（如「番外」），不被清空。
 */
export async function migrateChapterNumbering(): Promise<void> {
  const pid = currentProjectId
  if (!pid) return
  const [vols, chs] = await Promise.all([getAllVolumes(), getAllChapters()])
  if (chs.length === 0) return
  const seqs = chapterSeqMap(vols, chs)
  // 按卷预取台账行，避免逐章重复读库
  const byTab = new Map<string, TableRow[]>()
  for (const v of vols) {
    const tabId = `${VOL_LEDGER_PREFIX}${v.id}`
    byTab.set(tabId, await getTableRows(tabId))
  }
  const writes: Promise<void>[] = []
  flattenChapters(vols, chs).forEach((c, i) => {
    const no = seqs.get(c.id) ?? 0
    const row = byTab.get(`${VOL_LEDGER_PREFIX}${c.volumeId}`)?.find(r => r.id === `ch-${c.id}`)
    if (!row) return
    const want = no > 0 ? `第${no}章` : (row.data['章节号'] ?? '')
    if (row.data['章节号'] === want && row.order === i) return
    writes.push(saveTableRow({ ...row, data: { ...row.data, '章节号': want }, order: i }))
  })
  await Promise.all(writes)
}

/**
 * 多地图迁移（2.1.0 · 地图列表方案 B）：
 * 把「升级前唯一的那块画布」登记为一张「默认地图」，并把现有《地理风物》行全部归入它 ——
 * 升级后打开与升级前**完全一致**（零感知）。
 *
 * 幂等：已有地图行时不再新建，只回填「所属地图」为空的地理行。
 * 格档沿用旧的全局设置 `geoMapCellKm`（原实现把每格公里存在 setting 里）。
 */
export async function migrateGeoMaps(): Promise<number> {
  const pid = currentProjectId
  if (!pid) return 0
  const rows = await ops.getAll<TableRow>('tableRows')
  const maps = rows.filter(r => r.projectId === pid && r.tabId === 'geomaps')
  let changed = 0

  let defaultName = maps[0]?.data?.['名称']
  if (!maps.length) {
    const legacyKm = await getSetting<number>('geoMapCellKm', 1)
    defaultName = '默认地图'
    await ops.put('tableRows', {
      id: uid(),
      projectId: pid,
      tabId: 'geomaps',
      data: {
        '编号': 'MAP0001',
        '名称': defaultName,
        '每格公里': legacyKm === 10 ? '10' : '1',
        '说明': '升级时自动创建：承接升级前的全部地图内容。',
      },
      order: 0,
      createdAt: Date.now(),
    })
    changed++
  }
  if (!defaultName) return changed

  for (const r of rows) {
    if (r.projectId !== pid || r.tabId !== 'geography') continue
    if (r.data?.['所属地图']) continue
    await saveTableRow({ ...r, data: { ...r.data, '所属地图': defaultName } })
    changed++
  }
  return changed
}

// ============ 迁移统一入口 ============

/**
 * 按序跑完「当前项目」所需的全部结构迁移，幂等。
 *
 * 🔴 调用纪律：**凡把项目置为当前项目（setCurrentProject）后，都必须紧接着调它**——
 *    包括「启动时自动恢复上次项目」和「用户手动打开项目」两条路径。
 *
 * 为什么要有这个统一入口（2026-09-14 审计 P1-7）：
 *   此前迁移入口散落在 App.tsx 的两处调用点，且**两处跑的集合不一样**——
 *   手动 openProject 跑了 ledger + numbering + types 三件，
 *   而启动恢复上次项目那条路径**只跑了 migrateProjectTypes**。
 *   于是「关掉再开 → 自动回到上次项目」这条最常用路径上，旧的单表台账与卷内编号
 *   不会被纠正；期间台账展示、全文检索、AI 上下文都会继续读到旧结构，
 *   直到用户手动重新打开一次项目才自愈——属于「不报错但数据视图不对」的隐性偏差。
 *
 * 顺序要求（不可调换）：
 *   types（归一化项目形态，只碰 projects 库，与另两个独立）
 *   → ledger（把旧单表章节总表拆成按卷台账）
 *   → numbering（重算全局连续章节号）
 *   ⚠️ numbering **必须**排在 ledger 之后：它读写的正是 ledger 拆分后才存在的
 *      `chapter-vol-<卷id>` 台账行；顺序颠倒会对着空表白跑一遍、编号不生效。
 *
 * 注意：这里只做「数据」迁移，不含 UI 侧缓存刷新。调用方若需要刷新侧栏卷页签，
 *       请自行再调 schema.refreshVolumeTabs()——db 层不引用 schema，以免形成循环依赖。
 */
export async function runMigrations(): Promise<void> {
  if (!currentProjectId) return
  await migrateProjectTypes()
  await migrateChapterLedger()
  await migrateChapterNumbering()
  await migrateGeoMaps()
}
