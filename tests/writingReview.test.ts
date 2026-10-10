/**
 * B1（2.4.1）创作复盘 —— 单测
 *
 * 复盘的价值在**对比与记录**，所以重点验：
 *   ① 本周 / 上周的区间切分正确（含端点、不含第 8 天）；
 *   ② 上周为 0 时**不编造**「增长 ∞%」，而是标成 `new`；
 *   ③ 连续天数：今天还没写**不算断**（否则每天凌晨打开软件都会看到"连续中断"）；
 *   ④ 净增量口径：删字（负数）也要如实累加，不裁剪成 0。
 */
import { buildWritingReview, dayDiff } from '../src/lib/outline/writingReview'
import { todayKey } from '../src/lib/app/date'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ writingReview')

// 固定"今天"= 2026-09-22（周二），便于构造区间
const NOW = new Date(2026, 8, 22)
const key = (agoDays: number) => todayKey(new Date(2026, 8, 22 - agoDays))
const mk = (pairs: Array<[number, number]>) => pairs.map(([ago, w]) => ({ date: key(ago), words: w }))

// ---------- 1) dayDiff ----------
{
  ok('dayDiff 同日为 0', dayDiff('2026-09-22', '2026-09-22') === 0)
  ok('dayDiff 相邻为 1', dayDiff('2026-09-21', '2026-09-22') === 1)
  ok('dayDiff 跨月正确', dayDiff('2026-08-31', '2026-09-01') === 1)
  ok('dayDiff 乱字符串不崩', Number.isNaN(dayDiff('x', 'y')))
}

// ---------- 2) 本周 vs 上周 ----------
{
  // 本周（0~6 天前）= 100+100+100 = 300；上周（7~13 天前）= 200
  const r = buildWritingReview(mk([[0, 100], [1, 100], [2, 100], [7, 200]]), NOW)
  ok('本周累加仅含近 7 天', r.thisWeek === 300, `${r.thisWeek}`)
  ok('上周累加第 8~14 天', r.lastWeek === 200, `${r.lastWeek}`)
  ok('🔴 第 7 天归上周、第 6 天归本周（端点不串）', r.thisWeek === 300 && r.lastWeek === 200)
  ok('环比 +50%', r.weekDeltaPct === 50, `${r.weekDeltaPct}`)
  ok('趋势为 up', r.weekTrend === 'up')

  const down = buildWritingReview(mk([[0, 50], [7, 200]]), NOW)
  ok('下降时趋势为 down', down.weekTrend === 'down')
  ok('下降幅度取绝对值展示（负号不在数字里）', down.weekDeltaPct === -75, `${down.weekDeltaPct}`)

  const fresh = buildWritingReview(mk([[0, 80]]), NOW)
  ok('🔴 上周为 0 时不编造百分比', fresh.weekDeltaPct === null)
  ok('🔴 上周为 0 本周有产出 → 标 new', fresh.weekTrend === 'new')

  const none = buildWritingReview([], NOW)
  ok('空数据不崩', none.weekTrend === 'none' && none.thisWeek === 0)
}

// ---------- 3) 连续天数 ----------
{
  // 连续 3 天（含今天）
  const s3 = buildWritingReview(mk([[0, 10], [1, 10], [2, 10]]), NOW)
  ok('连续 3 天', s3.currentStreak === 3 && s3.longestStreak === 3, `cur=${s3.currentStreak} max=${s3.longestStreak}`)

  // 🔴 今天还没写：不算断（从昨天往回数）
  const noToday = buildWritingReview(mk([[1, 10], [2, 10]]), NOW)
  ok('🔴 今天还没写不算断（允许今天未开始）', noToday.currentStreak === 2, `${noToday.currentStreak}`)

  // 昨天也没写 → 断
  const broken = buildWritingReview(mk([[2, 10], [3, 10]]), NOW)
  ok('昨天也没写则当前连续为 0', broken.currentStreak === 0, `${broken.currentStreak}`)

  // 历史最长 ≠ 当前
  const hist = buildWritingReview(mk([[10, 10], [9, 10], [8, 10], [7, 10], [0, 10]]), NOW)
  ok('历史最长 4 天', hist.longestStreak === 4, `${hist.longestStreak}`)
  ok('当前 1 天', hist.currentStreak === 1, `${hist.currentStreak}`)
  ok('给出最长区间', !!hist.longestStreakRange && hist.longestStreakRange.from === key(10), JSON.stringify(hist.longestStreakRange))

  // 零产出的天不算"写过"
  const zero = buildWritingReview(mk([[0, 10], [1, 0], [2, 10]]), NOW)
  ok('字数为 0 的天不计入连续', zero.currentStreak === 1, `${zero.currentStreak}`)
}

// ---------- 4) 最高产的一天 / 本月 / 首末日 ----------
{
  const r = buildWritingReview(mk([[0, 100], [3, 5000], [40, 200]]), NOW)
  ok('最高产的一天', r.bestDay?.words === 5000 && r.bestDay.date === key(3), JSON.stringify(r.bestDay))
  ok('本月只累加当月', r.thisMonth === 5100, `${r.thisMonth}`)   // 40 天前是 8 月，不计
  ok('有产出的天数', r.activeDays === 3, `${r.activeDays}`)
  ok('首次 / 最近动笔日', r.firstDay === key(40) && r.lastDay === key(0), `${r.firstDay} / ${r.lastDay}`)
  ok('无正数产出时 bestDay 为 null', buildWritingReview(mk([[0, -50]]), NOW).bestDay === null)
}

// ---------- 5) 🔴 净增量口径：删字如实累加 ----------
{
  const r = buildWritingReview(mk([[0, 1000], [1, -300]]), NOW)
  ok('🔴 删字按负数累加（不裁剪成 0）', r.thisWeek === 700, `${r.thisWeek}`)
  ok('总天数为正（那天确实动过笔）', r.activeDays === 2, `${r.activeDays}`)
}

// ---------- 6) 洞察措辞 ----------
{
  const up = buildWritingReview(mk([[0, 300], [7, 100]]), NOW)
  ok('上升时给鼓励式洞察', up.insights.some(s => s.includes('往上') || s.includes('多写')),
    JSON.stringify(up.insights))
  const down = buildWritingReview(mk([[0, 10], [7, 500]]), NOW)
  ok('下降时不指责（含"不一定是坏事"这类缓冲）', down.insights.some(s => s.includes('不一定是坏事')), JSON.stringify(down.insights))
  ok('🔴 洞察不含反检测/评价类措辞', !/像机器|命中率|合格|不合格/.test(down.insights.join('')))
}

console.log(`\n  writingReview: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
