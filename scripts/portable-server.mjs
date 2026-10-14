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
//   · 🔴 **校验 Host 头**：只绑 127.0.0.1 **挡不住 DNS rebinding** —— 恶意网页可以让受害者的
//     浏览器向 `127.0.0.1:<port>` 发请求（请求确实从本机发出，绑定检查放行），此时 Host 头是
//     `evil.com`。本服务无任何鉴权 ⇒ 不加这道校验，任意网页都能 GET 走你全部稿件、PUT 覆盖它。
//     故每个请求都查 Host 必须是 127.0.0.1 / localhost / [::1]（可带端口），否则 403。
//   · PUT 载荷上限（防误传超大内容把内存吃满），超限回 **413**（不直接断开，否则前端只看到
//     "fetch failed"，无法告诉作者「你的库太大了」）。
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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync, createReadStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

// 【路径解析】直接用 import.meta.url 定位本脚本所在目录。
//   （2026-10-14：Node SEA 单文件 exe 方案已放弃 —— 原因见 memory/2026-10-14.md。
//     若将来恢复，把下面这行改回 try/catch + process.execPath 兜底即可；
//     三条踩坑实测结论见 `.workbuddy/portable-sea/2026-10-13-便携版免安装改造-实施记录.md`（历史记录）。
let __here = path.dirname(fileURLToPath(import.meta.url))

/**
 * 默认应用根目录：优先取「自身或上一级含 `dist/index.html`」的那一层 ——
 * 本脚本在 `scripts/` 下，应用根是它的上一级；直接放在应用根旁也能认出来。
 * 🔴 只在**没传 `--root`** 时生效；启动脚本/快捷方式传了参数就以参数为准。
 */
function defaultRoot() {
  if (existsSync(path.join(__here, 'dist', 'index.html'))) return __here
  const up = path.dirname(__here)
  if (existsSync(path.join(up, 'dist', 'index.html'))) return up
  return up
}

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const out = { port: 0, open: true, root: defaultRoot() }
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
/**
 * 外置大块数据（sidecar）目录：`data/blobs/<store>/<id>.json`。
 *
 * 【为什么要有它】备份载荷（每份 = 一个项目的整包正文，写完就再也不变）原先躺在整库 JSON 里，
 * 于是作者每敲一个字都要重传上百 MB 完全没动过的历史 —— 便携版会撞上 MAX_BODY，桌面版则每次
 * 防抖写盘都卡。挪出来之后，主 JSON 只留元数据，写盘体积降一个数量级。
 *
 * 🔴 对外契约**不变**：导入 / 导出仍是单文件（导出时内联回单文件，导入后拆开）。
 *    这里只改磁盘物理布局，不是新的数据格式。
 */
const BLOB_DIR = path.join(DATA_DIR, 'blobs')
/**
 * 允许外置的 store 白名单 —— 🔴 这是**安全边界**，不是配置项。
 * `store` / `id` 都会进文件路径，若放行任意字符串就是赤裸裸的路径穿越（`../../xxx`）。
 * 故两边都按「登记过的名字 + 受限字符集」双重校验，非法一律拒绝。
 */
const BLOB_STORES = new Set(['backupPayloads', 'vecRows', 'kbDocs', 'kbBodies'])
/** id 字符集：真实主键是 uid（字母数字）或 whole 布局的固定键 `__all__` */
const BLOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** 载荷上限：512 MiB（整库 JSON；正常小说库远小于此，超了就是异常） */
const MAX_BODY = 512 * 1024 * 1024

/**
 * 解析外置记录的文件路径；**任何不合法都返回 null**（调用方回 400）。
 * 三重校验：store 在白名单内 → id 字符集合法 → 归一化后仍落在 BLOB_DIR 内。
 */
function resolveBlobPath(store, id) {
  if (typeof store !== 'string' || !BLOB_STORES.has(store)) return null
  if (typeof id !== 'string' || !BLOB_ID_RE.test(id)) return null
  const abs = path.normalize(path.join(BLOB_DIR, store, `${id}.json`))
  const rel = path.relative(BLOB_DIR, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return abs
}

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
 * 🔴 校验请求来自本机（防 DNS rebinding）。
 *
 * 「只绑 127.0.0.1」挡不住这类攻击：请求由**受害者自己的浏览器**发出，源 IP 就是本机，
 * 绑定检查必然放行；唯一能区分「本软件页面」与「evil.com 的页面」的可信信号是 **Host 头**
 * （以及 Origin / Referer，但它们对 GET 常缺失；Host 一定在）。
 * ⇒ 放行条件：Host 的主机名部分是 127.0.0.1 / localhost / [::1]（端口任意）。
 */
function isLocalHost(req) {
  const host = (req.headers.host || '').trim().toLowerCase()
  if (!host) return false
  // 去掉端口：IPv6 是 [::1]:8765 形式，不能用冒号直接切
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
}

/**
 * 把 URL 路径解析成 dist 内的真实文件路径；越界返回 null。
 * 🔴 路径穿越防护：`path.normalize` 之后必须仍以 DIST_DIR 开头（`..%2f` 之类也要挡住）。
 * 🔴 `decodeURIComponent` 对**畸形百分号编码**（如 `/%`、`/%E0%A4%A`）会抛 `URIError` ——
 *    实测确认。它不是"构造不出来的输入"：浏览器/爬虫/手工输错都会产生。原先没兜住 ⇒
 *    一个异常直接把整个服务进程打挂（作者正在写的稿子因此丢窗口）。改为解码失败即拒绝。
 */
function resolveStatic(urlPath) {
  let p
  try {
    p = decodeURIComponent(urlPath.split('?')[0])
  } catch {
    return null
  }
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

/**
 * 读请求体。超限时不 `req.destroy()` —— 那样 socket 立刻关闭、413 根本发不出去，
 * 前端只看到 "fetch failed"（作者以为软件坏了，其实是自己的库超大了）。
 * 改为**继续吞掉剩余数据但不存**，让 handler 有机会回一个说得清楚的 413。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let len = 0
    let tooLarge = false
    req.on('data', (c) => {
      if (tooLarge) return // 已判定超限：丢弃后续分片，等 end 收尾
      len += c.length
      if (len > MAX_BODY) {
        tooLarge = true
        chunks.length = 0
        const e = new Error(`请求体过大（超过 ${MAX_BODY >> 20} MiB）`)
        e.code = 'BODY_TOO_LARGE'
        reject(e)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks)) })
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

/**
 * 外置记录的原子写。🔴 tmp 名必须**每次唯一**：与主 JSON 同一条教训
 * （main.cjs 里 `store:save` 与 `store:save-sync` 曾因共用 tmp 而互相写坏）。
 * 外置记录彼此独立，但仍可能有「连续两次写同一条」的并发，故加 pid + 递增序号。
 */
let __blobSeq = 0
function atomicWriteBlob(abs, text) {
  const tmp = `${abs}.${process.pid}.${++__blobSeq}.tmp`
  mkdirSync(path.dirname(abs), { recursive: true })
  try {
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, abs)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* 清理失败无所谓：名字唯一，不会污染后续写 */ }
    throw new Error(`写入外置记录失败（可能被网盘客户端占用）：${e.message}`)
  }
}

const server = createServer(async (req, res) => {
  const url = req.url || '/'

  // 🔴 第一道闸：本机校验（DNS rebinding 防御）。绑 127.0.0.1 不够 —— 见 isLocalHost 的注释。
  if (!isLocalHost(req)) {
    return sendJson(res, 403, { ok: false, error: 'forbidden: 便携服务只接受来自本机的请求' })
  }

  // ---- API ----
  if (url.startsWith('/api/')) {
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
          const buf = await readBody(req).catch(e => {
            if (e && e.code === 'BODY_TOO_LARGE') return null
            throw e
          })
          if (buf === null) {
            // 413 用完整句子：作者看到的是「库太大了」而不是「软件坏了」
            return sendJson(res, 413, {
              ok: false,
              error: `数据超过 ${MAX_BODY >> 20} MiB 上限，未能保存。请用「导出数据文件」留档，再清理旧的自动备份后重试。`,
            })
          }
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

      // ---- 外置大块数据（sidecar）----
      // 备份载荷 / 向量 / 知识库各存独立文件，主 JSON 只留元数据。路由与 /api/data 同构：
      //   GET    /api/blob?store=&id=       读一条（404 = 还没有）
      //   PUT    /api/blob?store=&id=       写一条（body 为该记录的 JSON）
      //   DELETE /api/blob?store=&id=       删一条
      //   GET    /api/blob/list?store=      列该 store 的全部 id
      // 🔴 store / id 一律过白名单（见 resolveBlobPath），否则就是路径穿越。
      if (url.startsWith('/api/blob')) {
        const u = new URL(url, 'http://127.0.0.1')
        const store = u.searchParams.get('store')
        const id = u.searchParams.get('id')

        if (url.startsWith('/api/blob/list')) {
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          if (typeof store !== 'string' || !BLOB_STORES.has(store)) {
            return sendJson(res, 400, { ok: false, error: '未知的外置 store' })
          }
          const dir = path.join(BLOB_DIR, store)
          const ids = existsSync(dir)
            ? readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).filter(x => BLOB_ID_RE.test(x))
            : []
          return sendJson(res, 200, { ids })
        }

        const abs = resolveBlobPath(store, id)
        if (!abs) return sendJson(res, 400, { ok: false, error: '外置记录的 store / id 不合法' })

        if (req.method === 'GET') {
          if (!existsSync(abs)) return sendJson(res, 404, { missing: true })
          try {
            return sendJson(res, 200, { value: JSON.parse(readFileSync(abs, 'utf8')) })
          } catch {
            // 🔴 单条损坏只该丢这一条：回 500 让调用方跳过它，不要让整块功能静默瘫痪
            return sendJson(res, 500, { ok: false, error: '外置记录已损坏（JSON 解析失败）' })
          }
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          const buf = await readBody(req).catch(e => {
            if (e && e.code === 'BODY_TOO_LARGE') return null
            throw e
          })
          if (buf === null) {
            return sendJson(res, 413, {
              ok: false,
              error: `这条外置记录超过 ${MAX_BODY >> 20} MiB 上限，未能保存。`,
            })
          }
          const text = buf.toString('utf8')
          try { JSON.parse(text) } catch {
            return sendJson(res, 400, { ok: false, error: '请求体不是有效 JSON' })
          }
          atomicWriteBlob(abs, text)
          return sendJson(res, 200, { ok: true })
        }
        if (req.method === 'DELETE') {
          try { unlinkSync(abs) } catch { /* 已不存在视为成功（删除是幂等的） */ }
          return sendJson(res, 200, { ok: true })
        }
        return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      }

      return sendJson(res, 404, { ok: false, error: 'unknown api' })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // ---- 静态 ----
  // 🔴 整段兜底：`statSync` / `readFileSync` 都可能因路径异常、文件被占用、权限问题抛错，
  //    与上面畸形 URL 编码同理 —— 这里任何一个异常都会掀翻整个服务进程。兜住后只影响这一次请求。
  try {
    const abs = resolveStatic(url)
    if (!abs || !existsSync(abs) || !statSync(abs).isFile()) {
      // SPA 兜底：未知路径（含被 resolveStatic 拒绝的畸形 URL）回 index.html
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
  } catch (e) {
    try {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('静态资源读取失败：' + (e instanceof Error ? e.message : String(e)))
    } catch { /* 连接已断，无从回复 */ }
  }
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

// ---------- 进程级兜底 ----------
//
// 🔴 本服务是便携版数据的**唯一落盘通道**：浏览器里的 JS 写不了应用目录，全靠它。
//    进程一挂，作者以为「一直在存」的改动就再也回不到 U 盘 —— **静默退出比报错糟糕得多**
//    （报错至少还看得见，静默退出是"存了但没存"）。
//    上面各处已逐点兜住已知异常，这里再兜一层**未知**异常：记下来、继续活着。
process.on('uncaughtException', (e) => {
  console.error('[portable] ⚠️ 未捕获异常（服务继续运行，但请留意）：', e?.message ?? e)
})
process.on('unhandledRejection', (e) => {
  console.error('[portable] ⚠️ 未处理的 Promise 拒绝（服务继续运行）：', e?.message ?? e)
})
// listen 成功之后的运行时错误（端口被抢占等）也要看见，否则又是一次"服务没了但没人知道"
server.on('error', (e) => {
  console.error('[portable] ⚠️ 服务出错：', e?.message ?? e)
})

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
