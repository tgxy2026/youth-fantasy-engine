// 青春幻想引擎 · 网页体验版 反馈 / 邀请校验 服务（零依赖，仅用 Node 内置模块）
// 职责：
//   POST /api/invite/check  { code }            -> 比对 INVITE_CODE，200/403
//   POST /api/feedback      (multipart/JSON)    -> 落盘到 FEEDBACK_DIR，返回 200
//   GET  /healthz                            -> 200 ok
// 设计：仅收「用户主动提交的反馈」，不建用户库、不存任何项目创作内容。
import http from 'node:http'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const PORT = Number(process.env.FEEDBACK_PORT || 3000)
const DATA_DIR = process.env.FEEDBACK_DIR || '/var/lib/yfe'
const INVITE_CODE = process.env.INVITE_CODE || ''

await mkdir(DATA_DIR, { recursive: true })
const FEEDBACK_FILE = DATA_DIR + '/feedback.jsonl'

const server = http.createServer(async (req, res) => {
  // 同源一般无需 CORS；保留 OPTIONS 预检以便本地调试
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    return res.end('ok')
  }

  // 邀请码校验：码只在服务端比较，不出现于客户端包
  if (req.method === 'POST' && req.url === '/api/invite/check') {
    const body = await readJson(req)
    if (body && typeof body.code === 'string' && INVITE_CODE && body.code === INVITE_CODE) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end('{"ok":true}')
    }
    res.writeHead(403, { 'Content-Type': 'application/json' })
    return res.end('{"ok":false,"error":"invalid"}')
  }

  // 反馈提交：原样落盘（含可选附件），元数据追加到 jsonl 便于检索
  if (req.method === 'POST' && req.url === '/api/feedback') {
    const buf = await readRaw(req, 8 * 1024 * 1024).catch(() => null)
    const id = randomUUID()
    const meta = {
      id,
      ts: new Date().toISOString(),
      ua: req.headers['user-agent'] || '',
      ip: req.socket.remoteAddress,
      bytes: buf ? buf.length : 0,
    }
    if (buf) await writeFile(`${DATA_DIR}/fb-${id}.bin`, buf).catch(() => {})
    await appendFile(FEEDBACK_FILE, JSON.stringify(meta) + '\n').catch(() => {})
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end('{"ok":true}')
  }

  res.writeHead(404)
  res.end()
})

function readJson(req) {
  return readRaw(req, 1 * 1024 * 1024)
    .then((b) => {
      try {
        return JSON.parse(b.toString('utf8'))
      } catch {
        return null
      }
    })
    .catch(() => null)
}

function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > max) {
        req.destroy()
        reject(new Error('too large'))
      } else {
        chunks.push(c)
      }
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

server.listen(PORT, () => console.log(`[yfe-feedback] listening on :${PORT}, data=${DATA_DIR}`))
