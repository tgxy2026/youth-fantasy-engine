// ============ 主从双栏「锁高 + 两栏独立滚动」全局一致性闸（3.1.2）============
//
// 需求口径（主人 2026-10-17）：凡「左列表 + 右详情」型页签，两栏必须各自独立滚动，
//   **不能有的地方改了有的地方没改**。
//   · 2.8.1（社区反馈）立下 MasterDetail 范式（锁高外壳 + 两栏各自 overflow-y-auto），
//     当时刻意豁免了表单家族（世界设定 / 制度四页签 / 创作轨迹），理由「跟页滚是期望行为」；
//   · 3.1.2 主人要求全局统一 ⇒ 三处豁免全部收编，酒馆各页签 / 地图 / 情节推演本就是锁高壳。
//
// 为什么值得闸：这全是**布局/样式**改动 —— 写错了不报错不崩，只是「某一栏不滚 /
//   跟着页滚」，肉眼不逐页对照根本发现；且新增页签时最容易漏（本闸把枚举成本固化，
//   以后加页签漏了直接红）。
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const ROOT = process.cwd()
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

console.log('—— masterDetailScroll：主从双栏独立滚动一致性闸（3.1.2）——')

// ---------- ① 全量枚举：每个主从双栏页签都必须「锁高」 ----------
// ⚠️ 新增「左列表 + 右详情」型页签时，把入口组件加进这个数组 —— 漏加不会红，
//    但数组本身就是口径清单；已按 App.tsx renderContent 路由逐个核对过。
const MASTER_DETAIL_PAGES: Array<[string, string]> = [
  ['src/components/world/CharacterSheet.tsx', '角色卡（主要/次要/NPC + 其他设定）'],
  ['src/components/outline/OutlineSheet.tsx', '分卷大纲 / 章节细纲'],
  ['src/components/sheets/WorldSetSheet.tsx', '世界设定 / 力量体系（母子结构）'],
  ['src/components/sheets/ParallelSetSheet.tsx', '政治/经济/信仰/司法（并列结构）'],
  ['src/components/audit/TrajectoryPanel.tsx', '创作轨迹'],
  ['src/components/tavern/TavernCard.tsx', '酒馆 · 角色卡片'],
  ['src/components/tavern/TavernWorld.tsx', '酒馆 · 背景设定'],
  ['src/components/tavern/TavernPlot.tsx', '酒馆 · 剧情推演'],
  ['src/components/tavern/TavernScript.tsx', '酒馆 · 故事剧本'],
  ['src/components/tavern/TavernReport.tsx', '酒馆 · 推演报告'],
  ['src/components/tavern/TavernFree.tsx', '酒馆 · 自由对话'],
  ['src/components/tavern/RunPanel.tsx', '酒馆 · 跑团互动'],
  ['src/components/world/GeoMapEditor.tsx', '地图编辑'],
  ['src/components/outline/PlotCanvas.tsx', '情节推演画布'],
]
for (const [f, label] of MASTER_DETAIL_PAGES) {
  const src = read(f)
  // 锁高两义：走 MasterDetail 组件的，或自己写锁高外壳（h-full + overflow-hidden/min-h-0）
  const viaComponent = src.includes("from '@/components/common/MasterDetail'")
  const viaShell = src.includes('h-full') && (src.includes('overflow-hidden') || src.includes('min-h-0'))
  ok(`① ${label}（${path.basename(f)}）锁高：走 MasterDetail 或自写锁高外壳`, viaComponent || viaShell)
}

// ---------- ② 本次收编的三处：恒双栏 + 两栏各自 overflow ----------
{
  const ws = read('src/components/sheets/WorldSetSheet.tsx')
  ok('② 世界设定：根容器锁高（page-enter flex h-full flex-col overflow-hidden）',
    ws.includes('page-enter flex h-full flex-col overflow-hidden'))
  ok('② 世界设定：页头 shrink-0（保存/AI 补全常驻，不随右栏滚走）', ws.includes('<header className="mb-4 shrink-0">'))
  ok('② 世界设定：双栏容器 flex-1 min-h-0（锁高链传给两栏）', ws.includes('<div className="flex flex-1 min-h-0 gap-4">'))
  ok('② 世界设定：左栏层目录 flex 列 + min-h-0（flex 子项默认 min-height:auto，删了就撑破锁高）',
    ws.includes('w-56 shrink-0 rounded-xl border border-ink-700 bg-ink-850/40 overflow-hidden flex flex-col min-h-0'))
  ok('② 世界设定：左栏唯一滚动区 flex-1 min-h-0 overflow-y-auto',
    ws.includes('<div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">'))
  ok('② 世界设定：右栏表单独立滚动（flex-1 min-w-0 min-h-0 overflow-y-auto）',
    ws.includes('<div className="flex-1 min-w-0 min-h-0 overflow-y-auto overscroll-contain pr-1">'))
  ok('② 世界设定：旧形态清干净——无 items-start 堆叠容器、无 lg:flex-row、无内联 maxHeight',
    !ws.includes('items-start') && !ws.includes('lg:flex-row') && !ws.includes('maxHeight: foldVh'))
  ok('② 世界设定：旧根容器类名已换（不再是 w-full page-enter）', !ws.includes('"w-full page-enter"'))
}
{
  const ps = read('src/components/sheets/ParallelSetSheet.tsx')
  ok('② 制度四页签：根容器锁高', ps.includes('page-enter flex h-full flex-col overflow-hidden'))
  ok('② 制度四页签：页头 shrink-0', ps.includes('<header className="mb-4 shrink-0">'))
  ok('② 制度四页签：双栏容器 flex-1 min-h-0', ps.includes('<div className="flex flex-1 min-h-0 gap-4">'))
  ok('② 制度四页签：左栏条目列表独立滚动（flex-1 min-h-0 overflow-y-auto）',
    ps.includes('<div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">'))
  ok('② 制度四页签：右栏表单独立滚动', ps.includes('<div className="flex-1 min-w-0 min-h-0 overflow-y-auto overscroll-contain pr-1">'))
  ok('② 制度四页签：旧形态清干净——无 items-start / lg:flex-row / 内联 maxHeight',
    !ps.includes('items-start') && !ps.includes('lg:flex-row') && !ps.includes('maxHeight: foldVh'))
}
{
  const tp = read('src/components/audit/TrajectoryPanel.tsx')
  ok('② 创作轨迹：根容器锁高', tp.includes('page-enter flex h-full flex-col overflow-hidden'))
  // 允许元素上带其它属性（例如 3.3.1 引导锚点 `data-guide`）—— 本闸要守的是「这块 shrink-0」，
  // 不是属性顺序；写死整串会变成「一加属性就红」，反而逼人删掉锚点。
  ok('② 创作轨迹：页头 + 总览 + AI 占比三块都 shrink-0（只让双栏区吃剩余高度）',
    /<header[^>]*className="mb-5 shrink-0"/.test(tp) &&
    tp.includes('grid grid-cols-2 md:grid-cols-4 gap-3 mb-5 shrink-0') &&
    tp.includes('mb-5 shrink-0 rounded-xl border border-ink-700 bg-ink-850/40 px-4 py-3'))
  ok('② 创作轨迹：双栏容器 flex-1 min-h-0', tp.includes('<div className="flex flex-1 min-h-0 gap-4">'))
  ok('② 创作轨迹：左栏章节列表 w-64 shrink-0 + flex 列',
    tp.includes('w-64 shrink-0 rounded-xl border border-ink-700 bg-ink-850/40 overflow-hidden flex flex-col min-h-0'))
  ok('② 创作轨迹：左栏唯一滚动区 flex-1 min-h-0 overflow-y-auto',
    tp.includes('<div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">'))
  ok('② 创作轨迹：右栏轨迹详情独立滚动（min-w-0 flex-1 min-h-0 overflow-y-auto）',
    tp.includes('<section className="min-w-0 flex-1 min-h-0 overflow-y-auto overscroll-contain pr-1">'))
  ok('② 创作轨迹：旧形态清干净——无 lg:grid-cols-[16rem,1fr]、无 62vh 内联 maxHeight',
    !tp.includes('lg:grid-cols-[16rem,1fr]') && !tp.includes("maxHeight: foldVh('62vh')"))
}

// ---------- ③ 情节推演：左缘卡片遮挡（3.1.2 实测bug）----------
// 病灶：卡片以 (x,y) 为**中心**渲染，scrollLeft 到不了负数 ⇒ 种子首列 x=80 时
//   卡片左缘 -50px 被裁，「待办伏笔」只剩「伏」右半边＋「笔」。
{
  // ③-a 种子：所有卡片 x ≥ 170（CARD_W/2 + 40，与 generate()/layBeats() 同口径）
  const seed = read('src/data/seedInstitutions.ts')
  const block = seed.slice(seed.indexOf('CANVAS_CARD_SEED'), seed.indexOf('CANVAS_CONN_SEED'))
  const xs: number[] = []
  const rowRe = /^\s*\[\d+, '[a-z]+', '[^']*', (\d+), (\d+)\]/gm
  let m: RegExpExecArray | null
  while ((m = rowRe.exec(block))) xs.push(Number(m[1]))
  ok('③-a 种子共 10 张卡（解析到 10 行坐标）', xs.length === 10, `实际 ${xs.length}`)
  ok('③-a 种子每张卡 x ≥ 170（左缘 ≥ 40px，不再被裁）', xs.length > 0 && xs.every(x => x >= 170),
    `最小 x = ${xs.length ? Math.min(...xs) : 'N/A'}`)
  ok('③-a 种子首列就在规范起点 170（与 AI 生成 / 模板铺节点同口径）', xs.includes(170))

  // ③-b 组件：载入自愈（旧快照 x=80 已落库的用户项目靠这个救回来）
  const pc = read('src/components/outline/PlotCanvas.tsx')
  ok('③-b PlotCanvas 定义 MIN_CARD_X = CARD_W/2 + 40', pc.includes('const MIN_CARD_X = CARD_W / 2 + 40'))
  ok('③-b PlotCanvas 定义 MIN_CARD_Y = 70（上缘也不越界）', pc.includes('const MIN_CARD_Y = 70'))
  ok('③-b 载入时对旧快照坐标自愈（x/y 各自 Math.max 下限，只挪越界的卡）',
    pc.includes('x: Math.max(MIN_CARD_X, c.x ?? MIN_CARD_X)') &&
    pc.includes('y: Math.max(MIN_CARD_Y, c.y ?? MIN_CARD_Y)'))
  ok('③-b 自愈挂在载入快照处（setCards 之前），不是渲染时打补丁',
    /getSetting<PlotPersist>\('plotCanvas'[\s\S]*?Math\.max\(MIN_CARD_X/.test(pc))
  ok('③-b 新增卡片的起点口径未变（generate / layBeats 仍 CARD_W/2 + 40，共 3 处）',
    (pc.match(/CARD_W \/ 2 \+ 40/g) ?? []).length >= 3)
  ok('③-b 卡片仍以中心渲染（-translate-x-1/2 -translate-y-1/2）—— 所以坐标下限判据必须留在',
    pc.includes('-translate-x-1/2 -translate-y-1/2'))
}

console.log(`\nmasterDetailScroll: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
