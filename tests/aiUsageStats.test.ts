// 3.0 · W1-4 AI 消耗统计 · 单测
//
// 盯三件事：
//   ① 汇总口径（按模型 / 按日 / 被拒计数）；
//   ② 容错（空输入、老数据无 calls、空模型名 / NaN 耗时）；
//   ③ 🔴 位置与接线闸：统计在「模型设置」、账本入口在「创作轨迹」、关于页已移除。
import fs from 'node:fs'
import { summarizeUsage, localDayOf } from '../src/lib/aiUsageStats'
import type { AiRun } from '../src/lib/aiRunTypes'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

function mkRun(id: string, calls: AiRun['calls']): AiRun {
  return {
    id, projectId: 'p1', kind: 'creative', title: 't', status: 'done',
    startedAt: 0, finishedAt: 0, basis: { at: 0 }, candidates: [], calls,
    outcome: null, error: '',
  }
}

console.log('\n—— aiUsageStats 用例开始 ——')

// ---------- ① 本地日期 ----------
{
  const ts = new Date(2026, 9, 10, 8, 30).getTime()
  ok('本地日期格式 YYYY-MM-DD', localDayOf(ts) === '2026-10-10', localDayOf(ts))
  ok('月 / 日个位补零', localDayOf(new Date(2026, 0, 5, 1, 0).getTime()) === '2026-01-05')
}

// ---------- ② 空输入 ----------
{
  const s = summarizeUsage([])
  ok('空输入 → 全 0', s.calls === 0 && s.totalMs === 0 && s.refusalCalls === 0 && s.runsWithCalls === 0)
  ok('空输入 → 两个聚合表都空', s.byModel.length === 0 && s.byDay.length === 0)
}

// ---------- ③ 聚合口径 ----------
{
  const d1 = new Date(2026, 9, 10, 9, 0).getTime()
  const d2 = new Date(2026, 9, 11, 9, 0).getTime()
  const s = summarizeUsage([
    mkRun('r1', [
      { model: 'A', ms: 1000, at: d1 },
      { model: 'A', ms: 2000, at: d1 },
      { model: 'B', ms: 500, at: d2, finishReason: 'content_filter' },
    ]),
    mkRun('r2', [{ model: 'B', ms: 1500, at: d2 }]),
    mkRun('r3', []), // 无调用 → 不计入 runsWithCalls
  ])
  ok('调用总数', s.calls === 4, String(s.calls))
  ok('累计耗时', s.totalMs === 5000, String(s.totalMs))
  ok('被拒计数（content_filter）', s.refusalCalls === 1, String(s.refusalCalls))
  ok('有调用的运行数（空 runs 不计）', s.runsWithCalls === 2, String(s.runsWithCalls))
  ok('按模型降序（A 2 次在前）', s.byModel[0].model === 'A' && s.byModel[0].calls === 2)
  ok('按模型聚合耗时', s.byModel.find(m => m.model === 'B')?.ms === 2000)
  ok('按日升序', s.byDay[0].day === '2026-10-10' && s.byDay[1].day === '2026-10-11')
  ok('按日聚合调用数与耗时', s.byDay[0].calls === 2 && s.byDay[1].calls === 2 && s.byDay[1].ms === 2000)
}

// ---------- ④ 容错 ----------
{
  const legacy = { ...mkRun('r', []), calls: undefined } as unknown as AiRun
  ok('老数据无 calls 字段不炸', summarizeUsage([legacy]).calls === 0)

  const s2 = summarizeUsage([mkRun('r2', [{ model: '', ms: NaN, at: Date.now() }])])
  ok('空模型名 / NaN 耗时不炸', s2.calls === 1 && s2.totalMs === 0)
  ok('空模型名归到「未记录模型」', s2.byModel[0].model.includes('未记录'))
}

// ---------- ⑤ 位置与接线闸 ----------
{
  const chat = fs.readFileSync('src/lib/aiCore/chat.ts', 'utf8')
  ok('🔴 chat() 上报用量', chat.includes('reportUsage('))
  ok('🔴 被拒调用标 content_filter（统计页据此显示「被拒 N 次」）',
    chat.includes("finishReason: 'content_filter'"))

  const ledger = fs.readFileSync('src/lib/aiRunLedger.ts', 'utf8')
  ok('🔴 createRun 接上用量总线', ledger.includes('bindUsageSink()'))
  ok('🔴 finishRun 摘掉总线（防下一次任务塞进已结束的）', ledger.includes('setUsageSink(null)'))

  ok('🔴 统计面板挂在「模型设置」页',
    fs.readFileSync('src/components/ModelSettingsPanel.tsx', 'utf8').includes('<AIUsagePanel />'))
  ok('🔴 运行账本入口在「创作轨迹」页',
    fs.readFileSync('src/components/TrajectoryPanel.tsx', 'utf8').includes('<RunLedgerPanel'))
  ok('🔴 关于页已移除账本入口',
    !fs.readFileSync('src/components/AboutPage.tsx', 'utf8').includes('RunLedgerPanel'))
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`)
if (fail) process.exit(1)
