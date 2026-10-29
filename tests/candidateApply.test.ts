// 3.2.0 · W3 候选应用编排 · 单测
//
// 盯三件事（方案 §9.2 / §16.2）：
//   ① **条件提交**：正文/细纲被改过 ⇒ 直接拒绝，绝不覆盖作者的编辑；
//   ② **严格写盘**：回读内容与写入值不一致 ⇒ 报失败且**不写回执**（否则界面会显示"已应用"而磁盘没落）；
//   ③ **崩溃可恢复**：`applying` 候选再次进来时，按"磁盘到底是改前还是改后"决定补回执还是重写，
//      绝不重复写一遍正文。
import { applyCandidate, type CandidateApplyDeps } from '@/lib/revision/candidateApply'
import type { RevisionJob } from '@/lib/revision/jobTypes'
import type { RevisionCandidate } from '@/lib/revision/revisionCandidate'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PID = 'w3-apply'
const digest = (t: string) => `d:${t.length}:${t.slice(0, 8)}`

const BEFORE = '这是改前的正文，作者刚写完。'
const AFTER = '这是改后的正文，AI 改写完成并更紧凑。'

function mkJob(bodyDigest: string, outlineDigest?: string): RevisionJob {
  return {
    id: 'job-1', projectId: PID, kind: 'rewrite',
    scope: { chapterId: 'ch-1' },
    baseline: { bodyDigest, ...(outlineDigest ? { outlineDigest } : {}), at: 1 },
    status: 'running', createdAt: 1, updatedAt: 1,
  } as unknown as RevisionJob
}

function mkCandidate(over: Partial<RevisionCandidate> = {}): RevisionCandidate {
  return {
    id: 'cand-1', jobId: 'job-1', projectId: PID, status: 'pending',
    text: AFTER, beforeText: BEFORE, summary: '改写', bytes: AFTER.length,
    createdAt: 1, updatedAt: 1, generation: 1,
    ...over,
  }
}

/** 内存里的"磁盘"：写入/回读/持久化全部可观测 */
function mkDeps(init: { body: string; failWrite?: boolean; corruptReadBack?: string }) {
  const disk = { body: init.body }
  const persisted: RevisionCandidate[] = []
  let writes = 0
  const deps: CandidateApplyDeps = {
    readBody: async () => disk.body,
    writeBody: async (text) => {
      writes++
      if (init.failWrite) throw new Error('磁盘写满')
      disk.body = text
      return text
    },
    readBack: async () => (init.corruptReadBack !== undefined ? init.corruptReadBack : disk.body),
    persist: async (c) => { persisted.push({ ...c }) },
    digest,
  }
  const api = { deps, disk, persisted, writes: () => writes }
  return api
}

async function main() {
  for (const failAt of [1, 2]) {
    const t = mkDeps({ body: '' })
    let reads = 0
    t.deps.readBody = async () => { if (++reads === failAt) throw new Error('读取失败'); return '' }
    const r = await applyCandidate(mkJob(digest('')), mkCandidate({ beforeText: '' }), t.deps)
    ok(`读取第 ${failAt} 次失败时空基准也不能当作正常正文`, !r.ok && r.code === 'write-failed')
    ok(`读取第 ${failAt} 次失败不写正文、不保存提交意图`, t.writes() === 0 && t.persisted.length === 0)
  }
  // ---------- ① 正常应用 ----------
  {
    const t = mkDeps({ body: BEFORE })
    const job = mkJob(digest(BEFORE))
    const r = await applyCandidate(job, mkCandidate(), t.deps)
    ok('① 正常应用成功', r.ok === true, JSON.stringify(r).slice(0, 160))
    if (r.ok) {
      ok('① 磁盘上确实是候选内容', t.disk.body === AFTER)
      ok('① 只写了一次（没有重复写）', t.writes() === 1, String(t.writes()))
      ok('① 回执与意图配对（operationId 一致）',
        r.receipt.operationId === r.candidate.intent?.operationId)
      ok('① 候选状态为 applied', r.candidate.status === 'applied')
      ok('① 返回 diff 统计（作者要看改了多少）',
        r.diff.identical === false && (r.diff.changed + r.diff.added + r.diff.removed) > 0,
        JSON.stringify(r.diff))
      ok('① intent 与 applied 都落过盘（崩溃时能追踪）',
        t.persisted.some(c => c.status === 'applying') && t.persisted.some(c => c.status === 'applied'))
    }
  }

  // ---------- ② 条件提交：正文被改过 ----------
  {
    const t = mkDeps({ body: `${BEFORE}（作者又加了一句）` })
    const job = mkJob(digest(BEFORE)) // 基准是旧摘要
    const r = await applyCandidate(job, mkCandidate(), t.deps)
    ok('🔴 ② 正文已变 ⇒ 拒绝（不覆盖作者编辑）', !r.ok && r.code === 'stale', JSON.stringify(r))
    ok('🔴 ② 一个字都没写', t.writes() === 0, String(t.writes()))
    ok('② 磁盘仍是作者的内容', t.disk.body.includes('作者又加了一句'))
    ok('② 失败原因说人话（正文已变化）', !r.ok && r.detail.includes('正文已变化'), !r.ok ? r.detail : '')
  }

  // ---------- ③ 严格写盘：回读不一致 ----------
  {
    const t = mkDeps({ body: BEFORE, corruptReadBack: '别的东西' })
    const job = mkJob(digest(BEFORE))
    const r = await applyCandidate(job, mkCandidate(), t.deps)
    ok('🔴 ③ 回读与写入不一致 ⇒ 失败（不报绿）', !r.ok && r.code === 'readback-mismatch', JSON.stringify(r))
    const last = t.persisted[t.persisted.length - 1]
    ok('🔴 ③ 候选停在 applying 且留着 intent（崩溃核对靠它）',
      last?.status === 'applying' && Boolean(last?.intent), JSON.stringify(last?.status))
    ok('🔴 ③ 绝不写回执（没写成就不许说成功）', !last?.receipt)
  }

  // ---------- ④ 写盘本身失败 ----------
  {
    const t = mkDeps({ body: BEFORE, failWrite: true })
    const job = mkJob(digest(BEFORE))
    const r = await applyCandidate(job, mkCandidate(), t.deps)
    ok('④ 写盘异常 ⇒ write-failed（不是"成功"也不是"过期"）', !r.ok && r.code === 'write-failed',
      JSON.stringify(r))
    ok('④ 磁盘未被改动', t.disk.body === BEFORE)
  }

  // ---------- ⑤ 崩溃恢复：上次写成功了，只差回执 ----------
  {
    const t = mkDeps({ body: AFTER }) // 磁盘已经是"改后"
    const job = mkJob(digest(BEFORE))
    const applying = mkCandidate({
      status: 'applying',
      intent: {
        operationId: 'op-1', jobId: 'job-1', submittedAt: 1,
        beforeBodyDigest: digest(BEFORE), candidateId: 'cand-1',
      },
    })
    const r = await applyCandidate(job, applying, t.deps)
    ok('🔴 ⑤ 磁盘已是改后 ⇒ 补回执而不是再写一次', r.ok === true && r.resumed === true, JSON.stringify(r).slice(0, 160))
    ok('🔴 ⑤ 没有重复写盘', t.writes() === 0, String(t.writes()))
    if (r.ok) ok('⑤ 回执与旧意图配对', r.receipt.operationId === 'op-1')
  }

  // ---------- ⑥ 崩溃恢复：上次没写成，正常补写 ----------
  {
    const t = mkDeps({ body: BEFORE }) // 磁盘还是改前
    const job = mkJob(digest(BEFORE))
    const applying = mkCandidate({
      status: 'applying',
      intent: {
        operationId: 'op-2', jobId: 'job-1', submittedAt: 1,
        beforeBodyDigest: digest(BEFORE), candidateId: 'cand-1',
      },
    })
    const r = await applyCandidate(job, applying, t.deps)
    ok('⑥ 磁盘还是改前 ⇒ 正常写一次', r.ok === true && r.resumed === false, JSON.stringify(r).slice(0, 160))
    ok('⑥ 这次写了一次', t.writes() === 1, String(t.writes()))
    ok('⑥ 磁盘变成候选内容', t.disk.body === AFTER)
  }

  // ---------- ⑦ 崩溃恢复：两边都不是 ----------
  {
    const t = mkDeps({ body: '作者在崩溃后又改过的第三版' })
    const job = mkJob(digest(BEFORE))
    const applying = mkCandidate({
      status: 'applying',
      intent: {
        operationId: 'op-3', jobId: 'job-1', submittedAt: 1,
        beforeBodyDigest: digest(BEFORE), candidateId: 'cand-1',
      },
    })
    const r = await applyCandidate(job, applying, t.deps)
    ok('🔴 ⑦ 既不是改前也不是改后 ⇒ 判"需核对"，绝不猜', !r.ok && r.code === 'needs-reconcile', JSON.stringify(r))
    ok('⑦ 同样一个字都没写', t.writes() === 0)
    ok('⑦ 告知可能被编辑过', !r.ok && r.detail.includes('编辑'), !r.ok ? r.detail : '')
  }

  // ---------- ⑧ 状态守卫 + 同章候选失效 ----------
  {
    const t = mkDeps({ body: BEFORE })
    const job = mkJob(digest(BEFORE))
    const r = await applyCandidate(job, mkCandidate({ status: 'applied' }), t.deps)
    ok('⑧ 已应用的候选不能再应用', !r.ok && r.code === 'state', JSON.stringify(r))

    const t2 = mkDeps({ body: BEFORE })
    const deps2: CandidateApplyDeps = {
      ...t2.deps,
      siblings: [
        mkCandidate({ id: 'cand-2', status: 'pending' }),
        mkCandidate({ id: 'cand-3', status: 'applied' }),
      ],
    }
    const r2 = await applyCandidate(job, mkCandidate(), deps2)
    ok('⑧ 应用成功后同章另一份候选失效', r2.ok === true && r2.invalidated.some(c => c.id === 'cand-2' && c.status === 'stale'),
      r2.ok ? JSON.stringify(r2.invalidated.map(c => [c.id, c.status])) : '')
    ok('⑧ 已应用的兄弟不被改动', r2.ok === true && r2.invalidated.some(c => c.id === 'cand-3' && c.status === 'applied'))
  }

  // ---------- ⑨ 细纲条件提交 ----------
  {
    const t = mkDeps({ body: BEFORE })
    const deps: CandidateApplyDeps = { ...t.deps, readOutlineDigest: async () => 'outline-new' }
    const job = mkJob(digest(BEFORE), 'outline-old')
    const r = await applyCandidate(job, mkCandidate(), deps)
    ok('🔴 ⑨ 细纲变了同样拒绝（正文变了但细纲也变了，候选依据已过期）',
      !r.ok && r.code === 'stale', JSON.stringify(r))
    ok('⑨ 原因写明细纲', !r.ok && r.detail.includes('细纲'), !r.ok ? r.detail : '')
  }

  // ---------- ⑩ 提交意图保存失败时，正文必须完全不动 ----------
  {
    const t = mkDeps({ body: BEFORE })
    t.deps.persist = async () => { throw new Error('候选载荷写盘失败') }
    let r
    try { r = await applyCandidate(mkJob(digest(BEFORE)), mkCandidate(), t.deps) }
    catch { /* 不能吞意图失败后继续改正文，也不能只抛最后一次写回执的错误 */ }
    ok('⑩ 意图未落盘 ⇒ 明确返回写入失败', r?.ok === false && r.code === 'write-failed')
    ok('⑩ 没有恢复依据时绝不开始替换正文', t.writes() === 0 && t.disk.body === BEFORE)
    ok('⑩ 失败仍返回原候选，可在恢复存储后重试', r?.ok === false && r.candidate.status === 'pending')
  }

  // ---------- ⑪ 正文已写但回执失败：保留 applying，重试只补回执 ----------
  {
    const t = mkDeps({ body: BEFORE })
    const persist = t.deps.persist
    t.deps.persist = async c => {
      if (c.status === 'applied') throw new Error('回执写盘失败')
      await persist(c)
    }
    let result
    try { result = await applyCandidate(mkJob(digest(BEFORE)), mkCandidate(), t.deps) }
    catch { /* 下方断言要求返回明确的恢复状态，不能只抛异常 */ }
    ok('⑪ 回执失败返回需核对状态', result?.ok === false && result.code === 'needs-reconcile')
    ok('⑪ 已写正文保留且 intent 仍在', t.disk.body === AFTER && t.persisted.at(-1)?.status === 'applying')
    if (result && !result.ok) {
      const stillFailed = await applyCandidate(mkJob(digest(BEFORE)), result.candidate, t.deps)
      ok('⑪ 恢复时回执仍写不成也如实返回需核对', !stillFailed.ok && stillFailed.code === 'needs-reconcile')
      ok('⑪ 重复回执失败不会重复替换正文', t.writes() === 1)
      t.deps.persist = persist
      const resumed = await applyCandidate(mkJob(digest(BEFORE)), result.candidate, t.deps)
      ok('⑪ 重试只补回执，不重复替换正文', resumed.ok && resumed.resumed && t.writes() === 1)
    }
  }

  console.log(`\n———— candidateApply：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

main()
