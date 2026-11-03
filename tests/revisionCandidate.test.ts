// ============ 3.2.0 · W3 候选生成与应用 ============
//
// 钉住：
//   ① 状态机只允许合法转移
//   ② 条件提交：正文摘要不一致时不提交
//   ③ 提交标记：intent 应用前写入，receipt 应用后写入
//   ④ 崩溃核对：有 intent 无 receipt → 需核对
//   ⑤ 同章互斥：应用一份后另一份失效
//   ⑥ Diff：逐行对比，不预读全文

import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'
import { uid } from '@/lib/app/id'
import {
  canTransition,
  transitionCandidate,
  invalidateSiblings,
  checkBaseline,
  type RevisionCandidate,
} from '../src/lib/revision/revisionCandidate'
import {
  validateCommitPrecondition,
  createSubmitIntent,
  createSubmitReceipt,
  reconcileCrash,
  prepareApplyCandidate,
  completeApplyCandidate,
  discardCandidate,
  staleCandidate,
  buildCandidate,
} from '../src/lib/revision/revisionCommit'
import {
  generateDiff,
  summarizeDiff,
  diffStats,
  wordChange,
} from '../src/lib/revision/revisionDiff'
import { saveRevisionJob, saveRevisionPayload } from '../src/lib/db/revisionJobs'
import type { RevisionJob, RevisionPayload } from '@/lib/revision/jobTypes'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const PID = 'p-w3-candidate'

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

function mkPayload(over: Partial<RevisionPayload> = {}): RevisionPayload {
  return {
    id: over.id ?? `p-${uid()}`,
    projectId: over.projectId ?? PID,
    kind: over.kind ?? 'candidate',
    jobId: over.jobId ?? `j-${uid()}`,
    summary: over.summary ?? '测试候选',
    bytes: over.bytes ?? 100,
    createdAt: over.createdAt ?? Date.now(),
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

// ───────────────── ① 状态机：合法转移 ─────────────────
async function case1() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  // 合法转移
  ok('①① pending → applying', canTransition('pending', 'applying'))
  ok('①② pending → stale', canTransition('pending', 'stale'))
  ok('①③ pending → discarded', canTransition('pending', 'discarded'))
  ok('①④ applying → applied', canTransition('applying', 'applied'))
  ok('①⑤ applying → needs-reconcile', canTransition('applying', 'needs-reconcile'))
  ok('①⑥ needs-reconcile → applied', canTransition('needs-reconcile', 'applied'))

  // 非法转移
  ok('①⑦ applied → pending（非法）', !canTransition('applied', 'pending'))
  ok('①⑧ discarded → applying（非法）', !canTransition('discarded', 'applying'))
  ok('①⑨ pending → applied（跳步，非法）', !canTransition('pending', 'applied'))

  // 同状态转移 → 合法（幂等）
  const c = mkCandidate({ status: 'pending' })
  const t = transitionCandidate(c, 'pending')
  ok('①⑩ 同状态转移幂等', t.ok && t.candidate?.status === 'pending')

  // 代次校验
  const t2 = transitionCandidate(c, 'applying', 999)
  ok('①⑪ 代次不匹配拒绝', !t2.ok && t2.error?.includes('代次不匹配'))

  const t3 = transitionCandidate(c, 'applying', 1)
  ok('①⑫ 代次匹配通过', t3.ok && t3.candidate?.status === 'applying')
}

// ───────────────── ② 条件提交：正文摘要校验 ─────────────────
async function case2() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const job = mkJob({
    id: 'j-commit',
    baseline: { bodyDigest: 'digest-orig', outlineDigest: 'outline-orig', createdAt: Date.now() },
  })

  // 摘要一致 → 通过
  const v1 = validateCommitPrecondition(job, 'digest-orig')
  ok('②① 摘要一致通过', v1.ok)

  // 摘要不一致 → 拒绝
  const v2 = validateCommitPrecondition(job, 'digest-changed')
  ok('②② 摘要不一致拒绝', !v2.ok && v2.error?.includes('正文已变化'))

  // 细纲变化 → 拒绝
  const v3 = validateCommitPrecondition(job, 'digest-orig', 'outline-changed')
  ok('②③ 细纲变化拒绝', !v3.ok && v3.error?.includes('细纲已变化'))
}

// ───────────────── ③ 提交标记：intent + receipt ─────────────────
async function case3() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const job = mkJob({ id: 'j-marker', baseline: { bodyDigest: 'digest-orig', createdAt: Date.now() } })
  const payload = mkPayload({ id: 'p-marker', kind: 'candidate', jobId: 'j-marker', candidateText: '候选正文', beforeText: '原文' })
  await saveRevisionJob(job)
  await saveRevisionPayload(payload)

  const c = buildCandidate(job, payload, 1)
  ok('③① 从任务+载荷构建候选', c !== undefined && c.id === 'p-marker')

  // 准备应用（创建 intent）
  const prep = prepareApplyCandidate(job, c!, 'digest-orig')
  ok('③② 准备应用成功', prep.ok && prep.intent !== undefined && prep.candidate?.status === 'applying')
  ok('③③ intent 包含操作 ID', prep.intent?.operationId !== undefined)
  ok('③④ intent 包含前摘要', prep.intent?.beforeBodyDigest === 'digest-orig')

  // 完成应用（创建 receipt）
  const comp = completeApplyCandidate(prep.candidate!, 'digest-after')
  ok('③⑤ 完成应用成功', comp.ok && comp.receipt !== undefined && comp.candidate?.status === 'applied')
  ok('③⑥ receipt 包含后摘要', comp.receipt?.afterBodyDigest === 'digest-after')
  ok('③⑦ receipt 与 intent 操作 ID 一致', comp.receipt?.operationId === prep.intent?.operationId)

  // 应用后正文变化 → 候选仍为 applied（已生效）
  ok('③⑧ 应用后状态为 applied', comp.candidate?.status === 'applied')
}

// ───────────────── ④ 崩溃核对 ─────────────────
async function case4() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const job = mkJob({ id: 'j-crash', baseline: { bodyDigest: 'digest-orig', createdAt: Date.now() } })
  const payload = mkPayload({ id: 'p-crash', kind: 'candidate', jobId: 'j-crash', candidateText: '候选', beforeText: '原文' })
  await saveRevisionJob(job)
  await saveRevisionPayload(payload)

  const c = buildCandidate(job, payload, 1)!

  // 无 intent → 无需核对
  const r1 = reconcileCrash(job, c, 'digest-orig')
  ok('④① 无 intent 无需核对', !r1.needsReconcile && r1.suggestedStatus === 'pending')

  // 有 intent 无 receipt，正文未变 → 需核对，建议 pending
  const intent = createSubmitIntent(job, c.id, 'digest-orig')
  const c2: RevisionCandidate = { ...c, status: 'applying', intent }
  const r2 = reconcileCrash(job, c2, 'digest-orig')
  ok('④② 有意图无回执正文未变需核对', r2.needsReconcile && r2.suggestedStatus === 'pending')

  // 有 intent 无 receipt，正文已变 → 需核对，建议 needs-reconcile
  const r3 = reconcileCrash(job, c2, 'digest-changed')
  ok('④③ 有意图无回执正文已变需核对', r3.needsReconcile && r3.suggestedStatus === 'needs-reconcile')

  // 有 intent 有 receipt，提交成功
  const receipt = createSubmitReceipt(intent, 'digest-after')
  const c3: RevisionCandidate = { ...c2, status: 'applied', receipt }
  const r4 = reconcileCrash(job, c3, 'digest-after')
  ok('④④ 提交成功无需核对', !r4.needsReconcile)

  // 有 intent 有 receipt，提交失败
  const failReceipt = createSubmitReceipt(intent, 'digest-after', undefined, false, '写盘失败')
  const c4: RevisionCandidate = { ...c2, status: 'discarded', receipt: failReceipt }
  const r5 = reconcileCrash(job, c4, 'digest-after')
  ok('④⑤ 提交失败需核对', r5.needsReconcile && r5.suggestedStatus === 'discarded')

  // 有 intent 有 receipt，提交成功但正文已变
  const r6 = reconcileCrash(job, c3, 'digest-changed')
  ok('④⑥ 提交成功但正文已变需核对', r6.needsReconcile && r6.suggestedStatus === 'applied')
}

// ───────────────── ⑤ 同章互斥：应用一份后另一份失效 ─────────────────
async function case5() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const c1 = mkCandidate({ id: 'c1', status: 'pending' })
  const c2 = mkCandidate({ id: 'c2', status: 'pending' })
  const c3 = mkCandidate({ id: 'c3', status: 'applied' })

  const all = [c1, c2, c3]
  const after = invalidateSiblings(all, 'c1')

  ok('⑤① 被应用的那份不被改动（状态由应用流程自己推进）', after.find(c => c.id === 'c1')?.status === 'pending')
  // 🔴 3.2.0 修正：同章另一份应标 **stale（基准失效）**，不是 discarded（作者主动放弃）。
  //    作者根本没看过它，记成"作者丢弃"会让复盘看到一堆他从未做过的决定。
  ok('⑤② 另一份 pending 变为 stale', after.find(c => c.id === 'c2')?.status === 'stale')
  ok('⑤② 失效原因写明"同章另一份候选已被应用"',
    (after.find(c => c.id === 'c2')?.staleReasons ?? []).join('').includes('另一份候选'))
  ok('⑤③ 已 applied 的不受影响', after.find(c => c.id === 'c3')?.status === 'applied')
}

// ───────────────── ⑥ 基准校验 ─────────────────
async function case6() {
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

  // 正文变化，但无关字段 → 可继续
  const r1 = checkBaseline(job, 'body-changed', 'outline-orig', 'settings-orig', 1)
  ok('⑥① 正文变化可继续', r1.ok && !r1.needsRerun && r1.bodyChanged)

  // 设定变化 → 需重跑
  const r2 = checkBaseline(job, 'body-orig', 'outline-orig', 'settings-changed', 1)
  ok('⑥② 设定变化需重跑', !r2.ok && r2.needsRerun && r2.settingsChanged)
  ok('⑥③ 设定变化步骤正确', r2.stepsToRerun.includes('设定审计'))

  // 章序变化 → 需重跑
  const r3 = checkBaseline(job, 'body-orig', 'outline-orig', 'settings-orig', 2)
  ok('⑥④ 章序变化需重跑', !r3.ok && r3.needsRerun && r3.chapterOrderChanged)
  ok('⑥⑤ 章序变化步骤正确', r3.stepsToRerun.includes('章序重排'))

  // 全部一致 → 通过
  const r4 = checkBaseline(job, 'body-orig', 'outline-orig', 'settings-orig', 1)
  ok('⑥⑥ 全部一致通过', r4.ok && !r4.needsRerun)
}

// ───────────────── ⑦ Diff 生成 ─────────────────
async function case7() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  // 完全相同
  const d1 = generateDiff('hello\nworld', 'hello\nworld')
  ok('⑦① 完全相同', d1.identical && d1.added === 0 && d1.removed === 0 && d1.changed === 0)

  // 新增行
  const d2 = generateDiff('hello', 'hello\nworld')
  ok('⑦② 新增行', !d2.identical && d2.added === 1 && d2.removed === 0)

  // 删除行
  const d3 = generateDiff('hello\nworld', 'hello')
  ok('⑦③ 删除行', !d3.identical && d3.added === 0 && d3.removed === 1)

  // 修改行
  const d4 = generateDiff('hello\nworld', 'hi\nworld')
  ok('⑦④ 修改行', !d4.identical && d4.changed === 1)

  // 空文本
  const d5 = generateDiff('', 'hello')
  ok('⑦⑤ 空文本新增', d5.added === 1 && d5.totalLines === 1)

  // 摘要
  const s1 = summarizeDiff(d1)
  ok('⑦⑥ 相同摘要', s1.text === '无变化' && s1.identical)

  const s2 = summarizeDiff(d2)
  ok('⑦⑦ 新增摘要', s2.text === '新增 1 行')

  const s3 = summarizeDiff(d3)
  ok('⑦⑧ 删除摘要', s3.text === '删除 1 行')

  // 统计
  const st1 = diffStats('a\nb', 'a\nb\nc')
  ok('⑦⑨ 统计正确', st1.added === 1 && st1.identical === false)
}

// ───────────────── ⑧ 字数变化 ─────────────────
async function case8() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  // 中文
  const w1 = wordChange('你好世界', '你好美丽的世界')
  ok('⑧① 中文字数增加', w1.beforeWords === 4 && w1.afterWords === 7 && w1.delta === 3)

  // 英文
  const w2 = wordChange('hello world', 'hello beautiful world')
  ok('⑧② 英文字数增加', w2.beforeWords === 2 && w2.afterWords === 3 && w2.delta === 1)

  // 中英混合
  const w3 = wordChange('Hello 世界', 'Hello 美丽的世界')
  ok('⑧③ 中英混合', w3.beforeWords === 3 && w3.afterWords === 6)

  // 空文本
  const w4 = wordChange('', 'hello')
  ok('⑧④ 空文本', w4.beforeWords === 0 && w4.afterWords === 1)

  // 无变化
  const w5 = wordChange('hello', 'hello')
  ok('⑧⑤ 无变化', w5.delta === 0 && w5.percent === 0)
}

// ───────────────── ⑨ 放弃与过期 ─────────────────
async function case9() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const c = mkCandidate({ id: 'c-discard', status: 'pending' })

  // 放弃
  const d1 = discardCandidate(c)
  ok('⑨① 放弃成功', d1.ok && d1.candidate?.status === 'discarded')

  // 过期
  const c2 = mkCandidate({ id: 'c-stale', status: 'pending' })
  const s1 = staleCandidate(c2)
  ok('⑨② 过期成功', s1.ok && s1.candidate?.status === 'stale')

  // 已 applied 不能放弃（非法转移）
  const c3 = mkCandidate({ id: 'c-applied', status: 'applied' })
  const d2 = discardCandidate(c3)
  ok('⑨③ applied 不能放弃', !d2.ok && d2.error?.includes('非法状态转移'))
}

// ───────────────── ⑩ 端到端：完整提交流程 ─────────────────
async function case10() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const job = mkJob({
    id: 'j-e2e',
    baseline: { bodyDigest: 'digest-orig', createdAt: Date.now() },
  })
  const payload = mkPayload({
    id: 'p-e2e',
    kind: 'candidate',
    jobId: 'j-e2e',
    candidateText: '这是候选正文',
    beforeText: '这是原文',
    summary: '端到端测试候选',
  })
  await saveRevisionJob(job)
  await saveRevisionPayload(payload)

  // 构建候选
  const c = buildCandidate(job, payload, 1)
  ok('⑩① 构建候选', c !== undefined)

  // 准备应用
  const prep = prepareApplyCandidate(job, c!, 'digest-orig')
  ok('⑩② 准备应用', prep.ok && prep.candidate?.status === 'applying')

  // 写盘失败由调用方通过回读摘要检测，不调用 completeApplyCandidate。
  // 本函数不校验 afterBodyDigest，只校验 candidate 状态。
  // 验证：非 applying 状态不能完成
  const cNotApplying = mkCandidate({ id: 'c-na', status: 'pending' })
  const compWrong = completeApplyCandidate(cNotApplying, 'digest-after')
  ok('⑩③ 非 applying 不能完成', !compWrong.ok && compWrong.error?.includes('不在 applying 状态'))

  // 模拟写盘成功
  const comp = completeApplyCandidate(prep.candidate!, 'digest-after')
  ok('⑩④ 写盘成功完成应用', comp.ok && comp.candidate?.status === 'applied')
  ok('⑩⑤ receipt 已写入', comp.receipt !== undefined)

  // 崩溃核对：有 intent 有 receipt，正文已变
  const r = reconcileCrash(job, comp.candidate!, 'digest-changed')
  ok('⑩⑥ 正文已变需核对', r.needsReconcile)
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
  console.log(`\nrevisionCandidate: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
