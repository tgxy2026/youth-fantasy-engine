// 青春幻想引擎 · 网页体验版 反馈 / 邀请校验 / 云端同步 服务（零依赖，仅用 Node 内置模块）
// 职责：
//   POST /api/invite/check  { code }            -> 比对 INVITE_CODES 列表，200/403
//   POST /api/feedback      (multipart/JSON)    -> 落盘到 FEEDBACK_DIR，返回 200
//   GET  /api/sync                             -> 拉取云端快照（Bearer SYNC_CODES 之一鉴权）
//   POST /api/sync          { rev, enc }        -> 上传云端快照（rev 守卫，冲突 409）
//   GET  /healthz                            -> 200 ok
// 设计：仅收「用户主动提交的反馈」与「开启同步者的整库快照」，不建公开用户库。
// 云端同步数据以「每同步码一个文件」落盘（sync-<sha256>.json），rev 做乐观并发守卫；
// 每个同步邀请码对应一个独立云端槽位，避免多人共用一码互相覆盖。
import http from 'node:http'
import { appendFile, mkdir, writeFile, readFile, rename, unlink } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'

const PORT = Number(process.env.FEEDBACK_PORT || 3000)
const DATA_DIR = process.env.FEEDBACK_DIR || '/var/lib/yfe'

// 邀请码 / 同步码均支持「列表」（逗号或空白分隔），兼容旧的单值环境变量名。
// #027：归一化——去掉所有空白并升大写，使大小写 / 码内空格差异不影响匹配。
// 注意：现有码本就是 YFE-XXXX-XXXX 全大写无空格格式，归一化对其幂等，槽位哈希不变。
function normCode(s) {
  return String(s || '').replace(/\s+/g, '').toUpperCase()
}
function parseList(s) {
  return new Set(String(s || '').split(/[\s,]+/).map((x) => normCode(x)).filter(Boolean))
}
const INVITE_CODES = parseList(process.env.INVITE_CODES || process.env.INVITE_CODE)
const SYNC_CODES = parseList(process.env.SYNC_CODES || process.env.SYNC_CODE)

await mkdir(DATA_DIR, { recursive: true })
const FEEDBACK_FILE = DATA_DIR + '/feedback.jsonl'
// 访问/登录事件流水（每次邀请校验、每次云端同步调用都追加一行，供每日巡检汇总）
const ACCESS_FILE = DATA_DIR + '/access.jsonl'

// 同步码 → 独立云端槽位文件名（只存 hash，不暴露码本身）
function slotOf(code) {
  return createHash('sha256').update(String(code)).digest('hex')
}
function syncFileFor(code) {
  return `${DATA_DIR}/sync-${slotOf(code)}.json`
}

// 读取某同步码的云端快照（不存在返回空）。enc 为客户端加密后的载荷（服务端不可读）。
async function readSync(code) {
  try {
    const raw = await readFile(syncFileFor(code), 'utf8')
    const data = JSON.parse(raw)
    if (data && typeof data === 'object' && typeof data.enc === 'string' && data.enc.length) {
      return { rev: Number(data.rev) || 0, enc: data.enc }
    }
  } catch {
    /* 文件不存在或损坏 → 视为空 */
  }
  return { rev: 0, enc: undefined }
}

// 同步槽位串行写锁：同一槽位的 push 排队执行。
// 不加锁时两个并发 POST 会交错成 read(rev=5) → read(rev=5) → write(rev=6) → write(rev=6)，
// 后写的静默覆盖先写的，且 rev 不递增 —— 即「假成功 + 真丢数据」。
const slotLocks = new Map()
function withSlotLock(key, fn) {
  const prev = slotLocks.get(key) || Promise.resolve()
  let release = () => {}
  const done = new Promise((resolve) => { release = resolve })
  slotLocks.set(key, prev.then(() => done))
  return prev
    .catch(() => {})
    .then(fn)
    .finally(() => release())
}

// 校验同步码：返回码本身（用于定位槽位）或 null
function syncAuth(req) {
  const h = req.headers['authorization'] || ''
  const m = h.match(/^Bearer\s+(.+)$/i)
  if (!m) return null
  const code = normCode(m[1])
  return SYNC_CODES.has(code) ? code : null
}

// 鉴权失败时记录「客户端实际提交的码」的短哈希（不可逆，不泄露码本身），
// 用于诊断用户是把入门码当同步码、还是手滑打错字。
function providedCodeHash(req) {
  const h = req.headers['authorization'] || ''
  const m = h.match(/^Bearer\s+(.*)$/i)
  if (!m) return null
  const c = m[1].trim()
  return c ? createHash('sha256').update(c).digest('hex').slice(0, 12) : null
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

  // 邀请码校验：码只在服务端比较，不出现于客户端包；支持多个入门邀请码。
  if (req.method === 'POST' && req.url === '/api/invite/check') {
    const limited = rateGuard(req, 'invite', true)
    if (limited) {
      await logAccess(req, { type: 'invite', ok: false, act: 'rate-limited', retry: limited.retryAfter })
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(limited.retryAfter) })
      return res.end(JSON.stringify({ ok: false, error: 'too_many_attempts', retryAfter: limited.retryAfter }))
    }
    const body = await readJson(req)
    const code = body && typeof body.code === 'string' ? normCode(body.code) : ''
    if (INVITE_CODES.has(code)) {
      rateReset(req, 'invite')
      await logAccess(req, { type: 'invite', ok: true, act: 'enter', code })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end('{"ok":true}')
    }
    rateFail(req, 'invite')
    await logAccess(req, { type: 'invite', ok: false, act: 'reject', code })
    res.writeHead(403, { 'Content-Type': 'application/json' })
    return res.end('{"ok":false,"error":"invalid"}')
  }

  // 反馈提交：原样落盘（含可选附件），元数据+文本内容追加到 jsonl 便于检索
  if (req.method === 'POST' && req.url === '/api/feedback') {
    const buf = await readRaw(req, 8 * 1024 * 1024).catch(() => null)
    const id = randomUUID()
    const text = extractField(buf, 'text')
    const meta = {
      id,
      ts: new Date().toISOString(),
      ua: req.headers['user-agent'] || '',
      ip: req.socket.remoteAddress,
      bytes: buf ? buf.length : 0,
      text,
      hasFile: !!(buf && extractField(buf, 'file')),
    }
    if (buf) await writeFile(`${DATA_DIR}/fb-${id}.bin`, buf).catch(() => {})
    await appendFile(FEEDBACK_FILE, JSON.stringify(meta) + '\n').catch(() => {})
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end('{"ok":true}')
  }

  // ===== 云端同步（#003 同步特权）=====
  // 每个同步码对应独立云端槽位；enc 为客户端加密后的载荷。
  if (req.method === 'GET' && req.url === '/api/sync') {
    const limitedG = rateGuard(req, 'sync')
    if (limitedG) {
      await logAccess(req, { type: 'sync', ok: false, act: 'rate-limited', retry: limitedG.retryAfter })
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(limitedG.retryAfter) })
      return res.end(JSON.stringify({ ok: false, error: 'too_many_attempts', retryAfter: limitedG.retryAfter }))
    }
    const code = syncAuth(req)
    if (!code) {
      rateFail(req, 'sync')
      await logAccess(req, { type: 'sync', ok: false, act: 'authfail', method: 'GET', bad: providedCodeHash(req) })
      res.writeHead(401, { 'Content-Type': 'application/json' })
      return res.end('{"ok":false,"error":"unauthorized"}')
    }
    await logAccess(req, { type: 'sync', ok: true, act: 'pull', code: slotOf(code) })
    const snap = await readSync(code)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ rev: snap.rev, enc: snap.enc ?? null }))
  }

  if (req.method === 'POST' && req.url === '/api/sync') {
    const limitedP = rateGuard(req, 'sync')
    if (limitedP) {
      await logAccess(req, { type: 'sync', ok: false, act: 'rate-limited', retry: limitedP.retryAfter })
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(limitedP.retryAfter) })
      return res.end(JSON.stringify({ ok: false, error: 'too_many_attempts', retryAfter: limitedP.retryAfter }))
    }
    const code = syncAuth(req)
    if (!code) {
      rateFail(req, 'sync')
      await logAccess(req, { type: 'sync', ok: false, act: 'authfail', method: 'POST', bad: providedCodeHash(req) })
      res.writeHead(401, { 'Content-Type': 'application/json' })
      return res.end('{"ok":false,"error":"unauthorized"}')
    }
    const body = await readJson(req)
    if (!body || typeof body !== 'object' || typeof body.enc !== 'string' || !body.enc) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end('{"ok":false,"error":"bad_body"}')
    }
    // 串行化：同一槽位的「读 rev → 比对 → 写盘」必须原子完成，否则并发 push 会互相覆盖
    const outcome = await withSlotLock(slotOf(code), async () => {
      const cur = await readSync(code)
      const baseRev = Number(body.rev) || 0
      if (cur.rev !== baseRev) {
        // 版本不一致：返回当前云端快照，由客户端做本地优先合并后重推
        await logAccess(req, { type: 'sync', ok: false, act: 'conflict', code: slotOf(code), rev: cur.rev })
        return { status: 409, payload: { ok: false, conflict: true, rev: cur.rev, enc: cur.enc ?? null } }
      }
      const next = { rev: cur.rev + 1, enc: body.enc }
      const file = syncFileFor(code)
      const tmp = file + '.tmp'
      try {
        // 先写临时文件再 rename：避免写入中途失败留下半截快照
        await writeFile(tmp, JSON.stringify(next), 'utf8')
        await rename(tmp, file)
      } catch (err) {
        // 写盘失败必须如实上报。历史上这里曾 .catch(() => {}) 静默吞掉 EACCES，
        // 导致服务端返回「成功」而文件纹丝不动，故障被伪装了一整天。
        console.error('[yfe-sync] write failed', slotOf(code), err)
        await logAccess(req, { type: 'sync', ok: false, act: 'pushfail', code: slotOf(code), err: String((err && err.code) || err) })
        return { status: 500, payload: { ok: false, error: 'write_failed' } }
      }
      await logAccess(req, { type: 'sync', ok: true, act: 'push', code: slotOf(code), rev: next.rev })
      return { status: 200, payload: { ok: true, rev: next.rev } }
    })
    res.writeHead(outcome.status, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(outcome.payload))
  }

  res.writeHead(404)
  res.end()
})

// 取真实客户端 IP（nginx 经 X-Real-IP 透传；否则回退到 socket 地址）
function clientIp(req) {
  const x = req.headers['x-real-ip']
  return (x && x.trim()) || req.socket.remoteAddress || ''
}

// ============ 限流（零依赖，内存态）============
// 目的不是防暴力破解——邀请码空间 32^8 ≈ 1.1e12，穷举不可行。
// 真正要防的是：无限重试把 access.jsonl 刷爆（每次失败都落盘一行，
// 高频下一天可写满磁盘），以及脚本式骚扰占住事件循环。
const RATE_WINDOW_MS = 5 * 60 * 1000 // 失败计数窗口：5 分钟
const RATE_MAX_FAILS = 5 // 窗口内最多失败 5 次
const RATE_BLOCK_MS = 10 * 60 * 1000 // 触发后封锁 10 分钟
const RATE_BURST_WINDOW_MS = 60 * 1000 // 总频率窗口：1 分钟
const RATE_BURST_MAX = 60 // invite 校验每 IP 每分钟上限（sync 不适用：正常编辑本就高频）

// key = `ip:type`，invite 与 sync 分开计数，避免一边输错把另一边也锁死
const rateBuckets = new Map()

function rateState(req, type) {
  const now = Date.now()
  const k = `${clientIp(req)}:${type}`
  let b = rateBuckets.get(k)
  if (!b) {
    b = { fails: [], hits: [], blockedUntil: 0 }
    rateBuckets.set(k, b)
  }
  b.fails = b.fails.filter((t) => now - t < RATE_WINDOW_MS)
  b.hits = b.hits.filter((t) => now - t < RATE_BURST_WINDOW_MS)
  return b
}

/** 放行返回 null；被限流返回剩余封锁秒数。burst=true 时才统计总频率 */
function rateGuard(req, type, burst = false) {
  const now = Date.now()
  const b = rateState(req, type)
  if (b.blockedUntil > now) {
    return { retryAfter: Math.ceil((b.blockedUntil - now) / 1000) }
  }
  if (burst) {
    b.hits.push(now)
    if (b.hits.length > RATE_BURST_MAX) {
      b.blockedUntil = now + RATE_BLOCK_MS
      b.hits = []
      return { retryAfter: Math.ceil(RATE_BLOCK_MS / 1000) }
    }
  }
  return null
}

/** 记一次失败，达到阈值则封锁。返回是否刚触发封锁 */
function rateFail(req, type) {
  const now = Date.now()
  const b = rateState(req, type)
  b.fails.push(now)
  if (b.fails.length >= RATE_MAX_FAILS) {
    b.blockedUntil = now + RATE_BLOCK_MS
    b.fails = []
    return true
  }
  return false
}

/** 成功后清零失败计数，避免正常用户被历史误输拖累 */
function rateReset(req, type) {
  const b = rateBuckets.get(`${clientIp(req)}:${type}`)
  if (b) {
    b.fails = []
    b.blockedUntil = 0
  }
}

// 定期清理过期桶，防止 Map 随访问 IP 无限增长
setInterval(() => {
  const now = Date.now()
  for (const [k, b] of rateBuckets) {
    const idleFail = !b.fails.length || now - b.fails[b.fails.length - 1] > RATE_WINDOW_MS
    const idleHit = !b.hits.length || now - b.hits[b.hits.length - 1] > RATE_BURST_WINDOW_MS
    if (b.blockedUntil < now && idleFail && idleHit) rateBuckets.delete(k)
  }
}, 10 * 60 * 1000).unref?.()

// 访问/登录事件流水：每次邀请校验与云端同步调用都追加一行（id 便于每日巡检增量收录）
async function logAccess(req, extra) {
  const line = JSON.stringify({
    id: randomUUID(),
    ts: new Date().toISOString(),
    ip: clientIp(req),
    ua: req.headers['user-agent'] || '',
    ...extra,
  })
  await appendFile(ACCESS_FILE, line + '\n').catch(() => {})
}

// 从 multipart 表单体中抽取某个字段的文本值（用于把反馈正文写入 jsonl，便于直读）
function extractField(buf, name) {
  if (!buf) return ''
  const s = buf.toString('utf8')
  const m = s.match(new RegExp(`name="${name}"[^]*?\\r\\n\\r\\n(.*?)\\r\\n--`, 's'))
  return m ? m[1].trim() : ''
}

function readJson(req) {
  // 放宽到 20MB：nginx 已在 /api/sync 放开 client_max_body_size，此处不能再用 1MB 截断，
  // 否则大项目推送会在 1MB 处被截、JSON.parse 失败返回 400（且 400 分支未记日志，难排查）。
  return readRaw(req, 20 * 1024 * 1024)
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

// 启动自检：确认数据目录可写。
// 历史上槽位文件属主被误设为 root，www-data 无写权限，而 push 又把 EACCES 静默吞掉，
// 结果「日志显示推送成功、文件纹丝不动」，故障潜伏一整天无人察觉。
const probe = `${DATA_DIR}/.write-probe`
try {
  await writeFile(probe, String(Date.now()), 'utf8')
  await readFile(probe, 'utf8')
  await unlink(probe)
  console.log(`[yfe-feedback] write-probe OK: ${DATA_DIR} 可写`)
} catch (err) {
  console.error(`[yfe-feedback] FATAL: 数据目录不可写 ${DATA_DIR} —— 同步推送将全部失败`, err)
}

server.listen(PORT, () => console.log(`[yfe-feedback] listening on :${PORT}, data=${DATA_DIR}, inviteCodes=${INVITE_CODES.size}, syncCodes=${SYNC_CODES.size}`))
