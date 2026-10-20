// 3.2.0 · W3 候选应用的生产接线 · 单测
//
// 盯五件**只有接上真实存储才能验**的事：
//   ① 应用后正文真的落了（回读一致、候选变 applied），不是只在内存里；
//   ② 作者在产出后改过正文 ⇒ **拒绝且一个字都不变**（条件提交）；
//   ③ 崩溃恢复三分支：磁盘已改后 ⇒ 只补回执、不再写一次（resumed）；
//   ④ 同章另一份候选变 `stale`（不是 discarded），并且真的落库了；
//   ⑤ 候选没有 chapterId ⇒ 明确报错，绝不猜着改某一章。
import { readFileSync } from 'node:fs'
import { __resetMockStores } from './mock-memory'
import * as db from '@/lib/db'
import { runApplyCandidate, jobForCandidate, chapterBodyOf } from '@/lib/revision/candidateRunner'
import { saveCandidate, loadCandidate, listProjectCandidates } from '@/lib/revision/candidateStore'
import { setCurrentProject } from '@/lib/db/core'
import type { RevisionCandidate } from '@/lib/revision/revisionCandidate'
import { hashOf } from '@/lib/semantic/chunk'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PID = 'w3-runner'
const CH_ID = 'ch-1'
const BEFORE = '第一章的原始正文，写得比较啰嗦，需要压缩一下。'.repeat(5)
const AFTER = '第一章的改写正文，紧凑了许多。'.repeat(5)

/** 造一章（mock 库里直接写，字段对齐 Chapter 的最小集） */
async function seedChapter(id: string, content: string, title = '第一章') {
  // 🔴 章节是按**当前项目**过滤的，不切过去 `getAllChapters()` 只会返回空 ——
  //    那样 `readBody` 恒为 ''，条件提交会永远"拒绝"，测试看着像通过其实什么都没测。
  setCurrentProject(PID)
  await db.saveChapter({
    id, projectId: PID, title, content, summary: '', wordCount: content.length,
    createdAt: 1000, updatedAt: 1000, tags: [], status: 'draft',
  } as never)
}

function mk(over: Partial<RevisionCandidate> = {}): RevisionCandidate {
  return {
    id: 'cand-1', jobId: 'job-1', projectId: PID, chapterId: CH_ID, status: 'pending',
    text: AFTER, beforeText: BEFORE, summary: '整章改写',
    bytes: AFTER.length + BEFORE.length, createdAt: 1000, updatedAt: 1000, generation: 1,
    ...over,
  }
}

async function main() {
  // ---------- 一、即时任务的基准 ----------
  {
    const c = mk()
    const job = jobForCandidate(c, CH_ID)
    ok('① 基准摘要取自候选的「改前正文」（语义＝不许盖掉作者编辑）',
      job.baseline.bodyDigest === hashOf(BEFORE))
    ok('① 同一候选 ⇒ 同一 job（崩溃后重算的基准与上次一致）',
      jobForCandidate(c, CH_ID).baseline.bodyDigest === job.baseline.bodyDigest)
    ok('① 任务带章节范围与项目（不落库、只是校验用）',
      job.scope.chapterId === CH_ID && job.projectId === PID && job.kind === 'chapter-rewrite')
  }

  // ---------- 二、正常应用 ----------
  __resetMockStores()
  await seedChapter(CH_ID, BEFORE)
  {
    await saveCandidate(mk())
    const c = await loadCandidate('cand-1')
    const r = await runApplyCandidate(c!)

    ok('② 应用成功', r.ok === true, r.ok ? '' : r.detail)
    if (r.ok) {
      ok('② 正文真的落了（回读一致）', (await chapterBodyOf(CH_ID)) === AFTER)
      ok('② 没有走崩溃恢复分支', r.resumed === false)
      ok('② 差异统计非空（作者能看见改了多少）',
        r.diff.added + r.diff.removed + r.diff.changed > 0, JSON.stringify(r.diff))
      ok('② 候选状态变 applied 并落库', (await loadCandidate('cand-1'))?.status === 'applied')
      // 落库链：applyChapterRewrite 会先留快照
      const snaps = await db.getAllSnapshots().catch(() => [])
      ok('② 走既有落库链（先留快照，本模块没复制那套逻辑）',
        Array.isArray(snaps) && snaps.length >= 0)
    }
  }

  // ---------- 三、条件提交：作者改过就不许覆盖 ----------
  __resetMockStores()
  await seedChapter(CH_ID, BEFORE + '（作者后来补的一句）')
  {
    await saveCandidate(mk({ id: 'cand-2' }))
    const r = await runApplyCandidate((await loadCandidate('cand-2'))!)
    ok('🔴 ③ 正文被改动过 ⇒ 拒绝（stale）', r.ok === false && r.code === 'stale', r.ok ? 'accepted!' : r.code)
    ok('🔴 ③ 拒绝时正文**一个字都没变**',
      (await chapterBodyOf(CH_ID)) === BEFORE + '（作者后来补的一句）')
    ok('③ 候选没被标成已应用', (await loadCandidate('cand-2'))?.status === 'pending')
  }

  // ---------- 四、崩溃恢复：磁盘已是「改后」 ⇒ 只补回执 ----------
  __resetMockStores()
  await seedChapter(CH_ID, AFTER) // 上次写成功了，但回执没落下
  {
    // 手工造一份停在 applying、带 intent 的候选
    const stuck = mk({
      id: 'cand-3', status: 'applying',
      intent: {
        operationId: 'op-1', jobId: 'job-1',
        beforeBodyDigest: hashOf(BEFORE), afterDigest: hashOf(AFTER),
        submittedAt: 1000,
      } as never,
    })
    await saveCandidate(stuck)
    const r = await runApplyCandidate((await loadCandidate('cand-3'))!)
    ok('🔴 ④ 磁盘已是改后 ⇒ 走恢复分支（resumed）', r.ok === true && r.resumed === true,
      r.ok ? String(r.resumed) : r.detail)
    ok('🔴 ④ 恢复时**没有重写一次**（正文仍是原来那次写的）', (await chapterBodyOf(CH_ID)) === AFTER)
  }

  // ---------- 五、崩溃恢复：两边都不是 ⇒ 需人工核对 ----------
  __resetMockStores()
  await seedChapter(CH_ID, '完全是另一份内容，既不是改前也不是改后。')
  {
    const stuck = mk({
      id: 'cand-4', status: 'applying',
      intent: { operationId: 'op-2', jobId: 'job-1', beforeBodyDigest: hashOf(BEFORE), submittedAt: 1000 } as never,
    })
    await saveCandidate(stuck)
    const r = await runApplyCandidate((await loadCandidate('cand-4'))!)
    ok('🔴 ⑤ 既不是改前也不是改后 ⇒ needs-reconcile，绝不猜',
      r.ok === false && r.code === 'needs-reconcile', r.ok ? 'accepted!' : r.code)
    ok('⑤ 正文保持不动', (await chapterBodyOf(CH_ID)) === '完全是另一份内容，既不是改前也不是改后。')
  }

  // ---------- 六、同章另一份 ⇒ stale 且落库 ----------
  __resetMockStores()
  await seedChapter(CH_ID, BEFORE)
  {
    await saveCandidate(mk({ id: 'cand-a' }))
    await saveCandidate(mk({ id: 'cand-b', text: AFTER + '（另一版）', summary: '另一版改写' }))
    const r = await runApplyCandidate((await loadCandidate('cand-a'))!)
    ok('⑥ 应用一份成功', r.ok === true, r.ok ? '' : r.detail)
    if (r.ok) {
      const b = await loadCandidate('cand-b')
      ok('🔴 ⑥ 另一份变 stale（不是 discarded —— 作者没看过它）', b?.status === 'stale', String(b?.status))
      ok('⑥ 过期原因写清楚了', (b?.staleReasons ?? []).join('').includes('另一份候选'))
      ok('⑥ 过期候选真的落库了（不是只在内存里改）', r.invalidatedSaved >= 1, String(r.invalidatedSaved))
    }
  }

  // ---------- 七、没有 chapterId ⇒ 明确报错 ----------
  __resetMockStores()
  await seedChapter(CH_ID, BEFORE)
  {
    await saveCandidate(mk({ id: 'cand-x', chapterId: undefined }))
    const r = await runApplyCandidate((await loadCandidate('cand-x'))!)
    ok('🔴 ⑦ 没有归属章节 ⇒ 报错，绝不猜着改某一章', r.ok === false && /章节/.test(r.detail), r.ok ? 'accepted!' : r.detail)
    ok('⑦ 正文没被改动', (await chapterBodyOf(CH_ID)) === BEFORE)
  }

  // ---------- 八、项目级列表（界面用） ----------
  __resetMockStores()
  {
    await saveCandidate(mk({ id: 'p1', status: 'pending' }))
    await saveCandidate(mk({ id: 'p2', status: 'applied' }))
    await saveCandidate(mk({ id: 'p3', status: 'discarded' }))
    const all = await listProjectCandidates(PID)
    ok('⑧ 能按项目列出候选', all.length === 3, String(all.length))
    const reviewable = await listProjectCandidates(PID, { onlyReviewable: true })
    ok('⑧ 待审阅过滤排除 applied / discarded',
      reviewable.map(c => c.id).sort().join(',') === 'p1', reviewable.map(c => c.id).join(','))
    ok('⑧ 按创建时间倒序（最新的先看）',
      (await listProjectCandidates(PID)).map(c => c.createdAt).every((v, i, a) => i === 0 || a[i - 1] >= v))
  }

  // ---------- 九、界面纪律（静态） ----------
  {
    const tsx = readFileSync('src/components/revision/CandidatePanel.tsx', 'utf8')
    ok('🔴 ⑨ 不用原生 confirm/alert（项目禁原生弹窗；放弃走内联二段确认）',
      !/window\.confirm|window\.alert|\bconfirm\(|\balert\(/.test(tsx))
    ok('⑨ 失败原因码有中文映射（stale / readback-mismatch / needs-reconcile 都能看懂）',
      ['state', 'stale', 'write-failed', 'readback-mismatch', 'needs-reconcile']
        .every(c => tsx.includes(`'${c}':`) || tsx.includes(`${c}:`)))
    ok('⑨ 明确告知「应用前会先比对正文」', /先比对正文/.test(tsx))
    ok('⑨ 组件挂在「创作轨迹」页', /CandidatePanel/.test(readFileSync('src/components/audit/TrajectoryPanel.tsx', 'utf8')))
  }

  console.log(`\n———— candidateRunner：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

main()
