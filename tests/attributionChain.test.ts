// 3.2.0 · WQ7 归属贯通（量最大的三条链）· 单测
//
// 盯两件事：
//   ① **正文连写链**（`enforceWordRange` 补字/压缩）与**审查链**（`aiContinuityAudit`）
//      真的把 taskId 带到了 chat() —— 这两条链每章合计 4~10 次调用，是统计准确度的主要来源；
//   ② 不传 request 的老调用（整章改写 / 优化工单侧）行为零变化，仍走兼容归属。
//
// 🔴 只断言"参数存在"是假绿：中间任何一层忘了 spread，最终都会静默退回兼容路径，
//    统计看着一样、并行时才发现串账。所以这里跑真账本 + 本地假端点。
import http from 'node:http'
import { __resetMockStores } from './mock-memory'
import { saveActiveId, saveProviders, requireActiveProvider, type AIProvider } from '../src/lib/ai'
import { enforceWordRange } from '../src/lib/editor/wordRange'
import { aiContinuityAuditWithStatus } from '../src/lib/ai/aiTasks'
import { createRun, finishRun } from '../src/lib/ai/aiRunLedger'
import { getAiRun } from '../src/lib/db'
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PID = 'wq7-chain'
const FILL = '补写的正文内容推进情节。'.repeat(20)
const FINDINGS = JSON.stringify([{ title: '时间线矛盾', level: '严重', detail: '第 2 章已说天黑了' }])

let hits = 0
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    hits++
    let sys = ''
    try {
      const body = JSON.parse(raw) as { messages?: { role: string; content: string }[] }
      sys = body.messages?.find(m => m.role === 'system')?.content ?? ''
    } catch { /* 忽略 */ }
    // 审查请求要 JSON 数组；补写请求要正文
    const content = /连续性|矛盾|审查/.test(sys) ? FINDINGS : FILL
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 9 },
    }))
  })
})

async function main() {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  const provider: AIProvider = {
    id: 'p1', name: '假端点', type: 'openai',
    baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'fake-model', local: false,
  }
  __resetMockStores()
  await saveProviders([provider])
  await saveActiveId('p1')
  const cfg = await requireActiveProvider()

  // ---------- 一、字数校准链（补写/压缩） ----------
  {
    const run = await createRun({ projectId: PID, kind: 'continue', title: '续写', basis: { at: 1 } })
    hits = 0
    const out = await enforceWordRange({
      cfg,
      body: '开局一段很短的正文。'.repeat(5),
      target: 1200,
      maxExpand: 1,
      maxShrink: 0,
      request: { scope: 'project', projectId: PID, taskId: run.id, taskType: 'continue', stepId: 'fill' },
    })
    await finishRun(run.id, { status: 'done' })
    const r = await getAiRun(run.id)
    ok('① 补写确实发出了请求', hits > 0, String(hits))
    ok('① 补写返回被采用（链路没被打断）', out.length > 50, String(out.length))
    ok('🔴 ① 补写调用记到任务名下（task-id，不是兼容路径）',
      (r?.calls.length ?? 0) > 0 && r?.calls.every(c => c.attributedBy === 'task-id') === true,
      JSON.stringify(r?.calls.map(c => c.attributedBy)))
    ok('① 调用账带 stepId（能定位到"补字"这一步）',
      r?.calls.every(c => c.request?.stepId === 'fill') === true,
      JSON.stringify(r?.calls.map(c => c.request?.stepId)))
  }

  // ---------- 二、审查链（连续性） ----------
  {
    const run = await createRun({ projectId: PID, kind: 'creative', title: '自检', basis: { at: 1 } })
    hits = 0
    const res = await aiContinuityAuditWithStatus('【设定】天黑了。', '第 2 章正文。', {
      request: { scope: 'project', projectId: PID, taskId: run.id, taskType: 'creative', stepId: 'self-check' },
    })
    await finishRun(run.id, { status: 'done' })
    const r = await getAiRun(run.id)
    ok('② 审查请求发出且解析成功', hits === 1 && res.state === 'completed', `${hits}/${res.state}`)
    ok('🔴 ② 审查调用同样按 task-id 记账',
      (r?.calls.length ?? 0) === 1 && r?.calls[0].attributedBy === 'task-id',
      JSON.stringify(r?.calls.map(c => c.attributedBy)))
    ok('② 审查调用带 stepId', r?.calls[0].request?.stepId === 'self-check')
  }

  // ---------- 三、老调用不传 request ⇒ 行为不变 ----------
  {
    const run = await createRun({ projectId: PID, kind: 'rewrite', title: '改写', basis: { at: 1 } })
    await aiContinuityAuditWithStatus('【设定】', '正文', {})
    await finishRun(run.id, { status: 'done' })
    const r = await getAiRun(run.id)
    ok('③ 不传 request 时仍走兼容归属（老调用点零改动）',
      r?.calls.length === 1 && r?.calls[0].attributedBy === 'legacy-single-run',
      JSON.stringify(r?.calls.map(c => c.attributedBy)))
  }

  // ---------- 四、静态闸：三层都不许漏 spread ----------
  {
    const wr = readFileSync('src/lib/editor/wordRange.ts', 'utf8')
    ok('④ 字数校准：两处 ask/askSoft 都带 request',
      (wr.match(/\.\.\.\(o\.request \? \{ request: o\.request \} : \{\}\)/g) ?? []).length === 2,
      String((wr.match(/o\.request \? \{ request/g) ?? []).length))
    const ac = readFileSync('src/lib/outline/autoContinue.ts', 'utf8')
    ok('④ 正文链：generateOneChapter 内部三处 + 主循环四处都带（≥6 处）',
      (ac.match(/request/g) ?? []).length >= 12,
      String((ac.match(/request/g) ?? []).length))
    const au = readFileSync('src/lib/aiTasks/audit.ts', 'utf8')
    ok('④ 审查：六处 chat 全部带 request',
      (au.match(/\.\.\.\(opts\?\.request \? \{ request: opts\.request \} : \{\}\)/g) ?? []).length === 6,
      String((au.match(/opts\?\.request/g) ?? []).length))
    const ex = readFileSync('src/lib/aiTasks/extract.ts', 'utf8')
    ok('④ 抽取：chat 带 request',
      /\.\.\.\(opts\?\.request \? \{ request: opts\.request \} : \{\}\)/.test(ex))
  }

  server.close()
  console.log(`\n———— attributionChain：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

main()
