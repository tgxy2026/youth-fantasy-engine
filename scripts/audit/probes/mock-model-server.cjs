#!/usr/bin/env node
/**
 * 假模型服务（OpenAI 兼容，3.2.1 T-01/T-03 取证用）
 *
 * 为什么要有它：AI-01（拒答与取消分开呈现）、AI-06（首字分布）这类验收只能靠
 * **可控的失败注入**跑出来 —— 真实端点既不可控，也不该为了一次验收去烧额度。
 * 🔴 本服务只证明「给定这种响应，客户端怎么呈现」；真实端点验证仍须主人提供端点与额度。
 *
 * 用法：
 *   node scripts/audit/probes/mock-model-server.cjs --port 8799
 *
 * 控制端点（取证脚本调用）：
 *   POST /_mode   {"mode":"normal|refusal|slow|cancel|http400|http401|empty"}   设当前模式
 *   GET  /_stats  返回每次请求的记录（含首字节时间，用于首字分布）
 *   POST /_reset  清空记录
 *
 * 兼容端点：
 *   GET  /v1/models              返回一个假模型（应用可能先探测）
 *   POST /v1/chat/completions    按 mode 行为返回（流式 / 非流式都支持）
 */
'use strict'
const http = require('node:http')

const argOf = (flag, dflt) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const PORT = Number(argOf('--port', '8799'))
const HOST = '127.0.0.1'

/** 当前模式 + 请求记录 */
let mode = 'normal'
let seq = 0
const requests = []

const BODY_NORMAL = ['夜色沉沉，山风顺着崖壁压下来。', '他握紧了剑柄，指节发白。']
const BODY_REFUSAL = '抱歉，我无法协助这个请求。'
const BODY_LONG = Array.from({ length: 12 }, (_, i) => `第${i + 1}段：这是一段用于测试取消的较长输出。`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function sseChunk(text, extra = {}) {
  return `data: ${JSON.stringify({
    id: 'mock-1', object: 'chat.completion.chunk', model: 'mock-model',
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    ...extra,
  })}\n\n`
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  const json = (obj, code = 200) => {
    const body = JSON.stringify(obj)
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  }

  // ---------- 控制面 ----------
  if (url.pathname === '/_mode' && req.method === 'POST') {
    let raw = ''
    for await (const c of req) raw += c
    try { mode = (JSON.parse(raw || '{}').mode || 'normal') } catch { mode = 'normal' }
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, mode }))
  }
  if (url.pathname === '/_stats') return json({ mode, requests })
  if (url.pathname === '/_reset' && req.method === 'POST') { requests.length = 0; return json({ ok: true }) }

  // ---------- 兼容面 ----------
  if (url.pathname === '/v1/models') {
    return json({ object: 'list', data: [{ id: 'mock-model', object: 'model', owned_by: 'yef-mock' }] })
  }
  if (!url.pathname.endsWith('/chat/completions')) return json({ error: { message: 'not found' } }, 404)

  let raw = ''
  for await (const c of req) raw += c
  let payload = {}
  try { payload = JSON.parse(raw || '{}') } catch { /* 忽略 */ }
  const stream = payload.stream === true
  const rec = {
    n: ++seq,
    mode,
    stream,
    model: payload.model ?? null,
    messages: Array.isArray(payload.messages) ? payload.messages.length : 0,
    lastUser: (() => { const arr = Array.isArray(payload.messages) ? payload.messages : []; const u = [...arr].reverse().find(x => x && x.role === 'user'); return String(u?.content ?? '').slice(0, 80) })(),
    responded: null,
    arrivedAt: Date.now(),
    firstByteAt: null,
    doneAt: null,
  }
  requests.push(rec)

  const markFirst = () => { if (!rec.firstByteAt) rec.firstByteAt = Date.now() }

  // 直接失败类
  if (mode === 'http400') {
    markFirst()
    rec.responded = '400'
    return json({ error: { message: '内容政策不允许：该请求触发了平台安全策略' } }, 400)
  }
  if (mode === 'http401') {
    markFirst()
    return json({ error: { message: 'invalid api key' } }, 401)
  }

  if (!stream) {
    // slow 模式在**非流式**下同样要慢 —— 否则首字统计全是 0ms（假数据）
    if (mode === 'slow') await sleep(2500)
    const content = mode === 'refusal' ? BODY_REFUSAL : mode === 'empty' ? '' : BODY_NORMAL.join('')
    markFirst()
    rec.responded = 'json'
    rec.doneAt = Date.now()
    return json({
      id: 'mock-1', object: 'chat.completion', model: 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    })
  }

  // 流式
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const firstDelay = mode === 'slow' ? 2500 : 30
  await sleep(firstDelay)
  if (res.destroyed) { rec.doneAt = Date.now(); return }

  if (mode === 'refusal') {
    markFirst()
    rec.responded = 'sse-refusal'
    res.write(sseChunk(BODY_REFUSAL))
    await sleep(20)
    res.write('data: [DONE]\n\n')
    rec.doneAt = Date.now()
    return res.end()
  }
  if (mode === 'empty') {
    markFirst()
    res.write('data: [DONE]\n\n')
    rec.doneAt = Date.now()
    return res.end()
  }

  markFirst()
  const chunks = mode === 'cancel' ? BODY_LONG : BODY_NORMAL
  const gap = mode === 'cancel' ? 600 : 40
  for (const c of chunks) {
    if (res.destroyed) break
    res.write(sseChunk(c))
    await sleep(gap)
  }
  if (!res.destroyed) res.write('data: [DONE]\n\n')
  rec.doneAt = Date.now()
  res.end()
})

server.listen(PORT, HOST, () => {
  console.log(`[mock-model] listening on http://${HOST}:${PORT}/v1  (mode=${mode})`)
})
