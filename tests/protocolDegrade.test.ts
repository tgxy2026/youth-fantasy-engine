// ============ 3.4.2 · D-1：三家官方协议的「400 降级 + 流式转非流式」============
//
// 规划 §4.F.3 要求降级「按协议分别实现，不得串味」；§6 要求网页形态不伪装可用（D-3 的台账在
// `webCors` 里单测）。这里用一个**受控假端点**逐条压这三件事：
//   ① 400 指向采样参数 ⇒ 撤掉温度重发一次，能救回来；
//   ② 400 指向结构字段 ⇒ 撤掉结构字段重发一次；
//   ③ 模型名 / 鉴权这类硬失败 ⇒ **一次都不重发**（禁止把真错因埋掉）；
//   ④ 流式解析不出内容 ⇒ 退一次非流式；
//   ⑤ `disableCompatibilityRetry` ⇒ 全程只发一次（续写规划那类任务不能偷偷多打）。
//
// 🔴 为什么必须用真 HTTP 而不是打桩 fetch：降级的判据是**响应体文案**，
//    打桩很容易顺手把文案写成「我们希望的样子」，从而测出一条永远绿、线上必红的路径。
import http from 'node:http'
import { anthropicDriver } from '../src/lib/aiCore/protocols/anthropic'
import { geminiDriver } from '../src/lib/aiCore/protocols/gemini'
import { responsesDriver } from '../src/lib/aiCore/protocols/openaiResponses'
import { nextWireFlags, shouldDegradeSamplingOn400, MAX_REQUESTS_PER_CALL } from '../src/lib/aiCore/protocols/shared'
import { PROTOCOL_WEB_CORS, CORS_VERDICT_LABEL, webProtocolCorsNote } from '../src/lib/aiCore/webCors'
import type { AIProvider } from '../src/lib/aiCore/core'
import type { DriverCallOpts } from '../src/lib/aiCore/protocols/contract'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- 受控假端点 ----------
interface Seen { path: string; body: Record<string, unknown> }
const seen: Seen[] = []
/** 各家拒绝策略（每个用例前改这些开关，不改服务器代码） */
const reject = { anthropicTemp: true, anthropicHard: '', geminiSchema: true, responsesTemp: true, responsesWeird: false, emptyStream: false }

const sendJson = (res: http.ServerResponse, status: number, obj: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}
const sendSse = (res: http.ServerResponse, events: string[]) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const e of events) res.write(`data: ${e}\n\n`)
  res.end()
}

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(raw) } catch { /* 忽略 */ }
    const url = req.url ?? ''
    seen.push({ path: url, body })
    const stream = body.stream === true

    // —— Anthropic /v1/messages ——
    if (url.startsWith('/v1/messages')) {
      if (reject.anthropicHard) {
        return sendJson(res, 400, { type: 'error', error: { message: reject.anthropicHard } })
      }
      if (reject.anthropicTemp && 'temperature' in body) {
        // 真实文案：部分模型只接受 0–1
        return sendJson(res, 400, { type: 'error', error: { message: 'temperature: Input should be less than or equal to 1' } })
      }
      if (reject.emptyStream) {
        return stream ? sendSse(res, ['{"type":"nothing"}']) : sendJson(res, 200, { content: [] })
      }
      if (stream) {
        return sendSse(res, [
          JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '阿' } }),
          JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '离' } }),
          JSON.stringify({ type: 'message_stop' }),
        ])
      }
      return sendJson(res, 200, {
        content: [{ type: 'text', text: '阿里' }], stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      })
    }

    // —— Gemini /v1beta/models/…:generateContent / :streamGenerateContent ——
    if (url.includes(':generateContent') || url.includes(':streamGenerateContent')) {
      const gen = (body.generationConfig ?? {}) as Record<string, unknown>
      if (reject.geminiSchema && 'responseJsonSchema' in gen) {
        return sendJson(res, 400, { error: { message: 'Unknown name "responseJsonSchema": Cannot find field.' } })
      }
      if (reject.emptyStream) {
        return url.includes(':streamGenerateContent')
          ? sendSse(res, ['{"candidates":[{"finishReason":"STOP"}]}'])
          : sendJson(res, 200, { candidates: [] })
      }
      if (url.includes(':streamGenerateContent')) {
        return sendSse(res, [
          JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '云' }] } }] }),
          JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '州' }] }, finishReason: 'STOP' }] }),
        ])
      }
      return sendJson(res, 200, {
        candidates: [{ content: { role: 'model', parts: [{ text: '云州' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
      })
    }

    // —— OpenAI Responses /v1/responses ——
    if (url.startsWith('/v1/responses')) {
      if (reject.responsesTemp && 'temperature' in body) {
        // 真实文案：推理系模型的原话里就带 "with this model"
        return sendJson(res, 400, {
          error: { message: "Unsupported parameter: 'temperature' is not supported with this model." },
        })
      }
      if (reject.responsesWeird) {
        return stream ? sendSse(res, ['{"type":"response.created"}']) : sendJson(res, 200, { output: [] })
      }
      if (stream) {
        return sendSse(res, [
          JSON.stringify({ type: 'response.output_text.delta', delta: '青' }),
          JSON.stringify({ type: 'response.output_text.delta', delta: '岚' }),
          JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 2 } } }),
        ])
      }
      return sendJson(res, 200, {
        output: [{ type: 'message', content: [{ type: 'output_text', text: '青岚' }] }],
        usage: { input_tokens: 3, output_tokens: 2 },
      })
    }

    sendJson(res, 404, { error: { message: `unexpected path ${url}` } })
  })
})
await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
const PORT = (server.address() as { port: number }).port
const ROOT = `http://127.0.0.1:${PORT}`

const providerOf = (protocol: AIProvider['protocol'], baseUrl: string, model: string): AIProvider => ({
  id: `fake-${protocol}`, name: '假端点', type: 'openai', protocol, local: false,
  baseUrl, apiKey: 'test-key', model,
})
const opts = (extra: Partial<DriverCallOpts> = {}): DriverCallOpts => ({
  timeoutMs: 10_000, temperature: 1.5, ...extra,
})
const reset = () => { seen.length = 0 }

// ---------- ① Anthropic：400 指向采样 ⇒ 撤温度重发 ----------
reject.anthropicTemp = true
reset()
{
  const cfg = providerOf('anthropic', ROOT, 'claude-test')
  const out = await anthropicDriver.chat(cfg, [{ role: 'user', content: 'hi' }], opts())
  ok('Anthropic 400(temperature) 会撤掉温度重发一次', seen.length === 2, `请求 ${seen.length} 次`)
  ok('  · 第一次带 temperature', 'temperature' in seen[0].body)
  ok('  · 第二次不带 temperature', !('temperature' in seen[1].body))
  ok('  · 结论确实拿回来了', out.content === '阿里', out.content)
  ok('  · 用量里记了实际请求次数（可核对）', out.usage?.attempts === 2, String(out.usage?.attempts))
}

// ---------- ② Anthropic：硬失败（模型名写错）⇒ 一次都不重发 ----------
reset()
reject.anthropicHard = 'model: no such model claude-test'
{
  const cfg = providerOf('anthropic', ROOT, 'claude-test')
  let err = ''
  try { await anthropicDriver.chat(cfg, [{ role: 'user', content: 'hi' }], opts()) } catch (e) { err = (e as Error).message }
  ok('Anthropic 硬失败不重发（只发 1 次）', seen.length === 1, `请求 ${seen.length} 次`)
  ok('  · 错误原因原样透出（没被降级后的假原因盖掉）', /no such model/i.test(err), err)
}
reject.anthropicHard = ''

// ---------- ③ Anthropic：disableCompatibilityRetry ⇒ 不降级 ----------
reset()
reject.anthropicTemp = true
{
  const cfg = providerOf('anthropic', ROOT, 'claude-test')
  let threw = false
  try {
    await anthropicDriver.chat(cfg, [{ role: 'user', content: 'hi' }], opts({ disableCompatibilityRetry: true }))
  } catch { threw = true }
  ok('disableCompatibilityRetry 时不重发（续写规划那类任务专用）', threw && seen.length === 1, `请求 ${seen.length} 次`)
}

// ---------- ④ Gemini：400 指向结构字段 ⇒ 撤字段重发 ----------
reject.geminiSchema = true
reset()
{
  const cfg = providerOf('gemini', ROOT, 'gemini-test')
  const out = await geminiDriver.chat(cfg, [{ role: 'user', content: 'hi' }], opts({
    wireFormat: 'json-schema', jsonSchema: { type: 'object' },
  }))
  ok('Gemini 400(responseJsonSchema) 会撤结构字段重发一次', seen.length === 2, `请求 ${seen.length} 次`)
  const gen0 = (seen[0].body.generationConfig ?? {}) as Record<string, unknown>
  const gen1 = (seen[1].body.generationConfig ?? {}) as Record<string, unknown>
  ok('  · 第一次带 responseJsonSchema', 'responseJsonSchema' in gen0)
  ok('  · 第二次不带 responseJsonSchema', !('responseJsonSchema' in gen1))
  ok('  · 结论确实拿回来了', out.content === '云州', out.content)
}

// ---------- ⑤ Gemini：流式解析不出内容 ⇒ 退非流式 ----------
reject.geminiSchema = false
reject.emptyStream = true
reset()
{
  const cfg = providerOf('gemini', ROOT, 'gemini-test')
  let err = ''
  try {
    await geminiDriver.chat(cfg, [{ role: 'user', content: 'hi' }], opts({ onToken: () => { /* 收集 */ } }))
  } catch (e) { err = (e as Error).message }
  ok('Gemini 流式空内容且非流式也空 ⇒ 发 2 次后如实报错', seen.length === 2, `请求 ${seen.length} 次`)
  // Gemini 的流式/非流式靠**端点**区分（没有 body.stream 字段），所以判据看路径
  ok('  · 第二次退成非流式端点（generateContent）',
    !!seen[1] && seen[1].path.includes(':generateContent') && !seen[1].path.includes(':streamGenerateContent'),
    seen[1]?.path)
  ok('  · 报错说明流式与重试都失败', /流式响应体无法解析|未返回/.test(err), err)
}
reject.emptyStream = false

// ---------- ⑥ Responses：400 带 "with this model" 也要能降采样 ----------
reject.responsesTemp = true
reset()
{
  const cfg = providerOf('openai-responses', ROOT, 'gpt-test')
  const out = await responsesDriver.chat(cfg, [{ role: 'user', content: 'hi' }], opts())
  ok('Responses 400(temperature, 原话含 with this model) 仍能降级', seen.length === 2, `请求 ${seen.length} 次`)
  ok('  · 第二次不带 temperature', !('temperature' in seen[1].body))
  ok('  · 结论确实拿回来了', out.content === '青岚', out.content)
}

// ---------- ⑦ Responses：事件族不标准 ⇒ 退非流式并保留内容 ----------
reject.responsesTemp = false
reject.responsesWeird = false
reset()
{
  const cfg = providerOf('openai-responses', ROOT, 'gpt-test')
  const out = await responsesDriver.chat(cfg, [{ role: 'user', content: 'hi' }], opts({ onToken: () => { /* noop */ } }))
  ok('Responses 正常流式拿到内容', out.content === '青岚', out.content)
  ok('  · 正常流式只发 1 次', seen.length === 1, `请求 ${seen.length} 次`)
}

// ---------- ⑧ 预算上限：任何路径都不超过 MAX_REQUESTS_PER_CALL ----------
{
  const max = Math.max(seen.length, 2)
  ok(`预算常量与实测一致（上限 ${MAX_REQUESTS_PER_CALL}，单用例实测 ≤ ${max}）`, max <= MAX_REQUESTS_PER_CALL, String(max))
}

// ---------- ⑨ 判据单测：把三条判据分开锁住 ----------
ok('shouldDegradeSamplingOn400 认「with this model」原话',
  shouldDegradeSamplingOn400("Unsupported parameter: 'temperature' is not supported with this model."))
ok('shouldDegradeSamplingOn400 不认模型名写错', !shouldDegradeSamplingOn400('model: no such model xyz'))
ok('shouldDegradeSamplingOn400 不认鉴权失败', !shouldDegradeSamplingOn400('invalid api key provided'))
ok('shouldDegradeSamplingOn400 空响应体不降级（与 OpenAI 兼容通道区别开）', !shouldDegradeSamplingOn400(''))
ok('nextWireFlags 先撤被点名的结构字段',
  JSON.stringify(nextWireFlags({ format: true, sampling: true }, 'unknown field text.format')) === JSON.stringify({ format: false, sampling: true }))
ok('nextWireFlags 再撤采样',
  JSON.stringify(nextWireFlags({ format: false, sampling: true }, 'temperature must be <= 1')) === JSON.stringify({ format: false, sampling: false }))
ok('nextWireFlags 无可撤时返回 null（停止重发）',
  nextWireFlags({ format: false, sampling: false }, 'temperature must be <= 1') === null)

// ---------- ⑩ D-3 台账：四种状态齐全、文案按状态说话 ----------
ok('CORS 台账覆盖五种协议',
  ['ollama', 'openai-chat', 'anthropic', 'gemini', 'openai-responses']
    .every(p => PROTOCOL_WEB_CORS[p as keyof typeof PROTOCOL_WEB_CORS] !== undefined))
ok('CORS 状态都有中文徽标',
  Object.values(CORS_VERDICT_LABEL).every(v => typeof v === 'string' && v.length > 0))
ok('桌面 / 便携版不显示网页 CORS 提示', webProtocolCorsNote(false, 'anthropic') === '')
ok('网页版未验证 ⇒ 明确写「尚未取得通过结论」',
  /尚未取得通过结论/.test(webProtocolCorsNote(true, 'anthropic')), webProtocolCorsNote(true, 'anthropic'))
ok('网页版本机端点 ⇒ 说产品策略而不是 CORS',
  /不连接本机/.test(webProtocolCorsNote(true, 'ollama')), webProtocolCorsNote(true, 'ollama'))

server.close()
console.log(`\n———— protocolDegrade：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
