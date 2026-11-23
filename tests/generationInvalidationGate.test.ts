// ============ 候选按代次失效：3.7.0 已接线（原 3.6.1 · B3 记账的 gap 关闭）============
//
// `revision/generationInvalidation`（租约 / 代次 / 迟到回调）在 3.6.0 记账时是 `gap`，
// 3.6.1 起由下面两条活闸兜住；**3.7.0 · W2 把「基准过期」那一半真正接上了**：
// `revision/candidateExpiry` 从真实库取当前摘要，调 `isBaselineStale` / `expireCandidate`，
// 由 `revision/changeWatch` 在正文 / 细纲 / 设定变更后触发（见 tests/baselineWiring.test.ts）。
// 仍未接线的只剩「跨窗口同批租约」—— 桌面单窗口、网页当前单标签页，暂无触发场景。
// 下面两条活闸继续钉死：「同一个候选被两处同时改」的存在性防线。
//   ① `aiTaskCenter.startTask`：同页签同 kind 运行中时**拒绝第二次发起**（重复生成/重复改写）；
//   ② `candidateStore.saveCandidate` + `sameCandidateRevision`：面板拿的是旧版本时**拒绝写回**
//      （过期快照覆盖新候选 = 作者的修改与 Agent 的结果互相抹掉）。
// 缺的只有**跨窗口同批租约**，而桌面单窗口、网页当前按单标签页使用，暂无触发场景。
//
// 所以这个文件的定位是「**把现有两条闸钉死**」，不是"给未接线模块补覆盖率"：
// 将来真出现多窗口，先看这里 —— 这两条还绿，才说明租约是唯一缺口。
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'
import { captureOwnedOperation } from '../src/lib/storage/ownedOperation'
import { loadCandidate, sameCandidateRevision, saveCandidate } from '../src/lib/revision/candidateStore'
import type { RevisionCandidate } from '../src/lib/revision/revisionCandidate'
import { resetTaskCenter, runningTaskCount, startTask, tasksSnapshot } from '../src/lib/ai/aiTaskCenter'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const tick = () => new Promise<void>(r => setTimeout(r, 0))

const PROJECT = 'p-gate'
const mk = (over: Partial<RevisionCandidate> = {}): RevisionCandidate => ({
  id: 'cand-1', jobId: 'job-1', projectId: PROJECT, status: 'pending',
  text: '改后的正文', beforeText: '改前的正文', summary: '整章改写',
  bytes: 12, createdAt: 1000, updatedAt: 1000, generation: 1,
  ...over,
})

async function main() {
  // ---------- 闸 ①：同页签同类拒绝重复发起（重复生成 = 同一批候选被写两遍）----------
  {
    resetTaskCenter()
    // 用对象持有 resolve：`let` 变量在闭包里赋值不会被 TS 跟踪，会被收窄成 never
    const deferred: { release: () => void } = { release: () => undefined }
    const gate = new Promise<void>(resolve => { deferred.release = resolve })
    const first = startTask({ ownerTab: 'rewrite', kind: 'candidate', title: '生成候选', run: async () => gate })
    const dup = startTask({ ownerTab: 'rewrite', kind: 'candidate', title: '生成候选', run: async () => gate })
    ok('同页签同类运行中时第二次发起被拒', dup === null && first !== null)
    ok('只留一条任务记录', tasksSnapshot().length === 1 && runningTaskCount() === 1, JSON.stringify(tasksSnapshot()))
    deferred.release()
    await tick()
    ok('第一次的任务仍能正常收尾', tasksSnapshot()[0]?.status === 'done', JSON.stringify(tasksSnapshot()))
  }

  // ---------- 闸 ②-a：版本比较器（纯函数）----------
  {
    const base = mk()
    ok('完全一致时判为同一版本', sameCandidateRevision(base, mk()) === true)
    const mutated: [string, Partial<RevisionCandidate>][] = [
      ['id', { id: 'cand-2' }],
      ['jobId', { jobId: 'job-2' }],
      ['projectId', { projectId: 'p-other' }],
      ['chapterId', { chapterId: 'ch-9' }],
      ['status', { status: 'applied' }],
      ['updatedAt', { updatedAt: 1001 }],
      ['createdAt', { createdAt: 999 }],
      ['beforeText', { beforeText: '改前（被别的窗口改过）' }],
      ['text', { text: '改后（被别的窗口改过）' }],
      ['generation', { generation: 2 }],
      ['summary', { summary: '只改对话' }],
    ]
    for (const [name, patch] of mutated) {
      ok(`字段 ${name} 变了 ⇒ 判为不同版本`, sameCandidateRevision(base, mk(patch)) === false)
    }
    ok('意图变了 ⇒ 判为不同版本', sameCandidateRevision(base, mk({ intent: { operationId: 'op-9', jobId: 'job-1', submittedAt: 1, beforeBodyDigest: 'd', candidateId: 'cand-1' } })) === false)
    const receipt = { operationId: 'op-1', receivedAt: 5, afterBodyDigest: 'd2', ok: true }
    ok('回执变了 ⇒ 判为不同版本', sameCandidateRevision(base, mk({ receipt })) === false)
    ok('过期原因变了 ⇒ 判为不同版本', sameCandidateRevision(base, mk({ staleReasons: ['细纲变了'] })) === false)
    ok('关联检查变了 ⇒ 判为不同版本', sameCandidateRevision(base, mk({ checkPayloadIds: ['check-1'] })) === false)
    ok('缺省 intent 与显式 null 视为相同（老数据不会因此变"过期"）',
      sameCandidateRevision(base, { ...mk(), intent: null as unknown as RevisionCandidate['intent'] }) === true)
  }

  // ---------- 闸 ②-b：带 owner 的过期写回必须被拒 ----------
  {
    __resetMockStores()
    db.setCurrentProject(PROJECT)
    const owner = captureOwnedOperation(PROJECT)
    const original = mk()
    const created = await saveCandidate(original, owner, undefined, { create: true })
    ok('首次写入候选成功', created.ok === true, JSON.stringify(created))

    const stored = await loadCandidate(original.id, owner)
    ok('能读回刚写入的候选', stored?.text === original.text, JSON.stringify(stored))

    // 别人（另一个窗口）先改了这个候选
    const newer = await saveCandidate(mk({ text: '另一个窗口改过的正文', updatedAt: 2000 }), owner, stored ?? undefined)
    ok('更新时需要带上一版快照（正常路径）', newer.ok === true, JSON.stringify(newer))

    // 旧面板拿的还是最初那一版 → 必须拒绝，且不能把新内容盖掉
    let rejected = ''
    try {
      await saveCandidate(mk({ text: '旧面板想写回的正文' }), owner, original)
    } catch (e) { rejected = e instanceof Error ? e.message : String(e) }
    ok('用过期快照写回时明确拒绝', rejected.includes('候选已变化'), rejected)
    const after = await loadCandidate(original.id, owner)
    ok('被拒后候选内容仍是新版本（没有静默覆盖）', after?.text === '另一个窗口改过的正文', JSON.stringify(after))

    // 同一版快照重复提交是允许的（幂等重放，不该把正常保存也拦掉）
    const replay = await saveCandidate(mk({ text: '另一个窗口改过的正文', updatedAt: 2000 }), owner, after ?? undefined)
    ok('版本一致时重复提交不被拦（幂等重放）', replay.ok === true, JSON.stringify(replay))
  }

  // ---------- W2 接线闸（3.7.0）：过期函数的 src 消费者 + 事件类型有生产者 ----------
  {
    const fs = await import('node:fs')
    const expiry = fs.readFileSync('src/lib/revision/candidateExpiry.ts', 'utf8')
    const watch = fs.readFileSync('src/lib/revision/changeWatch.ts', 'utf8')
    ok('gap 关闭：isBaselineStale 有生产消费者（不再是零调用）', expiry.includes('isBaselineStale('))
    ok('gap 关闭：expireCandidate 有生产消费者', expiry.includes('expireCandidate('))
    ok('changeWatch 接到正文 / 细纲 / 设定三路变更', watch.includes('expireRevisionCandidatesForChapter') && watch.includes('expireRevisionCandidatesForProject'))
    ok('changeEvents 两类事件被真实构造（buildChangeEvidence → createChangeEvent）',
      fs.readFileSync('src/lib/revision/changeEvents.ts', 'utf8').includes('createChangeEvent(')
      && fs.readFileSync('src/lib/revision/changeWatch.ts', 'utf8').includes('buildChangeEvidence('))
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} generationInvalidationGate ${pass}/${pass + fail}`)
  if (fail) process.exitCode = 1
}

await main()
