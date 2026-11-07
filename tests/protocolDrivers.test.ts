// 3.4.2 · 多协议 driver 纵切 · 单测
//
// 用受控假端点逐协议验证：请求路径 / 鉴权头 / system 槽位 / 角色映射 / SSE 事件族 /
// 用量解析 / 中途报错 / 无结束哨兵。🔴 解析失败不得静默当成功。
import http from 'node:http'
import { chat } from '../src/lib/aiCore/chat'
import { isCancelled } from '../src/lib/aiCore/transport'
import { protocolOf } from '../src/lib/aiCore/protocol'
import { driverFor, listModelsFor, capabilitiesOfProtocol } from '../src/lib/aiCore/protocols'
import type { AIProvider } from '../src/lib/aiCore/core'
import { OLLAMA_PRESET, ONLINE_PRESETS, providerFromPreset } from '../src/lib/aiCore/core'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
const anthEvent = (type: string, obj: unknown) => `event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`

type Mode = 'anthropic-json' | 'anthropic-stream' | 'anthropic-error' | 'anthropic-unknown-events' | 'slow-anthropic'
  | 'gemini-json' | 'gemini-stream' | 'gemini-blocked'
  | 'responses-json' | 'responses-stream' | 'responses-failed'
  | 'legacy-ollama' | 'legacy-openai'
  | 'parity-anthropic' | 'parity-openai'

let mode: Mode = 'anthropic-json'
let lastUrl = ''
let lastHeaders: http.IncomingHttpHeaders = {}
let lastBody: Record<string, unknown> = {}
const sent: { url: string; body: Record<string, unknown> }[] = []
let hits = 0

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    hits++
    lastUrl = req.url ?? ''
    lastHeaders = req.headers
    try { lastBody = JSON.parse(raw) as Record<string, unknown> } catch { lastBody = {} }
    sent.push({ url: lastUrl, body: lastBody })
    const json = (obj: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    const stream = (chunks: string[]) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const c of chunks) res.write(c)
      res.end()
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        data: [
          { id: 'claude-active', lifecycle: 'active' },
          { id: 'claude-retired', lifecycle: 'retired' },
        ],
      }))
      return
    }
    if (req.method === 'GET' && req.url === '/v1beta/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        models: [
          { name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding', supportedGenerationMethods: ['embedContent'] },
        ],
      }))
      return
    }
    if (mode === 'parity-anthropic') {
      if (lastBody.stream === true) {
        return stream([
          anthEvent('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: '第一段' } }),
          anthEvent('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: '第二段' } }),
          anthEvent('message_stop', { type: 'message_stop' }),
        ])
      }
      return json({ content: [{ type: 'text', text: '{"a":1}' }], usage: { input_tokens: 1, output_tokens: 1 } })
    }
    if (mode === 'parity-openai') {
      if (lastBody.stream === true) {
        return stream([
          sse({ choices: [{ delta: { content: '第一段' } }] }),
          sse({ choices: [{ delta: { content: '第二段' } }] }),
          'data: [DONE]\n\n',
        ])
      }
      return json({ choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    }
    if (mode === 'legacy-ollama') {
      return json({ message: { content: '旧版' }, done: true, prompt_eval_count: 1, eval_count: 1 })
    }
    if (mode === 'legacy-openai') {
      return json({ choices: [{ message: { content: '旧版' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    }
    if (mode === 'anthropic-unknown-events') {
      return stream([
        anthEvent('message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } }),
        anthEvent('ping', { type: 'ping' }),
        anthEvent('some_future_event', { type: 'some_future_event', note: 'ignore me' }),
        anthEvent('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: '仍可用' } }),
        anthEvent('message_stop', { type: 'message_stop' }),
      ])
    }
    if (mode === 'slow-anthropic') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(anthEvent('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: '半截' } }))
      setTimeout(() => {
        try {
          res.write(anthEvent('message_stop', { type: 'message_stop' }))
          res.end()
        } catch { /* 客户端已取消 */ }
      }, 300)
      return
    }
    if (mode === 'anthropic-json') {
      return json({ id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'text', text: '你好' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } })
    }
    if (mode === 'anthropic-stream') {
      return stream([
        anthEvent('message_start', { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } }),
        anthEvent('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: '你' } }),
        anthEvent('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: '好' } }),
        anthEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
        anthEvent('message_stop', { type: 'message_stop' }),
      ])
    }
    if (mode === 'anthropic-error') {
      return stream([
        anthEvent('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: '半截' } }),
        anthEvent('error', { type: 'error', error: { type: 'overloaded_error', message: 'boom' } }),
      ])
    }
    if (mode === 'gemini-json') {
      return json({ candidates: [{ content: { role: 'model', parts: [{ text: '你好' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } })
    }
    if (mode === 'gemini-stream') {
      return stream([
        sse({ candidates: [{ content: { role: 'model', parts: [{ text: '你' }] } }] }),
        sse({ candidates: [{ content: { role: 'model', parts: [{ text: '好' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }),
      ])
    }
    if (mode === 'gemini-blocked') {
      return json({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] })
    }
    if (mode === 'responses-json') {
      return json({ id: 'r1', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '你好' }] }], usage: { input_tokens: 10, output_tokens: 5 } })
    }
    if (mode === 'responses-stream') {
      return stream([
        sse({ type: 'response.created', response: {} }),
        sse({ type: 'response.output_text.delta', delta: '你' }),
        sse({ type: 'response.output_text.delta', delta: '好' }),
        sse({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 5 } } }),
      ])
    }
    // responses-failed
    return stream([sse({ type: 'response.failed', response: { error: { message: 'failed-boom' } } })])
  })
})

function providerOf(protocol: AIProvider['protocol']): AIProvider {
  return {
    id: 'p-test', name: 'test', type: protocol === 'ollama' ? 'ollama' : 'openai',
    ...(protocol ? { protocol } : {}),
    baseUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key', model: 'test-model',
    local: false, contextWindow: 32000,
  }
}

let port = 0
async function run(): Promise<void> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => {
    port = (server.address() as { port: number }).port
    resolve()
  }))
  const msgs = [
    { role: 'system' as const, content: '系统规则' },
    { role: 'user' as const, content: '第一问' },
    { role: 'assistant' as const, content: '第一答' },
    { role: 'user' as const, content: '第二问' },
  ]

  // ---------- 路由与注册 ----------
  ok('protocolOf：旧数据 type=ollama ⇒ ollama', protocolOf({ type: 'ollama' }) === 'ollama')
  ok('protocolOf：旧数据 type=openai ⇒ openai-chat', protocolOf({ type: 'openai' }) === 'openai-chat')
  ok('protocolOf：显式 protocol 优先', protocolOf({ type: 'openai', protocol: 'gemini' }) === 'gemini')
  ok('注册表：五个协议都有 driver',
    ['ollama', 'openai-chat', 'anthropic', 'gemini', 'openai-responses'].every(p => !!driverFor(p as never)))
  ok('能力声明：五个协议都有完整字段',
    ['ollama', 'openai-chat', 'anthropic', 'gemini', 'openai-responses'].every(p => {
      const c = capabilitiesOfProtocol(p as never)
      return !!c && typeof c.stream === 'boolean' && typeof c.cancel === 'boolean'
        && typeof c.multiTurn === 'boolean' && typeof c.embedding === 'boolean'
        && ['low', 'medium', 'high'].includes(c.latency) && typeof c.unattended === 'boolean'
        && ['local', 'subscription', 'metered', 'unknown'].includes(c.quota)
    }))
  ok('能力声明：Anthropic 无 embedding', capabilitiesOfProtocol('anthropic')?.embedding === false)
  ok('能力声明：Ollama 是本地额度', capabilitiesOfProtocol('ollama')?.quota === 'local')

  // ---------- 预设写入侧：protocol 与旧存储键 ----------
  const presetOf = (label: string) => ONLINE_PRESETS.find(p => p.label === label)!
  const anth = providerFromPreset(presetOf('Anthropic Claude'))
  ok('预设写入：Anthropic protocol + 旧存储键 type=openai + 非本地',
    anth.protocol === 'anthropic' && anth.type === 'openai' && anth.local === false,
    `${anth.protocol}/${anth.type}/${anth.local}`)
  const gem = providerFromPreset(presetOf('Google Gemini'))
  ok('预设写入：Gemini protocol', gem.protocol === 'gemini' && gem.type === 'openai')
  const resp = providerFromPreset(presetOf('OpenAI Responses'))
  ok('预设写入：Responses protocol', resp.protocol === 'openai-responses' && resp.type === 'openai')
  const olla = providerFromPreset(OLLAMA_PRESET)
  ok('预设写入：Ollama protocol=ollama',
    olla.protocol === 'ollama' && olla.type === 'ollama' && olla.local === true)
  const custom = providerFromPreset(presetOf('自定义'))
  ok('预设写入：自定义默认 openai-chat', custom.protocol === 'openai-chat' && custom.type === 'openai')

  // ---------- Anthropic ----------
  mode = 'anthropic-json'
  let out = await chat(providerOf('anthropic'), msgs, { timeoutMs: 5000 })
  ok('Anthropic 非流式：正文', out === '你好', out)
  ok('Anthropic：端点 /v1/messages', lastUrl === '/v1/messages', lastUrl)
  ok('Anthropic：x-api-key + anthropic-version',
    lastHeaders['x-api-key'] === 'test-key' && typeof lastHeaders['anthropic-version'] === 'string')
  ok('Anthropic：system 在顶层', lastBody.system === '系统规则')
  ok('Anthropic：messages 去掉 system 且保留角色',
    Array.isArray(lastBody.messages) && (lastBody.messages as { role: string }[]).every(m => m.role !== 'system')
    && (lastBody.messages as { role: string }[]).length === 3)
  ok('Anthropic：max_tokens 必然下发', typeof lastBody.max_tokens === 'number')
  ok('Anthropic：不擅自下发结构字段', !('output_config' in lastBody))

  mode = 'anthropic-stream'
  const aTokens: string[] = []
  out = await chat(providerOf('anthropic'), msgs, { timeoutMs: 5000, onToken: t => aTokens.push(t) })
  ok('Anthropic 流式：逐段回调', aTokens.join('') === '你好', aTokens.join('|'))
  ok('Anthropic 流式：message_stop 收尾后返回完整正文', out === '你好', out)

  mode = 'anthropic-error'
  let threw = ''
  try { await chat(providerOf('anthropic'), msgs, { timeoutMs: 5000, onToken: () => {} }) } catch (e) { threw = String((e as Error).message) }
  ok('Anthropic 流内 error ⇒ 抛错（不静默当成功）', threw.includes('boom'), threw)

  // ---------- Gemini ----------
  mode = 'gemini-json'
  out = await chat(providerOf('gemini'), msgs, { timeoutMs: 5000 })
  ok('Gemini 非流式：正文', out === '你好', out)
  ok('Gemini：端点 /v1beta/models/{model}:generateContent',
    lastUrl.startsWith('/v1beta/models/test-model:generateContent'), lastUrl)
  ok('Gemini：x-goog-api-key', lastHeaders['x-goog-api-key'] === 'test-key')
  ok('Gemini：systemInstruction 在顶层', !!lastBody.systemInstruction)
  ok('Gemini：assistant 映射为 model',
    ((lastBody.contents as { role?: string }[]) ?? []).some(c => c.role === 'model'))
  ok('Gemini：不擅自下发 responseMimeType',
    !('responseMimeType' in ((lastBody.generationConfig as Record<string, unknown>) ?? {})))

  mode = 'gemini-stream'
  const gTokens: string[] = []
  out = await chat(providerOf('gemini'), msgs, { timeoutMs: 5000, onToken: t => gTokens.push(t) })
  ok('Gemini 流式：独立端点 + alt=sse',
    lastUrl.includes(':streamGenerateContent') && lastUrl.includes('alt=sse'), lastUrl)
  ok('Gemini 流式：无结束哨兵也能逐段收完', gTokens.join('') === '你好', gTokens.join('|'))
  ok('Gemini 流式：返回完整正文', out === '你好', out)

  mode = 'gemini-blocked'
  threw = ''
  try { await chat(providerOf('gemini'), msgs, { timeoutMs: 5000 }) } catch (e) { threw = String((e as Error).message) }
  ok('Gemini：promptFeedback.blockReason ⇒ 抛错', threw.includes('SAFETY') || threw.includes('拒绝'), threw)

  // ---------- Responses ----------
  mode = 'responses-json'
  out = await chat(providerOf('openai-responses'), msgs, { timeoutMs: 5000 })
  ok('Responses 非流式：正文', out === '你好', out)
  ok('Responses：端点 /v1/responses', lastUrl === '/v1/responses', lastUrl)
  ok('Responses：Bearer 鉴权', lastHeaders.authorization === 'Bearer test-key')
  ok('Responses：instructions 在顶层', lastBody.instructions === '系统规则')
  ok('Responses：input 去掉 system',
    Array.isArray(lastBody.input) && (lastBody.input as { role: string }[]).length === 3)
  ok('Responses：不擅自下发 text.format', !('text' in lastBody))

  mode = 'responses-stream'
  const rTokens: string[] = []
  out = await chat(providerOf('openai-responses'), msgs, { timeoutMs: 5000, onToken: t => rTokens.push(t) })
  ok('Responses 流式：具名事件逐段回调', rTokens.join('') === '你好', rTokens.join('|'))
  ok('Responses 流式：completed 后返回完整正文', out === '你好', out)

  mode = 'responses-failed'
  threw = ''
  try { await chat(providerOf('openai-responses'), msgs, { timeoutMs: 5000, onToken: () => {} }) } catch (e) { threw = String((e as Error).message) }
  ok('Responses：response.failed ⇒ 抛错', threw.includes('failed-boom'), threw)

  // ---------- 3.4.1 旧配置（无 protocol）路由 ----------
  mode = 'legacy-ollama'
  out = await chat({ ...providerOf('ollama'), protocol: undefined }, msgs, { timeoutMs: 5000 })
  ok('旧配置 type=ollama 无 protocol ⇒ 仍走 /api/chat', lastUrl === '/api/chat', lastUrl)
  ok('旧配置 Ollama 正文', out === '旧版', out)

  mode = 'legacy-openai'
  out = await chat({ ...providerOf('openai-chat'), protocol: undefined }, msgs, { timeoutMs: 5000 })
  ok('旧配置 type=openai 无 protocol ⇒ 仍走 /chat/completions', lastUrl === '/chat/completions', lastUrl)
  ok('旧配置 OpenAI 正文', out === '旧版', out)

  // ---------- 未知 SSE 事件优雅忽略 ----------
  mode = 'anthropic-unknown-events'
  const uTokens: string[] = []
  out = await chat(providerOf('anthropic'), msgs, { timeoutMs: 5000, onToken: t => uTokens.push(t) })
  ok('Anthropic 未知事件 / ping 被优雅忽略，正文不受影响', uTokens.join('') === '仍可用' && out === '仍可用', `${uTokens.join('|')} / ${out}`)

  // ---------- 取消保留可识别信号 ----------
  mode = 'slow-anthropic'
  const ac = new AbortController()
  const pending = chat(providerOf('anthropic'), msgs, { timeoutMs: 5000, signal: ac.signal, onToken: () => {} })
  setTimeout(() => ac.abort(), 60)
  let cancelled = false
  let cancelErr = ''
  try { await pending } catch (e) { cancelled = isCancelled(e); cancelErr = `${(e as Error)?.name}: ${String((e as Error)?.message)}` }
  ok('Anthropic 流式中途取消 ⇒ AICancelled', cancelled, cancelErr)

  // ---------- 结构化能力已确认：按官方字段下发 ----------
  mode = 'gemini-json'
  await chat({ ...providerOf('gemini'), structuredOutput: 'json-object' }, msgs, { timeoutMs: 5000, output: 'json-object' })
  const gen = (lastBody.generationConfig as Record<string, unknown>) ?? {}
  ok('Gemini 确认 json-object 能力后下发 responseMimeType', gen.responseMimeType === 'application/json', JSON.stringify(gen))

  const schema = {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  }

  mode = 'parity-anthropic'
  await chat({ ...providerOf('anthropic'), structuredOutput: 'json-schema' }, msgs, { timeoutMs: 5000, output: 'json-schema', schema })
  const aStruct = (sent[sent.length - 1].body.output_config as { format?: { type?: string; schema?: unknown } } | undefined)?.format
  ok('Anthropic json-schema ⇒ output_config.format', aStruct?.type === 'json_schema' && JSON.stringify(aStruct?.schema) === JSON.stringify(schema), JSON.stringify(aStruct))

  mode = 'parity-anthropic'
  await chat({ ...providerOf('anthropic'), structuredOutput: 'json-object' }, msgs, { timeoutMs: 5000, output: 'json-object' })
  ok('Anthropic json-object 不下发（该协议只支持带 schema 的格式）', !('output_config' in sent[sent.length - 1].body))

  mode = 'gemini-json'
  await chat({ ...providerOf('gemini'), structuredOutput: 'json-schema' }, msgs, { timeoutMs: 5000, output: 'json-schema', schema })
  const gStruct = (sent[sent.length - 1].body.generationConfig as Record<string, unknown>) ?? {}
  ok('Gemini json-schema ⇒ responseMimeType + responseJsonSchema',
    gStruct.responseMimeType === 'application/json' && JSON.stringify(gStruct.responseJsonSchema) === JSON.stringify(schema), JSON.stringify(gStruct))

  mode = 'responses-json'
  await chat({ ...providerOf('openai-responses'), structuredOutput: 'json-schema' }, msgs, { timeoutMs: 5000, output: 'json-schema', schema })
  const rStruct = (sent[sent.length - 1].body.text as { format?: { type?: string; schema?: unknown } } | undefined)?.format
  ok('Responses json-schema ⇒ text.format', rStruct?.type === 'json_schema' && JSON.stringify(rStruct?.schema) === JSON.stringify(schema), JSON.stringify(rStruct))

  mode = 'responses-json'
  await chat({ ...providerOf('openai-responses'), structuredOutput: 'json-object' }, msgs, { timeoutMs: 5000, output: 'json-object' })
  const rStruct2 = (sent[sent.length - 1].body.text as { format?: { type?: string } } | undefined)?.format
  ok('Responses json-object ⇒ text.format json_object', rStruct2?.type === 'json_object', JSON.stringify(rStruct2))

  // ---------- 三类抽样：提示词内容与解析键名不因协议变化 ----------
  const parityMsgs = [
    { role: 'system' as const, content: '固定系统规则' },
    { role: 'user' as const, content: '第一问' },
    { role: 'assistant' as const, content: '第一答' },
    { role: 'user' as const, content: '第二问' },
  ]
  mode = 'parity-anthropic'
  const aOut = await chat(providerOf('anthropic'), parityMsgs, { timeoutMs: 5000, output: 'json-object' })
  const aReq = sent[sent.length - 1]
  mode = 'parity-openai'
  const oOut = await chat(providerOf('openai-chat'), parityMsgs, { timeoutMs: 5000, output: 'json-object' })
  const oReq = sent[sent.length - 1]
  const aMsgs = (aReq.body.messages ?? []) as { role: string; content: string }[]
  const oMsgs = (oReq.body.messages ?? []) as { role: string; content: string }[]
  const oRest = oMsgs.filter(m => m.role !== 'system')
  ok('A 类 JSON：同一请求跨协议返回相同文本', aOut === oOut && aOut === '{"a":1}', `${aOut} / ${oOut}`)
  ok('A 类 JSON：system 内容逐字一致', aReq.body.system === oMsgs[0]?.content, `${String(aReq.body.system)} / ${oMsgs[0]?.content}`)
  ok('A 类 JSON：非 system 消息内容与顺序逐字一致',
    JSON.stringify(aMsgs.map(m => m.content)) === JSON.stringify(oRest.map(m => m.content)))
  ok('C 类多轮：角色序列等价（顶层 system vs messages 内 system）',
    JSON.stringify(aMsgs.map(m => m.role)) === JSON.stringify(['user', 'assistant', 'user'])
    && JSON.stringify(oMsgs.map(m => m.role)) === JSON.stringify(['system', 'user', 'assistant', 'user']))

  mode = 'parity-anthropic'
  const aParts: string[] = []
  await chat(providerOf('anthropic'), parityMsgs, { timeoutMs: 5000, onToken: t => aParts.push(t) })
  mode = 'parity-openai'
  const oParts: string[] = []
  await chat(providerOf('openai-chat'), parityMsgs, { timeoutMs: 5000, onToken: t => oParts.push(t) })
  ok('B 类长文流式：跨协议片段拼接一致',
    aParts.join('') === oParts.join('') && aParts.join('') === '第一段第二段', `${aParts.join('|')} / ${oParts.join('|')}`)

  // ---------- 模型清单：按协议走各自端点 ----------
  const aModels = await listModelsFor(providerOf('anthropic'))
  ok('Anthropic 模型清单：GET /v1/models，过滤 retired', JSON.stringify(aModels) === JSON.stringify(['claude-active']), JSON.stringify(aModels))
  ok('Anthropic 模型清单：带 x-api-key + anthropic-version',
    lastHeaders['x-api-key'] === 'test-key' && typeof lastHeaders['anthropic-version'] === 'string')

  const gModels = await listModelsFor(providerOf('gemini'))
  ok('Gemini 模型清单：GET /v1beta/models，过滤非 generateContent 并去前缀',
    JSON.stringify(gModels) === JSON.stringify(['gemini-a']), JSON.stringify(gModels))
  ok('Gemini 模型清单：带 x-goog-api-key', lastHeaders['x-goog-api-key'] === 'test-key')

  // ---------- 未登记协议 ----------
  const bogus = { ...providerOf('openai-chat'), protocol: 'bogus' } as unknown as AIProvider
  threw = ''
  try { await chat(bogus, msgs, { timeoutMs: 5000 }) } catch (e) { threw = String((e as Error).message) }
  ok('未登记协议在发送前明确报错（不静默退回 OpenAI 兼容）', threw.includes('暂不支持'), threw)

  console.log(`\n———— protocolDrivers：${pass} 通过 / ${fail} 失败 ————`)
  server.close()
  if (fail > 0) process.exit(1)
}

run().catch(e => { console.log('FAIL 未捕获异常:', e?.stack ?? e); server.close(); process.exit(1) })