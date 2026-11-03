// ============ 3.3.3 · B4 写作目标：近 7 日日均与完稿预估 ============
//
// 钉住（规划 §9 · progress 验收 B-05）：
//   ① 「近 7 日」是 7 个**自然日**，缺字数的日子按 0 计入分母；
//   ② 只有 1 天有记录也除以 7（不能拿"有记录的天数"做分母）；
//   ③ 无记录 / 日均为零 / 没设全书目标 ⇒ 不给预计日期（estDate=null、daysNeeded=0），并给原因；
//   ④ 已达标 ⇒ remaining 0，不返回"还需 0 天"的日期；
//   ⑤ 只吃自动码字记录：手工登记不在入参里（混进来会重复计算）。
import { GOAL_PACE_DAYS, projectGoal, recentDailyAverage } from '../src/lib/stats/goalPace'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const NOW = new Date(2026, 9, 31, 15, 0, 0) // 2026-10-31
const key = (daysAgo: number) => {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - daysAgo)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const stat = (daysAgo: number, words: number) => ({ date: key(daysAgo), words })

function main() {
  ok('窗口是 7 天', GOAL_PACE_DAYS === 7)

  // ① 缺日按 0 计入分母：7 天里只有 2 天写了 1000 / 2000 ⇒ 3000/7 ≈ 429
  const sparse = [stat(1, 1000), stat(4, 2000)]
  ok('缺日按 0 计入分母', recentDailyAverage(sparse, NOW) === Math.round(3000 / 7), `${recentDailyAverage(sparse, NOW)}`)

  // ② 只有 1 天记录也除以 7（旧实现取"最近 7 条有记录的天"会算成 1000）
  ok('只有一天也除以 7', recentDailyAverage([stat(0, 1000)], NOW) === Math.round(1000 / 7))

  // ③ 第 7 天以前的不计入
  ok('7 天窗口之外不计入', recentDailyAverage([stat(7, 7000), stat(0, 700)], NOW) === 100)

  // ④ 未来日期 / 乱日期不参与
  ok('未来日期不参与', recentDailyAverage([stat(-1, 9999), stat(0, 700)], NOW) === 100)

  // ⑤ 无记录 ⇒ 不编日期
  const none = projectGoal({ totalWords: 0, goalTotal: 300000, stats: [], now: NOW })
  ok('无记录时 pace 为 0', none.pace === 0)
  ok('无记录时不给预计日期', none.estDate === null && none.daysNeeded === 0)
  ok('无记录原因可展示', none.reason === 'no-daily-record')

  // ⑥ 没设目标 ⇒ 不估
  const noGoal = projectGoal({ totalWords: 12000, goalTotal: 0, stats: [stat(0, 3000)], now: NOW })
  ok('没设全书目标不给日期', noGoal.estDate === null && noGoal.reason === 'no-goal')
  ok('没设目标时 remaining 为 0（不显示负数）', noGoal.remaining === 0)

  // ⑦ 正常预估：剩 90000，日均 3000 ⇒ 30 天
  const proj = projectGoal({ totalWords: 210000, goalTotal: 300000, stats: [stat(0, 21000)], now: NOW })
  ok('日均来自 7 自然日窗口', proj.pace === 3000, `${proj.pace}`)
  ok('剩余字数', proj.remaining === 90000, `${proj.remaining}`)
  ok('还需 30 天', proj.daysNeeded === 30, `${proj.daysNeeded}`)
  ok('预计日期 = 今天 + 30 天', proj.estDate?.getTime() === new Date(2026, 10, 30).getTime(), String(proj.estDate))
  ok('能估时不带原因', proj.reason === '')

  // ⑧ 已达标
  const done = projectGoal({ totalWords: 320000, goalTotal: 300000, stats: [stat(0, 3000)], now: NOW })
  ok('已达标不给"还需 0 天"', done.daysNeeded === 0 && done.estDate === null && done.reason === 'reached')
  ok('已达标剩余为 0', done.remaining === 0)

  // ⑨ 不够一天向上取整（差 10 字也按 1 天）
  const tiny = projectGoal({ totalWords: 299990, goalTotal: 300000, stats: [stat(0, 7000)], now: NOW })
  ok('不足一天向上取整', tiny.daysNeeded === 1, `${tiny.daysNeeded}`)

  // ⑩ 手工登记不掺：函数签名只收 stats（这里用负向断言说明来源）
  ok('只按自动记录计算（手工表不在入参）', projectGoal({
    totalWords: 0, goalTotal: 10000, stats: [stat(0, 700)], now: NOW,
  }).pace === 100)

  console.log(`\ngoalPace: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()