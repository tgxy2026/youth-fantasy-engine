// 3.3.3 · B-04 实机验证用的假 OpenAI 兼容端点（**仅供隔离测试**）
//
// 用法：`node scripts/verify/mock-openai-endpoint.mjs`（MOCK_PORT / MOCK_DELAY_MS / MOCK_LOG 可调）
// 模型配置：type=openai、baseUrl=http://127.0.0.1:18080/v1、apiKey 随意、model=mock-1
//
// 目的：让创意写作/拆书在真实浏览器里跑起来，但不出网、不计费、可控制时机（便于中途强杀）。
// 🔴 不接真实书库、不代表模型质量；只证明链路与请求行为。
import http from 'node:http'
import fs from 'node:fs'

const PORT = Number(process.env.MOCK_PORT || 18080)
const LOG = process.env.MOCK_LOG || '.workbuddy/tmp/mock-openai-requests.log'
const DELAY_MS = Number(process.env.MOCK_DELAY_MS || 800)
/** 让第 N 次「抽取类」请求返回 500（A-06 用：50 单元里第 37 个失败） */
const FAIL_AT = Number(process.env.MOCK_FAIL_AT || 0)
let extractSeq = 0

/** 生成一段"像正文"的中文，长度可控，便于验证字数与段落 */
function prose(seed, chars = 600) {
  const base = [
    '风从山谷里翻上来，带着湿冷的土腥味。',
    '他站在断崖边，指节因用力而发白。',
    '远处传来钟声，一下，又一下，像有人在数着什么。',
    '她没有回头，只把斗笠压得更低。',
    '"再往前，就没有回头路了。"他说。',
    '"本来也没有。"她答。',
  ]
  let out = `【${seed}】`
  let i = 0
  while (out.length < chars) out += base[i++ % base.length]
  return out
}

function logRequest(kind, body) {
  const line = `\n=== ${new Date().toISOString()} ${kind} ===\n${JSON.stringify(body).slice(0, 4000)}\n`
  try { fs.appendFileSync(LOG, line) } catch { /* 日志失败不影响响应 */ }
}

function wantsJson(body) {
  if (body?.response_format) return true
  const text = (body?.messages ?? []).map((m) => m.content ?? '').join('\n')
  return /JSON|json/.test(text) && /输出|返回|格式/.test(text)
}

function jsonAnswer(promptText) {
  // 「设定奠基」：结构照抄 src/lib/aiTasks/creative.ts 的 bibleSys（不得增删键名）
  if (/设定架构师/.test(promptText)) {
    return JSON.stringify({
      characters: [
        { name: '沈砚', tier: '主要', desc: '替人记仇的抄书人，记性极好', identity: '抄书人', traits: '谨慎、记仇', realm: '凡人', faction: '无', special: '过目不忘' },
        { name: '柳七', tier: '次要', desc: '王朝末年的密探，专盯仇契', identity: '密探', traits: '多疑', realm: '凡人', faction: '缉事司', special: '易容' },
      ],
      factions: [{ name: '缉事司', desc: '王朝末年的秘密缉查机构', category: '隐秘组织', leader: '都督魏衡', relationToMain: '追捕主角' }],
      locations: [{ name: '断碑巷', desc: '京城里专替人抄书立契的巷子', category: '城市', parent: '京城' }],
      terms: [{ name: '仇契', desc: '记在纸上就必须由记仇人偿还的契约', category: '其他' }],
      items: [{ name: '玄铁墨锭', desc: '写下的字十年不褪', category: '材料', grade: '凡品' }],
    })
  }
  // 「拆书抽取」：返回**对象数组** [{type,name,aliases,desc,evidence}]，type 必须命中 ENTITY_TYPES
  if (/抽取|实体/.test(promptText) && !/分卷大纲.{0,5}逐章细纲/.test(promptText)) {
    const m = promptText.match(/第(\d+)章/)
    const n = m ? m[1] : '0'
    return JSON.stringify([
      { type: '人物', name: `测试人物${n}`, aliases: [], desc: `第${n}章出场`, evidence: `原文：测试人物${n}` },
      { type: '地点', name: `测试地点${n}`, aliases: [], desc: `第${n}章场景`, evidence: `原文：测试地点${n}` },
    ])
  }
  // 「分卷大纲」：结构照抄 planOutlineSys（volumes[] + chapters[]）
  if (/分卷大纲.{0,5}逐章细纲/.test(promptText)) {
    const m = promptText.match(/共\s*(\d+)\s*章/)
    const total = m ? Math.min(Number(m[1]), 30) : 5
    const chapters = Array.from({ length: total }, (_, i) => ({
      title: `第${i + 1}节·断碑巷${i + 1}`,
      event: `沈砚替人讨第 ${i + 1} 笔仇，牵出缉事司的旧案。`,
      function: i === 0 ? '推进主线' : (i % 3 === 0 ? '爽点' : '铺垫'),
      cast: '沈砚、柳七',
      hook: `第 ${i + 1} 章末：仇契上多出一行陌生的名字。`,
      scenes: ['断碑巷的雨夜', '缉事司后堂'],
    }))
    return JSON.stringify({
      volumes: [{
        title: '卷一·断碑',
        positioning: '抄书人被卷进王朝末年的仇契旧案',
        stage: '凡人→初入修行',
        scope: '京城与断碑巷一带',
        opening: '沈砚只想安稳抄书',
        climax1: '第一笔仇找上门',
        turn: '仇契背后的名字指向自己',
        climax2: '缉事司围巷',
        ending: '沈砚带着半张仇契出城',
        events: '讨仇→被追→揭旧案→出城',
        subplots: '柳七的真实立场',
      }],
      chapters,
    })
  }
  if (/JSON\s*数组|返回\s*\[\]/i.test(promptText)) return '[]'
  return JSON.stringify({ ok: true, items: [] })
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '600',
}

const server = http.createServer((req, res) => {
  const url = req.url || '/'

  // 浏览器先发预检；不回 CORS 头就会 ERR_FAILED
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    res.end()
    return
  }

  if (req.method === 'GET' && /\/models$/.test(url)) {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-1', object: 'model' }] }))
    return
  }

  if (req.method !== 'POST' || !/\/chat\/completions$/.test(url)) {
    res.writeHead(404, { 'Content-Type': 'application/json', ...CORS })
    res.end(JSON.stringify({ error: { message: 'not found' } }))
    return
  }

  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    let body = {}
    try { body = JSON.parse(raw) } catch { /* 保留空对象 */ }
    logRequest((/抽取|实体|单元/.test((body.messages ?? []).map((m) => m.content ?? '').join('\n')) ? 'chat-extract' : 'chat'), body)

    const promptText = (body.messages ?? []).map((m) => m.content ?? '').join('\n')

    // 抽取类请求单独计数，便于精确模拟"第 37 个单元失败"
    const isExtract = /抽取|实体|单元/.test(promptText)
    if (isExtract) extractSeq++
    if (FAIL_AT && isExtract && extractSeq === FAIL_AT) {
      logRequest('chat-FAIL#' + extractSeq, body)
      res.writeHead(500, { 'Content-Type': 'application/json', ...CORS })
      res.end(JSON.stringify({ error: { message: `mock 注入失败：第 ${extractSeq} 个抽取单元`, type: 'mock_fail' } }))
      return
    }
    // 提示词里明确要 JSON 的阶段（设定奠基 / 分卷大纲）走结构；写正文的阶段给正文
    const asksProse = /写正文|正文片段|本章正文|续写正文|接着写/.test(promptText)
    const proseSystem = /续写助手/.test(body.messages?.[0]?.content || '')
    const reviewSystem = /连续性审查专家|人设监督编辑|伏笔管理专家/.test(body.messages?.[0]?.content || '')
    const askJson = reviewSystem || (!proseSystem && (!asksProse || /抽取|实体/.test(promptText)))
    const wantJson = askJson && (!!body.response_format || /设定架构师|分卷大纲与逐章细纲|只输出 JSON|JSON 结构|抽取|实体/.test(promptText))
    const content = reviewSystem ? '[]' : wantJson ? jsonAnswer(promptText) : prose('续写', 900)
    const stream = !!body.stream

    const finish = () => {
      if (!stream) {
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS })
        res.end(JSON.stringify({
          id: 'mock-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000),
          model: body.model || 'mock-1',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
        }))
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...CORS,
      })
      // 分 6 片吐出，模拟流式
      const chunkSize = Math.ceil(content.length / 6)
      for (let i = 0; i < content.length; i += chunkSize) {
        const piece = content.slice(i, i + chunkSize)
        res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`)
      }
      res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    }

    setTimeout(finish, DELAY_MS)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock openai ready: http://127.0.0.1:${PORT}/v1  (delay=${DELAY_MS}ms, log=${LOG})`)
})
