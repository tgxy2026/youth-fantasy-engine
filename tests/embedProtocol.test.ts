// 3.4.2 · Gemini embedding 旁路 · 单测
//
// 验证：官方 batchEmbedContents 路径 / 鉴权 / 请求体 / 响应解析；
// 配置解析与状态判定（Anthropic 明确不支持）；旧 Ollama / OpenAI 行为不回归。
import http from 'node:http'
import { embedTexts, embedPath, parseEmbedResponse, type EmbedConfig } from '../src/lib/semantic/embed'
import { embeddingStatus, resolveEmbedConfig, type EmbeddingSettings } from '../src/lib/semantic/settings'
import type { AIProvider } from '../src/lib/aiCore/core'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

let port = 0
let lastUrl = ''
let lastHeaders: http.IncomingHttpHeaders = {}
let lastBody: Record<string, unknown> = {}

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    lastUrl = req.url ?? ''
    lastHeaders = req.headers
    try { lastBody = JSON.parse(raw) as Record<string, unknown> } catch { lastBody = {} }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ embeddings: [{ values: [1, 2, 3] }, { values: [4, 5, 6] }] }))
  })
})

const cfg = (): EmbedConfig => ({
  type: 'gemini',
  baseUrl: `http://127.0.0.1:${port}`,
  apiKey: 'test-key',
  model: 'gemini-embedding-001',
})

async function run(): Promise<void> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => {
    port = (server.address() as { port: number }).port
    resolve()
  }))

  // ---------- 纯函数 ----------
  ok('embedPath Gemini 走 batchEmbedContents',
    embedPath({ type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-embedding-001' })
    === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents')
  ok('embedPath 已带 /v1beta 不重复拼接',
    embedPath({ type: 'gemini', baseUrl: 'https://x/v1beta', model: 'm' }) === 'https://x/v1beta/models/m:batchEmbedContents')
  ok('parseEmbedResponse Gemini 取 embeddings[].values',
    JSON.stringify(parseEmbedResponse('gemini', { embeddings: [{ values: [1, 2] }, { values: [3, 4] }] })) === '[[1,2],[3,4]]')
  ok('旧 OpenAI 路径不回归',
    embedPath({ type: 'openai', baseUrl: 'https://api.x.com/v1/' }) === 'https://api.x.com/v1/embeddings')
  ok('旧 OpenAI 解析不回归',
    JSON.stringify(parseEmbedResponse('openai', { data: [{ embedding: [1, 2], index: 0 }] })) === '[[1,2]]')

  // ---------- 实请求 ----------
  const r = await embedTexts(['甲', '乙'], cfg())
  ok('Gemini embedTexts 成功', r.ok && r.dim === 3 && r.vectors?.length === 2, JSON.stringify(r))
  ok('Gemini 请求路径', lastUrl === '/v1beta/models/gemini-embedding-001:batchEmbedContents', lastUrl)
  ok('Gemini 鉴权头 x-goog-api-key', lastHeaders['x-goog-api-key'] === 'test-key')
  const reqs = (lastBody.requests ?? []) as { model?: string; content?: { parts?: { text?: string }[] } }[]
  ok('Gemini 请求体 requests[].content.parts[].text',
    reqs.length === 2 && reqs[0]?.model === 'models/gemini-embedding-001' && reqs[0]?.content?.parts?.[0]?.text === '甲',
    JSON.stringify(reqs))

  // ---------- 配置解析与状态 ----------
  const geminiProvider: AIProvider = {
    id: 'p1', name: 'g', type: 'openai', protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'k', model: 'm', local: false,
  }
  const set: EmbeddingSettings = { providerId: 'p1', model: 'gemini-embedding-001', autoIndexOnSave: false }
  const resolved = await resolveEmbedConfig(set, [geminiProvider])
  ok('resolveEmbedConfig Gemini ⇒ type=gemini', resolved?.type === 'gemini', JSON.stringify(resolved))

  const anthropic: AIProvider = { ...geminiProvider, protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' }
  ok('resolveEmbedConfig Anthropic ⇒ null', (await resolveEmbedConfig(set, [anthropic])) === null)

  const stGem = await embeddingStatus(set, [geminiProvider])
  ok('embeddingStatus Gemini 可用', stGem.ready, JSON.stringify(stGem))
  const stAnth = await embeddingStatus(set, [anthropic])
  ok('embeddingStatus Anthropic 明确拒绝',
    !stAnth.ready && stAnth.reason.includes('Anthropic'), JSON.stringify(stAnth))

  // ---------- 缺密钥 ----------
  const bad = await embedTexts(['x'], { ...cfg(), apiKey: '' })
  ok('Gemini 缺密钥直接失败', !bad.ok && String(bad.error).includes('API 密钥'), JSON.stringify(bad))

  console.log(`\n———— embedProtocol：${pass} 通过 / ${fail} 失败 ————`)
  server.close()
  if (fail > 0) process.exit(1)
}

run().catch(e => { console.log('FAIL 未捕获异常:', e?.stack ?? e); server.close(); process.exit(1) })