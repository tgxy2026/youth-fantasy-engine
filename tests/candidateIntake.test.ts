// 3.2.0 · W3 候选生产入口 · 单测
//
// 盯一件之前**根本没人做**的事：整章改写的产出要真的被登记成候选。
//
// 为什么这条测试值得写：候选的存储、应用内核、审阅界面三块都齐了，却没有任何地方创建候选 ⇒
// 「候选审阅」永远空着，而空态写着"跑一次整章改写后，产出的稿子会先放在这里"。
// 那是**承诺了没交付**。本测试锁住这条链路，防止它再次退化成"界面在、生产者没有"。
//
// 另外四条联动（都是不写就会留下假状态的地方）：
//   ② 在创意写作页替换正文后，候选要变 `applied` —— 否则点第二次会把同一段正文覆盖两遍；
//   ③ 点「丢弃这次结果」后，候选要变 `discarded` —— 否则挂着作者刚否掉的稿子；
//   ④ 同章其它候选要变 `stale`（不是 discarded，作者没看过它们）；
//   ⑤ 存不下（超 256 KiB）时**如实返回失败**，不假装存了。
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { __resetMockStores } from './mock-memory'
import * as db from '@/lib/db'
import { setCurrentProject } from '@/lib/db/core'
import {
  recordRewriteCandidate, markCandidateApplied, markCandidateDiscarded, rewriteJobIdOf,
} from '@/lib/revision/candidateIntake'
import { loadCandidate, listProjectCandidates, listJobCandidates } from '@/lib/revision/candidateStore'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PID = 'w3-intake'
const CH = 'ch-intake-1'
const CH2 = 'ch-intake-2'
const BEFORE = '原始正文，句子比较啰嗦。'.repeat(6)
const AFTER = '改写正文，紧凑。'.repeat(6)

async function seedChapter(id: string, content: string, title: string) {
  // 🔴 章节按**当前项目**过滤 —— 不切过去，后面任何按章读写的判据都会拿到空值
  setCurrentProject(PID)
  await db.saveChapter({
    id, projectId: PID, title, content, summary: '', wordCount: content.length,
    createdAt: 1000, updatedAt: 1000, tags: [], status: 'draft',
  } as never)
}

async function main() {
  // ---------- 一、登记（生产入口本身） ----------
  __resetMockStores()
  await seedChapter(CH, BEFORE, '第一章')
  let candId = ''
  {
    const r = await recordRewriteCandidate({
      projectId: PID, chapterId: CH, text: AFTER, beforeText: BEFORE,
      summary: '润色：120 → 66 字', createdAt: 5000,
    })
    candId = r.candidateId ?? ''
    ok('① 登记成功并给出候选 id', r.ok === true && candId !== '', JSON.stringify(r))

    const c = candId ? await loadCandidate(candId) : null
    ok('① 候选状态是 pending（等作者决定，没有偷偷改正文）', c?.status === 'pending', c?.status)
    ok('① 改前/改后正文都存下了（应用时要拿改前比对）',
      c?.beforeText === BEFORE && c?.text === AFTER)
    ok('① 记了归属章节（应用的唯一落点依据）', c?.chapterId === CH)
    ok('① jobId 按章分（同章多稿归一组；跨章共用会把别章候选一起标过期）',
      c?.jobId === rewriteJobIdOf(CH) && c.jobId.includes(CH))
    ok('① 正文没被这次登记改动（登记 ≠ 应用）',
      (await db.getAllChapters()).find(x => x.id === CH)?.content === BEFORE)

    const list = await listProjectCandidates(PID, { onlyReviewable: true })
    ok('🔴 ① 它真的出现在「候选审阅」的待审阅列表里（这正是原来缺的一环）',
      list.some(x => x.id === candId), `列表 ${list.length} 份`)
  }

  // ---------- 二、替换正文后标 applied ----------
  {
    await seedChapter(CH, AFTER, '第一章')  // 模拟"替换该章正文"已写入
    const done = await markCandidateApplied(candId)
    ok('② 标记成功', done === true)
    const c = await loadCandidate(candId)
    ok('② 状态变 applied 且记了应用时间', c?.status === 'applied' && !!c?.appliedAt, c?.status)
    const reviewable = await listProjectCandidates(PID, { onlyReviewable: true })
    ok('🔴 ② 已应用的候选不再出现在待审阅列表（否则作者会再点一次把正文盖一遍）',
      !reviewable.some(x => x.id === candId))
    ok('② 再标一次返回 false（重复调用不改状态、不报错）',
      (await markCandidateApplied(candId)) === false)
  }

  // ---------- 三、丢弃后标 discarded ----------
  __resetMockStores()
  await seedChapter(CH2, BEFORE, '第二章')
  {
    const r = await recordRewriteCandidate({
      projectId: PID, chapterId: CH2, text: AFTER, beforeText: BEFORE, summary: '扩写',
    })
    const id = r.candidateId ?? ''
    ok('③ 登记成功', r.ok && id !== '')
    const done = await markCandidateDiscarded(id, '作者在创意写作页丢弃了这次结果')
    ok('③ 标记成功', done === true)
    const c = await loadCandidate(id)
    ok('③ 状态变 discarded 且留下理由（日后回看为什么丢）',
      c?.status === 'discarded' && (c?.discardedReason ?? '').includes('丢弃'), c?.status)
    const reviewable = await listProjectCandidates(PID, { onlyReviewable: true })
    ok('③ 丢弃的候选不在待审阅列表里', !reviewable.some(x => x.id === id))
  }

  // ---------- 四、同章多稿：应用一份，另一份变 stale ----------
  __resetMockStores()
  await seedChapter(CH, BEFORE, '第一章')
  {
    const a = await recordRewriteCandidate({
      projectId: PID, chapterId: CH, text: AFTER, beforeText: BEFORE, summary: '第一稿',
    })
    const b = await recordRewriteCandidate({
      projectId: PID, chapterId: CH, text: `${AFTER}\n\n又补了一段。`, beforeText: BEFORE, summary: '第二稿',
    })
    ok('④ 同章两份都登记成功（jobId 相同 ⇒ 互为 siblings）',
      a.ok && b.ok && (await listJobCandidates(rewriteJobIdOf(CH))).length === 2)

    await markCandidateApplied(a.candidateId!)
    const other = await loadCandidate(b.candidateId!)
    ok('🔴 ④ 另一份变 stale（不是 discarded —— 作者根本没看过它）',
      other?.status === 'stale', other?.status)
    ok('④ 并写明原因（"同章另一份候选已被应用"）',
      (other?.staleReasons ?? []).some(s => s.includes('另一份')), JSON.stringify(other?.staleReasons))
    ok('④ stale 的那份仍可读（正文没被删，作者想对比还在）',
      (other?.text ?? '').includes('又补了一段'))
  }

  // ---------- 五、存不下要如实失败 ----------
  __resetMockStores()
  await seedChapter(CH, BEFORE, '第一章')
  {
    // 256 KiB 上限：用超长正文触发（中文 3 字节/字）
    const huge = '巨'.repeat(100_000)
    const r = await recordRewriteCandidate({
      projectId: PID, chapterId: CH, text: huge, beforeText: huge, summary: '超大候选',
    })
    ok('🔴 ⑤ 超过 256 KiB ⇒ ok:false 并说明原因（不假装存了）',
      r.ok === false && !!r.detail, JSON.stringify(r))
    ok('⑤ 没有留下半份坏候选', (await listProjectCandidates(PID)).length === 0)
  }

  // ---------- 六、接线断言（这些破了不报错，只会悄悄失效） ----------
  {
    const root = process.cwd()
    const cs = readFileSync(path.join(root, 'src/lib/creative/creativeSession.ts'), 'utf8')
    ok('🔴 ⑥ 整章改写成功后登记候选', /recordRewriteCandidate\(/.test(cs))
    ok('🔴 ⑥ 先登记候选、再放开「替换」按钮（否则有空窗会让候选状态漏标）',
      cs.indexOf('recordRewriteCandidate(') < cs.indexOf('running: false, suspect'))
    ok('🔴 ⑥ 替换正文成功后标 applied', /markCandidateApplied\(/.test(cs))
    ok('🔴 ⑥ 丢弃这次结果时标 discarded', /markCandidateDiscarded\(/.test(cs))
    ok('⑥ 可疑结果不登记（界面已锁住替换，留候选只会误导）',
      /if \(!suspect\) \{[\s\S]{0,400}recordRewriteCandidate\(/.test(cs))

    const ui = readFileSync(path.join(root, 'src/components/creative/CreativeRewriteSection.tsx'), 'utf8')
    ok('⑥ 界面告诉作者"已登记到候选审阅"', ui.includes('候选审阅'))
    ok('⑥ 候选存不下时如实显示原因', ui.includes('candidateError'))

    const panel = readFileSync(path.join(root, 'src/components/revision/CandidatePanel.tsx'), 'utf8')
    // 🔴 实机 10-21 抓到：应用成功后该条离开列表，挂在条目上的提示会跟着消失 ⇒ 作者不知道成没成
    ok('🔴 ⑥ 结果提示渲染在列表外面（rows.map 之前），不会随条目被移除而消失',
      panel.indexOf('{note && (') < panel.indexOf('rows.map('),
      `note@${panel.indexOf('{note && (')} map@${panel.indexOf('rows.map(')}`)
    ok('⑥ 不再把结果提示挂在条目里', !/<li key=\{c\.id\}[\s\S]{0,900}note\?\.id === c\.id/.test(panel))
  }

  console.log(`\n▶ candidateIntake: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

__resetMockStores()
main().catch(e => {
  console.error(e)
  process.exit(1)
})
