// 3.2.0 · WQ7 改写侧归属 · 单测
//
// 盯两件事：
//   ① **整章改写**（`aiRewriteChapter`）真的把 `request` 传到了 `chat()` —— 它的调用链最长
//      （主调用 + 续写补写循环 + 字数校准），中间漏 spread 一处就退回兼容归属；
//   ② **工单改写**（`runTicketChapter`）自己建一条 `rewrite` 任务账，且**每条返回路径都收尾**
//      （中止/失败/空正文/落库失败/成功）—— 少收一条，账本里就会永久挂着一条 running。
//
// 🔴 为什么必须端到端：只断言"选项里有 request 字段"是假绿，参数没被 spread 下去照样绿。
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { __resetMockStores } from './mock-memory'
import { saveActiveId, saveProviders, type AIProvider } from '../src/lib/ai'
import { aiRewriteChapter } from '../src/lib/ai/aiTasks'
import { createRun, finishRun } from '../src/lib/ai/aiRunLedger'
import { getAiRun } from '../src/lib/db'
import { runTicketChapter } from '../src/lib/app/optimizeTicket'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PID = 'wq7-rewrite'
const REPLY = '这一段是被改写后的正文，用来验证归属链路，字数不需要很长，够判断即可。'

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
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 21, completion_tokens: 34 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: REPLY }, finish_reason: 'stop' }], usage: { prompt_tokens: 21, completion_tokens: 34 } }))
  })
})

const REWRITE_OPTS = {
  title: '第一章',
  body: '原文正文，用来被改写。',
  action: 'polish' as const,
  requirement: '把句子理顺',
  isLatest: true,
}

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

  // ---------- 一、显式 request 真的到账 ----------
  {
    const run = await createRun({ projectId: PID, kind: 'rewrite', title: '整章改写', basis: { at: 1 } })
    hits = 0
    await aiRewriteChapter({
      ...REWRITE_OPTS,
      request: { scope: 'project', projectId: PID, taskId: run.id, taskType: 'rewrite', stepId: 'rewrite' },
    }).catch(() => '')
    await finishRun(run.id, { status: 'done' })
    const r = await getAiRun(run.id)

    ok('① 改写确实发出了请求', hits > 0, String(hits))
    ok('① 调用账记在该任务上（attributedBy=task-id）',
      (r?.calls.length ?? 0) > 0 && Boolean(r?.calls.every(c => c.attributedBy === 'task-id')),
      JSON.stringify(r?.calls.map(c => c.attributedBy)))
    ok('① 请求上下文带 taskId 与 stepId',
      Boolean(r?.calls.every(c => c.request?.taskId === run.id && c.request?.stepId === 'rewrite')))
    ok('① 真实 usage 仍被提取（归属改造没弄丢用量）',
      Boolean(r?.calls.some(c => c.promptTokens === 21 && c.tokensEstimated !== true)),
      JSON.stringify(r?.calls.map(c => ({ t: c.promptTokens, e: c.tokensEstimated }))))
  }

  // ---------- 二、不传 request ⇒ 兼容归属（行为零变化） ----------
  {
    __resetMockStores()
    await saveProviders([provider])
    await saveActiveId('p1')
    const run = await createRun({ projectId: PID, kind: 'rewrite', title: '整章改写（旧调用）', basis: { at: 1 } })
    await aiRewriteChapter(REWRITE_OPTS).catch(() => '')
    await finishRun(run.id, { status: 'done' })
    const r = await getAiRun(run.id)
    ok('② 不传 request 时仍能记账（唯一任务 ⇒ 兼容归属）',
      (r?.calls.length ?? 0) > 0 && Boolean(r?.calls.every(c => c.attributedBy === 'legacy-single-run')),
      JSON.stringify(r?.calls.map(c => c.attributedBy)))
  }

  // ---------- 三、工单改写：空执行不建账 ----------
  {
    __resetMockStores()
    const before = await runTicketChapter([], {})
    ok('③ 没有可执行条目 ⇒ 原样返回（不算失败）',
      before.items.length === 0 && before.chapterId === '' && before.error === undefined,
      JSON.stringify(before))
    ok('③ 空执行不建账（不产生垃圾 running 记录）', before.chapterId === '')
  }

  // ---------- 四、静态契约：账本收尾覆盖所有返回路径 ----------
  {
    const src = readFileSync('src/lib/app/optimizeTicket.ts', 'utf8')
    ok('④ 工单改写建 rewrite 任务账', /kind: 'rewrite'/.test(src) && /startRewriteLedger\(/.test(src))
    ok('④ 账本按 taskId 归属（scope=project + taskType=rewrite）',
      /scope: 'project'/.test(src) && /taskType: 'rewrite'/.test(src))
    // 5 条返回路径：中止 / 失败 / 空正文 / 落库失败 / 成功
    const settles = (src.match(/settleRewriteLedger\(ledger, /g) ?? []).length
    ok('④ 每条返回路径都收尾（≥5 处，含中止与成功）', settles >= 5, String(settles))
    ok('④ 中止记 aborted（条目保持 pending，不改写状态机）',
      /settleRewriteLedger\(ledger, 'aborted'\)/.test(src))
    ok('④ 成功时记一条 adopted 候选（改写也算候选）',
      /noteCandidate\(ledger\.id/.test(src) && /state: 'adopted'/.test(src))
    ok('④ 设定同步带上同一份归属（不另起一套）',
      // 3.2.0 · WQ6：末尾多传一份本章预算；归属仍在 request 位
      /extractAndCommitSettings\(text, hit\.chapter\.title, 'add-only', undefined, opts\.signal, request, budget\)/.test(src))
  }

  // ---------- 五、改写链内部三处调用都透传 ----------
  {
    const rw = readFileSync('src/lib/aiTasks/rewrite.ts', 'utf8')
    ok('⑤ 改写选项声明 request（可空 ⇒ 老调用零变化）', /request\?: CallRequestContext/.test(rw))
    // 主调用 + 续写补写循环 + 字数校准 = 3 处
    const spreads = (rw.match(/o\.request \? \{ request: o\.request \}/g) ?? []).length
    ok('⑤ 三处模型调用都透传（主调用／续写补写／字数校准）', spreads === 3, String(spreads))
  }

  // ---------- 六、无父任务的调用如实标独立 ----------
  {
    const post = readFileSync('src/lib/outline/chapterPostProcess.ts', 'utf8')
    ok('⑥ 后处理接受 request 并传给抽取', /request\?: CallRequestContext/.test(post)
      && /opts\?\.request \? \{ request: opts\.request \}/.test(post))
    const ui = readFileSync('src/components/jiewenji/useJieWenJiModel.ts', 'utf8')
    ok('⑥ 编辑器助手后处理标 scope=independent（不冒充任何任务的账）',
      /scope: 'independent'/.test(ui))
  }

  console.log(`\n———— rewriteAttribution：${pass} 通过 / ${fail} 失败 ————`)
  server.close()
  if (fail > 0) process.exit(1)
}

main()
