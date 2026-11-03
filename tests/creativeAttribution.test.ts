// 3.2.0 · WQ7 显式归属贯通 · 单测
//
// 盯一件事：**生产调用点真的把 taskId 传下去了**。
//   `creativeSession` 建账本 → `aiWorkflow` 选项 → `aiGenerateBible` / `aiPlanOutline` → `chat()`
//   → 用量总线 → 账本按 taskId 精确入账（`attributedBy === 'task-id'`）。
//
// 🔴 为什么必须端到端跑一次：只断言"参数存在"是假绿 —— 中间任何一层忘了 spread，
//    最终都会悄悄退回「唯一任务」兼容归属，统计看着一样、并行时才发现串账。
import http from 'node:http'
import { __resetMockStores } from './mock-memory'
import { saveActiveId, saveProviders, type AIProvider } from '../src/lib/ai'
import { aiGenerateBible } from '../src/lib/ai/aiTasks'
import { createRun, finishRun } from '../src/lib/ai/aiRunLedger'
import { getAiRun } from '../src/lib/db'
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PID = 'wq7-explicit'
const REPLY = JSON.stringify({ entities: [{ type: '人物', name: '测试甲', desc: '一个测试人物' }] })

let hits = 0
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    hits++
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(raw) } catch { /* 忽略 */ }
    if (body.stream === true) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: REPLY } }] })}\n\n`)
      // 收尾块带 usage：验证归属改造之后「真实用量提取」这条路仍然通
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 22 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: REPLY }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 22 } }))
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

  // ---------- 一、显式 taskId 真的到账 ----------
  {
    const run = await createRun({ projectId: PID, kind: 'creative', title: '创意写作', basis: { at: 1 } })
    hits = 0
    // 解析结果是否成功不影响归属断言（这里验的是记账链，不是抽取质量）
    await aiGenerateBible('一个关于测试的想法', {
      request: { scope: 'project', projectId: PID, taskId: run.id, taskType: 'creative', stepId: 'bible' },
    }).catch(() => null)
    await finishRun(run.id, { status: 'done' })

    const r = await getAiRun(run.id)
    ok('① 模型调用确实发生了（假端点收到请求）', hits > 0, String(hits))
    ok('🔴 ① 调用账记到了这个任务名下（不再靠"最近创建的任务"猜）',
      (r?.calls.length ?? 0) > 0, JSON.stringify(r?.calls.length))
    ok('🔴 ① 归属方式是 task-id（不是 legacy-single-run）',
      r?.calls.every(c => c.attributedBy === 'task-id') === true,
      JSON.stringify(r?.calls.map(c => c.attributedBy)))
    ok('① 调用账里带着 taskId / stepId（复盘能定位到哪一步）',
      r?.calls.every(c => c.request?.taskId === run.id && c.request?.stepId === 'bible') === true,
      JSON.stringify(r?.calls.map(c => c.request)))
    ok('① 真实 usage 照旧提取（归属改造没把用量弄丢）',
      r?.calls.some(c => c.promptTokens === 11 && c.tokensEstimated !== true) === true,
      JSON.stringify(r?.calls.map(c => ({ t: c.promptTokens, e: c.tokensEstimated }))))
  }

  // ---------- 二、不传 request ⇒ 兼容归属仍在（老调用点不受影响） ----------
  {
    const run = await createRun({ projectId: PID, kind: 'creative', title: '无归属', basis: { at: 1 } })
    await aiGenerateBible('另一个想法').catch(() => null)
    await finishRun(run.id, { status: 'done' })
    const r = await getAiRun(run.id)
    // 设定奠基失败会重试，所以这里只要求「有账且全是兼容归属」，不锁死条数
    ok('② 没传 request 时仍能记账（唯一任务 ⇒ 兼容归属）',
      (r?.calls.length ?? 0) > 0 && r?.calls.every(c => c.attributedBy === 'legacy-single-run') === true,
      JSON.stringify(r?.calls.map(c => c.attributedBy)))
  }

  // ---------- 三、静态检查：三层都不许漏 spread ----------
  {
    const wf = readFileSync('src/lib/ai/aiWorkflow.ts', 'utf8')
    ok('③ 编排层：设定奠基与大纲规划都透传 request',
      (wf.match(/\.\.\.\(opts\.request \? \{ request: opts\.request \} : \{\}\)/g) ?? []).length >= 2,
      String((wf.match(/\.\.\.\(opts\.request/g) ?? []).length))
    const tasks = readFileSync('src/lib/aiTasks/creative.ts', 'utf8')
    ok('③ 任务层：两个大调用都往 chat() 带 request',
      (tasks.match(/\.\.\.\(opts\.request \? \{ request: opts\.request \} : \{\}\)/g) ?? []).length >= 2,
      String((tasks.match(/\.\.\.\(opts\.request/g) ?? []).length))
    const cs = readFileSync('src/lib/creative/creativeSession.ts', 'utf8')
    ok('③ 会话层：把账本 run id 当 taskId 传下去',
      /taskId: ledger\.id/.test(cs) && /taskType: 'creative'/.test(cs))
  }

  server.close()
  console.log(`\n———— creativeAttribution：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

main()
