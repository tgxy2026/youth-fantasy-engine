// UX09 · 批量重生成摘要的**逐章记账**（regenSummaries）
//
// 原实现在循环里 `catch { }` 跳过单章失败，只返回 `{done,total}`，完成提示却写
// 「全书摘要重生成完成（共 total 章）」⇒ 失败章节被说成成功，作者只能自己去章节总表里翻。
// 这里锁住的口径：
//   ① 单章失败不中断，但必须逐条记下「哪一章、为什么、摘要有没有落库」；
//   ② 模型返回空内容 = 失败（不能写空摘要还报成功）；
//   ③ 摘要写入失败与「总表没同步」是两件事，分别记；
//   ④ 作者主动中止不算失败，未处理章节不计数；
//   ⑤ 完成文案在有失败时**绝不**出现「全部完成」。
import type { Chapter } from '../src/lib/types'
import { regenSummaryText, regenTargets, regenFailureReason, runRegenSummaries, type RegenOutcome } from '../src/components/editor/regenSummaries'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const mkCh = (id: string, title: string, content: string): Chapter =>
  ({ id, projectId: 'p', volumeId: 'v', order: 0, title, content, summary: '旧摘要', createdAt: 0, updatedAt: 0 }) as Chapter

const CH = [
  mkCh('c1', '第一章 雨夜', '正文一'),
  mkCh('c2', '第二章 破境', '正文二'),
  mkCh('c3', '第三章 空章', '   '),      // 无正文：不纳入
  mkCh('c4', '第四章 归途', '正文四'),
]

/** 造一份可控的依赖：第 N 次 summarize 抛错 / 返回空 / 正常 */
function makeDeps(opts: {
  failAt?: number; emptyAt?: number; saveFailAt?: number; syncFailAt?: number
  abortAfter?: number; batchEvery?: number
} = {}) {
  const calls = { summarize: 0, save: [] as string[], sync: [] as string[], progress: [] as string[], batch: [] as string[], aborted: false }
  let n = 0
  return {
    calls,
    deps: {
      signal: new AbortController().signal,
      isAborted: () => calls.aborted,
      summarize: async (text: string) => {
        calls.summarize += 1
        n += 1
        if (opts.abortAfter !== undefined && n > opts.abortAfter) { calls.aborted = true; throw new Error('aborted') }
        if (opts.failAt === n) throw new Error('模型 500：上游繁忙\n第二行不该出现')
        if (opts.emptyAt === n) return '   '
        return `摘要(${text.slice(0, 4)})`
      },
      save: async (chapter: Chapter) => {
        if (opts.saveFailAt === n) throw new Error('写入章节失败')
        calls.save.push(chapter.id)
      },
      syncMaster: async (chapter: Chapter) => {
        if (opts.syncFailAt === n) throw new Error('总表写入失败')
        calls.sync.push(chapter.id)
      },
      onProgress: (attempted: number, total: number) => calls.progress.push(`${attempted}/${total}`),
      onBatch: (attempted: number, total: number) => calls.batch.push(`${attempted}/${total}`),
      batchEvery: opts.batchEvery,
    },
  }
}

const run = (deps: ReturnType<typeof makeDeps>['deps']): Promise<RegenOutcome> => runRegenSummaries(CH, deps)

// ---------- ① 全部成功 ----------
{
  const { deps, calls } = makeDeps({ batchEvery: 2 })
  const out = await run(deps)
  ok('🔴 ① 三章有正文全部计入，空章不纳入', out.total === 3 && out.succeeded === 3 && out.failed.length === 0, JSON.stringify(out))
  ok('① 逐章进度上报，且总长恒定', calls.progress.join(',') === '1/3,2/3,3/3', calls.progress.join(','))
  ok('① 批量提示按 batchEvery 触发', calls.batch.join(',') === '2/3', calls.batch.join(','))
  ok('① 全绿文案才可以说「完成」', regenSummaryText(out).kind === 'success' && regenSummaryText(out).text.includes('完成'), regenSummaryText(out).text)
}

// ---------- ② 单章模型失败：不中断，逐条记账 ----------
{
  const { deps, calls } = makeDeps({ failAt: 2 })
  const out = await run(deps)
  ok('🔴 ② 中途失败不中断，后续章继续处理', out.attempted === 3 && calls.save.length === 2, JSON.stringify(out))
  ok('🔴 ② 失败记录带章名与原因', out.failed.length === 1 && out.failed[0].title === '第二章 破境'
    && out.failed[0].reason.includes('模型 500'), JSON.stringify(out.failed))
  ok('② 失败原因压成一行（不带换行）', !out.failed[0].reason.includes('\n'))
  ok('② succeeded 只数真正写入的章', out.succeeded === 2, String(out.succeeded))
  const text = regenSummaryText(out)
  ok('🔴 ② 有失败时文案绝不写「全书…完成」', !text.text.includes('全书摘要重生成完成') && text.kind === 'info', text.text)
  ok('② 文案点明「没生成成功」', text.text.includes('没生成成功'), text.text)
}

// ---------- ③ 模型返回空内容 ----------
{
  const { deps, calls } = makeDeps({ emptyAt: 1 })
  const out = await run(deps)
  ok('🔴 ③ 空摘要算失败、不写空摘要', out.failed.length === 1 && out.failed[0].reason.includes('没有返回摘要')
    && !calls.save.includes('c1'), JSON.stringify(out))
}

// ---------- ④ 写章节失败 vs 总表未同步：分开记 ----------
{
  const { deps } = makeDeps({ saveFailAt: 1 })
  const out = await run(deps)
  ok('🔴 ④ 写章节失败 ⇒ summarySaved=false 且不计成功',
    out.failed[0]?.summarySaved === false && out.failed[0].reason.includes('写入章节失败') && out.succeeded === 2, JSON.stringify(out))

  const syncCase = makeDeps({ syncFailAt: 3 })
  const out2 = await run(syncCase.deps)
  ok('🔴 ④ 总表未同步 ⇒ summarySaved=true，摘要仍算写入成功',
    out2.failed.length === 1 && out2.failed[0].summarySaved === true && out2.succeeded === 3
    && out2.failed[0].reason.includes('总表未同步'), JSON.stringify(out2))
  const text = regenSummaryText(out2)
  ok('④ 文案把「总表未同步」与「没生成成功」分开说',
    text.text.includes('总表未同步') && !text.text.includes('没生成成功'), text.text)
}

// ---------- ⑤ 主动中止 ----------
{
  const { deps, calls } = makeDeps({ abortAfter: 1 })
  const out = await run(deps)
  ok('🔴 ⑤ 中止后不再处理剩余章，未处理章不计入 attempted',
    out.aborted === true && out.attempted === 2 && calls.save.length === 1, JSON.stringify(out))
  ok('🔴 ⑤ 中止不算失败（是作者自己按的）', out.failed.length === 0, JSON.stringify(out.failed))
  const text = regenSummaryText(out)
  ok('⑤ 中止文案说明「未处理的章节保持原摘要」', text.kind === 'info' && text.text.includes('中止') && text.text.includes('未处理'), text.text)
}

// ---------- ⑥ 原因截断 ----------
{
  ok('原因截断到 120 字以内并加省略号', regenFailureReason(new Error('长'.repeat(500))).length === 121
    && regenFailureReason(new Error('长'.repeat(500))).endsWith('…'))
  ok('空原因给「未知原因」', regenFailureReason(new Error('  ')) === '未知原因')
  ok('抛字符串也兜住', regenFailureReason('上游超时') === '上游超时')
}

// ---------- ⑦ 目标筛选 ----------
{
  ok('只有空白正文的章不纳入', regenTargets([mkCh('a', 'A', '  \n\t'), mkCh('b', 'B', '有字')]).map(c => c.id).join(',') === 'b')
  const out = await runRegenSummaries([], makeDeps().deps)
  ok('全书都没正文 ⇒ total 0、无失败、文案说完成 0 章', out.total === 0 && out.failed.length === 0
    && regenSummaryText(out).text.includes('共 0 章'), JSON.stringify(out))
}

console.log(`\nregenSummaries: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
