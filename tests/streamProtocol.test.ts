// 3.2.0 · WQ6 流协议判定 · 单测
//
// 盯四件事（方案 §16.7 + 验收「断流保留草稿且不报完成」「重试次数可核对」）：
//   ① 流里带 `error` ⇒ **不能算成功**（HTTP 200 只代表连上了），且不把半截内容当完整结果；
//   ② 缺结束标记（`[DONE]` / `done:true`）⇒ 内容可用但 `finishReason` 记 **eof（未知）**，不假装 stop；
//   ③ 流式解析失败 → 非流式重试 ⇒ `attempts: 2`（次数必须可核对）；
//   ④ 正常 `[DONE]` ⇒ `finishReason` 保留厂商给的 stop。
import http from 'node:http'
import { __resetMockStores } from './mock-memory'
import { saveActiveId, saveProviders, chat, type AIProvider } from '../src/lib/ai'
import { createRun, finishRun } from '../src/lib/ai/aiRunLedger'
import { getAiRun } from '../src/lib/db'
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PID = 'wq6-proto'

type Mode = 'ok' | 'no-done' | 'error-mid' | 'garbage-then-json' | 'ollama-error'
  | '400-model' | '400-empty-then-ok' | 'garbage-after-degrade'
let mode: Mode = 'ok'
let hits = 0

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
const DONE = 'data: [DONE]\n\n'

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    hits++
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(raw) } catch { /* 忽略 */ }
    const streaming = body.stream === true

    // 400：错误文案指向"模型不存在" ⇒ 不该降级重试（否则作者看到的错误原因会变味）
    if (mode === '400-model') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'model `fake-404` not found' } }))
      return
    }
    // 400 两次（参数不被接受）→ 第三次仍返回垃圾流：用于验证「请求次数上限」拦得住第 4 次
    if (mode === 'garbage-after-degrade') {
      if (hits <= 2) { res.writeHead(400); res.end(''); return }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('还是不是 JSON\n')
      res.end()
      return
    }
    // 400：响应体为空（老中转站常见）⇒ 仍降级到裸请求，第三次成功
    if (mode === '400-empty-then-ok') {
      if (hits < 2) { res.writeHead(400); res.end(''); return }
      // 降级后的这次要按**流式**应答（否则还会触发"流解析失败→非流式"的第二次降级，次数就不止 2 了）
      if (body.stream === true) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(sse({ choices: [{ delta: { content: '裸请求成功' } }] }))
        res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
        res.write(DONE)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '裸请求成功' }, finish_reason: 'stop' }] }))
      return
    }
    if (mode === 'ollama-error') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(sse({ error: 'model "qwen3:99b" not found' }))
      res.end()
      return
    }

    if (mode === 'garbage-then-json' && streaming) {
      // 非标准体：每行都不是 JSON ⇒ readSSE 全跳过 ⇒ content 为空 ⇒ 触发非流式重试
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('这不是 JSON\n也不是 data 行\n')
      res.end()
      return
    }

    if (streaming) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(sse({ choices: [{ delta: { content: '前半段正文' } }], usage: { prompt_tokens: 5, completion_tokens: 6 } }))
      if (mode === 'error-mid') {
        res.write(sse({ error: { message: 'quota exceeded for this key', type: 'insufficient_quota' } }))
        res.end()
        return
      }
      if (mode === 'no-done') {
        // 对端直接收掉：没有 [DONE]，也没有 finish_reason
        res.end()
        return
      }
      res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
      res.write(DONE)
      res.end()
      return
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      choices: [{ message: { content: '非流式重试拿到的正文' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 12 },
    }))
  })
})

/** 跑一次 chat 并取回它在账本里的那条调用（归属用显式 taskId，避免兼容路径干扰） */
async function run(provider: AIProvider) {
  const rec = await createRun({ projectId: PID, kind: 'other', title: 't', basis: { at: 1 } })
  const out: { text?: string; err?: string } = {}
  try {
    out.text = await chat(provider, [{ role: 'user', content: 'hi' }], {
      onToken: () => {},
      timeoutMs: 5000,
      idleTimeoutMs: 2000,
      request: { scope: 'project', projectId: PID, taskId: rec.id },
    })
  } catch (e) { out.err = e instanceof Error ? e.message : String(e) }
  await finishRun(rec.id, { status: out.err ? 'failed' : 'done' })
  const saved = await getAiRun(rec.id)
  return { out, call: saved?.calls[0] }
}

async function main() {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  const openai: AIProvider = {
    id: 'p1', name: '假端点', type: 'openai',
    baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'fake', local: false,
  }
  // 云端 qwen3：`thinkToggle` 生效 ⇒ 请求链是 full → noToggle → bare（三级），
  // 正好用来验证"三级之后不许再来第四条"。
  const openaiQwen: AIProvider = { ...openai, id: 'p3', model: 'qwen3-max' }
  const ollama: AIProvider = {
    id: 'p2', name: '假 Ollama', type: 'ollama',
    baseUrl: `http://127.0.0.1:${port}`, apiKey: '', model: 'qwen3:8b', local: true,
  }
  __resetMockStores()
  await saveProviders([openai, ollama])
  await saveActiveId('p1')

  // ---------- ① 流里报错 ----------
  mode = 'error-mid'
  {
    const { out } = await run(openai)
    ok('🔴 ① 流里带 error ⇒ 抛错（HTTP 200 不算成功）', Boolean(out.err), String(out.text))
    ok('① 错误文案带服务商原文（不是"未返回内容"这种含糊话）',
      (out.err ?? '').includes('quota exceeded'), out.err ?? '')
    ok('① 明确告知半截内容未被采用', (out.err ?? '').includes('未采用'), out.err ?? '')
  }

  // ---------- ② 缺结束标记 ----------
  mode = 'no-done'
  {
    const { out, call } = await run(openai)
    ok('② 缺 [DONE] 但内容完整 ⇒ 正常返回（兼容端点可接受 EOF）', out.text === '前半段正文', out.text ?? out.err)
    ok('🔴 ② 结束原因记 eof（未知），不假装 stop', call?.finishReason === 'eof', String(call?.finishReason))
  }

  // ---------- ③ 正常结束 ----------
  mode = 'ok'
  {
    const { out, call } = await run(openai)
    ok('③ 正常流式返回内容', out.text === '前半段正文', out.text ?? out.err)
    ok('③ 结束原因保留厂商给的 stop', call?.finishReason === 'stop', String(call?.finishReason))
    ok('③ 正常路径不写 attempts（只有重试才写）', call?.attempts === undefined, String(call?.attempts))
  }

  // ---------- ④ 流式失败 → 非流式重试 ----------
  mode = 'garbage-then-json'
  {
    hits = 0
    const { out, call } = await run(openai)
    ok('④ 降级重试成功（"跑不通"变成"慢一点能跑"）', out.text === '非流式重试拿到的正文', out.text ?? out.err)
    ok('④ 确实发了两次请求', hits === 2, String(hits))
    ok('🔴 ④ 账本记 attempts=2（重试次数可核对）', call?.attempts === 2, String(call?.attempts))
  }

  // ---------- ⑤ Ollama 流里报错 ----------
  mode = 'ollama-error'
  {
    const { out } = await run(ollama)
    ok('🔴 ⑤ Ollama 流里的 error 同样不能当成功', Boolean(out.err), String(out.text))
    ok('⑤ 保留 Ollama 原话（模型不存在这类问题一眼可辨）',
      (out.err ?? '').includes('not found'), out.err ?? '')
  }

  // ---------- ⑥ 400 降级只在"可选参数被拒"时发生 ----------
  mode = '400-model'
  {
    hits = 0
    const { out } = await run(openai)
    // 说明：`describeApiError` 会把 400 翻译成"最常见原因"的建议文案（不原样回显服务商话术），
    // 所以这里只钉「报错 + 只发一次」，不钉具体措辞。
    ok('🔴 ⑥ 400 指向"模型不存在" ⇒ 直接报错，不再白发两轮',
      Boolean(out.err) && (out.err ?? '').includes('400'), out.err ?? '')
    ok('🔴 ⑥ 只发了 1 次请求（旧实现会无脑降级三次）', hits === 1, String(hits))
  }

  mode = '400-empty-then-ok'
  {
    hits = 0
    const { out, call } = await run(openai)
    ok('⑥ 400 但响应体为空（老中转站）⇒ 仍降级，最终能跑通',
      out.text === '裸请求成功', out.text ?? out.err)
    ok('⑥ 降级次数记进账本（attempts=2：原始请求 + 裸请求）', call?.attempts === 2, String(call?.attempts))
  }

  // ---------- ⑥-b 请求次数上限 ----------
  mode = 'garbage-after-degrade'
  {
    hits = 0
    const { out } = await run(openaiQwen)
    ok('🔴 ⑥-b 已经用满 3 次请求 ⇒ 第 4 次（非流式降级）被拦住',
      Boolean(out.err) && (out.err ?? '').includes('上限'), out.err ?? '')
    ok('🔴 ⑥-b 实际只打了 3 次（不为一个坏端点打 4 次）', hits === 3, String(hits))
  }

  // 纯函数判据
  {
    const { shouldDegradeOn400 } = await import('../src/lib/aiCore/chat')
    ok('⑥ 空响应体 ⇒ 允许降级（兼容优先）', shouldDegradeOn400('') === true)
    ok('⑥ 指向模型/消息/鉴权/额度 ⇒ 不降级',
      ['model not found', 'invalid messages', 'invalid api key', 'insufficient quota', 'context length exceeded']
        .every(t => shouldDegradeOn400(t) === false))
    ok('⑥ 指向未知参数 ⇒ 降级',
      ['unsupported parameter: temperature', 'unknown field: enable_thinking', 'unrecognized request argument']
        .every(t => shouldDegradeOn400(t) === true))
  }

  // ---------- ⑦ 静态闸 ----------
  {
    const src = readFileSync('src/lib/aiCore/chat.ts', 'utf8')
    ok('⑥ chat() 两条通道都检查流内错误',
      (src.match(/report\.errorMessage|streamReport\.errorMessage/g) ?? []).length >= 2)
    ok('⑥ chat() 用 sawDone 判结束标记，缺标记记 eof',
      /!streamReport\.sawDone/.test(src) && /'eof'/.test(src))
    const tp = readFileSync('src/lib/aiCore/transport.ts', 'utf8')
    ok('⑥ readSSE 认两种结束标记（[DONE] 与 done:true）',
      tp.includes("payload === '[DONE]'") && tp.includes('.done === true'))
    ok('⑥ 单次调用请求上限有明确常量（不是散落的魔数）',
      /export const MAX_REQUESTS_PER_CALL = 3/.test(src)
      && /attempts >= MAX_REQUESTS_PER_CALL/.test(src))
  }

  server.close()
  console.log(`\n———— streamProtocol：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

main()
