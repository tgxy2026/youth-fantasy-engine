// 青春幻想引擎 · 网页体验版 反馈 / 邀请校验 / 云端同步 服务（零依赖，仅用 Node 内置模块）
// 职责：
//   POST /api/invite/check  { code }            -> 比对 INVITE_CODE，200/403
//   POST /api/feedback      (multipart/JSON)    -> 落盘到 FEEDBACK_DIR，返回 200
//   GET  /api/sync                             -> 拉取云端快照（Bearer SYNC_CODE 鉴权）
//   POST /api/sync          { rev, stores }     -> 上传云端快照（rev 守卫，冲突 409）
//   GET  /healthz                            -> 200 ok
// 设计：仅收「用户主动提交的反馈」与「开启同步者的整库快照」，不建公开用户库。
// 云端同步数据以单文件（sync.json）落盘，rev 做乐观并发守卫；多设备并发以最后写入为准。
import http from 'node:http'
import { appendFile, mkdir, writeFile, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const PORT = Number(process.env.FEEDBACK_PORT || 3000)
const DATA_DIR = process.env.FEEDBACK_DIR || '/var/lib/yfe'
const INVITE_CODE = process.env.INVITE_CODE || ''
const SYNC_CODE = process.env.SYNC_CODE || ''

await mkdir(DATA_DIR, { recursive: true })
const FEEDBACK_FILE = DATA_DIR + '/feedback.jsonl'
const SYNC_FILE = DATA_DIR + '/sync.json'

// 读取云端快照（不存在返回空）
async function readSync() {
  try {
    const raw = await readFile(SYNC_FILE, 'utf8')
    const data = JSON.parse(raw)
    if (data && typeof data === 'object' && data.stores && typeof data.stores === 'object' && !Array.isArray(data.stores)) {
      return { rev: Number(data.rev) || 0, stores: data.stores }
    }
  } catch {
    /* 文件不存在或损坏 → 视为空 */
  }
  return { rev: 0, stores: {} }
}

function syncAuth(req) {
  const h = req.headers['authorization'] || ''
  return SYNC_CODE !== '' && h === `Bearer ${SYNC_CODE}`
}

const server = http.createServer(async (req, res) => {
  // 同源一般无需 CORS；保留 OPTIONS 预检以便本地调试
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
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

  // ===== 云端同步（#003 同步特权）=====
  if (req.method === 'GET' && req.url === '/api/sync') {
    if (!syncAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      return res.end('{"ok":false,"error":"unauthorized"}')
    }
    const snap = await readSync()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(snap))
  }

  if (req.method === 'POST' && req.url === '/api/sync') {
    if (!syncAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      return res.end('{"ok":false,"error":"unauthorized"}')
    }
    const body = await readJson(req)
    if (!body || typeof body !== 'object' || !body.stores || typeof body.stores !== 'object' || Array.isArray(body.stores)) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end('{"ok":false,"error":"bad_body"}')
    }
    const cur = await readSync()
    const baseRev = Number(body.rev) || 0
    if (cur.rev !== baseRev) {
      // 版本不一致：返回当前云端快照，让客户端采用云端版本（last-write-wins）
      res.writeHead(409, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, conflict: true, ...cur }))
    }
    const next = { rev: cur.rev + 1, stores: body.stores }
    await writeFile(SYNC_FILE, JSON.stringify(next), 'utf8').catch(() => {})
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, rev: next.rev }))
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
