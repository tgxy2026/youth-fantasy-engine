// 3.2.0 · WQ5 结构格式**真的下发** · 单测
//
// 盯四件事（方案 §16.6 / 验收 AI-05）：
//   ① 作者没确认能力 ⇒ 请求体里没有 format / response_format（与 3.1.x 逐字节一致）；
//   ② 作者确认后，显式 JSON 任务才下发；旧 `json:true` 即便确认了也**不下发**；
//   ③ 端点返回 400 时只撤被点名的可选参数（格式），其余参数保留并重试一次；
//   ④ 模型名这类「与可选参数无关」的 400 不降级 —— 错误原因不被换掉，也不白发请求。
import http from 'node:http'
import { chat, type AIProvider } from '../src/lib/ai'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

type Mode = 'ok' | 'reject-format' | 'model-not-found'
type Json = Record<string, unknown>

function startOpenAI() {
  const bodies: Json[] = []
  let mode: Mode = 'ok'
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', d => { raw += d })
    req.on('end', () => {
      let body: Json = {}
      try { body = JSON.parse(raw) } catch { /* 忽略坏请求 */ }
      bodies.push(body)
      if (mode === 'model-not-found') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'model `nope` not found' } }))
        return
      }
      if (mode === 'reject-format' && body.response_format !== undefined) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'response_format is not supported by this endpoint' } }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }))
    })
  })
  return new Promise<{ port: number; bodies: Json[]; setMode: (m: Mode) => void; close: () => void }>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: (server.address() as { port: number }).port,
      bodies,
      setMode: m => { mode = m },
      close: () => server.close(),
    }))
  })
}

function startOllama() {
  const bodies: Json[] = []
  let rejectFormat = false
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', d => { raw += d })
    req.on('end', () => {
      let body: Json = {}
      try { body = JSON.parse(raw) } catch { /* 忽略坏请求 */ }
      bodies.push(body)
      if (rejectFormat && body.format !== undefined) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end('this ollama version does not accept format')
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      res.end(JSON.stringify({ message: { content: '{"ok":true}' }, done: true }) + '\n')
    })
  })
  return new Promise<{ port: number; bodies: Json[]; setReject: (v: boolean) => void; close: () => void }>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: (server.address() as { port: number }).port,
      bodies,
      setReject: v => { rejectFormat = v },
      close: () => server.close(),
    }))
  })
}

const openaiProvider = (port: number, extra: Partial<AIProvider> = {}): AIProvider => ({
  id: 'wire-openai', name: '测试端点', type: 'openai',
  baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'wire-model',
  contextWindow: 8192, ...extra,
})

const ollamaProvider = (port: number, extra: Partial<AIProvider> = {}): AIProvider => ({
  id: 'wire-ollama', name: '本地假模型', type: 'ollama',
  baseUrl: `http://127.0.0.1:${port}`, apiKey: '', model: 'fake', local: true,
  contextWindow: 8192, ...extra,
})

const MSGS = [{ role: 'user' as const, content: '只回一个 JSON' }]

async function main() {
  const api = await startOpenAI()
  const oll = await startOllama()
  try {
    // ---------- 一、OpenAI 兼容：默认不下发 ----------
    {
      const out = await chat(openaiProvider(api.port), MSGS, { output: 'json-object', reasoning: 'off' })
      ok('① 未确认能力 ⇒ 请求体没有 response_format', api.bodies[0].response_format === undefined)
      ok('① 未确认能力 ⇒ 温度仍是结构化低温 0.3', api.bodies[0].temperature === 0.3)
      ok('① 返回可用内容（提示词约束路径照常工作）', out.includes('"ok"'))
    }

    // ---------- 二、确认后显式任务下发 ----------
    {
      api.bodies.length = 0
      await chat(openaiProvider(api.port, { structuredOutput: 'json-object' }), MSGS,
        { output: 'json-object', reasoning: 'off' })
      ok('② 作者确认 ⇒ 显式 JSON 任务下发 response_format',
        JSON.stringify(api.bodies[0].response_format) === '{"type":"json_object"}',
        JSON.stringify(api.bodies[0]))
      ok('② 温度与思维链参数不被格式功能带偏',
        api.bodies[0].temperature === 0.3 && api.bodies[0].enable_thinking === undefined)

      api.bodies.length = 0
      await chat(openaiProvider(api.port, { structuredOutput: 'json-object' }), MSGS, { json: true })
      ok('🔴 ② 旧 json:true 即便确认了能力也不下发（老调用点逐字节不变）',
        api.bodies[0].response_format === undefined, JSON.stringify(api.bodies[0]))

      api.bodies.length = 0
      await chat(openaiProvider(api.port, { structuredOutput: 'json-object' }), MSGS,
        { output: 'text' })
      ok('② 文本任务不下发结构格式', api.bodies[0].response_format === undefined)
    }

    // ---------- 三、schema 下发 ----------
    {
      api.bodies.length = 0
      const schema = { type: 'object', properties: { ok: { type: 'boolean' } } }
      await chat(openaiProvider(api.port, { structuredOutput: 'json-schema' }), MSGS,
        { output: 'json-schema', reasoning: 'off', schema })
      const rf = api.bodies[0].response_format as Json | undefined
      ok('③ 已确认 schema 且本次给了 schema ⇒ 下发 json_schema',
        (rf as any)?.type === 'json_schema'
        && JSON.stringify((rf as any)?.json_schema?.schema) === JSON.stringify(schema),
        JSON.stringify(rf))

      api.bodies.length = 0
      await chat(openaiProvider(api.port, { structuredOutput: 'json-object' }), MSGS,
        { output: 'json-schema', reasoning: 'off', schema })
      ok('③ 端点只确认到 json-object ⇒ 退为 json_object（schema 不出现在请求里）',
        JSON.stringify(api.bodies[0].response_format) === '{"type":"json_object"}')
    }

    // ---------- 四、400 只撤被点名的可选参数 ----------
    {
      api.bodies.length = 0
      api.setMode('reject-format')
      const out = await chat(openaiProvider(api.port, { structuredOutput: 'json-object' }), MSGS,
        { output: 'json-object', reasoning: 'off' })
      ok('④ 端点不认格式 ⇒ 自动撤掉格式重试一次并成功', out.includes('"ok"') && api.bodies.length === 2)
      ok('④ 第一次带 response_format、第二次没有',
        api.bodies[0].response_format !== undefined && api.bodies[1].response_format === undefined)
      ok('④ 撤格式时温度等其它参数保持原样（不降成裸请求）',
        api.bodies[1].temperature === 0.3 && api.bodies[1].stream === false,
        JSON.stringify(api.bodies[1]))
      api.setMode('ok')
    }

    // ---------- 五、与可选参数无关的 400 不降级 ----------
    {
      api.bodies.length = 0
      api.setMode('model-not-found')
      let err = ''
      try {
        await chat(openaiProvider(api.port, { structuredOutput: 'json-object' }), MSGS,
          { output: 'json-object', reasoning: 'off' })
      } catch (e) { err = e instanceof Error ? e.message : String(e) }
      ok('⑤ 模型名错误 ⇒ 只发一次请求（不白发降级）', api.bodies.length === 1, String(api.bodies.length))
      ok('⑤ 错误原因仍是模型名（没被换成第三轮的结果）', /model|nope/i.test(err), err)
      api.setMode('ok')
    }

    // ---------- 六、Ollama：format 只在确认后下发 ----------
    {
      oll.bodies.length = 0
      await chat(ollamaProvider(oll.port), MSGS, { output: 'json-object', reasoning: 'off' })
      ok('⑥ Ollama 未确认 ⇒ 请求体没有 format', oll.bodies[0].format === undefined)

      oll.bodies.length = 0
      await chat(ollamaProvider(oll.port, { structuredOutput: 'json-object' }), MSGS,
        { output: 'json-object', reasoning: 'off' })
      ok('⑥ Ollama 确认后 ⇒ 下发 format="json"', oll.bodies[0].format === 'json')

      oll.bodies.length = 0
      await chat(ollamaProvider(oll.port, { structuredOutput: 'json-object' }), MSGS, { json: true })
      ok('🔴 ⑥ Ollama 旧 json:true 同样不下发 format', oll.bodies[0].format === undefined)

      oll.bodies.length = 0
      oll.setReject(true)
      const out = await chat(ollamaProvider(oll.port, { structuredOutput: 'json-object' }), MSGS,
        { output: 'json-object', reasoning: 'off' })
      ok('⑥ Ollama 不认 format ⇒ 撤掉重试一次并成功',
        out.includes('"ok"') && oll.bodies.length === 2 && oll.bodies[1].format === undefined,
        JSON.stringify({ hits: oll.bodies.length, second: oll.bodies[1] }))
      oll.setReject(false)
    }

    // ---------- 七、推理与结构共存只在确认后成立 ----------
    {
      // 未确认共存：required 会被降级成不推理（协议层），但仍可下发格式
      api.bodies.length = 0
      await chat(openaiProvider(api.port, { structuredOutput: 'json-object' }), MSGS,
        { output: 'json-object', reasoning: 'required' })
      ok('⑦ 只确认结构、没确认共存 ⇒ required 被降级（不下发 enable_thinking，也没有意外开推理）',
        api.bodies[0].enable_thinking === undefined && api.bodies[0].response_format !== undefined)
    }
  } finally {
    api.close()
    oll.close()
  }
}

main().then(() => {
  console.log(`\n———— structuredOutputWire：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}).catch(e => {
  console.error(e)
  process.exit(1)
})
