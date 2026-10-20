// 3.2.0 · W4 检查报告留存（A 策略）· 单测
//
// 作者 2026-10-20 拍板：**有问题才存 + 双闸淘汰**。
// 盯四件事：
//   ① 全绿不落库、有严重/中等才落（否则 200 份额度会被"每次检查"刷满）；
//   ② 未完成/失败的检查**不算**"没问题"（那是故障，不是发现）；
//   ③ 同一批发现只存一份（检查重跑不算新报告）；
//   ④ 双闸淘汰真的会删（每任务 5 份 / 每项目 200 份 / 32 MiB）。
import { readFileSync } from 'node:fs'
import { __resetMockStores } from './mock-memory'
import {
  isWorthPersisting, isSeriousLevel, countFindings, findingsFingerprint,
  planCheckReportPrune, persistCheckReports, CHECK_REPORT_LIMITS,
  type CheckFindingLike,
} from '@/lib/revision/checkReports'
import { listProjectRevisionPayloads, saveRevisionPayload } from '@/lib/db/revisionJobs'
import type { RevisionPayload } from '@/lib/revision/jobTypes'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const F_SERIOUS: CheckFindingLike = { level: '严重', title: '时间线冲突', detail: '第 3 章说三天后，第 5 章说次日' }
const F_MID: CheckFindingLike = { level: '中等', title: '人设漂移', detail: '角色忽然改用书面语' }
const F_INFO: CheckFindingLike = { level: '提示', title: '可用词更准', detail: '建议' }

const run = (findings: CheckFindingLike[], state = 'completed') => ({ state, result: { data: findings } })
const PID = 'w4-report'

async function main() {
  // ---------- 一、判据 ----------
  {
    ok('① 全绿（只有提示）不落库', !isWorthPersisting(run([F_INFO])))
    ok('① 空结论不落库', !isWorthPersisting(run([])))
    ok('① 有「中等」要落库', isWorthPersisting(run([F_MID])))
    ok('① 有「严重」要落库', isWorthPersisting(run([F_SERIOUS])))
    ok('🔴 ① 失败/取消/未完成都不算"没问题"（不落库，也不冒充通过）',
      !isWorthPersisting(run([F_SERIOUS], 'failed'))
      && !isWorthPersisting(run([F_SERIOUS], 'cancelled'))
      && !isWorthPersisting(run([F_SERIOUS], 'partial')))
    ok('① 没有 run / 没有 result 时不落库', !isWorthPersisting(null) && !isWorthPersisting({ state: 'completed' }))
    ok('① 级别词表与审计侧一致（严重/中等 算，提示 不算）',
      isSeriousLevel('严重') && isSeriousLevel('中等') && !isSeriousLevel('提示') && !isSeriousLevel(undefined))
    const c = countFindings([F_SERIOUS, F_MID, F_INFO, F_INFO])
    ok('① 计数分档正确', c.serious === 1 && c.minor === 1 && c.info === 2, JSON.stringify(c))
  }

  // ---------- 二、指纹（去重依据） ----------
  {
    const a = findingsFingerprint([F_SERIOUS, F_MID])
    const b = findingsFingerprint([F_MID, F_SERIOUS])
    ok('② 指纹与顺序无关（两次跑出的顺序可能不同）', a === b, `${a} vs ${b}`)
    ok('② 内容不同 ⇒ 指纹不同', findingsFingerprint([F_SERIOUS]) !== findingsFingerprint([F_MID]))
    ok('② 指纹稳定可复算', findingsFingerprint([F_SERIOUS]) === findingsFingerprint([{ ...F_SERIOUS }]))
  }

  // ---------- 三、淘汰计划（纯函数） ----------
  {
    const mk = (id: string, jobId: string, at: number, bytes = 100) => ({ id, jobId, createdAt: at, bytes })
    const six = Array.from({ length: 6 }, (_, i) => mk(`p${i}`, 'job1', 1000 + i))
    const drop1 = planCheckReportPrune(six, { perJob: 5, perProject: 200 })
    ok('③ 每任务超过 5 份 ⇒ 删最旧的 1 份', drop1.length === 1 && drop1[0] === 'p0', drop1.join(','))

    const many = Array.from({ length: 6 }, (_, i) => mk(`q${i}`, `job${i}`, 1000 + i))
    const drop2 = planCheckReportPrune(many, { perJob: 5, perProject: 3 })
    ok('③ 每项目总数超限 ⇒ 删最旧的', drop2.length === 3 && drop2.includes('q0') && drop2.includes('q1') && drop2.includes('q2'),
      drop2.join(','))

    const heavy = [mk('h0', 'j', 100, 60), mk('h1', 'j', 200, 60)]
    const drop3 = planCheckReportPrune(heavy, { perJob: 5, perProject: 200, perProjectBytes: 100 })
    ok('③ 每项目字节超限 ⇒ 从最旧的删起（保留最新的）',
      drop3.length === 1 && drop3[0] === 'h0', drop3.join(','))

    ok('③ 额度内一份都不删', planCheckReportPrune([mk('a', 'j', 1)], {}).length === 0)
    ok('③ 默认上限与 W2 配额一致（200 份 / 32 MiB / 每任务 5 份）',
      CHECK_REPORT_LIMITS.perProject === 200 && CHECK_REPORT_LIMITS.perProjectBytes === 32 * 1024 * 1024
      && CHECK_REPORT_LIMITS.perJob === 5)
  }

  // ---------- 四、落库编排 ----------
  __resetMockStores()
  {
    const r = await persistCheckReports({
      projectId: PID, jobId: 'job-green',
      reports: [
        { checkId: 'continuity', source: '自检', run: run([F_INFO]) },
        { checkId: 'ooc', source: '自检', run: run([]) },
        { checkId: 'foreshadow', source: '自检', run: null },
      ],
    })
    ok('④ 全绿批次：一份都不落库', r.saved === 0 && r.skipped === 3, JSON.stringify(r))
    ok('④ 全绿批次：库里没有报告', (await listProjectRevisionPayloads(PID)).length === 0)
  }

  {
    const r = await persistCheckReports({
      projectId: PID, jobId: 'job-1',
      reports: [
        { checkId: 'continuity', source: '自检 · 连续性', run: run([F_SERIOUS]) },
        { checkId: 'ooc', source: '自检 · 人设', run: run([F_INFO]) },
        { checkId: 'foreshadow', source: '自检 · 伏笔', run: run([]) },
      ],
    })
    ok('④ 有严重发现 ⇒ 只落那一份', r.saved === 1 && r.skipped === 2, JSON.stringify(r))
    const rows = await listProjectRevisionPayloads(PID)
    ok('④ 落库内容带 checkId / source / 结论',
      rows.length === 1 && JSON.stringify(rows[0].report).includes('continuity')
      && JSON.stringify(rows[0].report).includes('时间线冲突'), JSON.stringify(rows[0].report).slice(0, 120))
    ok('④ 摘要把严重/中等数写清（作者在列表里能直接看）',
      /严重 1/.test(rows[0].summary) && /中等 0/.test(rows[0].summary), rows[0].summary)
    ok('④ 载荷 kind=report（不与候选抢回收语义）', rows[0].kind === 'report')
  }

  {
    // 同一批发现重跑 ⇒ 不新增（指纹去重）
    const before = (await listProjectRevisionPayloads(PID)).length
    const r = await persistCheckReports({
      projectId: PID, jobId: 'job-1',
      reports: [{ checkId: 'continuity', source: '自检 · 连续性', run: run([F_SERIOUS]) }],
    })
    const after = (await listProjectRevisionPayloads(PID)).length
    ok('🔴 ④ 同一批发现重跑不新增报告（指纹去重）', r.saved === 0 && after === before, JSON.stringify(r))
  }

  {
    // 每任务 5 份上限：造 6 份不同内容
    __resetMockStores()
    for (let i = 0; i < 6; i++) {
      await persistCheckReports({
        projectId: PID, jobId: 'job-cap',
        reports: [{
          checkId: 'continuity', source: '自检',
          run: run([{ level: '严重', title: `第 ${i} 类问题`, detail: `细节 ${i}` }]),
        }],
      })
    }
    const rows = await listProjectRevisionPayloads(PID)
    ok('🔴 ④ 每任务最多留 5 份（第 6 份把最旧的挤掉）', rows.length === 5, String(rows.length))
    ok('④ 留下的是最新的 5 份（第 0 份被淘汰）',
      !rows.some(r => JSON.stringify(r.report).includes('第 0 类问题')),
      rows.map(r => r.summary).join(' | '))
  }

  {
    // 写盘异常不抛（旁路）
    __resetMockStores()
    const bad = { id: 'x', projectId: PID, kind: 'report', jobId: 'j', report: {}, summary: '', bytes: 1, createdAt: 1 } as RevisionPayload
    await saveRevisionPayload(bad) // 占位，保证 store 存在
    const r = await persistCheckReports({ projectId: PID, jobId: 'j2', reports: [] })
    ok('④ 空输入直接返回（不报错、不写盘）', r.saved === 0 && r.error === undefined)
  }

  // ---------- 五、接线（自检跑完就落库，且不打断创作） ----------
  {
    const src = readFileSync('src/lib/outline/autoContinue.ts', 'utf8')
    ok('⑤ 自检流程调用了落库（不是只有纯函数）', /persistCheckReports\(/.test(src))
    ok('⑤ 用请求归属当 projectId/jobId（挂不到任务的报告没人看得到）',
      /projectId: String\(request\.projectId\)/.test(src) && /jobId: request\.taskId/.test(src))
    ok('⑤ 三项审校各自登记 checkId',
      ['continuity', 'ooc', 'foreshadow'].every(k => new RegExp(`checkId: '${k}'`).test(src)))
    ok('🔴 ⑤ 落库失败不打断创作（有 catch）', /persistCheckReports\(\{[\s\S]{0,600}?\}\)\.catch\(/.test(src))
  }

  console.log(`\n———— checkReports：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

main()
