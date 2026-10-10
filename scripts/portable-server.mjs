// ============ 便携版本地服务（scripts/portable-server.mjs）============
//
// 【它是什么】极简 Node 本地服务，为「U 盘便携版」提供三件事：
//   ① 静态托管前端产物（`dist/`）；
//   ② 数据读写 API（`GET/PUT /api/data`）—— 把整库 JSON 落盘到**应用目录内的 `./data`**；
//   ③ 自动打开系统默认浏览器到 `http://127.0.0.1:<port>`。
//
// 【为什么必须是「本地服务 + 浏览器客户端」，而不是单文件 HTML】
//   便携版硬性要求「项目数据跟脚本、源代码在**同一个文件夹内**」。
//   · 浏览器 IndexedDB 落在浏览器 profile，不跟随 U 盘 ⇒ 排除；
//   · File System Access API 需用户手势、仅在 Chromium、跨机权限重置 ⇒ 不满足「双击即用」；
//   · 浏览器里的 JS 又**不能直接写应用目录**。
//   ⇒ 唯一可行解：由 Node 服务落盘（它能写应用目录），浏览器只做客户端。这就是本文件。
//
// 【为什么不用老路（vite-plugin-singlefile）】
//   老便携版把 JS/CSS 全内联进单个 HTML，但数据仍走 FSA —— 同样不满足「同目录数据」。
//   且该插件已于 2.9.0 作为死依赖移除。故按「效果优先」重建（见 docs/3.0-开发方案.md §9）。
//
// 【安全边界（本地服务的基本自觉）】
//   · **只绑 127.0.0.1**，不绑 0.0.0.0 —— 否则同局域网任何人都能读你的小说数据。
//   · PUT 载荷上限（防误传超大内容把内存吃满）。
//   · 静态托管做**路径穿越**防护（.. 归一化后必须落在 dist 内）。
//   · 数据文件名固定，不接受客户端指定路径。
//
// 【用法】
//   node scripts/portable-server.mjs                 # 用默认端口（自动探测可用）
//   node scripts/portable-server.mjs --port 8765     # 指定端口
//   node scripts/portable-server.mjs --no-open       # 不自动开浏览器（CI / 排查用）
//   node scripts/portable-server.mjs --root <dir>    # 指定应用根目录（默认＝本脚本上一级）
'use strict'

import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, createReadStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const out = { port: 0, open: true, root: path.dirname(__dirname) }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') out.port = Number(argv[++i]) || 0
    else if (a === '--no-open') out.open = false
    else if (a === '--root') out.root = path.resolve(argv[++i] || '')
  }
  return out
}
const ARGS = parseArgs(process.argv.slice(2))

const APP_ROOT = ARGS.root
const DIST_DIR = path.join(APP_ROOT, 'dist')
const DATA_DIR = path.join(APP_ROOT, 'data')
const DATA_FILE = path.join(DATA_DIR, 'youth-fantasy-engine-data.json')
const TMP_FILE = path.join(DATA_DIR, '.data.json.tmp')
const PORT_LOCK = path.join(DATA_DIR, '.port')
/** 载荷上限：512 MiB（整库 JSON；正常小说库远小于此，超了就是异常） */
const MAX_BODY = 512 * 1024 * 1024

function log(...a) { console.log('[portable]', ...a) }
function fail(msg, code = 1) { console.error('[portable] ❌', msg); process.exit(code) }

// ---------- 前置检查 ----------
if (!existsSync(DIST_DIR) || !existsSync(path.join(DIST_DIR, 'index.html'))) {
  fail(
    `未找到前端产物：${DIST_DIR}\\index.html\n` +
    `  请先在项目里执行 \`npm run build:portable\`，或确认「便携版」目录内已含构建产物。`,
  )
}
mkdirSync(DATA_DIR, { recursive: true })

// ---------- 防多开：端口锁 ----------
// 同一 U 盘被双击两次启动时，第二个实例若起在别的端口，两个客户端会各持一份内存 cache
// 交替写同一个数据文件 ⇒ 互相覆盖。这里用 `./data/.port` 记录在跑的端口：若能连上就复用、不再起服务。
async function probeExisting() {
  try {
    if (!existsSync(PORT_LOCK)) return null
    const p = Number(readFileSync(PORT_LOCK, 'utf8').trim())
    if (!p) return null
    // 能 ping 通 ⇒ 已有一个实例在跑，复用它的端口（别再起第二个，免得两份 cache 互相覆盖）
    const ok = await fetch(`http://127.0.0.1:${p}/api/ping`, { signal: AbortSignal.timeout(800) })
      .then(r => r.ok)
      .catch(() => false)
    return ok ? p : null
  } catch { return null }
}

// ---------- 端口探测 ----------
async function pickPort(preferred) {
  const isFree = (p) => new Promise(resolve => {
    const s = createServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => s.close(() => resolve(true)))
    s.listen(p, '127.0.0.1')
  })
  if (preferred && await isFree(preferred)) return preferred
  // 默认从 8765 起试（避开 dev 常用的 3000/5173/5199）
  for (let p = preferred || 8765; p < (preferred || 8765) + 50; p++) {
    if (await isFree(p)) return p
  }
  throw new Error('在 127.0.0.1 上找不到可用端口')
}

// ---------- 静态托管 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json; charset=utf-8',
}

/**
 * 把 URL 路径解析成 dist 内的真实文件路径；越界返回 null。
 * 🔴 路径穿越防护：`path.normalize` 之后必须仍以 DIST_DIR 开头（`..%2f` 之类也要挡住）。
 */
function resolveStatic(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0])
  if (p === '/' || p === '') p = '/index.html'
  const abs = path.normalize(path.join(DIST_DIR, p))
  const rel = path.relative(DIST_DIR, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return abs
}

/** 往 index.html 注入便携标记（供前端 `PORTABLE` 判定，见 fileBackend.ts） */
function injectPortableFlag(html, port) {
  const flag = `<script>window.__YFE_PORTABLE__={apiBase:''};window.__YFE_PORTABLE_PORT__=${port};</script>`
  if (html.includes('</head>')) return html.replace('</head>', `${flag}</head>`)
  return flag + html
}

// ---------- HTTP 服务 ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let len = 0
    req.on('data', (c) => {
      len += c.length
      if (len > MAX_BODY) { reject(new Error('请求体过大（超过 512 MiB）')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 原子写：先写 .tmp 再 rename（与桌面版同口径，防断电/同步中断留半个文件） */
function atomicWrite(text) {
  writeFileSync(TMP_FILE, text, 'utf8')
  try { renameSync(TMP_FILE, DATA_FILE) } catch (e) {
    // Windows 上 rename 覆盖已存在文件是允许的（会替换）；失败一般是文件被占用
    throw new Error(`写入数据文件失败（可能被网盘客户端占用）：${e.message}`)
  }
}

const server = createServer(async (req, res) => {
  const url = req.url || '/'

  // ---- API ----
  if (url.startsWith('/api/')) {
    // 只允许本机访问（双保险：绑定已是 127.0.0.1，这里再查一次 Host/来源）
    try {
      if (url === '/api/ping') return sendJson(res, 200, { ok: true, app: 'youth-fantasy-engine' })

      if (url.startsWith('/api/data')) {
        if (req.method === 'GET') {
          if (!existsSync(DATA_FILE)) {
            // 404 = 首次使用（文件还不存在），前端据此按空库启动，**不是错误**
            return sendJson(res, 404, { missing: true, path: DATA_FILE })
          }
          const text = readFileSync(DATA_FILE, 'utf8')
          return sendJson(res, 200, { text, path: DATA_FILE })
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          const buf = await readBody(req)
          const text = buf.toString('utf8')
          // 最小校验：必须是本软件的 PortableData（kind 必查），挡住误写
          try {
            const o = JSON.parse(text)
            if (!o || o.kind !== 'portable-data') {
              return sendJson(res, 400, { ok: false, error: '不是有效的便携数据（缺少 kind="portable-data"）' })
            }
          } catch {
            return sendJson(res, 400, { ok: false, error: '请求体不是有效 JSON' })
          }
          atomicWrite(text)
          return sendJson(res, 200, { ok: true, path: DATA_FILE })
        }
        return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      }

      return sendJson(res, 404, { ok: false, error: 'unknown api' })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // ---- 静态 ----
  const abs = resolveStatic(url)
  if (!abs || !existsSync(abs) || !statSync(abs).isFile()) {
    // SPA 兜底：未知路径回 index.html（前端路由用）
    const idx = path.join(DIST_DIR, 'index.html')
    if (existsSync(idx)) {
      const html = injectPortableFlag(readFileSync(idx, 'utf8'), PORT)
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' })
      return res.end(html)
    }
    res.writeHead(404); return res.end('Not Found')
  }
  const ext = path.extname(abs).toLowerCase()
  if (ext === '.html') {
    const html = injectPortableFlag(readFileSync(abs, 'utf8'), PORT)
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' })
    return res.end(html)
  }
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    // 静态资源（带 hash 文件名）可长缓存；index.html 已单独 no-store
    'Cache-Control': ext === '.map' ? 'no-store' : 'public, max-age=31536000',
  })
  createReadStream(abs).pipe(res)
})

// ---------- 打开浏览器 ----------
function openBrowser(url) {
  try {
    const platform = process.platform
    if (platform === 'win32') {
      // Windows：`start` 是 cmd 内建命令，须经 cmd /c；空标题参数防止把 URL 当窗口标题
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
    } else if (platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
    return true
  } catch (e) {
    log('⚠️ 自动打开浏览器失败（请手动访问上面的地址）：', e.message)
    return false
  }
}

// ---------- 启动 ----------
let PORT = 0

async function main() {
  const existing = await probeExisting()
  if (existing) {
    const url = `http://127.0.0.1:${existing}`
    log(`检测到本便携版已在运行（端口 ${existing}）—— 直接复用，不再另起一个实例（防两个客户端互相覆盖数据）。`)
    log(`地址：${url}`)
    if (ARGS.open) openBrowser(url)
    return
  }

  PORT = await pickPort(ARGS.port)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(PORT, '127.0.0.1', resolve)
  })

  writeFileSync(PORT_LOCK, String(PORT), 'utf8')
  const url = `http://127.0.0.1:${PORT}`

  log('==================================================')
  log('  青春幻想引擎 · 便携版已启动')
  log(`  地址：${url}`)
  log(`  数据：${DATA_FILE}`)
  log('  （关闭本窗口即停止服务；数据已随时落盘到上面这个文件）')
  log('==================================================')

  if (ARGS.open) {
    const ok = openBrowser(url)
    if (!ok) log(`请手动在浏览器打开：${url}`)
  }

  const shutdown = () => {
    try { if (existsSync(PORT_LOCK)) writeFileSync(PORT_LOCK, '', 'utf8') } catch { /* 忽略 */ }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(e => fail(e instanceof Error ? e.message : String(e)))
