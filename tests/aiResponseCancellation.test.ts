// 真实 HTTP：收到响应头后正文迟迟不结束时，取消/超时仍必须生效。
import http from 'node:http'
import assert from 'node:assert/strict'
import { chat } from '../src/lib/aiCore/chat'
import { isCancelled } from '../src/lib/aiCore/transport'

let requests = 0
const server = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    requests++
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.write('{"choices":')
    const timer = setTimeout(() => {
      if (!res.destroyed) res.end('[{"message":{"content":"迟到内容"}}]}')
    }, 2000)
    res.on('close', () => clearTimeout(timer))
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address() as { port: number }
const provider = (protocol: 'ollama' | 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini') => ({
  id: 'slow', name: 'slow', type: protocol === 'ollama' ? 'ollama' as const : 'openai' as const,
  protocol, baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'synthetic', model: 'test-model', local: false, contextWindow: 32000,
})
const messages = [{ role: 'user' as const, content: '隔离测试' }]
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
try {
  for (const protocol of ['ollama', 'openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const) {
    const abort = new AbortController()
    const start = Date.now(), expected = requests + 1
    const pending = chat(provider(protocol), messages, { timeoutMs: 5000, signal: abort.signal }).then(
      value => ({ value }), error => ({ error }),
    )
    while (requests < expected && Date.now() - start < 3000) await delay(10)
    assert.equal(requests, expected, `${protocol} 本地模拟端点应收到一次请求`)
    await delay(100) // 响应头和部分正文已经到达
    abort.abort()
    const cancelled = await Promise.race([pending, delay(700).then(() => ({ pending: true }))])
    assert.ok('error' in cancelled && isCancelled(cancelled.error), `${protocol} 响应头后的取消未及时生效：${JSON.stringify(cancelled)}`)
  }

  const timeoutStart = Date.now()
  const timeout = await Promise.race([
    chat(provider('openai-chat'), messages, { timeoutMs: 180 }).then(value => ({ value }), error => ({ error })),
    delay(1000).then(() => ({ pending: true })),
  ])
  assert.ok('error' in timeout && /超时/.test(String(timeout.error)), `正文超时未生效：${JSON.stringify(timeout)}`)
  assert.ok(Date.now() - timeoutStart < 1000)
  console.log('AI_RESPONSE_CANCELLATION_PASS: headers received, body cancellation and timeout')
} finally {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
