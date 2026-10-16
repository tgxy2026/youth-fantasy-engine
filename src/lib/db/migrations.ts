// ============ 存储层 · 数据迁移（台账 / 章节号 / 地图）与统一入口 ============
// 2026-09-19 结构优化 D2：自 db.ts 拆出。
// ⚠️ 这里跑的是**运行时数据迁移**（打开项目后执行），与 ./idbMigrations 的 IndexedDB schema 迁移是两件事。
// 🔴 runMigrations 里的调用次序＝依赖次序（types → ledger → numbering → geomaps），不可调换。
import type { CardRecord, TableRow } from '@/lib/types'
import { uid } from '@/lib/app/id'
import { chapterSeqMap, flattenChapters } from '@/lib/outline/chapterSeq'
import { ops, currentProjectId } from '@/lib/db/core'
import { migrateProjectTypes } from '@/lib/db/projects'
import { getAllVolumes, VOL_LEDGER_PREFIX } from '@/lib/db/volumes'
import { getAllChapters } from '@/lib/db/chapters'
import { getTableRows, saveTableRow } from '@/lib/db/tabs'
import { getSetting } from '@/lib/db/meta'
// 旧项目级 AI 配置键名（叶子模块，与云同步 / 导出路径共用同一份定义）
import { LEGACY_PROJECT_AI_KEYS } from '@/lib/storage/sensitiveMeta'

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
async function migrateGeoMaps(): Promise<number> {
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
 * 「其他设定」（misc-settings）**表格 → 卡片**（2026-09-20 晚间形态改定）。
 *
 * 为什么必须迁移：两种形态**存在不同的 store** —— 表格在 `tableRows`、卡片在 `cardRecords`。
 * 改 schema 类型不会自动搬家，不迁移的话作者先前填好的条目会在界面上「凭空消失」
 * （数据其实还躺在库里，只是新界面读的是另一个 store）。
 *
 * 映射：`card.name` ← 原「名称」列；`card.data` ← `{ '设定内容::内容': 原「内容」列 }`。
 * 🔴 `模块::字段` 这个键形态必须与 schema 一致（卡片表的存储键就是它，见 `resolveSlot`）——
 *    当前 = 模块「设定内容」+ 字段「内容」。schema 若改模块名，**这里要同步**；
 *    `tests/miscSettings.test.ts` 有一条断言钉住两者相等，改名会当场红。
 *    这里刻意不 import schema：db 层引用 schema 会形成循环依赖（见本文件 runMigrations 注释）。
 *
 * 幂等：该表已无表格行时直接返回；**先写卡、再删原行**，单条失败留给下次（id 复用 ⇒ 不会重复建卡）。
 */
export async function migrateMiscSettingsToCards(): Promise<number> {
  const pid = currentProjectId
  if (!pid) return 0
  const rows = (await ops.getAll<TableRow>('tableRows'))
    .filter(r => r.projectId === pid && r.tabId === 'misc-settings')
  if (rows.length === 0) return 0
  let moved = 0
  let failed = 0
  for (const r of rows) {
    const rec: CardRecord = {
      // 复用原行 id：即便这里跑第二遍，put 也是覆盖而不是新增（幂等的关键）
      id: r.id,
      projectId: pid,
      tabId: 'misc-settings',
      name: (r.data['名称'] ?? '').trim() || '未命名设定',
      data: { '设定内容::内容': r.data['内容'] ?? '' },
      order: r.order ?? moved,
    }
    try {
      await ops.put('cardRecords', rec)
      await ops.del('tableRows', r.id)
      moved++
    } catch (e) {
      // 单条失败：下次打开项目时会再来一遍（行还在，卡已写也不怕）。
      // 🔴 但必须留痕 —— 否则作者只看到「设定少了几条」，既无报错也无解释。
      failed++
      console.warn('[migrations] 其他设定 表→卡片：第' + (moved + failed) + '条迁移失败（该条目暂不显示，重开项目会自动重试）：', e)
    }
  }
  if (failed > 0) console.warn(`[migrations] 其他设定迁移未完成 ${failed} 条，重开项目会自动重试`)
  return moved
}

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
  // 🔴 备份载荷分离（C2 · 2.4.2）放在守卫**之前**：backups / backupPayloads 是**跨项目的本地专属**
  //    store，与「当前打开哪个项目」无关；放在守卫之后，只剩孤儿备份的库就永远迁移不到 ——
  //    而备份列表在项目管理页也会用到。
  //    〔2026-09-23 更正〕原文那句「从不打开项目的用户」在当前调用图上不成立（唯一调用点是
  //    openProject，届时 currentProjectId 已就位）。位置本身是对的 —— 它让迁移函数不依赖任何
  //    项目上下文，也为将来可能出现的启动期调用点留了余地。
  await migrateBackupPayloads()
  // 老库里的检索密钥残留：同样与「当前项目」无关，故也在守卫之前
  await migrateLegacySearchKey()
  // 旧项目级 AI 配置残留（含 apiKey 明文，会随备份文件出门）：同样是跨项目的全表清理
  await migrateLegacyProjectAiKeys()
  if (!currentProjectId) return
  await migrateProjectTypes()
  await migrateChapterLedger()
  await migrateChapterNumbering()
  await migrateGeoMaps()
  // 与上面几步互不相干（只碰 misc-settings 一张表），故放最后，不参与既有的顺序约束
  await migrateMiscSettingsToCards()
  // 故事内时间 → 发生时间（2.4.4）：同样只碰 history / timeline 两张表，与上面互不依赖
  await migrateStoryTimeColumns()
}

/**
 * 「故事内时间」→「发生时间」（2.4.4 · 社区反馈）：历史事件 / 时间脉络两张表把单个时间点
 * 拆成了「发生时间 / 结束时间」两端。
 *
 * 为什么必须迁移：schema 改列名**不会**自动搬数据 —— 表还是那张表、行还是那些行，
 * 只是渲染时按新列名去取值，于是老数据全部变成空白格（数据其实还在，界面上看不见了）。
 *
 * 口径（2.4.4 · 主人哥哥定版：**时间点事件也要发生=结束**）：
 *  · 老键「故事内时间」→ 复制到「发生时间」，**同时把「结束时间」补成同一天**（时间点事件）；
 *  · 只有发生时间、没有结束时间的行 → 同样补结束时间=发生时间；
 *  · 幂等判据用 `'结束时间' in data`（键存在即视为作者已表态 —— 他后来刻意清空的行不会被反复覆盖）；
 *  · **只补不删** —— 老键「故事内时间」原样保留（万一作者降级回旧版，数据还在）。
 */
async function migrateStoryTimeColumns(): Promise<number> {
  const pid = currentProjectId
  if (!pid) return 0
  const OLD = '故事内时间'
  const START = '发生时间'
  const END = '结束时间'
  let moved = 0
  for (const tabId of ['history', 'timeline']) {
    const rows = await getTableRows(tabId)
    for (const r of rows) {
      const data = { ...(r.data ?? {}) }
      const old = String(data[OLD] ?? '').trim()
      if (old && !(START in data)) data[START] = old
      // 🔴 `start` 必须在回填 START **之后**再读 —— 纯老行（只有 OLD 键）在回填前 start 是空串，
      //    拿它去判会当成「没有起点」而漏补「结束时间」（要等第二次打开才自愈）。
      const start = String(data[START] ?? '').trim()
      // 两端补齐：有起点、没结束（键不存在）⇒ 补成同一天（时间点事件口径）
      if (!(END in data) && start) data[END] = start
      if (data === r.data) continue
      await saveTableRow({ ...r, data })
      moved++
    }
  }
  return moved
}

/**
 * 清掉老库里 `tavern.settings` 下的 `search` 残留（2026-09-23 六维审计 P1）。
 *
 * 【为什么必须清】云盘同步是**整条 key-value** 写出，没法只排除某个字段；`EXCLUDED_META_KEYS`
 * 里已经有 `app.search`，但这个密钥在**老库里还有第二份载体** —— 2026-09-15 搬家前它挂在
 * `tavern.settings.search` 上。写入侧（`saveTavernSettings`）与升级路径
 * （`upgradeLegacyDefaults`）都会剔它，唯独「从没保存过酒馆设置」的老库会一直留着 ⇒
 * 开启云盘同步后 apiKey 随 `.yfe` 落到网盘，而检索设置面板的密钥栏明确承诺「只存本机、不上传」。
 *
 * 幂等：没有 search 字段直接返回 0；清理失败也不阻断流程（最坏情况与修复前等价）。
 *
 * ⚠️ 两个键名写成字面量是**有意**的：`searchSettings.ts` 会 import `./db`（门面），
 *    本文件若 import 它会直接成环（tests/importCycles 会红）。
 *    真源：`searchSettings.ts` 的 `K_APP_SEARCH`、`tavern/settings.ts` 的 `K_TAVERN_SETTINGS`。
 */
export async function migrateLegacySearchKey(): Promise<number> {
  const rec = await ops.get<{ key: string; value: Record<string, unknown> }>('meta', 'tavern.settings')
  const v = rec?.value
  if (!v || typeof v !== 'object' || !('search' in v)) return 0
  const { search: _drop, ...rest } = v
  await ops.put('meta', { key: 'tavern.settings', value: rest })
  return 1
}

/**
 * 清掉**项目级**的旧 AI 配置残留（2026-10-13 · 社区反馈）。
 *
 * 【病根】1.5.0 之前模型配置是**按项目**存在 `settingsKV` 里的（键名 `aiProviders` /
 *    `aiActiveProviderId`，与全局 meta 同名）。搬到全局之后，`aiCore/session.ts` 的
 *    `ensureMigrated()` 只做「合并到全局」，**不删原键** ⇒ 老项目里一直留着第二份，
 *    而那份的 `aiProviders` 带着 **apiKey 明文**。
 *    紧接着 `exportProject()` 按 `<项目id>::` 前缀**全收** `bundle.settings` ⇒
 *    备份文件 / 迁移包 / 定稿快照把密钥一起带出门 —— 而备份文件本就是给作者外传的。
 *
 * 【为什么能放心删】`ensureMigrated()` 一旦写下迁移标记，这两个键就是死数据：
 *    `loadProviders()` / `loadActiveId()` 只读全局 meta，没有任何读取路径会碰它们。
 *    ⚠️ 但**迁移标记键本身不能删**（见 `LEGACY_PROJECT_AI_KEYS` 的说明）——故此处按
 *    精确键名匹配，而不是拿 `isSensitiveMetaKey` 一把扫。
 *
 * 【为什么单独立一个迁移】`ensureMigrated()` 对**已迁移过的库**会短路（读标记直接返回），
 *    所以「迁移时顺手删」治不了存量 —— 本机就是这种情况（标记早已为 true、旧键还在）。
 *    这里扫全表，与「当前打开哪个项目」无关，故挂在 `runMigrations()` 的守卫**之前**。
 *
 * 幂等：键不存在即跳过；可反复跑。
 * @returns 删掉的记录条数
 */
export async function migrateLegacyProjectAiKeys(): Promise<number> {
  let all: { key?: unknown }[]
  try {
    all = await ops.getAll<{ key?: unknown }>('settingsKV')
  } catch (e) {
    // 读失败不能当成「没有残留」—— 但也不能挡住启动：留痕后按 0 返回，下次再清
    console.warn('[migrations] 清理旧项目级 AI 配置时读 settingsKV 失败，本次跳过：', e)
    return 0
  }
  let removed = 0
  for (const rec of all) {
    const key = String(rec?.key ?? '')
    const i = key.indexOf('::')
    if (i <= 0) continue // 无项目前缀（全局键）或前缀为空 ⇒ 不是目标
    if (!LEGACY_PROJECT_AI_KEYS.includes(key.slice(i + 2))) continue
    await ops.del('settingsKV', key)
    removed++
  }
  return removed
}

/**
 * 备份「元数据 / 载荷」分离（C2 · 2.4.2）：把老记录里的 bundle 搬到 backupPayloads，
 * backups 只留元数据 + 体积。**幂等**（没有 bundle 的记录直接跳过），可反复跑。
 *
 * 🔴 顺序：先写载荷、再改元数据 —— 中途失败最多留下「载荷已搬、元数据还带 bundle」的中间态，
 *    读取侧两种形态都能吃（见 `withBytes` / `getBackupPayload`），不会丢备份。
 */
export async function migrateBackupPayloads(): Promise<number> {
  const all = await ops.getAll<Record<string, unknown>>('backups')
  let moved = 0
  for (const rec of all) {
    const bundle = rec.bundle as { project?: unknown } | undefined
    const id = String(rec.id ?? '')
    if (!bundle || !id) continue
    await ops.put('backupPayloads', { id, projectId: String(rec.projectId ?? ''), bundle })
    const { bundle: _drop, ...rest } = rec
    await ops.put('backups', { ...rest, bytes: JSON.stringify(bundle).length })
    moved++
  }
  return moved
}
