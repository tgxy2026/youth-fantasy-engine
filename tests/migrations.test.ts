// ============ 迁移统一入口 runMigrations 回归 ============
// 审计 P1-7 的核心问题不是「某个迁移函数写错了」，而是**两条打开路径跑的迁移集合不一致**：
//   手动 openProject 跑 ledger + numbering + types 三件；
//   启动自动恢复上次项目只跑 types 一件。
// 所以这里刻意把三条迁移的整体效果与**顺序**一起锁住。
//
// ⚠️ 前置状态必须写实：真实历史上 `volumes` / `chapters` 本就存在（编辑器维护），
//    `chapter-master` 只是**另一张表视图**（migrateChapterLedger 只搬台账行、不建章节记录）。
//    若造出「有台账行但没有 chapters 记录」的架空状态，numbering 会对着空集合白跑，
//    得出「迁移没生效」的假结论——这正是本测试第一版踩过的坑，特此注明。
//
// 顺序怎么验？旧形态的「章节号」是**卷内独立编号**（每卷都从第 1 章重新开始）：
//   正确顺序（ledger 先搬家 → numbering 再重算）→ 第二卷的章应变成「第3章」「第4章」；
//   若顺序颠倒（numbering 先跑）→ 那时行还挂在旧 tab `chapter-master` 上，
//   numbering 按 `chapter-vol-<卷id>` 取行会取不到，第二卷的章会保留旧值「第1章」→ 断言失败。
import * as db from '../src/lib/db'
import { createDemoProject } from '../src/lib/app/seedData'
import { __resetMockStores, __dumpAll, memoryOps } from './mock-memory'
import type { TableRow, Volume, Chapter } from '../src/lib/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 清掉某项目的卷/章/台账，腾出干净场地注入旧格式数据 */
async function clearProjectData(pid: string) {
  for (const store of ['volumes', 'chapters', 'tableRows'] as const) {
    const all = await memoryOps.getAll<{ id: string; projectId: string }>(store)
    const mine = all.filter(r => r.projectId === pid)
    if (mine.length) await memoryOps.bulkDel(store, mine.map(r => r.id))
  }
}

// ---------- 注入 1.9.1 旧形态 ----------
__resetMockStores()
const pid = await createDemoProject()
await clearProjectData(pid)
db.setCurrentProject(pid)

const row = (id: string, order: number, data: Record<string, string>): TableRow =>
  ({ id, projectId: pid, tabId: 'chapter-master', order, data })

// ① 卷与章（真实存在，由编辑器维护）
const mkVol = (id: string, order: number, title: string): Volume =>
  ({ id, projectId: pid, order, title, description: '', createdAt: 1 })
const mkCh = (id: string, volumeId: string, order: number, title: string): Chapter =>
  ({ id, projectId: pid, volumeId, order, title, content: '', summary: '', status: '草稿', wordCount: 0, createdAt: 1, updatedAt: 1 })
await db.saveVolume(mkVol('v1', 0, '第一卷'))
await db.saveVolume(mkVol('v2', 1, '第二卷'))
await db.saveChapter(mkCh('c1', 'v1', 0, '废脉'))
await db.saveChapter(mkCh('c2', 'v1', 1, '塔灵'))
await db.saveChapter(mkCh('c3', 'v2', 0, '入城'))
await db.saveChapter(mkCh('c4', 'v2', 1, '夜宴'))

// ② 旧单表台账（卷定义行 + 章行，行 id 保持 ch-<章节id>）
await db.saveTableRow(row('r-vol1', 0, { '章节标题': '第一卷' }))
await db.saveTableRow(row('r-vol2', 1, { '章节标题': '第二卷' }))
// 🔴 关键：**每卷都从「第1章」开始**（卷内独立编号）——正确迁移后应为全局 1/2/3/4
await db.saveTableRow(row('ch-c1', 2, { '章节号': '第1章', '章节标题': '废脉', '所属卷': '第一卷' }))
await db.saveTableRow(row('ch-c2', 3, { '章节号': '第2章', '章节标题': '塔灵', '所属卷': '第一卷' }))
await db.saveTableRow(row('ch-c3', 4, { '章节号': '第1章', '章节标题': '入城', '所属卷': '第二卷' }))
await db.saveTableRow(row('ch-c4', 5, { '章节号': '第2章', '章节标题': '夜宴', '所属卷': '第二卷' }))

// ---------- 跑统一入口 ----------
await db.runMigrations()

const vols = await db.getAllVolumes()
ok('runMigrations 后两卷齐备', vols.length === 2, `实际=${vols.length}`)

const mine = (await memoryOps.getAll<TableRow>('tableRows')).filter(r => r.projectId === pid)
ok('runMigrations 清空了旧单表 chapter-master', mine.filter(r => r.tabId === 'chapter-master').length === 0,
  `残留=${mine.filter(r => r.tabId === 'chapter-master').length}`)

const ledgerTabs = new Set(mine.filter(r => r.tabId.startsWith('chapter-vol-')).map(r => r.tabId))
ok('runMigrations 为每卷建了台账表', ledgerTabs.size === 2, `实际=${ledgerTabs.size}`)
ok('runMigrations 迁移了全部 4 行章台账', mine.filter(r => r.id.startsWith('ch-')).length === 4,
  `实际=${mine.filter(r => r.id.startsWith('ch-')).length}`)

/** 取某章台账行里的「章节号」 */
const chapterNo = (chapterId: string): string | undefined =>
  mine.find(r => r.id === `ch-${chapterId}`)?.data['章节号']

// 🔴 顺序断言：第二卷的章必须是全局连续的「第3章」「第4章」。
//    若 numbering 排在 ledger 之前，这两行不会被重算，会保留旧值「第1章」「第2章」。
ok('【顺序】第二卷首章被重算为「第3章」（证明 ledger 先于 numbering）',
  chapterNo('c3') === '第3章', `实际=${chapterNo('c3')}`)
ok('【顺序】第二卷次章被重算为「第4章」', chapterNo('c4') === '第4章', `实际=${chapterNo('c4')}`)
ok('第一卷章号保持「第1章」「第2章」',
  chapterNo('c1') === '第1章' && chapterNo('c2') === '第2章',
  `实际=${chapterNo('c1')}/${chapterNo('c2')}`)

// ---------- 幂等：再跑两遍不得产生任何写差异 ----------
const snap = __dumpAll()
await db.runMigrations()
await db.runMigrations()
ok('runMigrations 幂等（连跑两遍全库快照一致）', snap === __dumpAll(),
  snap === __dumpAll() ? '' : '重复运行产生了写差异')

// ---------- 未设当前项目时必须安全空转 ----------
{
  __resetMockStores()
  db.setCurrentProject('')
  let threw = false
  try { await db.runMigrations() } catch { threw = true }
  ok('未设当前项目时 runMigrations 安全空转（不抛异常）', !threw)
}

// ---------- 必选模块同步 migrateLockedFeatures（2.8.0 · 「关于打赏」由 default 升 locked） ----------
// 场景：老项目在「自定义项目」里取消勾选过「关于打赏」，features 里就没有 about。
//   覆盖安装（保留旧数据、只换程序）后必须能补回来 —— 否则该页签永远不会出现，作者也无处可开。
// ⚠️ 本测试不 import schema（schema 链会拉进 './db'，在 node 里要打桩）：
//   锁定项 id 由调用方传入，这里直接给字面量，正好顺带验证「db 层不认识 schema」这一设计。
{
  __resetMockStores()
  db.setCurrentProject('')
  const LOCKED = ['editor', 'dashboard', 'about']

  const pCustom = await db.createProject('老自定义', '', '', '', 'custom', ['politics', 'trajectory'])
  const pDone = await db.createProject('新自定义', '', '', '', 'custom', ['editor', 'dashboard', 'about', 'politics'])
  const pFull = await db.createProject('完整项目', '', '', '', 'full', ['dashboard'])

  // 前置：确实缺 about（否则本用例什么都没测）
  ok('前置：老自定义项目的 features 里确实没有 about',
    !(await db.getProject(pCustom.id))!.features!.includes('about'))

  const n = await db.migrateLockedFeatures(LOCKED)
  ok('只改动「缺必选模块的自定义项目」1 个（另两个跳过，不计入）', n === 1, `实际=${n}`)

  const c = (await db.getProject(pCustom.id))!
  ok('缺的必选模块被补上（about）', c.features!.includes('about'), c.features!.join(','))
  ok('原有可选模块一个不少（只补不改）',
    c.features!.includes('politics') && c.features!.includes('trajectory'), c.features!.join(','))
  ok('补入项不重复（原 2 + 新 3 = 5）', c.features!.length === 5, `实际=${c.features!.join(',')}`)

  const o = (await db.getProject(pDone.id))!
  ok('已含全部必选模块的项目不被改写', o.features!.length === 4, `实际=${o.features!.join(',')}`)

  const f = (await db.getProject(pFull.id))!
  ok('完整项目不在同步范围内（features 原样）', f.features!.join(',') === 'dashboard', f.features!.join(','))

  // 幂等：再跑一遍应无事可做
  const n2 = await db.migrateLockedFeatures(LOCKED)
  ok('幂等：第二遍返回 0（无写差异）', n2 === 0, `实际=${n2}`)

  // 与「当前打开哪个项目」无关 —— 这正是它挂在启动期、而非 runMigrations 项目段的原因
  db.setCurrentProject('不存在的项目')
  const n3 = await db.migrateLockedFeatures(LOCKED)
  ok('与当前项目无关：currentProjectId 无效时照常工作', n3 === 0, `实际=${n3}`)
}

console.log(`\nmigrations: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
