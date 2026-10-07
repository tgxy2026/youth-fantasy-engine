// ============ 应用内下载安装包（主进程专用内核）============
//
// 2026-10-07 · 2.9.0：把「检查更新」的终点从「开系统浏览器」改成「应用内下载 + 拉起安装器」。
// 主人拍板口径：**下到「下载」文件夹 · 下完自动拉起安装器 · 只比对文件大小**。
//
// 🔴 边界（与 net:fetch 同源的安全约束，逐条对齐）：
//   · **只允许 http/https** —— 防 file:// 被借去读本地文件；
//   · **不带任何用户数据** —— 不附加项目名/机器信息/统计/自定义 cookie（继承 Chromium 默认栈的头）；
//   · **落盘位置与文件名由主进程决定** —— 渲染层给的是「原始文件名」而不是路径，且强制 .exe
//     并做字符清洗（防 `..\..\` 之类穿越、防控制字符）；
//   · **先写 `<name>.part`，成功后再改名** —— 中断/失败不会留下半截 .exe 被用户误当成品双击；
//   · **下完比对大小**（主人选的口径）：以响应 `content-length` 为准做**精确比对**；Gitee 的
//     assets 不提供 sha256，故不做摘要校验（这一点在界面文案里如实写明，不假装有校验）。
//   · 额外挡一道**兜底页**：Gitee 在要求登录/限流时会回一个网页，若直接存成 .exe 用户会双击到
//     一个网页文本 —— 判定以**文件头**为准（真安装包是 PE，头两字节必为 `MZ`，见 looksLikeExe）。
//     ⚠️ 不要退回「查 content-type 是不是 text/html」：实测 Gitee 把网页以 `text/plain` 返回，
//     那条判据在真机探针里被绕过过。
//
// 🔴 永不 throw：Electron 跨 IPC 的异常会被重新包装、原始信息丢失，一律返回结构化结果。
const fs = require('fs')
const path = require('path')
const { Transform } = require('stream')
const { pipeline } = require('stream/promises')
const { Readable } = require('stream')

/** 单次下载的总超时：113MB 在慢网下也要给足（30 分钟） */
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000
/** 进度推送节流：至少间隔 200ms 才发一次 IPC（避免刷爆渲染层） */
const PROGRESS_INTERVAL_MS = 200

/** 当前进行中的下载（同一时刻只允许一个；新的会先中止旧的） */
let activeAbort = null

/**
 * 清洗安装包文件名。
 * 只取 basename（防路径穿越）、剔除控制字符与 Windows 非法字符、强制 .exe 结尾。
 * 非法时返回空串（调用方据此拒绝，不猜一个名字出来）。
 */
function sanitizeInstallerName(raw) {
  const base = String(raw || '').split(/[\\/]/).pop() || ''
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned || !/\.exe$/i.test(cleaned)) return ''
  return cleaned.slice(0, 120)
}

/** 中止当前下载；返回是否真的中止了一个（供 IPC 回报） */
function cancelActiveDownload() {
  if (!activeAbort) return false
  try {
    activeAbort.abort()
  } catch {
    /* 已结束，忽略 */
  }
  return true
}

/**
 * 判断落盘的文件是不是真正的 PE 可执行文件（头两字节 `MZ` = 0x4D 0x5A）。
 *
 * 🔴 为什么以**文件头**为准，而不是查 `content-type`（2026-10-07 实机探针的教训）：
 *   原本按「content-type 含 text/html 就拒绝」挡兜底页，但实测 **Gitee 把仓库网页以
 *   `text/plain; charset=utf-8` 返回** —— 那个 45KB 的网页被当成安装包存了下来（拦截被绕过）。
 *   文件头判据同时挡住：HTML 页 / JSON 报错页 / 登录墙截断的响应，且对真安装包零误判。
 */
function looksLikeExe(file) {
  let fd = null
  try {
    fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(2)
    const n = fs.readSync(fd, head, 0, 2, 0)
    return n === 2 && head[0] === 0x4d && head[1] === 0x5a
  } catch {
    return false
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* 关不掉不影响判定 */
      }
    }
  }
}

/**
 * 下载安装包到 `dir`，文件名用 `fileName`（清洗后）。
 *
 * @param {object} o
 * @param {string} o.url        安装包直链（http/https）
 * @param {string} o.dir        目标目录（由主进程传入，如 app.getPath('downloads')）
 * @param {string} o.fileName   原始文件名（只取 basename 并清洗）
 * @param {(p:{received:number,total:number,percent:number})=>void} [o.onProgress]
 * @returns {Promise<{ok:true,path:string,size:number}|{ok:false,cancelled?:true,error:string}>}
 */
async function downloadInstaller({ url, dir, fileName, onProgress }) {
  let target
  try {
    target = new URL(String(url))
  } catch {
    return { ok: false, error: '下载地址不合法' }
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { ok: false, error: '不允许的协议：' + target.protocol }
  }

  const name = sanitizeInstallerName(fileName) || sanitizeInstallerName(decodeURIComponent(target.pathname))
  if (!name) return { ok: false, error: '安装包文件名不合法（须以 .exe 结尾）' }

  const dest = path.join(dir, name)
  const part = dest + '.part'

  // 同一时刻只跑一个下载：先把上一个收掉，避免两个流抢同一个 .part
  if (activeAbort) cancelActiveDownload()

  const ctrl = new AbortController()
  activeAbort = ctrl
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS)

  let received = 0
  let lastSentAt = 0
  const report = (total) => {
    if (typeof onProgress !== 'function') return
    const now = Date.now()
    if (now - lastSentAt < PROGRESS_INTERVAL_MS) return
    lastSentAt = now
    onProgress({
      received,
      total,
      percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
    })
  }

  try {
    // 残留的 .part 先清掉（上次中断留下的；不清会让本次写入位置错乱）
    try {
      fs.unlinkSync(part)
    } catch {
      /* 不存在即可 */
    }

    const res = await fetch(target.toString(), { redirect: 'follow', signal: ctrl.signal })
    if (!res.ok) {
      return { ok: false, error: `服务器返回 ${res.status}${res.statusText ? ' ' + res.statusText : ''}` }
    }
    if (res.url && !/^https?:/i.test(res.url)) {
      return { ok: false, error: '被重定向到非 http(s) 地址，已中止' }
    }
    if (!res.body) return { ok: false, error: '响应没有内容' }

    const total = Number(res.headers.get('content-length') || 0) || 0
    const out = fs.createWriteStream(part)
    let counted = 0
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        counted += chunk.length
        received = counted
        report(total)
        cb(null, chunk)
      },
    })

    await pipeline(Readable.fromWeb(res.body), counter, out)
    report(total)

    // 大小比对（主人选的口径）：有 content-length 就必须精确相等；没有则只能确认「非空」
    if (total > 0 && counted !== total) {
      try {
        fs.unlinkSync(part)
      } catch {
        /* 清理失败不掩盖真实错误 */
      }
      return { ok: false, error: `下载不完整（${counted} / ${total} 字节），已丢弃，请重试` }
    }
    if (counted === 0) {
      try {
        fs.unlinkSync(part)
      } catch {
        /* 同上 */
      }
      return { ok: false, error: '下载到的文件是空的，已丢弃' }
    }

    // 🔴 兜底页拦截（见 looksLikeExe 的注释：Gitee 的网页是 text/plain，「查 content-type」判不准）
    if (!looksLikeExe(part)) {
      try {
        fs.unlinkSync(part)
      } catch {
        /* 同上 */
      }
      return { ok: false, error: '下载到的不是可执行文件（可能需要登录或被限流），请改用夸克网盘' }
    }

    // 临时名 → 正式名（同目录 rename 是原子的；既有同名文件会被覆盖）
    try {
      fs.renameSync(part, dest)
    } catch (e) {
      try {
        fs.unlinkSync(part)
      } catch {
        /* 同上 */
      }
      return { ok: false, error: `安装包落盘失败（${(e && e.code) || 'IO'}）：可能旧安装包正被占用，请先关掉它` }
    }

    return { ok: true, path: dest, size: counted }
  } catch (e) {
    try {
      fs.unlinkSync(part)
    } catch {
      /* 同上 */
    }
    const aborted = e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')
    return aborted
      ? { ok: false, cancelled: true, error: '已取消下载' }
      : { ok: false, error: String((e && e.message) || e) }
  } finally {
    clearTimeout(timer)
    if (activeAbort === ctrl) activeAbort = null
  }
}

module.exports = { downloadInstaller, cancelActiveDownload, sanitizeInstallerName }
