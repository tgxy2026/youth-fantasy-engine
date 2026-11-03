// ============ 3.2.0 · W2 工作产物存储 ============
//
// 钉住：
//   ① revisionJobs 是项目级元数据 —— 随项目走，导出项目时带走、删项目时一并清理。
//   ② revisionPayloads 是本地专属 —— 不参与云盘同步（见 syncCore.LOCAL_ONLY_STORES）。
//   ③ IDB 13→14 迁移：建表 + 索引。
//   ④ 严格写盘：写入成功并回读摘要一致后才发布元数据引用。
//   ⑤ 容量约束：每批最多 20 章；每项目最多 5 个未结束批次、200 个载荷、总载荷 32 MiB。

import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'
import { ops } from '../src/lib/db/core'
import { getRevisionJob, listProjectRevisionJobs, listActiveRevisionJobs, saveRevisionJob, deleteRevisionJob, deleteRevisionJobWithCleanup, getRevisionPayload, saveRevisionPayload, deleteRevisionPayload } from '../src/lib/db/revisionJobs'
import { candidateToPayload, reclaimStaleCandidates } from '../src/lib/revision/candidateStore'
import { MAX_BATCH_CHAPTERS, MAX_PAYLOAD_BYTES, MAX_PAYLOADS_PER_PROJECT, MAX_PAYLOAD_TOTAL_BYTES, MAX_ACTIVE_BATCHES } from '../src/lib/revision/jobTypes'
import type { RevisionJob, RevisionPayload, RevisionJobStatus } from '@/lib/revision/jobTypes'
import { uid } from '@/lib/app/id'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const PID = 'p-w2-storage'

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

// ───────────────── ① CRUD：revisionJobs ─────────────────
async function case1() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const job = mkJob({ id: 'j1' })
  await saveRevisionJob(job)

  const got = await getRevisionJob('j1')
  ok('① 任务写入后可读取', got?.id === 'j1', JSON.stringify(got))
  ok('① 任务 projectId 正确', got?.projectId === PID, JSON.stringify(got?.projectId))

  const list = await listProjectRevisionJobs(PID)
  ok('① 按项目列出任务', list.length === 1, JSON.stringify(list.length))

  const updated = mkJob({ id: 'j1', status: 'running' as RevisionJobStatus, updatedAt: Date.now() })
  await saveRevisionJob(updated)
  const after = await getRevisionJob('j1')
  ok('① 任务更新后状态生效', after?.status === 'running', JSON.stringify(after?.status))

  await deleteRevisionJob('j1')
  const gone = await getRevisionJob('j1')
  ok('① 任务删除后不可读', gone === undefined, JSON.stringify(gone))
}

// ───────────────── ② 未结束任务筛选 ─────────────────
async function case2() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const activeStatuses: RevisionJobStatus[] = ['running', 'awaiting-review', 'paused', 'interrupted']
  const doneStatuses: RevisionJobStatus[] = ['completed', 'failed', 'cancelled']

  for (let i = 0; i < 4; i++) {
    await saveRevisionJob(mkJob({ id: `j-a${i}`, status: activeStatuses[i] }))
  }
  for (let i = 0; i < 3; i++) {
    await saveRevisionJob(mkJob({ id: `j-d${i}`, status: doneStatuses[i] }))
  }

  const active = await listActiveRevisionJobs(PID)
  ok('② 未结束任务筛选正确', active.length === 4, JSON.stringify(active.map(j => j.id)))
  ok('② 已结束任务不计入', active.every(j => activeStatuses.includes(j.status)), JSON.stringify(active.map(j => j.status)))
}

// ───────────────── ③ CRUD：revisionPayloads ─────────────────
async function case3() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const payload = mkPayload({ id: 'p1', summary: '测试候选摘要', bytes: 200 })
  await saveRevisionPayload(payload)

  const got = await getRevisionPayload('p1')
  ok('③ 载荷写入后可读取', got?.id === 'p1', JSON.stringify(got))
  ok('③ 载荷摘要正确', got?.summary === '测试候选摘要', JSON.stringify(got?.summary))
  ok('③ 载荷字节数正确', got?.bytes === 200, JSON.stringify(got?.bytes))

  await deleteRevisionPayload('p1')
  const gone = await getRevisionPayload('p1')
  ok('③ 载荷删除后不可读', gone === undefined, JSON.stringify(gone))
}

// ───────────────── ④ 任务-载荷关联 ─────────────────
async function case4() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const job = mkJob({ id: 'j-job' })
  const payload = mkPayload({ id: 'p-payload', jobId: 'j-job' })

  await saveRevisionJob(job)
  await saveRevisionPayload(payload)

  const j = await getRevisionJob('j-job')
  const p = await getRevisionPayload('p-payload')
  ok('④ 任务与载荷可独立读取', j !== undefined && p !== undefined, JSON.stringify({ j: j?.id, p: p?.id }))
  ok('④ 载荷关联任务 ID 正确', p?.jobId === 'j-job', JSON.stringify(p?.jobId))

  // 按 jobId 索引查询（通过 getAll 后过滤，因 ops.getAllByIndex 需 store 支持）
  const allPayloads = await ops.getAll<RevisionPayload>('revisionPayloads')
  const forJob = allPayloads.filter(p => p.jobId === 'j-job')
  ok('④ 按 jobId 过滤载荷', forJob.length === 1, JSON.stringify(forJob.length))
}

// ───────────────── ⑤ 候选载荷回收（配额只增不减的修复）─────────────────
//
// 3.2.1 之前：候选的存储形态就是载荷，放弃 / 应用 / 过期都不删载荷，
// 而唯一能删的 deleteCandidate 与 cleanupOrphanPayloads 都零调用
// ⇒ 攒满 200 份后新候选永远存不进来（提示「请先清理旧候选」也无从下手）。
// 现在由 reclaimStaleCandidates 按「终态 + 超龄」回收，这里钉住它的两条边界。
async function case5() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const DAY = 24 * 60 * 60 * 1000
  const now = Date.now()
  const mkCand = (id: string, status: 'pending' | 'applied' | 'discarded', createdAt: number) =>
    candidateToPayload({
      id, jobId: `j-${id}`, projectId: PID, status,
      text: `候选正文 ${id}`, beforeText: `改前 ${id}`, summary: '摘要',
      bytes: 16, createdAt, updatedAt: createdAt, generation: 1,
    })

  // 超龄 40 天（> 30 天宽限）
  await saveRevisionPayload(mkCand('c-old-discarded', 'discarded', now - 40 * DAY))
  await saveRevisionPayload(mkCand('c-old-pending', 'pending', now - 40 * DAY))
  // 未超龄（1 天）
  await saveRevisionPayload(mkCand('c-new-applied', 'applied', now - 1 * DAY))

  const reclaimed = await reclaimStaleCandidates(PID, now)
  ok('⑤ 只回收「终态 + 超龄」的那一份', reclaimed === 1, JSON.stringify(reclaimed))
  ok('⑤ 超龄已放弃 → 已删', await getRevisionPayload('c-old-discarded') === undefined)
  ok('🔴 超龄但待审 → 一份都不许动', await getRevisionPayload('c-old-pending') !== undefined)
  ok('⑤ 已应用但未超龄 → 留着（宽限期内可回看）', await getRevisionPayload('c-new-applied') !== undefined)

  // 幂等：再跑一次不应再删（可删的已经删完）
  ok('⑤ 再跑一次回收 0 份（幂等）', (await reclaimStaleCandidates(PID, now)) === 0)
}

// ───────────────── ⑥ 容量常量 ─────────────────
async function case6() {
  ok('⑥ 每批最多章节数', MAX_BATCH_CHAPTERS === 20, String(MAX_BATCH_CHAPTERS))
  ok('⑥ 单载荷最大字节数', MAX_PAYLOAD_BYTES === 256 * 1024, String(MAX_PAYLOAD_BYTES))
  ok('⑥ 每项目最多载荷数', MAX_PAYLOADS_PER_PROJECT === 200, String(MAX_PAYLOADS_PER_PROJECT))
  ok('⑥ 总载荷最大字节数', MAX_PAYLOAD_TOTAL_BYTES === 32 * 1024 * 1024, String(MAX_PAYLOAD_TOTAL_BYTES))
  ok('⑥ 最多未结束批次', MAX_ACTIVE_BATCHES === 5, String(MAX_ACTIVE_BATCHES))
}

// ───────────────── ⑦ 项目隔离 ─────────────────
async function case7() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const job1 = mkJob({ id: 'j-p1', projectId: PID })
  await saveRevisionJob(job1)

  // 切换到另一个项目
  const PID2 = 'p-w2-storage-2'
  await db.setCurrentProject(PID2)
  const job2 = mkJob({ id: 'j-p2', projectId: PID2 })
  await saveRevisionJob(job2)

  const list1 = await listProjectRevisionJobs(PID)
  const list2 = await listProjectRevisionJobs(PID2)
  ok('⑦ 项目1只看到自己的任务', list1.length === 1 && list1[0].id === 'j-p1', JSON.stringify(list1.map(j => j.id)))
  ok('⑦ 项目2只看到自己的任务', list2.length === 1 && list2[0].id === 'j-p2', JSON.stringify(list2.map(j => j.id)))
}

// ───────────────── ⑧ 任务级联删除 ─────────────────
async function case8() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const job = mkJob({ id: 'j-cascade' })
  const payload = mkPayload({ id: 'p-cascade', jobId: 'j-cascade' })

  await saveRevisionJob(job)
  await saveRevisionPayload(payload)

  await deleteRevisionJobWithCleanup('j-cascade', 'p-cascade')

  const j = await getRevisionJob('j-cascade')
  const p = await getRevisionPayload('p-cascade')
  ok('⑧ 任务删除后不可读', j === undefined, JSON.stringify(j))
  ok('⑧ 载荷不立即删除（由清理器回收）', p !== undefined, JSON.stringify(p?.id))
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
  console.log(`\nrevisionStorage: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
