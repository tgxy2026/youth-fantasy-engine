// 3.0 · W1-1 运行账本 ＋ 版本保护 · 单测
//
// 盯两件事：
//   ① **版本保护判据**（纯函数）：基准怎么采、什么情况下判「候选已过期」——
//      这条错了就是「旧候选静默覆盖作者编辑」，属于最该钉死的一类。
//   ② **账本读写**（走 mock 存储）：任务级记录能建/改/收尾/查/删，且不串项目。
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'
import {
  chapterFingerprint, computeBasis, checkBasisStale,
  createRun, patchRun, finishRun, appendRunCall, makeCandidateRef,
} from '../src/lib/aiRunLedger'
import { getAiRun, listProjectAiRuns, listRecentAiRuns, deleteAiRun } from '../src/lib/db'
import type { Chapter } from '../src/lib/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PID = 'airun-test-proj'

function mkChapter(id: string, content: string, updatedAt: number): Chapter {
  return {
    id, projectId: PID, volumeId: 'v1', order: 0, title: '第 1 章',
    content, summary: '', status: 'draft', wordCount: content.length, createdAt: 0, updatedAt,
  } as unknown as Chapter
}

async function main() {
  console.log('\n—— aiRunLedger 用例开始 ——')

  // ---------- 一、章级指纹 ----------
  {
    const a = mkChapter('c1', '正文甲', 1000)
    const b = mkChapter('c1', '正文甲', 1000)
    const c = mkChapter('c1', '正文甲', 2000) // 只动 updatedAt
    const d = mkChapter('c1', '正文乙', 1000) // 只动正文
    ok('同内容同 time → 指纹一致', chapterFingerprint(a) === chapterFingerprint(b))
    ok('🔴 只改 updatedAt → 指纹变（改回原样也要重确认）', chapterFingerprint(a) !== chapterFingerprint(c))
    ok('正文变 → 指纹变', chapterFingerprint(a) !== chapterFingerprint(d))
  }

  // ---------- 二、基准采集 ----------
  {
    const ch = mkChapter('cA', '甲', 100)
    const basis = computeBasis([ch], 7, 5000)
    ok('computeBasis 记 at', basis.at === 5000)
    ok('computeBasis 记 settingsRev', basis.settingsRev === 7)
    ok('computeBasis 记章指纹', basis.chapters?.length === 1 && basis.chapters[0].chapterId === 'cA')
  }

  // ---------- 三、失效判定 ----------
  {
    const chA = mkChapter('cA', '甲', 100)
    const basis = computeBasis([chA], 7, 5000)
    const same = new Map([['cA', chapterFingerprint(chA)]])

    ok('未改动 → 不失效', checkBasisStale(basis, { chapters: same, settingsRev: 7 }).stale === false)

    const r1 = checkBasisStale(basis, { chapters: new Map([['cA', 'deadbeef-1']]), settingsRev: 7 })
    ok('章改动 → 失效', r1.stale === true)
    ok('原因含「正文已被改动」', r1.reasons.some(x => x.includes('正文已被改动')))

    const r2 = checkBasisStale(basis, { chapters: new Map(), settingsRev: 7 })
    ok('涉及章被删 → 失效', r2.stale === true)
    ok('原因含「已被删除」', r2.reasons.some(x => x.includes('已被删除')))

    const r3 = checkBasisStale(basis, { chapters: same, settingsRev: 8 })
    ok('设定戳变 → 失效', r3.stale === true)
    ok('原因含「上游设定」', r3.reasons.some(x => x.includes('上游设定')))

    // 拿不到设定戳的一侧不参与比对（不误报）
    const noRev = computeBasis([chA], null, 5000)
    ok('基准无设定戳 → 不比设定', checkBasisStale(noRev, { chapters: same, settingsRev: 999 }).stale === false)
    ok('当前无设定戳 → 不比设定', checkBasisStale(basis, { chapters: same, settingsRev: null }).stale === false)

    // 多重失配去重
    const multi = checkBasisStale(computeBasis([chA], 7, 1), {
      chapters: new Map([['cA', 'x'], ['cA2', 'y']]), settingsRev: 9,
    })
    ok('多条失配不重复报同一句', multi.reasons.length === new Set(multi.reasons).size)
  }

  // ---------- 四、账本读写 ----------
  __resetMockStores()
  db.setCurrentProject(PID)
  {
    const ch = mkChapter('c1', '正文', 100)
    const basis = computeBasis([ch], null)
    const run = await createRun({ projectId: PID, kind: 'creative', title: '创意写作', basis })
    ok('createRun 返回 id', !!run.id)
    ok('createRun 初始 running', run.status === 'running')
    ok('createRun 已落库', (await getAiRun(run.id))?.title === '创意写作')

    await appendRunCall(run.id, { model: 'm1', ms: 1200, promptTokens: 100, completionTokens: 200, finishReason: 'stop', at: 1 })
    await appendRunCall(run.id, { model: 'm1', ms: 800, finishReason: 'content_filter', at: 2 })
    const r2 = await getAiRun(run.id)
    ok('appendRunCall 累计 2 条', r2?.calls.length === 2)
    ok('调用账保留 finishReason（§14 判据来源）', r2?.calls[1].finishReason === 'content_filter')

    await patchRun(run.id, { candidates: [makeCandidateRef('chapter:c1', 3, 'fp-abc')] })
    const r3 = await getAiRun(run.id)
    ok('patchRun 写候选引用', r3?.candidates[0].count === 3)
    ok('候选初始 state=pending', r3?.candidates[0].state === 'pending')

    await finishRun(run.id, { status: 'done', outcome: { created: 2, updated: 1, skipped: 0, failed: [] } })
    const done = await getAiRun(run.id)
    ok('finishRun 置 done', done?.status === 'done')
    ok('finishRun 记回执', done?.outcome?.created === 2)
    ok('finishRun 记 finishedAt', (done?.finishedAt ?? 0) > 0)

    ok('listProjectAiRuns 按项目取到', (await listProjectAiRuns(PID)).length === 1)
    ok('listRecentAiRuns 取到', (await listRecentAiRuns()).length === 1)
    ok('别的项目查不到（不串库）', (await listProjectAiRuns('other-proj')).length === 0)

    await deleteAiRun(run.id)
    ok('deleteAiRun 生效', (await getAiRun(run.id)) === undefined)
  }

  // ---------- 五、记账不打断创作（缺失记录静默） ----------
  {
    const r = await patchRun('不存在的-id', { status: 'failed' })
    ok('patchRun 缺失记录返回 undefined（不抛）', r === undefined)
  }

  console.log(`\n———— aiRunLedger：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

main()
