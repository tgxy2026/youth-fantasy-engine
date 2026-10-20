// 3.2.0 · W3 候选存储 · 单测
//
// 盯四件事（方案 §9.2「工作产物分层」+ 严格写盘）：
//   ① 候选正文与元数据装在同一份载荷里，能原样往返（含 intent / receipt / staleReasons）；
//   ② **不猜**：报告载荷 / 缺元数据的载荷不会被当成候选读出来（否则界面会显示不存在的候选）；
//   ③ 单份 > 256 KiB **拒绝不截断**（截断的候选等于废稿）；
//   ④ 配额：单项目 200 份、总量 32 MiB，超限明确报错。
import { __resetMockStores } from './mock-memory'
import {
  saveCandidate, loadCandidate, listJobCandidates, listApplicableCandidates, deleteCandidate,
  candidateToPayload, payloadToCandidate,
} from '@/lib/revision/candidateStore'
import type { RevisionCandidate } from '@/lib/revision/revisionCandidate'
import { saveRevisionPayload } from '@/lib/db/revisionJobs'
import { MAX_PAYLOAD_BYTES } from '@/lib/revision/jobTypes'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PID = 'w3-store'

function mk(over: Partial<RevisionCandidate> = {}): RevisionCandidate {
  return {
    id: 'cand-1', jobId: 'job-1', projectId: PID, status: 'pending',
    text: '改后的正文，比较紧凑。', beforeText: '改前的正文，比较啰嗦一些。',
    summary: '整章改写', bytes: 30, createdAt: 1000, updatedAt: 1000, generation: 1,
    ...over,
  }
}

async function main() {
  // ---------- ① 往返 ----------
  __resetMockStores()
  {
    const c = mk({
      intent: { operationId: 'op-1', jobId: 'job-1', submittedAt: 1001, beforeBodyDigest: 'd1', candidateId: 'cand-1' },
      staleReasons: ['细纲变了'],
      checkPayloadIds: ['check-1'],
    })
    const saved = await saveCandidate(c)
    ok('① 存盘成功', saved.ok === true, JSON.stringify(saved))

    const back = await loadCandidate(c.id)
    ok('① 正文往返一致', back?.text === c.text && back?.beforeText === c.beforeText)
    ok('① 元数据往返一致（状态/意图/过期原因/关联检查）',
      back?.status === 'pending' && back?.intent?.operationId === 'op-1'
      && (back?.staleReasons ?? []).join('') === '细纲变了'
      && (back?.checkPayloadIds ?? []).join('') === 'check-1',
      JSON.stringify(back))
    ok('① 字节数按 UTF-8 计（中文 3 字节，不是字符数）',
      saved.ok === true && saved.bytes > c.text.length, saved.ok ? String(saved.bytes) : '')
  }

  // ---------- ② 不猜：错种类的载荷 ----------
  __resetMockStores()
  {
    const candidate = mk()
    // 报告载荷（同 id 不同 kind）
    await saveRevisionPayload({
      id: 'rep-1', projectId: PID, kind: 'report', jobId: 'job-1',
      report: { status: 'applied' }, summary: '检查报告', bytes: 10, createdAt: 1,
    })
    ok('🔴 ② 报告载荷不会被当成候选（kind 不符 ⇒ null）', (await loadCandidate('rep-1')) === null)

    // 缺 report 元数据的候选载荷
    await saveRevisionPayload({
      id: 'cand-bad', projectId: PID, kind: 'candidate', jobId: 'job-1',
      beforeText: 'a', candidateText: 'b', summary: 's', bytes: 2, createdAt: 1,
    })
    ok('🔴 ② 缺元数据的候选载荷不猜（返回 null，而不是编一个 pending）',
      (await loadCandidate('cand-bad')) === null)

    ok('② 纯函数层同样拒绝（payloadToCandidate）',
      payloadToCandidate({
        id: 'x', projectId: PID, kind: 'report', jobId: 'j', summary: 's', bytes: 1, createdAt: 1,
      }) === null)
    ok('② 正常候选能转换', Boolean(payloadToCandidate(candidateToPayload(candidate))))
  }

  // ---------- ③ 单份上限：拒绝不截断 ----------
  __resetMockStores()
  {
    const huge = '字'.repeat(Math.ceil(MAX_PAYLOAD_BYTES / 3) + 10) // 中文 3 字节/字
    const r = await saveCandidate(mk({ id: 'cand-huge', text: huge }))
    ok('🔴 ③ 超过 256 KiB ⇒ 拒绝（too-large）', !r.ok && r.code === 'too-large', JSON.stringify(r))
    ok('🔴 ③ 磁盘上没留下半截候选（不截断）', (await loadCandidate('cand-huge')) === null)
    ok('③ 错误信息给出实际字节与上限', !r.ok && r.detail.includes('256'), !r.ok ? r.detail : '')
  }

  // ---------- ④ 配额：条数 ----------
  __resetMockStores()
  {
    for (let i = 0; i < 200; i++) {
      const r = await saveCandidate(mk({ id: `bulk-${i}`, text: `第 ${i} 份候选` }))
      if (!r.ok) { ok(`④ 第 ${i + 1} 份就失败（不该）`, false, JSON.stringify(r)); break }
    }
    const over = await saveCandidate(mk({ id: 'bulk-over', text: '第 201 份' }))
    ok('🔴 ④ 超过 200 份 ⇒ 拒绝（quota-count）', !over.ok && over.code === 'quota-count', JSON.stringify(over))
    ok('④ 提示先清理旧候选', !over.ok && over.detail.includes('清理'), !over.ok ? over.detail : '')
    // 覆盖同一份不算新增
    const replace = await saveCandidate(mk({ id: 'bulk-0', text: '第 0 份候选（更新）' }))
    ok('④ 覆盖已有候选不触发配额', replace.ok === true, JSON.stringify(replace))
  }

  // ---------- ⑤ 列表：按任务取、按时间排、可应用筛选 ----------
  __resetMockStores()
  {
    await saveCandidate(mk({ id: 'a1', jobId: 'job-A', createdAt: 300, status: 'pending' }))
    await saveCandidate(mk({ id: 'a2', jobId: 'job-A', createdAt: 100, status: 'applied' }))
    await saveCandidate(mk({ id: 'a3', jobId: 'job-A', createdAt: 200, status: 'applying' }))
    await saveCandidate(mk({ id: 'b1', jobId: 'job-B', createdAt: 50, status: 'pending' }))

    const a = await listJobCandidates('job-A')
    ok('⑤ 按任务取，不串任务', a.length === 3 && a.every(c => c.jobId === 'job-A'), String(a.length))
    ok('⑤ 按创建时间升序（界面"第几稿"天然有序）',
      a.map(c => c.id).join(',') === 'a2,a3,a1', a.map(c => c.id).join(','))

    const applicable = await listApplicableCandidates('job-A')
    ok('⑤ 可应用 = pending + applying（崩溃恢复那一路也算）',
      applicable.map(c => c.id).sort().join(',') === 'a1,a3', applicable.map(c => c.id).join(','))
    ok('⑤ 已应用的候选不再出现在可应用列表', !applicable.some(c => c.id === 'a2'))
  }

  // ---------- ⑥ 删除 ----------
  __resetMockStores()
  {
    await saveCandidate(mk({ id: 'del-1' }))
    await deleteCandidate('del-1')
    ok('⑥ 删除后读不到（不是残留空壳）', (await loadCandidate('del-1')) === null)
    ok('⑥ 删除不抛（幂等）', await deleteCandidate('del-1').then(() => true, () => false))
  }

  console.log(`\n———— candidateStore：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

main()
