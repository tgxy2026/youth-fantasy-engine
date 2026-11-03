// ============ W4 工单接线 + WT2 候选代次失效 · 单元测试 ============
//
// 钉住：
//   ① 证据定位：逐字命中
//   ② 去重键：章+来源+证据摘要
//   ③ 能力缺项报告：JSON/思考/证据
//   ④ 检查持久化：写入/读取/关联
//   ⑤ 代次管理：租约/升级/过期
//   ⑥ 候选按代次失效：同代次应用一份后另一份失效
//   ⑦ 迟到回调：项目删除/租约过期/其他窗口
//   ⑧ 基准过期：正文/细纲/设定/章序变化

import {
  locateEvidence,
  fromContinuityFinding,
  fromCandidate,
  reportCapabilityGaps,
  dedupExtendedItems,
  filterItems,
  ticketDedupKey,
  type ExtendedTicketItem,
} from '../src/lib/revision/findingAdapters'
import {
  persistCheckResult,
  loadCheckResult,
  restoreCheckState,
  summarizeCheckState,
} from '../src/lib/revision/checkPersistence'
import {
  createGeneration,
  bumpGeneration,
  isLeaseValid,
  isLeaseExpired,
  canContinue,
  handleLateCallback,
  handleProjectSwitch,
  isBaselineStale,
  expireCandidate,
  expireCandidatesByBaseline,
  invalidateByGeneration,
  type GenerationLease,
} from '../src/lib/revision/generationInvalidation'
import { __resetMockStores } from './mock-memory'
import * as db from '../src/lib/db'
import { saveRevisionJob, saveRevisionPayload } from '../src/lib/db/revisionJobs'
import { buildCandidate } from '../src/lib/revision/revisionCommit'
import type { RevisionJob, RevisionPayload } from '@/lib/revision/jobTypes'
import type { RevisionCandidate } from '@/lib/revision/revisionCandidate'
import { uid } from '@/lib/app/id'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const PID = 'p-w4-wt2'

function mkJob(over: Partial<RevisionJob> = {}): RevisionJob {
  return {
    id: over.id ?? `j-${uid()}`,
    projectId: over.projectId ?? PID,
    kind: over.kind ?? 'chapter-review',
    scope: over.scope ?? { chapterId: 'ch1' },
    params: over.params ?? {},
    status: over.status ?? 'queued',
    stepCount: over.stepCount ?? 3,
    currentStep: over.currentStep ?? 0,
    steps: over.steps ?? [
      { id: 's1', name: '抽取', status: 'pending' },
      { id: 's2', name: '生成候选', status: 'pending' },
      { id: 's3', name: '应用', status: 'pending' },
    ],
    baseline: over.baseline ?? { bodyDigest: 'digest-1', createdAt: Date.now() },
    createdAt: over.createdAt ?? Date.now(),
    updatedAt: over.updatedAt ?? Date.now(),
    ...over,
  }
}

function mkCandidate(over: Partial<RevisionCandidate> = {}): RevisionCandidate {
  return {
    id: over.id ?? `c-${uid()}`,
    jobId: over.jobId ?? `j-${uid()}`,
    projectId: over.projectId ?? PID,
    status: over.status ?? 'pending',
    text: over.text ?? '候选文本',
    beforeText: over.beforeText ?? '原文',
    summary: over.summary ?? '测试候选',
    bytes: over.bytes ?? 100,
    createdAt: over.createdAt ?? Date.now(),
    updatedAt: over.updatedAt ?? Date.now(),
    generation: over.generation ?? 1,
    ...over,
  }
}

// ───────────────── ① 证据定位 ─────────────────
async function case1() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const body = '这是第一章的正文内容。\n第二段内容在这里。\n第三段。'

  // 逐字命中
  const r1 = locateEvidence('正文内容', body)
  ok('①① 逐字命中', r1.located && r1.paragraphIndex === 0)

  // 未命中
  const r2 = locateEvidence('不存在的文本', body)
  ok('①② 未命中', !r2.located)

  // 空引文
  const r3 = locateEvidence('', body)
  ok('①③ 空引文', !r3.located)

  // 空正文
  const r4 = locateEvidence('文本', '')
  ok('①④ 空正文', !r4.located)

  // 多段定位
  const r5 = locateEvidence('第二段内容', body)
  ok('①⑤ 多段定位', r5.located && r5.paragraphIndex === 1)
}

// ───────────────── ② 去重键 ─────────────────
async function case2() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const item1: ExtendedTicketItem = {
    id: '1', chapterId: 'ch1', chapterTitle: '第一章', chapterNo: 1,
    source: 'continuity', severity: 'warn', title: '问题1', detail: '详情',
    action: 'manual', status: 'pending',
    evidence: [{ quote: '引文A', located: true }],
  }
  const item2: ExtendedTicketItem = {
    ...item1, id: '2',
  }

  // 相同章+来源+证据摘要 → 相同去重键
  const k1 = ticketDedupKey(item1)
  const k2 = ticketDedupKey(item2)
  ok('②① 相同去重键', k1 === k2)

  // 不同来源 → 不同去重键
  const item3: ExtendedTicketItem = { ...item1, source: 'style' as const, id: '3' }
  const k3 = ticketDedupKey(item3)
  ok('②② 不同来源不同键', k1 !== k3)

  // 无证据 → 退回标题规则
  const item4: ExtendedTicketItem = { ...item1, evidence: undefined, id: '4' }
  const k4 = ticketDedupKey(item4)
  ok('②③ 无证据用标题', k4.includes('问题1'))
}

// ───────────────── ③ 能力缺项报告 ─────────────────
async function case3() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const items: ExtendedTicketItem[] = [
    {
      id: '1', chapterId: 'ch1', chapterTitle: '第一章', chapterNo: 1,
      source: 'ai-review', severity: 'warn', title: '问题1', detail: '详情',
      action: 'polish', status: 'pending',
    },
  ]

  // 无缺项
  const r1 = reportCapabilityGaps(items, 'gpt-4o', true, false)
  ok('③① 无缺项', !r1.hasGaps && r1.gaps.length === 0)

  // JSON 缺项
  const r2 = reportCapabilityGaps(items, 'gpt-4o', false, false)
  ok('③② JSON 缺项', r2.hasGaps && r2.gaps.includes('jsonOutput'))

  // 思考模式缺项
  const items2: ExtendedTicketItem[] = [
    {
      id: '1', chapterId: 'ch1', chapterTitle: '第一章', chapterNo: 1,
      source: 'ai-ooc', severity: 'warn', title: '问题1', detail: '详情',
      action: 'rewrite', status: 'pending',
    },
  ]
  const r3 = reportCapabilityGaps(items2, 'gpt-4o', true, false)
  ok('③③ 思考缺项', r3.hasGaps && r3.gaps.includes('thinking'))

  // 证据定位缺项
  const items3: ExtendedTicketItem[] = [
    {
      id: '1', chapterId: 'ch1', chapterTitle: '第一章', chapterNo: 1,
      source: 'continuity', severity: 'warn', title: '问题1', detail: '详情',
      action: 'manual', status: 'pending',
      evidence: [{ quote: '引文', located: false }],
    },
  ]
  const r4 = reportCapabilityGaps(items3, 'gpt-4o', true, true)
  ok('③④ 证据缺项', r4.hasGaps && r4.gaps.includes('evidence-locate'))
}

// ───────────────── ④ 去重与筛选 ─────────────────
async function case4() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const items: ExtendedTicketItem[] = [
    {
      id: '1', chapterId: 'ch1', chapterTitle: '第一章', chapterNo: 1,
      source: 'continuity', severity: 'warn', title: '问题1', detail: '详情',
      action: 'manual', status: 'pending',
      evidence: [{ quote: '引文A', located: true }],
    },
    {
      id: '2', chapterId: 'ch1', chapterTitle: '第一章', chapterNo: 1,
      source: 'continuity', severity: 'warn', title: '问题1', detail: '详情',
      action: 'manual', status: 'pending',
      evidence: [{ quote: '引文A', located: true }],
    },
    {
      id: '3', chapterId: 'ch2', chapterTitle: '第二章', chapterNo: 2,
      source: 'style', severity: 'info', title: '问题2', detail: '详情',
      action: 'polish', status: 'pending',
    },
  ]

  // 去重
  const deduped = dedupExtendedItems(items)
  ok('④① 去重', deduped.length === 2)

  // 按来源筛选
  const bySource = filterItems(items, { sources: ['continuity'] })
  ok('④② 按来源筛选', bySource.length === 2)

  // 按章筛选
  const byChapter = filterItems(items, { chapterIds: ['ch1'] })
  ok('④③ 按章筛选', byChapter.length === 2)

  // 可执行筛选：items[0] action='manual' 不通过；items[2] action='polish' 但无证据不通过
  const runnable = filterItems(items, { onlyRunnable: true })
  ok('④④ 可执行筛选', runnable.length === 0)
}

// ───────────────── ⑤ 检查持久化 ─────────────────
async function case5() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const job = mkJob({ id: 'j-check' })
  await saveRevisionJob(job)

  // 持久化
  const r1 = await persistCheckResult('j-check', PID, 'check-1', 'continuity', { issues: [{ title: '问题1' }] }, [{ quote: '引文', located: true }], '检查摘要')
  ok('⑤① 持久化成功', r1.ok && r1.payloadId !== undefined)

  // 读取
  if (r1.ok && r1.payloadId) {
    const loaded = await loadCheckResult(r1.payloadId)
    ok('⑤② 读取成功', loaded !== undefined && loaded?.id === r1.payloadId)
  }

  // 恢复状态
  const restored = await restoreCheckState('j-check')
  ok('⑤③ 状态恢复', restored.job !== undefined && restored.checks.length >= 1)

  // 汇总
  const summary = summarizeCheckState(restored.checks)
  ok('⑤④ 汇总正确', summary.total >= 1)

  // 不存在的任务
  const r2 = await restoreCheckState('nonexistent')
  ok('⑤⑤ 不存在任务', r2.job === undefined)
}

// ───────────────── ⑥ 代次管理 ─────────────────
async function case6() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  // 创建代次
  const lease = createGeneration('window-1', 'j-1', 60000)
  ok('⑥① 创建代次', lease.generation === 1 && lease.leaseHolder === 'window-1')

  // 租约有效
  ok('⑥② 租约有效', isLeaseValid(lease, 'window-1'))

  // 租约过期
  const expiredLease: GenerationLease = { ...lease, expiresAt: Date.now() - 1000 }
  ok('⑥③ 租约过期', isLeaseExpired(expiredLease))

  // 升级代次
  const bumped = bumpGeneration(lease, 'window-1')
  ok('⑥④ 升级代次', typeof bumped === 'object' && 'generation' in bumped && (bumped as GenerationLease).generation === 2)

  // 其他窗口不能升级
  const bumped2 = bumpGeneration(lease, 'window-2')
  ok('⑥⑤ 其他窗口不能升级', typeof bumped2 === 'object' && 'error' in bumped2)

  // 其他窗口不能继续
  const can = canContinue(lease, 'window-2', [])
  ok('⑥⑥ 其他窗口不能继续', !can.ok && can.error?.includes('租约被'))

  // 同代次有 applying 不能继续
  const c = mkCandidate({ status: 'applying' as const, generation: 1 })
  const can2 = canContinue(lease, 'window-1', [c])
  ok('⑥⑦ 同代次 applying 不能继续', !can2.ok)
}

// ───────────────── ⑦ 候选按代次失效 ─────────────────
async function case7() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const c1 = mkCandidate({ id: 'c1', generation: 1, status: 'pending' })
  const c2 = mkCandidate({ id: 'c2', generation: 1, status: 'pending' })
  const c3 = mkCandidate({ id: 'c3', generation: 2, status: 'pending' })

  const updated = invalidateByGeneration([c1, c2, c3], 'c1', 1)
  ok('⑦① 应用者不变', updated.find(x => x.id === 'c1')?.status === 'pending')
  ok('⑦② 同代次另一份失效', updated.find(x => x.id === 'c2')?.status === 'discarded')
  ok('⑦③ 不同代次保留', updated.find(x => x.id === 'c3')?.status === 'pending')

  // 已 applied 的不受影响
  const c4 = mkCandidate({ id: 'c4', generation: 1, status: 'applied' })
  const updated2 = invalidateByGeneration([c1, c4], 'c1', 1)
  ok('⑦④ applied 不受影响', updated2.find(x => x.id === 'c4')?.status === 'applied')
}

// ───────────────── ⑧ 迟到回调处理 ─────────────────
async function case8() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const lease = createGeneration('window-1', 'j-1', 60000)

  // 项目已删除
  const r1 = handleLateCallback(lease, 'window-1', true, true)
  ok('⑧① 项目删除丢弃', r1.discard && r1.action === 'discard')

  // 任务不存在
  const r2 = handleLateCallback(lease, 'window-1', false, false)
  ok('⑧② 任务不存在丢弃', r2.discard && r2.action === 'discard')

  // 租约过期
  const expired: GenerationLease = { ...lease, expiresAt: Date.now() - 1000 }
  const r3 = handleLateCallback(expired, 'window-1', false, true)
  ok('⑧③ 租约过期标记', !r3.discard && r3.action === 'mark-stale')

  // 其他窗口持有
  const r4 = handleLateCallback(lease, 'window-2', false, true)
  ok('⑧④ 其他窗口丢弃', r4.discard && r4.action === 'discard')

  // 正常
  const r5 = handleLateCallback(lease, 'window-1', false, true)
  ok('⑧⑤ 正常保留', !r5.discard && r5.action === 'keep')

  // 无租约
  const r6 = handleLateCallback(undefined, 'window-1', false, true)
  ok('⑧⑥ 无租约标记', !r6.discard && r6.action === 'mark-stale')
}

// ───────────────── ⑨ 切项目回调 ─────────────────
async function case9() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const r1 = handleProjectSwitch('p1', 'p1')
  ok('⑨① 同项目注入', r1.shouldInject)

  const r2 = handleProjectSwitch('p1', 'p2')
  ok('⑨② 不同项目不注入', !r2.shouldInject && r2.reason?.includes('不注入'))
}

// ───────────────── ⑩ 基准过期 ─────────────────
async function case10() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const job = mkJob({
    id: 'j-baseline',
    baseline: {
      bodyDigest: 'body-orig',
      outlineDigest: 'outline-orig',
      settingsDigest: 'settings-orig',
      chapterOrder: 1,
      createdAt: Date.now(),
    },
  })

  // 正文变化
  const r1 = isBaselineStale(job, 'body-changed', 'outline-orig', 'settings-orig', 1)
  ok('⑩① 正文变化过期', r1.stale && r1.reasons.includes('正文已变化'))

  // 设定变化
  const r2 = isBaselineStale(job, 'body-orig', 'outline-orig', 'settings-changed', 1)
  ok('⑩② 设定变化过期', r2.stale && r2.reasons.includes('依赖设定已变化'))

  // 章序变化
  const r3 = isBaselineStale(job, 'body-orig', 'outline-orig', 'settings-orig', 2)
  ok('⑩③ 章序变化过期', r3.stale && r3.reasons.includes('章序已变化'))

  // 全部一致
  const r4 = isBaselineStale(job, 'body-orig', 'outline-orig', 'settings-orig', 1)
  ok('⑩④ 全部一致不过期', !r4.stale)

  // 候选过期
  const c = mkCandidate({ id: 'c-expire', status: 'pending' })
  const r5 = expireCandidate(c, ['正文已变化'])
  ok('⑩⑤ 候选过期', r5.ok && r5.candidate?.status === 'stale')

  // 已 applied 不能过期
  const c2 = mkCandidate({ id: 'c-applied', status: 'applied' })
  const r6 = expireCandidate(c2, ['正文已变化'])
  ok('⑩⑥ applied 不能过期', !r6.ok)

  // 批量过期
  const c3 = mkCandidate({ id: 'c3', status: 'pending' })
  const c4 = mkCandidate({ id: 'c4', status: 'applied' })
  const r7 = expireCandidatesByBaseline([c3, c4], job, 'body-changed', 'outline-orig', 'settings-orig', 1)
  ok('⑩⑦ 批量过期', r7.expiredCount === 1 && r7.updated[0].status === 'stale')
}

// ───────────────── ⑪ 从 ContinuityFinding 构建 ─────────────────
async function case11() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const finding = { level: '严重', title: '角色已死却出场', detail: '第10章已死，第15章又出场', where: '第15章' }
  const item = fromContinuityFinding(finding, 'ch15', '第十五章', 15, '第15章正文内容')
  ok('⑪① 构建成功', item.title === '角色已死却出场' && item.source === 'continuity')
  ok('⑪② 证据定位', item.evidence?.length === 1 && item.evidence[0].located)
}

// ───────────────── ⑫ 端到端：检查持久化 + 候选关联 ─────────────────
async function case12() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const job = mkJob({ id: 'j-e2e', baseline: { bodyDigest: 'digest-1', createdAt: Date.now() } })
  await saveRevisionJob(job)

  // 持久化检查
  const r1 = await persistCheckResult('j-e2e', PID, 'check-e2e', 'continuity', { issues: [] }, [])
  ok('⑫① 检查持久化', r1.ok && r1.payloadId !== undefined)

  // 创建候选
  const payload: RevisionPayload = {
    id: 'p-e2e', projectId: PID, jobId: 'j-e2e', kind: 'candidate',
    candidateText: '候选正文', beforeText: '原文', summary: '端到端候选', bytes: 100, createdAt: Date.now(),
  }
  await saveRevisionPayload(payload)

  const c = buildCandidate(job, payload, 1)
  ok('⑫② 候选构建', c !== undefined)

  // 从候选构建工单条目
  if (c) {
    const item = fromCandidate(c, 'ch1', '第一章', 1, '正文内容')
    ok('⑫③ 从候选构建工单', item.candidateId === c.id)
  }

  // 恢复状态
  const restored = await restoreCheckState('j-e2e')
  ok('⑫④ 状态恢复', restored.checks.length >= 1)
}

async function main() {
  await case1()
  await case2()
  await case3()
  await case4()
  await case5()
  await case6()
  await case7()
  await case8()
  await case9()
  await case10()
  await case11()
  await case12()
  console.log(`\nw4wt2: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
