// ============ 码字日历「年度热力图 + 年度数字卡」闸（3.1.2 · OPT-004）============
//
// 需求口径（主人 2026-10-17，经提问拍板选 C 混合方案）：
//   「日历进度表只占窗口约 1/4，右边大片空白；填充 365 天也填不满。换一种统计/展示方式，
//     让它更好地填满窗口、不要大量空白，然后让它进行每年的滚动。」
//   ⇒ 方案 C：左侧**年度热力图撑满** + 右侧**年度数字卡**（全年产量 / 打卡天数 / 最长连续 / 最佳单日）。
//
// 关键实现约束（都是这次改造里容易回退的点）：
//   ① 网格必须**按年**生成并补齐首尾整周（周一开头），列＝周、行＝周一到周日；
//   ② 格子用 `aspect-square` + `1fr` 列宽 ⇒ 随容器宽度等比缩放、天然撑满（不再是 11px 固定小格）；
//   ③ 年份切换不得越过今年（未来年份没有数据，切过去是一片空白）；
//   ④ 色阶仍是**单一判据** `heatLevel` + `data-heat`（mono 主题靠线型兜底的锚点，不能丢）；
//   ⑤ 统计口径**按项目**（`db.getDailyStats()` 已按当前项目过滤，见 OPT-005 核实结论）。
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const ROOT = process.cwd()
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

console.log('—— writingCalendar：码字日历年度化闸（3.1.2）——')

const dash = read('src/components/app/Dashboard.tsx')

// ---------- ① 年度网格：按年生成、周一开头、补齐首尾整周 ----------
{
  ok('① 网格按「年」构建（1 月 1 日 / 12 月 31 日为界）',
    dash.includes('const jan1 = new Date(calYear, 0, 1)') && dash.includes('const dec31 = new Date(calYear, 11, 31)'))
  ok('① 周一开头（(getDay() + 6) % 7 的偏移换算）',
    dash.includes('const lead = (jan1.getDay() + 6) % 7') && dash.includes('const tail = 6 - ((dec31.getDay() + 6) % 7)'))
  ok('① 列＝周、行＝周一→周日（gridAutoFlow: column + repeat(7, auto)）',
    dash.includes("gridAutoFlow: 'column'") && dash.includes("gridTemplateRows: 'repeat(7, auto)'"))
  ok('① 月标签按「每月 1 日所在列」打标',
    dash.includes('c.inYear && c.dom === 1') && dash.includes('months.push'))
}

// ---------- ② 撑满宽度：1fr 列 + aspect-square（替代旧的 11px 固定格） ----------
{
  ok('② 网格列宽 1fr 自适应（repeat(${weeks}, minmax(0, 1fr))）',
    dash.includes('repeat(${yearGrid.weeks}, minmax(0, 1fr))'))
  ok('② 格子 aspect-square（宽度随容器、高度等比 ⇒ 天然撑满且不变形）',
    dash.includes('aspect-square') && dash.includes('heatColor(c.words)'))
  ok('② 负向：旧「26 周固定小格」已拆除（无 heatDays / 26 * 7 / w-11px 网格）',
    !dash.includes('heatDays') && !dash.includes('26 * 7') && !dash.includes('w-11px h-11px rounded-2 '))
}

// ---------- ③ 年份切换 ----------
{
  ok('③ 年份状态 + 上一年/下一年按钮（下一年不得越过今年）',
    dash.includes("const [calYear, setCalYear] = useState(() => new Date().getFullYear())")
    && dash.includes('setCalYear(y => y - 1)')
    && dash.includes('disabled={calYear >= thisYear}'))
  ok('③ 非今年时提供「回到今年」（切远之后一键回位）',
    dash.includes('回到今年') && dash.includes('onClick={() => setCalYear(thisYear)}'))
}

// ---------- ④ 年度数字卡四项 ----------
{
  const cards = ['全年产量', '打卡天数', '最长连续', '最佳单日']
  const missing = cards.filter(c => !dash.includes(`'${c}'`))
  ok('④ 右栏四张年度卡齐全（全年产量 / 打卡天数 / 最长连续 / 最佳单日）',
    missing.length === 0, `缺：${missing.join('、')}`)
  ok('④ 打卡率按闰年取分母（365 / 366）', dash.includes('isLeapYear(calYear) ? 366 : 365'))
  // 🔴 主人二次调整（2026-10-17 晚）：四个统计项改**横向一行** —— 竖排右栏会把区块撑高，
  //    热力图下方留一片没用的空白。现在高度由热力图决定。
  ok('④ 四个统计项横向一行（ml-auto flex flex-wrap + gap-x，label/值/备注并列）',
    dash.includes('ml-auto flex flex-wrap items-center gap-x-5 gap-y-1'))
  ok('🔴 负向：已无竖排右栏（xl:w-48 / xl:grid-cols-1 一律不得回潮）',
    !dash.includes('xl:w-48') && !dash.includes('xl:grid-cols-1'))
  ok('④ 年内最长连续由逐日扫描得出（run/longest）',
    dash.includes('let longest = 0, run = 0') && dash.includes('if (run > longest) longest = run'))
}

// ---------- ⑤ 色阶单一真源保留（mono 线型兜底的锚点） ----------
{
  ok('⑤ 色阶仍是单一判据 heatLevel 四档（<500/<1500/<3000/3000+）',
    dash.includes('const heatLevel = (w: number) => (w === 0 ? 0 : w < 500 ? 1 : w < 1500 ? 2 : w < 3000 ? 3 : 4)'))
  ok('⑤ 每格仍输出 data-heat（纯黑白主题靠它做线型/填充区分）',
    dash.includes('data-heat={c.inYear ? heatLevel(c.words) : -1}'))
}

// ---------- ⑥ 统计口径按项目（OPT-005 核实结论） ----------
{
  ok('⑥ 数据源仍是 getDailyStats()（[单项目] 过滤在 db 层，不跨项目）',
    dash.includes('db.getDailyStats()'))
  const meta = read('src/lib/db/meta.ts')
  ok('⑥ db 层按 currentProjectId 过滤（口径未被改宽成跨项目）',
    meta.includes('return all.filter(s => s.projectId === currentProjectId)'))
}

console.log(`\nwritingCalendar: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
