// 3.2.1 · T-05（CO-07「不同状态正确汇总」）· 覆盖率汇总口径 · 单测
//
// 盯四件事：
//   ① `skipped`（空章 / 作者跳过）**单独计数**，不能混进 done，也不能当成"没问题"；
//   ② `failed`（没检成）必须让 `allPassed` 变 false —— 漏检绝不能显示成通过；
//   ③ 严重发现 > 0 也算不通过（本地引擎说"发现了冲突"时不能报绿）；
//   ④ 空输入不抛（诊断时一章都没跑过也要能显示）。
//
// ⚠️ 现状如实记录：`coverage = done / total`，**skipped 会拉低覆盖率**。
//    这是 3.2.0 起的既有口径（方案要求"空章跳过但仍计入进度"），本次只钉住不改行为；
//    要不要把分母改成 `total - skipped` 属产品口径决定，已登记在 3.2.1 规划里待主人拍板。
import { calculateCoverage } from '@/lib/aiTasks/reviewFindings'
import type { CheckItemResult } from '@/lib/aiTasks/reviewFindings'

let pass = 0, fail = 0
function ok(name: string, cond: unknown, extra = '') {
  if (cond) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, '::', extra) }
}

const item = (status: CheckItemResult['status'], over: Partial<CheckItemResult> = {}): CheckItemResult => ({
  id: 'c' + Math.random().toString(36).slice(2, 6),
  name: '章',
  status,
  findings: 0,
  critical: 0,
  ...over,
})

function main() {
  // ① 全检成
  {
    const s = calculateCoverage([item('done'), item('done')])
    ok('① 全部 done ⇒ coverage=1、allPassed=true', s.coverage === 1 && s.allPassed === true, JSON.stringify(s))
    ok('① 计数正确', s.total === 2 && s.done === 2 && s.failed === 0 && s.skipped === 0)
  }

  // ② 空章跳过
  {
    const s = calculateCoverage([item('done'), item('done'), item('skipped'), item('skipped')])
    ok('② skipped 单独计数，不混进 done', s.skipped === 2 && s.done === 2, JSON.stringify(s))
    ok('② 跳过不算失败（allPassed 仍为 true）', s.allPassed === true)
    ok('② 现状：coverage 用 done/total，skipped 会拉低（2/4=0.5）', s.coverage === 0.5, String(s.coverage))
  }

  // ③ 漏检
  {
    const s = calculateCoverage([item('done'), item('failed', { error: '超时' })])
    ok('③ failed 单独计数', s.failed === 1 && s.done === 1, JSON.stringify(s))
    ok('③ 🔴 有 failed 就 allPassed=false（漏检不许报绿）', s.allPassed === false)
  }

  // ④ 严重发现
  {
    const s = calculateCoverage([item('done', { findings: 3, critical: 1 })])
    ok('④ findings / critical 累加', s.totalFindings === 3 && s.criticalFindings === 1, JSON.stringify(s))
    ok('④ 有严重发现 ⇒ allPassed=false', s.allPassed === false)
  }

  // ⑤ 空输入
  {
    const s = calculateCoverage([])
    ok('⑤ 空数组不抛，coverage=0', s.total === 0 && s.coverage === 0 && s.done === 0)
    ok('⑤ 空输入 allPassed=true（没检过也没发现）—— 界面须另有"未运行"文案，不能只靠这个布尔值',
      s.allPassed === true)
  }

  console.log(`\n———— reviewCoverage：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

void main()
