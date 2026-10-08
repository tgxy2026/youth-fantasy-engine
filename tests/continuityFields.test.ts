// ============ 2.9.1 · 连续性校验新增「已登记字段接入」四节 ============
//
// 覆盖 continuityCheck 第 11~14 节：
//   11) 伏笔回收前置条件  12) 地理行程与时间线对账
//   13) 爽点间隔登记口径  14) 秘密计划揭晓章到点
//
// 🔴 这四节的共同契约是「**只提示、绝不改动作者数据**」，所以每个用例都配一条
//    「不该报的不报」的负向断言 —— 只看正面命中，证明不了判据有判别力。
//
// 背景：这四列此前是「作者认真填了、程序从不读」的死字段
// （见 docs/2.9.0-功能全景与数据复用机会梳理-2026-10-08.html 的 A 档）。
import * as db from '../src/lib/db'
import { auditContinuity } from '../src/lib/continuityCheck'
import type { Volume, Chapter } from '../src/lib/types'
import { __resetMockStores, memoryOps } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const J = (v: unknown) => JSON.stringify(v)

const mkVol = (id: string, order: number, title: string): Volume => {
  return { id, projectId: 'p1', order, title, description: '', createdAt: 0 }
}
// ⚠️ 必须用块体 return：`=> ({...})` 在跨行时会被 tsc 误解析（见 adversarial.test.ts 的同一注释）
const mkCh = (id: string, volId: string, order: number, title: string): Chapter => {
  return { id, projectId: 'p1', volumeId: volId, order, title, content: '', summary: '', status: '构思', wordCount: 0, createdAt: 0, updatedAt: 0 }
}
const tbl = (id: string, tabId: string, order: number, data: Record<string, string>) => {
  return { id, projectId: 'p1', tabId, order, data }
}

__resetMockStores()
;(async () => {
  const pid = 'p1'
  await memoryOps.put('projects', { id: pid, name: '字段接入场', createdAt: 0, updatedAt: 0 })
  db.setCurrentProject(pid)

  // 5 章（章号由隐藏顺序字段派生，与标题写法无关）
  await memoryOps.put('volumes', mkVol('v1', 0, '卷一'))
  for (let i = 1; i <= 5; i++) await memoryOps.put('chapters', mkCh(`c${i}`, 'v1', i - 1, `第${i}章`))

  // ---------- 第 11 节：伏笔回收前置条件 ----------
  await memoryOps.put('tableRows', tbl('f9', 'foreshadow', 0, { '编号': 'F0009', '状态': '未回收', '伏笔内容': '暗桩', '回收前置条件': '陈渊探得醉话' }))
  // 已回收 + 前置条件点名 F0009（仍未回收）⇒ 应报「前置未铺就」
  await memoryOps.put('tableRows', tbl('f10', 'foreshadow', 1, { '编号': 'F0010', '状态': '已回收', '伏笔内容': '暗桩供词', '回收前置条件': '陈渊识破（承 F0009）' }))
  // 已回收 + 前置条件为空 ⇒ 应报「未填回收前置条件」
  await memoryOps.put('tableRows', tbl('f11', 'foreshadow', 2, { '编号': 'F0011', '状态': '已回收', '伏笔内容': '借刀杀人计', '回收前置条件': '' }))
  // 已回收 + 前置条件点名的 F0010 **已回收** ⇒ 不应报
  await memoryOps.put('tableRows', tbl('f12', 'foreshadow', 3, { '编号': 'F0012', '状态': '已回收', '伏笔内容': '谷口暗桩', '回收前置条件': '接住 F0010' }))

  // ---------- 第 12 节：地理行程与时间线对账 ----------
  await memoryOps.put('tableRows', tbl('g1', 'geography', 0, { '编号': 'G0001', '名称': '青岚山', '距离与行程时间': '云州城→青岚山：马车两日' }))
  await memoryOps.put('tableRows', tbl('g2', 'geography', 1, { '编号': 'G0002', '名称': '断魂崖', '距离与行程时间': '青岚山→断魂崖：飞舟三日' }))
  await memoryOps.put('tableRows', tbl('g3', 'geography', 2, { '编号': 'G0003', '名称': '藏经阁', '距离与行程时间': '外门弟子房→藏经阁：半刻' }))
  // 第1→2 章换了地点而**同日**，行程却要 3 天 ⇒ 应报「行程时间存疑」
  await memoryOps.put('tableRows', tbl('tl1', 'timeline', 0, { '章节号': '第1章', '章节标题': '第1章', '发生时间': '3024年3月1日', '地理位置': '青岚山' }))
  await memoryOps.put('tableRows', tbl('tl2', 'timeline', 1, { '章节号': '第2章', '章节标题': '第2章', '发生时间': '3024年3月1日', '地理位置': '断魂崖' }))
  // 第3 章换去「藏经阁」但行程不足一天（半刻）⇒ 不应报
  await memoryOps.put('tableRows', tbl('tl3', 'timeline', 2, { '章节号': '第3章', '章节标题': '第3章', '发生时间': '3024年3月1日', '地理位置': '藏经阁' }))

  // ---------- 第 13 节：爽点间隔登记口径 ----------
  await memoryOps.put('tableRows', tbl('hp1', 'hookpoints', 0, { '章节号': '第1章', '章节标题': '第1章', '爽点内容': '开局', '距上个爽点间隔（章）': '—' }))
  // 第1章 → 第3章 实际间隔 2，表里登记「5」⇒ 应报
  await memoryOps.put('tableRows', tbl('hp2', 'hookpoints', 1, { '章节号': '第3章', '章节标题': '第3章', '爽点内容': '打脸', '距上个爽点间隔（章）': '5' }))
  // 第3章 → 第4章 实际间隔 1，表里登记「1」⇒ 不应报
  await memoryOps.put('tableRows', tbl('hp3', 'hookpoints', 2, { '章节号': '第4章', '章节标题': '第4章', '爽点内容': '升级', '距上个爽点间隔（章）': '1' }))

  // ---------- 第 14 节：秘密计划揭晓章到点 ----------
  // 计划「第2章」且正文已写到第 5 章 + 泄露风险「高」⇒ 应报（warn）
  await memoryOps.put('tableRows', tbl('s1', 'secrets', 0, { '编号': 'S0001', '秘密内容': '陈渊是混沌神体', '泄露风险等级': '高', '计划揭晓章节': '第2章' }))
  // 卷级表述「卷五神族降世」解析不出章号 ⇒ 不应报
  await memoryOps.put('tableRows', tbl('s2', 'secrets', 1, { '编号': 'S0002', '秘密内容': '萧景行借刀杀人', '泄露风险等级': '高', '计划揭晓章节': '卷五神族降世' }))
  // 计划「第9章」尚未到点（当前 5 章）⇒ 不应报
  await memoryOps.put('tableRows', tbl('s3', 'secrets', 2, { '编号': 'S0003', '秘密内容': '老瞎子身份', '泄露风险等级': '低', '计划揭晓章节': '第9章' }))

  const before = JSON.stringify(await db.getTableRows('foreshadow'))
  const issues = await auditContinuity()
  const titles = issues.map(i => i.title)
  const has = (kw: string) => titles.some(t => t.includes(kw))

  // ---------- 第 11 节断言 ----------
  ok('11 · 伏笔「前置未铺就」被检出', has('伏笔前置未铺就'), J(titles.filter(t => t.includes('伏笔'))))
  ok('11 · 已回收但前置条件为空被检出', has('已回收但未填「回收前置条件」'))
  ok('11 · 前置点名已回收伏笔时不误报（F0012 → F0010）', !titles.some(t => t.includes('F0012 依赖')))
  ok('11 · 未回收的伏笔不因前置条件被报', !titles.some(t => t.includes('伏笔 F0009 已回收')))

  // ---------- 第 12 节断言 ----------
  ok('12 · 同日跨地而行程 3 天 → 检出「行程时间存疑」', has('行程时间存疑'))
  ok('12 · 行程不足一天（半刻）不误报', !titles.some(t => t.includes('藏经阁')), J(titles.filter(t => t.includes('行程'))))
  ok('12 · 提示语点明了两地名与原由', issues.some(i => i.title.includes('青岚山') && i.title.includes('断魂崖')))

  // ---------- 第 13 节断言 ----------
  ok('13 · 爽点间隔登记与算值不一致被检出', has('爽点间隔登记不一致'))
  ok('13 · 间隔登记正确时不误报（第4章 gap=1 登记 1）', !titles.some(t => t.includes('第4章') && t.includes('爽点间隔')))
  ok('13 · 手填「—」时跳过不报', !titles.some(t => t.includes('第1章') && t.includes('爽点间隔')))

  // ---------- 第 14 节断言 ----------
  ok('14 · 计划揭晓章已到点被检出（第2章 ≤ 当前 5 章）', has('秘密计划揭晓章已到'))
  ok('14 · 高泄露风险的到点提醒升为「冲突」级以外仍可见（severity=warn）', issues.some(i => i.title.includes('秘密计划揭晓章已到') && i.severity === 'warn'))
  ok('14 · 卷级表述（卷五神族降世）不误报', !titles.some(t => t.includes('S0002')))
  ok('14 · 未到点的秘密不报（第9章 > 当前 5 章）', !titles.some(t => t.includes('S0003')))

  // ---------- 契约断言：只提示、不改数据 ----------
  const after = JSON.stringify(await db.getTableRows('foreshadow'))
  ok('契约 · 四节检查跑完后伏笔表逐字未变（只提示不改数据）', before === after)

  console.log(`\n===== 结果：${pass} PASS / ${fail} FAIL =====`)
  await Promise.resolve()
  process.exit(fail ? 1 : 0)
})()
