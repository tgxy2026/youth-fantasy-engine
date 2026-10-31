// Electron 主进程：窗口 + 本地数据文件读写（IPC）
// 数据文件保存在系统用户数据目录（Windows: C:\Users\<用户>\AppData\Roaming\<应用名>\），
// 格式与便携（U 盘）版完全一致 —— 可互相导出导入。
// 🔴 `safeStorage` 不能漏（2026-10-31 实机抓到）：3.3.2 的桌面登录要用它加密令牌。
//    漏了不会在语法检查/单测里暴露，只在真机启动时抛 ReferenceError —— 而它位于
//    `app.whenReady()` 的同步段里，一抛就把**后面所有 IPC 注册与窗口创建**全跳过，
//    表现为「双击没反应 / 桌面版整个打不开」。教训：主进程新增能力时，
//    `require('electron')` 的解构列表要跟着改。
const { app, BrowserWindow, ipcMain, dialog, shell, session, safeStorage } = require('electron')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
// 2.9.0 · 应用内下载安装包的内核（只允许 http/https、先写 .part、下完比对大小）
const { downloadInstaller, cancelActiveDownload } = require('./updateDownload.cjs')
// 3.0 · W0-2 老用户数据迁移内核（探测旧 userData / 窗口前复制旧 IDB / 读写整库 JSON / profile / 卸载引导）
const migration = require('./migration.cjs')
// 3.0 · W3-2 同步文件路径闸（2026-10-10 从本文件抽出成独立模块 —— 规则可读、可被单测审读）
const { assertSyncPath } = require('./syncPath.cjs')
// 3.0.2 · 私有网盘同步内核（WebDAV / S3 兼容）：渲染进程受同源策略限制，跨域请求必须由主进程代发
const { webdavRequest, s3Request } = require('./remoteSync.cjs')
// 3.1.2 · 应用图标（桌面快捷方式）切换内核：内置三套预设图标 → 解包到 userData → 改写 .lnk
const appIcon = require('./appIcon.cjs')
// 3.2.2 · 审计 C2：换数据位置时把外置目录（blobs）一起搬走的内核（可被单测直接验）
const blobMove = require('./blobMove.cjs')
// 3.3.2 · P1-5b 桌面账号登录（浏览器授权 + 回环端口 + safeStorage 存令牌）
const desktopAuth = require('./desktopAuth.cjs')
// 3.3.2 · §15 老板键（全局快捷键隐藏/恢复 + 通知渲染层保存）
const bossKey = require('./bossKey.cjs')

const SMOKE_TEST = process.argv.includes('--smoke-test')
/**
 * 桌面登录自检（`--desktop-auth-selftest=<服务器地址>`）。
 *
 * 【为什么需要它】桌面登录要开系统浏览器，窗口又不受自动化工具控制，
 * 所以「真桌面进程能不能走通登录」以前只能靠人工点。加上这个开关后，
 * 主进程会用**和生产完全相同的流程**（回环端口 + PKCE + 换令牌 + 写安全存储）跑一次，
 * 只是把「打开浏览器」换成把授权地址打印到 stdout，外部脚本可以接着完成登录。
 *
 * 🔴 只在显式传参时生效，正常启动完全不受影响；跑完直接退出，不创建窗口。
 */
const DESKTOP_AUTH_SELFTEST = (() => {
  const a = process.argv.find((x) => x.startsWith('--desktop-auth-selftest='))
  return a ? a.slice('--desktop-auth-selftest='.length) : ''
})()
// 3.1.2 · 图标自检：真机跑一遍「应用 → 读回 → 还原」，供封装后 / CI 验证快捷方式确实被改（详见下方实现）
const ICON_SELFTEST = process.argv.includes('--app-icon-selftest')
/**
 * 3.2.2 · 审计 D1（P1）：是否**放行**多实例。
 *
 * 🔴 默认**不允许**：两个进程用同一个资料区时，各自持有整库内存快照，
 *    谁后写盘谁赢 —— 另一窗口的修改会被静默覆盖（审计实测：窗口 A 写 `AUDIT-A` 已落盘，
 *    窗口 B 在旧稿上写 `AUDIT-B` 后，磁盘只剩 B，A 的内容消失，而两个窗口都显示"已保存"）。
 *    原子写盘只能防"写了一半"，防不住"拿旧数据覆盖新数据"。
 *
 * 保留开关是给**审计/回归**用的：要验证「双开不互相覆盖」必须真起两个进程，
 * 而在单实例锁下第二个进程会直接退出、根本造不出现场。
 */
const ALLOW_MULTI_INSTANCE = process.argv.includes('--multi-instance')

/**
 * 单实例锁：拿不到锁 = 已有实例在跑 ⇒ 聚焦它、本进程立刻退出（不建窗口、不注册 IPC）。
 *
 * ⚠️ 锁的作用域是 **userData 目录**：用不同 `--user-data-dir` 启动的两个实例各自拿锁、互不影响
 *    （实机回归正是靠这一点隔离测试资料区）。
 * ⚠️ `--smoke-test` / `--app-icon-selftest` 也走这道锁：它们本就该用临时 user-data-dir 单独跑。
 */
if (!ALLOW_MULTI_INSTANCE) {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    // 🔴 只 quit 不够：下面 app.whenReady() 仍会排队，可能在退出前把窗口建出来。
    //    CommonJS 顶层 return 是合法的（模块被包在函数里）⇒ 直接结束本模块。
    app.quit()
    return
  }
  app.on('second-instance', () => {
    // 用户重复启动：把已有窗口叫到前面（最小化过就先还原），不要让第二个进程另起炉灶
    const w = BrowserWindow.getAllWindows()[0]
    if (!w || w.isDestroyed()) return
    try {
      if (w.isMinimized()) w.restore()
      if (!w.isVisible()) w.show()
      w.focus()
    } catch { /* 窗口正在销毁：忽略 */ }
  })
}

/**
 * 自定义数据文件位置的配置。
 * 刻意放在 userData 目录（而不是数据文件旁边）：配置本身绝不能被云盘同步走，
 * 否则 A 机的路径配置会被同步到 B 机，把 B 机指向错误的目录。
 */
function locationFile() {
  return path.join(app.getPath('userData'), 'data-location.json')
}

/** 用户自定义的数据文件路径（null = 用默认位置）。启动时读一次，之后由 IPC 维护。 */
let customDataPath = null

function loadCustomPath() {
  try {
    const p = JSON.parse(fs.readFileSync(locationFile(), 'utf-8')).path
    if (typeof p === 'string' && p) customDataPath = p
  } catch {
    customDataPath = null // 未自定义 / 配置损坏 → 回落到默认位置
  }
}

/**
 * 本地数据文件路径。
 * 默认在用户数据目录（Windows: C:\Users\<用户>\AppData\Roaming\<应用名>\），
 * 用户可改到云盘同步目录里（WPS 云盘 / OneDrive 等）实现跨设备同步。
 */
function dataFile() {
  return customDataPath || path.join(app.getPath('userData'), 'youth-fantasy-engine-data.json')
}

/**
 * 读取本地数据文件，返回**三态**（渲染层据此决定是否允许写盘）：
 *   { text, missing:false }                   读到内容
 *   { text:null, missing:true }               文件不存在（首次使用，属正常）
 *   { text:null, missing:false, error:'…' }   读取失败（被云盘/杀软占用、权限、IO）——🔴 危险
 *
 * 🔴 为什么必须区分「不存在」与「读失败」：
 *   旧实现把**所有**异常都吞成 null，渲染层分辨不出，于是把"读失败"当成"空库"启动；
 *   用户只要动一下数据（哪怕只是启动时自动播种示范项目），空库就会覆盖磁盘上的真实文件。
 *   这条路径不可逆 —— 必须让渲染层知道"文件在，但没读出来"。
 */
function readDataFileSync() {
  const file = dataFile()
  try {
    return { text: fs.readFileSync(file, 'utf-8'), missing: false }
  } catch (e) {
    if (e && e.code === 'ENOENT') return { text: null, missing: true }
    return { text: null, missing: false, error: (e && e.message) || String(e) }
  }
}

/**
 * 原子写盘：先写 .tmp，再 rename 覆盖正文件。
 *
 * 为什么必须原子：数据文件可能被放进 WPS 云盘 / OneDrive 等同步目录，
 * 若像以前那样直接 writeFile 覆盖，云盘客户端可能在「写了一半」时抓拍上传，
 * 另一台设备拉到的就是截断的 JSON —— 解析失败后应用会以空库启动，
 * 用户会以为数据全没了。rename 在同一分区内是原子操作，可彻底避免半截文件。
 *
 * 刻意不留 .bak：同步目录里多一份副本会让云盘流量翻倍，
 * 且应用内已有快照（snapshots）机制兜底，不需要再叠一层。
 */
/**
 * 🔴 2026-09-22 六维审计 P1：tmp 名必须**每次唯一**。
 *
 * 原来两条写路径共用 `file + '.tmp'`：关窗时防抖中的异步写（`store:save`）仍在途，
 * 同步写（`store:save-sync`）又进来写同一个 tmp —— rename 可能把**写了一半的内容**搬成正文件，
 * 恰好破坏这两个函数本来要防的「截断 JSON」。加 pid + 递增序号即可：
 * 同进程内不会重名，跨进程靠 pid 区分（且同步/异步两条路径各自独立）。
 */
let __tmpSeq = 0
const tmpNameOf = (file) => `${file}.${process.pid}.${++__tmpSeq}.tmp`

function writeAtomicSync(file, text) {
  const tmp = tmpNameOf(file)
  try {
    fs.writeFileSync(tmp, text, 'utf-8')
    fs.renameSync(tmp, file)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* 清理失败无所谓：名字唯一，不会污染后续写 */ }
    throw e
  }
}

async function writeAtomic(file, text) {
  const tmp = tmpNameOf(file)
  try {
    await fsp.writeFile(tmp, String(text), 'utf-8')
    await fsp.rename(tmp, file)
  } catch (e) {
    try { await fsp.unlink(tmp) } catch { /* 同上 */ }
    throw e
  }
}

app.whenReady().then(() => {
  // 字体枚举权限（2026-09-28 · 社区需求）：渲染层 navigator.queryLocalFonts() 需要
  // local-fonts 权限。Chromium 把它归为需授权能力，Electron 无授权 UI、无 handler 时
  // 对该权限默认拒绝 —— 必须显式放行。
  // 🔴 2026-10-07 六维审计 P2：原先一律 `callback(true)` —— 把 media / geolocation /
  //    notifications / midi 等一并放行，安全面大于必要；且原注释「与未设 handler 的默认
  //    批准行为一致」依赖 Electron 的版本默认值（新版对不少权限已改为默认拒绝），不可靠。
  //    现**只放行 local-fonts**。已核：全项目只有 fontPrefs.ts 的 queryLocalFonts 用到权限
  //    API ⇒ 收窄不影响任何现有功能。将来若要用别的权限，往这个集合里加即可。
  const ALLOWED_PERMISSIONS = new Set(['local-fonts'])
  try {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission))
    })
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))
  } catch { /* 权限注册失败不挡启动：字体枚举降级为预置清单 + 自定义输入 */ }

  loadCustomPath() // 恢复用户自定义的数据文件位置（若有）

  // 🔴 3.0 · W0-2：**窗口创建前**先把旧版 IndexedDB 目录复制过来。
  //    时机是关键 —— IDB 是进程内 LevelDB，窗口起来后再替换目录不生效且可能损坏；
  //    仅在「新 userData 尚无 IndexedDB 目录」时执行（全新首启）。失败不挡启动。
  try {
    const mr = migration.precopyLegacyIdb()
    if (mr.copied) console.log('[migration] 已复制旧版 IndexedDB 目录到新 userData')
  } catch (e) {
    console.warn('[migration] 复制旧 IDB 目录失败（不挡启动）：', e && e.message)
  }
  // ---- 3.3.2 · 桌面账号登录 IPC ----
  //
  // 为什么走主进程而不是渲染进程：
  //   · 回环监听是「本机端口」，渲染层没有 raw socket；
  //   · 令牌要写进系统安全存储（`safeStorage`），只能在主进程用；
  //   · 打开系统浏览器也要 `shell.openExternal`。
  // 渲染层只拿到两个结果：「成功（带用户名）/ 失败（带原因）」，永远看不到令牌原文。
  const authTokenFile = path.join(app.getPath('userData'), 'desktop-session.bin')
  const tokenVault = desktopAuth.createTokenVault({ safeStorage, fs, file: authTokenFile })
  /**
   * 登录服务器 origin（3.3.2 · P5）：同步请求要打到**账号服务器**，而不是本机页面。
   * 🔴 只记 origin（协议+域名+端口），不记任何凭据；登出时清掉。
   * 🔴 与令牌分开存：origin 不是秘密，但"跟着令牌一起没了"会让用户每次都要重填服务器地址。
   */
  const authOriginFile = path.join(app.getPath('userData'), 'desktop-origin.txt')
  let authOrigin = ''
  try { authOrigin = String(fs.readFileSync(authOriginFile, 'utf8') || '').trim() } catch { authOrigin = '' }
  const saveAuthOrigin = (origin) => {
    authOrigin = origin || ''
    try {
      if (authOrigin) fs.writeFileSync(authOriginFile, authOrigin)
      else fs.unlinkSync(authOriginFile)
    } catch { /* 写不进去只影响"下次自动填地址"，不影响本次登录 */ }
  }

  ipcMain.handle('auth:desktopStatus', () => {
    let available = false
    try { available = safeStorage.isEncryptionAvailable() } catch { available = false }
    return { signedIn: !!tokenVault.load(), encrypted: available }
  })

  /**
   * 桌面登录的**实际流程**：回环端口 → 浏览器授权 → code+verifier 换令牌 → 写安全存储。
   *
   * 抽成具名函数而不是内联在 IPC 里，是为了能被 `--desktop-auth-selftest` 直接调用。
   * 否则这段最容易在装配层出错（漏个导入就整个启动中断，见文件头 safeStorage 的注释），
   * 却只能靠人工点界面才能发现。
   *
   * @param {{ baseUrl: string, name?: string, openBrowser: (url: string) => Promise<void> }} o
   *        `openBrowser` 由调用方决定：生产是 `shell.openExternal`，自检是打印到 stdout。
   */
  const runDesktopLogin = async ({ baseUrl: rawBase, name, openBrowser }) => {
    const baseUrl = String(rawBase || '').replace(/\/+$/, '')
    if (!/^https?:\/\//.test(baseUrl)) return { ok: false, error: '服务器地址不合法' }
    const { verifier, challenge } = desktopAuth.createPkce()
    const state = desktopAuth.createState()
    let srv
    try {
      srv = await desktopAuth.startLoopbackServer(async (query) => {
        const v = desktopAuth.verifyCallback({ query, expectedState: state })
        if (!v.ok) return { ok: false, title: '授权未完成', detail: v.reason }
        /**
         * 🔴 **必须把 code 带出来**（2026-10-31 实机抓到）。
         *
         * 这个回调的返回值有两个用途：① 渲染给浏览器的结果页（title/detail）；
         * ② `waitForCode()` 的解析值 —— 下面换令牌用的就是它的 `.code`。
         * 第一版只返回了 ①②里的标题/说明，把 code 丢了 ⇒ `outcome.code` 恒为 undefined
         * ⇒ 换成令牌时服务端回 400「缺少授权码」⇒ **桌面登录永远不可能成功**。
         * 单测没抓到是因为它直接测 `startLoopbackServer`，自己塞了自己的返回值。
         */
        return { ok: true, code: v.code, title: '授权成功', detail: '可以关闭这个页面，回到桌面版继续。' }
      })
      const url = desktopAuth.buildAuthorizeUrl({
        baseUrl, port: srv.port, challenge, state, name: name || '',
      })
      await openBrowser(url)
      const outcome = await srv.waitForCode()
      if (!outcome.ok) return { ok: false, error: outcome.detail || '授权未完成' }

      // 换令牌：code + verifier → 令牌。🔴 令牌只在主进程里过一手，不返回给渲染层。
      const resp = await fetch(`${baseUrl}/api/auth/desktop/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: outcome.code, verifier }),
      })
      const body = await resp.json().catch(() => ({}))
      if (!resp.ok || !body || !body.token) {
        return { ok: false, error: String((body && body.error) || `换取登录凭据失败（HTTP ${resp.status}）`) }
      }
      const saved = tokenVault.save(String(body.token))
      // 记下服务器 origin：之后同步请求（Bearer）要打到同一个源
      try { saveAuthOrigin(new URL(baseUrl).origin) } catch { /* baseUrl 已校验过，理论上不会失败 */ }
      return {
        ok: true,
        user: body.user ? { name: body.user.name } : null,
        // 🔴 没加密能力时明说"仅本次有效"，不要假装已记住
        persisted: saved.persisted === true,
        persistedReason: saved.persisted ? '' : (saved.reason || 'NO_SAFE_STORAGE'),
      }
    } catch (err) {
      return { ok: false, error: err && err.message ? String(err.message) : '登录失败' }
    } finally {
      try { if (srv) srv.close() } catch { /* ignore */ }
    }
  }

  ipcMain.handle('auth:desktopLogin', (_e, opts) => runDesktopLogin({
    baseUrl: opts && opts.baseUrl,
    name: opts && opts.name,
    openBrowser: (url) => shell.openExternal(url),
  }))

  ipcMain.handle('auth:desktopLogout', () => {
    tokenVault.clear()
    saveAuthOrigin('')
    return { ok: true }
  })

  /** 登录服务器 origin（同步请求用它拼绝对地址；未登录返回空串） */
  ipcMain.handle('auth:desktopOrigin', () => ({ origin: tokenVault.load() ? authOrigin : '' }))

  /**
   * 代发带令牌的请求。
   * 🔴 只允许打到登录时用的那个源：令牌是账号凭据，不能被渲染层的任意 URL 带走。
   */
  ipcMain.handle('auth:desktopFetch', async (_e, opts) => {
    const token = tokenVault.load()
    if (!token) return { ok: false, status: 401, error: '未登录' }
    const url = String((opts && opts.url) || '')
    const allowOrigin = String((opts && opts.origin) || authOrigin || '')
    try {
      if (allowOrigin && new URL(url).origin !== new URL(allowOrigin).origin) {
        return { ok: false, status: 0, error: '请求目标与登录服务器不一致' }
      }
    } catch {
      return { ok: false, status: 0, error: 'URL 不合法' }
    }
    try {
      const r = await fetch(url, {
        method: (opts && opts.method) || 'GET',
        headers: { ...((opts && opts.headers) || {}), Authorization: `Bearer ${token}` },
        body: opts && opts.body != null ? opts.body : undefined,
      })
      /**
       * 🔴 3.3.2 · P5：同步要下**对象二进制**（图片/分片），`r.text()` 会把它们解坏。
       * 调用方用 `binary: true` 明确要 base64；不传时仍返回 text（现有调用零变化）。
       */
      const buf = Buffer.from(await r.arrayBuffer())
      if (opts && opts.binary) return { ok: r.ok, status: r.status, base64: buf.toString('base64') }
      return { ok: r.ok, status: r.status, text: buf.toString('utf8') }
    } catch (err) {
      return { ok: false, status: 0, error: err && err.message ? String(err.message) : '请求失败' }
    }
  })

  // ---- 桌面登录自检（`--desktop-auth-selftest=<baseUrl>`）：跑完即退，不建窗口 ----
  //
  // 与 `--smoke-test` 同一类：只供自动化/流水线验证，正常启动完全不经过这里。
  if (DESKTOP_AUTH_SELFTEST) {
    ;(async () => {
      const r = await runDesktopLogin({
        baseUrl: DESKTOP_AUTH_SELFTEST,
        // 把「打开浏览器」换成打印地址：外部脚本可以接着完成登录，不必真弹浏览器
        openBrowser: async (url) => { console.log('DESKTOP_AUTH_URL ' + url) },
      })
      if (r.ok) {
        const who = r.user && r.user.name ? r.user.name : '-'
        console.log(`DESKTOP_AUTH_OK user=${who} persisted=${r.persisted === true}`)
      } else {
        console.log('DESKTOP_AUTH_FAIL ' + (r.error || 'unknown'))
      }
      app.exit(r.ok ? 0 : 1)
    })()
    return
  }

  // ---- 存储相关 IPC ----
  // 启动时读取本地数据文件
  ipcMain.handle('store:load', () => {
    const r = readDataFileSync()
    return { text: r.text, path: dataFile(), missing: r.missing === true, error: r.error ?? null }
  })

  // 防抖后的异步写盘（渲染层每次数据变更后调用）。原子写，见 writeAtomic 注释。
  ipcMain.handle('store:save', async (_e, text) => {
    try {
      await writeAtomic(dataFile(), String(text))
      return { ok: true, error: null }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // ---- 外置大块数据（sidecar）----
  //
  // 【为什么要有它】备份载荷每份是一个项目的整包正文，**写完就再也不变**，却躺在整库 JSON 里
  // ⇒ 作者每敲一个字，都要把上百 MB 没动过的历史重新 stringify + 写盘一遍（表现为明显卡顿）。
  //   挪到独立文件后，主 JSON 只留元数据，写盘体积降一个数量级。
  //
  // 🔴 与便携版（scripts/portable-server.mjs 的 /api/blob）**同一套语义**：
  //    两端都只外置「登记过的 store」，store / id 都过白名单，都是原子写。
  //    差异只在传输（这里是 IPC，那边是 HTTP）。
  //
  // 🔴 外置目录**跟随数据文件**（含用户自定义到云盘的情况）：否则换位置后载荷就找不到了。
  const BLOB_STORES = new Set(['backupPayloads'])
  const BLOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
  function blobRoot() {
    return path.join(path.dirname(dataFile()), 'blobs')
  }
  /** 解析外置记录路径；**任何不合法都返回 null**（store/id 会进路径 ⇒ 白名单是安全边界） */
  function resolveBlobPath(store, id) {
    if (typeof store !== 'string' || !BLOB_STORES.has(store)) return null
    if (typeof id !== 'string' || !BLOB_ID_RE.test(id)) return null
    const root = blobRoot()
    const abs = path.normalize(path.join(root, store, `${id}.json`))
    const rel = path.relative(root, abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null
    return abs
  }

  ipcMain.handle('payload:read', async (_e, store, id) => {
    try {
      const abs = resolveBlobPath(store, id)
      if (!abs) return { ok: false, error: '外置记录的 store / id 不合法' }
      if (!fs.existsSync(abs)) return { ok: true, missing: true }
      return { ok: true, value: JSON.parse(fs.readFileSync(abs, 'utf-8')) }
    } catch (err) {
      // 单条损坏只该丢这一条，不该掀翻整块功能
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle('payload:write', async (_e, store, id, text) => {
    try {
      const abs = resolveBlobPath(store, id)
      if (!abs) return { ok: false, error: '外置记录的 store / id 不合法' }
      try { JSON.parse(String(text)) } catch { return { ok: false, error: '内容不是有效 JSON' } }
      // 🔴 必须先建目录：`writeAtomic` 是给主 JSON 写的（那个目录启动时已存在），
      //    而外置目录是按需生成的 —— 漏掉这一步会让**第一次写备份载荷必然 ENOENT**
      //    （2026-10-11 真 Electron 实机抓到：write 一律失败，恢复备份时才是"载荷缺失"）。
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      await writeAtomic(abs, String(text))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle('payload:del', async (_e, store, id) => {
    try {
      const abs = resolveBlobPath(store, id)
      if (!abs) return { ok: false, error: '外置记录的 store / id 不合法' }
      try { fs.unlinkSync(abs) } catch { /* 已不存在视为成功（删除幂等） */ }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle('payload:list', async (_e, store) => {
    try {
      if (typeof store !== 'string' || !BLOB_STORES.has(store)) return { ok: false, error: '未知的外置 store', ids: [] }
      const dir = path.join(blobRoot(), store)
      if (!fs.existsSync(dir)) return { ok: true, ids: [] }
      const ids = fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => f.slice(0, -5))
        .filter(x => BLOB_ID_RE.test(x))
      return { ok: true, ids }
    } catch (err) {
      return { ok: false, error: String(err), ids: [] }
    }
  })

  // 同步写盘：窗口关闭（beforeunload）时保证未保存数据落盘。同样原子写。
  ipcMain.on('store:save-sync', (e, text) => {
    try {
      writeAtomicSync(dataFile(), String(text))
      e.returnValue = { ok: true, error: null }
    } catch (err) {
      e.returnValue = { ok: false, error: String(err) }
    }
  })

  // 导出全部数据为便携版数据文件（保存到 U 盘等任意位置）
  ipcMain.handle('store:export', async (_e, text) => {
    const r = await dialog.showSaveDialog({
      title: '导出数据文件（可保存到 U 盘，供便携版使用）',
      defaultPath: '我的小说库.novel.json',
      filters: [{ name: '小说工坊数据文件', extensions: ['json'] }],
    })
    if (r.canceled || !r.filePath) return null
    await fsp.writeFile(r.filePath, String(text), 'utf-8')
    return r.filePath
  })

  /**
   * 把一段 HTML 渲染成 PDF 并保存（创作证据包 / 打印导出用）。
   *
   * 🔴 **为什么必须由主进程做，且必须走 Chromium 的打印引擎**：
   *    前端 PDF 库（jsPDF 一类）自带字体不含中文，硬套会输出一堆豆腐块；
   *    而中文子集化 / 嵌入字体是另一个大坑。Chromium 的 printToPDF 用系统字体，零依赖、中文无问题。
   *
   * 实现要点：
   *   · 用**隐藏窗口**加载（不能拿主窗口打 —— 那会把整个应用界面打进去）；
   *   · HTML 先落**临时文件**再 loadFile：`data:` URL 对超长内容会被截断（证据包轻松过几十 KB）；
   *   · 窗口禁用 JS：证据包是静态文档，禁用后更安全，且不影响排版。
   *
   * @returns 保存后的绝对路径；用户取消返回 null；失败抛异常（由调用方转成界面提示）
   */
  ipcMain.handle('export:pdf', async (_e, html, defaultName) => {
    const r = await dialog.showSaveDialog({
      title: '保存为 PDF',
      defaultPath: String(defaultName || '导出文档.pdf'),
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
    })
    if (r.canceled || !r.filePath) return null

    const tmp = path.join(app.getPath('temp'), `yfe-print-${Date.now()}-${process.pid}.html`)
    let win = null
    try {
      await fsp.writeFile(tmp, String(html ?? ''), 'utf-8')
      win = new BrowserWindow({
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
      })
      await win.loadFile(tmp)
      const buf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
      await fsp.writeFile(r.filePath, buf)
      return r.filePath
    } finally {
      try { win?.destroy() } catch { /* 窗口已销毁 */ }
      try { await fsp.unlink(tmp) } catch { /* 临时文件清理失败不阻断导出 */ }
    }
  })

  // 从便携版数据文件导入（选择 U 盘上的数据文件，读取内容）
  ipcMain.handle('store:import', async () => {
    const r = await dialog.showOpenDialog({
      title: '导入数据文件（选择便携版 U 盘上的数据文件）',
      properties: ['openFile'],
      filters: [{ name: '小说工坊数据文件', extensions: ['json'] }],
    })
    if (r.canceled || !r.filePaths.length) return null
    return await fsp.readFile(r.filePaths[0], 'utf-8')
  })

  // 在资源管理器中显示数据文件（方便用户手动备份）
  ipcMain.handle('store:reveal', () => {
    shell.showItemInFolder(dataFile())
  })

  ipcMain.handle('store:path', () => dataFile())

  // ---- 自定义数据文件位置（#033）----
  // 目的：让用户把「数据文件」指到 WPS 云盘 / OneDrive 等同步目录，由云盘客户端
  // 搬运实现跨设备同步，软件里不用再单独配同步路径。
  // ⚠️ 只搬数据文件本身，**不要把整个 userData 目录交给云盘** —— 里面混着
  // Chromium 的 Local Storage（leveldb，带独占锁）与十几 MB 缓存，跨设备覆盖会损坏。
  ipcMain.handle('store:chooseDataDir', async () => {
    const r = await dialog.showOpenDialog({
      title: '选择数据文件的存放位置（放进 WPS 云盘 / OneDrive 等同步目录即可跨设备同步）',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (r.canceled || !r.filePaths.length) return null
    return path.join(r.filePaths[0], 'youth-fantasy-engine-data.json')
  })

  /**
   * 把外置目录（`<数据文件目录>/blobs`）整棵搬到新数据文件旁边。
   *
   * 🔴 3.2.2 · 审计 C2（P1）：`blobRoot()` 跟着 `dataFile()` 走，而 `store:setDataPath`
   *    原先**只写主 JSON**。于是换完位置后：备份列表（元数据在主 JSON 里）全在，
   *    点恢复却说"载荷缺失" —— 真正的外置文件还躺在旧目录。审计实测就是这条。
   *    ⇒ 资料集 = 主文件 + 外置文件，迁移必须**先搬齐、再校验、最后才切配置**。
   *
   * 🔴 内核已抽到 `electron/blobMove.cjs`（2026-10-23）：埋在 main.cjs 里没法单测，
   *    要跑它就得起整个 Electron。抽出去后可用真实临时目录直接验「复制 / 校验 / 失败不切」。
   */
  async function copyBlobsAlong(oldFile, newFile) {
    return blobMove.copyBlobsAlong(oldFile, newFile)
  }

  /** 迁移数据文件到新位置。目标已存在数据文件时「改用那份」（adopted），不覆盖。 */
  ipcMain.handle('store:setDataPath', async (_e, target, text) => {
    try {
      const p = String(target || '')
      if (!p || !path.isAbsolute(p)) return { ok: false, path: null, adopted: false, error: '路径无效' }
      await fsp.mkdir(path.dirname(p), { recursive: true })
      let adopted = false
      let copied = 0
      try {
        await fsp.access(p)
        adopted = true // 目标已有数据文件 → 通常是另一台设备同步过来的，改用那份
        // 🔴 接管别人的资料时**不搬外置文件**：两套备份混进同一个 blobs 目录会互相覆盖。
        //    提示口径由渲染层负责（adopted 已回传），这里只保证不静默混库。
      } catch {
        // 真正"搬家"：先把外置目录整棵搬过去并校验，成功才动主 JSON 与配置
        const moved = await copyBlobsAlong(dataFile(), p)
        if (!moved.ok) {
          return {
            ok: false, path: null, adopted: false,
            error: `历史备份文件没能一起搬过去，已取消迁移（原位置未改动）：${moved.error}`,
          }
        }
        copied = moved.copied
        await writeAtomic(p, String(text ?? ''))
      }
      await fsp.writeFile(locationFile(), JSON.stringify({ path: p }), 'utf-8')
      customDataPath = p
      return { ok: true, path: p, adopted, copied, error: null }
    } catch (err) {
      return { ok: false, path: null, adopted: false, error: String(err) }
    }
  })

  /** 恢复默认存放位置（userData 目录）。原位置的数据文件不会被删除。 */
  ipcMain.handle('store:resetDataPath', async (_e, text) => {
    try {
      const p = path.join(app.getPath('userData'), 'youth-fantasy-engine-data.json')
      let adopted = false
      let copied = 0
      try {
        await fsp.access(p)
        adopted = true // 默认位置原本就有数据 → 沿用那份
      } catch {
        // 同上：回迁也要把外置目录带回去，否则「换了位置再换回来」备份就断链
        const moved = await copyBlobsAlong(dataFile(), p)
        if (!moved.ok) {
          return {
            ok: false, path: null, adopted: false,
            error: `历史备份文件没能一起搬回去，已取消切换（当前位置未改动）：${moved.error}`,
          }
        }
        copied = moved.copied
        await writeAtomic(p, String(text ?? ''))
      }
      try {
        await fsp.unlink(locationFile())
      } catch {
        /* 本来就没有自定义配置 */
      }
      customDataPath = null
      return { ok: true, path: p, adopted, copied, error: null }
    } catch (err) {
      return { ok: false, path: null, adopted: false, error: String(err) }
    }
  })

  ipcMain.handle('store:isCustomPath', () => !!customDataPath)

  // ---- 3.0 · W0-2 老用户数据迁移 ----
  ipcMain.handle('migration:probe', () => migration.probeLegacy())
  ipcMain.handle('migration:readLegacyJson', () => migration.readLegacyJson())
  ipcMain.handle('migration:writeNewJson', (_e, text) => migration.writeNewJson(text))
  ipcMain.handle('migration:copyProfile', () => migration.copyLegacyProfile())
  ipcMain.handle('migration:findUninstaller', () => migration.findLegacyUninstaller())
  ipcMain.handle('migration:runUninstaller', (_e, p) => migration.runUninstaller(p))
  ipcMain.handle('migration:revealLegacyDir', () => migration.revealLegacyDir())

  // 🔴 2026-10-07 六维审计 P2：sync:readFile / sync:writeFile 原先直接吃渲染层传来的任意路径，
  //    等于把「任意文件读写」原语暴露出去。收窄规则（绝对路径 + .yfe 结尾或其派生名 .yfe.*）
  //    已于 2026-10-10（W3-2 · §11.1 L3）抽到 `electron/syncPath.cjs`，顶部 require，此处直接用。

  // ---- 云盘文件同步（#031 桌面版）：经主进程 fs 读写用户选定的同步目录 ----
  // 渲染进程 nodeIntegration=false，无法直接 require('fs')；所有文件 IO 必须走 IPC 到主进程。
  // 桌面版云同步把加密后的 .yfe 文件写在用户选定的云盘同步目录里，由 OneDrive/WPS 云盘 等客户端搬运。
  ipcMain.handle('sync:chooseDir', async () => {
    const r = await dialog.showOpenDialog({
      title: '选择云盘同步文件夹（建议放进 OneDrive / WPS 云盘 等同步目录，即可跨设备同步）',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (r.canceled || !r.filePaths.length) return null
    return r.filePaths[0]
  })
  ipcMain.handle('sync:readFile', async (_e, p) => {
    try {
      return { ok: true, text: await fsp.readFile(assertSyncPath(p), 'utf-8') }
    } catch (e) {
      // ⚠️ 这里必须区分「文件不存在」与「读取失败」，二者语义天差地别：
      //   ENOENT = 首次同步尚无同步文件 → 安全地当作空库（text: null）；
      //   EACCES / EBUSY / EPERM = 权限被拒或文件被占用（云盘客户端搬运文件时最常见）
      //     → 必须如实上报为读取失败。若一并当成空库，渲染端会认为「云端为空」，
      //       随后一次 push 就用本地内容整体覆盖掉云端的真实快照（2026-09-14 审计 P0-2）。
      // 另：不 throw 而是返回结构化结果——Electron 会把跨 IPC 的异常重新包装，
      //     原始 err.code 在渲染端会丢失，届时同样无法区分。
      if (e && e.code === 'ENOENT') return { ok: true, text: null }
      return { ok: false, reason: e && e.message ? String(e.message) : String(e) }
    }
  })
  ipcMain.handle('sync:writeFile', async (_e, p, text) => {
    try {
      // 原子写：先写 tmp，再把旧文件改名 .bak（回退用），最后 rename tmp 为正文件，避免写崩损坏。
      // ⚠️ 注意 .bak 落在**同步目录**里，会被网盘客户端一并上传（同一份数据占双倍流量）。
      //    这是**有意保留的取舍**：同步文件只有云端那一份，留一个上一版副本是最后的自救手段。
      //    （2026-09-19 六维审计 P2-3 记下这个取舍，不再当"忘了删"处理；要改就得连带想清楚
      //      写坏时拿什么回退。）
      const safe = assertSyncPath(p)
      const tmp = safe + '.tmp'
      await fsp.writeFile(tmp, String(text), 'utf-8')
      try {
        await fsp.rename(safe, safe + '.bak')
      } catch {
        /* 首次写入无旧文件，忽略 */
      }
      await fsp.rename(tmp, safe)
      return { ok: true, error: null }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // ---- 私有网盘同步（3.0.2 · WebDAV / S3 兼容）：同样经主进程代发，破同源策略 ----
  // 🔴 凭据（WebDAV 密码 / S3 secretKey）由渲染层随每次请求传入，主进程**不落盘、不记忆**。
  //    ⚠️ 渲染层也不把凭据写进 localStorage 明文？——不：凭据存 settingsKV（本地专属、已被
  //     EXCLUDED_META_KEYS 排除出同步载荷，永不随 .yfe 上云），见 desktopCloudSync.ts。
  // 🔴 这两条 handler 只做「URL 协议白名单 + 转发」，具体请求语义在 electron/remoteSync.cjs。
  ipcMain.handle('cloud:webdav', async (_e, url, init) => webdavRequest(url, init))
  ipcMain.handle('cloud:s3', async (_e, spec) => s3Request(spec))

  // ---- 主进程代发 HTTP 请求（联网检索用）----
  // 为什么必须绕到主进程：搜索接口（自建 SearXNG、Jina、Exa 等）不返回 Access-Control-Allow-Origin，
  //   渲染进程直连会被同源策略拦掉；桌面版没有自己的服务器，唯一的「后端」就是这个主进程。
  //   与当年网页版那条 /api/ai 反代同一个道理 —— 但请求不出本机，比走服务器更干净。
  //
  // 🔴 它是一个通用 HTTP 客户端，边界必须收窄（否则等于给渲染进程开了一个万能网络出口）：
  //   · 只允许 http/https —— 拒绝 file: 等协议，否则可以借它读本地文件
  //   · 只带调用方显式给出的头，**剔除 cookie / referer / origin / host**（主进程的会话 cookie 不该被带走）
  //   · 限时 30s；响应超 2MB 直接中止（搜索结果是几十 KB 量级，防止大文件把内存吃满）
  //   · 跟随重定向后再校验最终 URL 协议
  //   · 永不 throw —— Electron 跨 IPC 的异常会被重新包装、原始信息丢失，一律返回结构化结果
  const NET_TIMEOUT_MS = 30000
  const NET_MAX_BYTES = 2 * 1024 * 1024

  // 网络代理设置（2026-09-28 · 社区需求）：由渲染层推送配置，主进程对整个默认 session 生效——
  // 渲染层 fetch（Chromium 栈）与主进程 net.fetch 两条链路同时覆盖。
  // 🔴 只接受渲染层「用户自填的出口地址」，主进程不存储任何配置（每次启动由渲染层重推）；
  //    规则串白名单清洗（host/port/逗号分号/尖括号 local 标记），防注入到 Chromium 代理解析器。
  ipcMain.handle('net:set-proxy', async (_e, cfg) => {
    try {
      const c = cfg || {}
      if (typeof session.defaultSession.setProxy !== 'function') {
        return { ok: false, error: '当前 Electron 版本不支持设置代理' }
      }
      const clean = (v, max) => String(v ?? '')
        /**
         * 🔴 3.2.2 · 审计 C4（P2）：白名单里**必须允许 `/`**。
         *
         * 原先这里没有 `/`，而下一段校验用的正则要求 `scheme://` ——
         * 于是界面示例里写的 `http://127.0.0.1:8080` 先被洗成 `http:127.0.0.1:8080`，
         * 再被 `^(https?|socks5?):\/\/…$` 判为格式错误，而裸 `127.0.0.1:8080` 反而通过。
         * 作者照着帮助文字填就必错（审计实测：「代理地址格式不正确」，本地偏好却记成已启用）。
         * 加上 `/` 之后两条正则才自洽；注入面仍由下面那条严格正则兜住（不接受多规则语法）。
         */
        .replace(/[^a-zA-Z0-9.\-_:,;=<>\s*/]/g, '').slice(0, max)
      if (!c.enabled) {
        // 🔴 停用必须回到 mode:'system'（跟随系统代理/PAC）而不是 'direct'——
        //    Electron 默认就是 system；推 direct 会把「系统挂了代理」的用户的全部请求
        //    （含 AI 与云同步）改成绕过代理直连，与界面承诺的「跟随系统网络设置」相反。
        await session.defaultSession.setProxy({ mode: 'system' })
        return { ok: true }
      }
      const rules = clean(c.rules, 300)
      // 主进程侧按「单条 scheme://host:port」再校验一次（纵深防御：渲染层 normalizeProxyInput
      // 之外的第二道；白名单字符过滤防不住 Chromium 的多规则语法 http=a:80;https=b:80）
      if (!/^(https?|socks5?):\/\/[a-zA-Z0-9.\-]+(:\d{1,5})?$/.test(rules)
        && !/^[a-zA-Z0-9.\-]+(:\d{1,5})?$/.test(rules)) {
        return { ok: false, error: '代理地址格式不正确' }
      }
      if (!rules) return { ok: false, error: '代理地址为空或包含非法字符' }
      const bypass = clean(c.bypass, 300)
      await session.defaultSession.setProxy({
        mode: 'fixed_servers',
        proxyRules: rules,
        ...(bypass ? { proxyBypassRules: bypass } : {}),
      })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // 2.6.3 · 检查更新：用系统默认浏览器打开下载链接。
  // 🔴 只放行 http/https —— 防止这个口子将来被拿去打开 file:// 或自定义协议。
  ipcMain.handle('net:open-external', async (_e, url) => {
    try {
      const target = new URL(String(url))
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        return { ok: false, error: '不允许的协议：' + target.protocol }
      }
      await shell.openExternal(target.href)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // ---- 2.9.0 · 应用内下载安装包（把「检查更新」的终点从「开系统浏览器」改成「回内下载 + 拉起安装器」）----
  // 🔴 三道边界：
  //   ① 目标目录由**主进程**钉死在「下载」文件夹 —— 渲染层给的是文件名，不能指定路径；
  //   ② 文件名校验也在主进程（见 updateDownload.cjs 的 sanitizeInstallerName：只取 basename + 强制 .exe）；
  //   ③ 拉起安装器前**再校验一次**「路径确实在下载文件夹里、是 .exe、且真实存在」——
  //      这个口子只用来跑刚下好的安装包，绝不能变成「执行任意 exe」的万能入口。
  /** 是否是在「下载」文件夹里的真实 .exe（拉起 / 定位安装包的前置校验） */
  const isDownloadedInstaller = (p) => {
    try {
      const root = path.resolve(app.getPath('downloads')) + path.sep
      const abs = path.resolve(String(p || ''))
      return abs.startsWith(root) && /\.exe$/i.test(abs) && fs.statSync(abs).isFile()
    } catch {
      return false
    }
  }

  ipcMain.handle('update:download', async (e, url, fileName) => {
    const wc = e.sender
    return downloadInstaller({
      url,
      dir: app.getPath('downloads'),
      fileName,
      // 进度节流在主进程内核里（≥200ms 一次），这里只负责转发给**发起下载的那个窗口**
      onProgress: (p) => {
        try {
          if (!wc.isDestroyed()) wc.send('update:progress', p)
        } catch {
          /* 窗口已关：忽略 */
        }
      },
    })
  })

  ipcMain.handle('update:cancel', () => ({ ok: cancelActiveDownload() }))

  // 拉起刚下好的安装器；closeApp=true 时随后退出本程序（覆盖更新时旧文件不能被占用）
  ipcMain.handle('update:launch-installer', async (_e, filePath, closeApp) => {
    try {
      const abs = path.resolve(String(filePath || ''))
      if (!isDownloadedInstaller(abs)) {
        return { ok: false, error: '只允许运行刚下载到「下载」文件夹里的安装包' }
      }
      const openErr = await shell.openPath(abs)
      if (openErr) return { ok: false, error: openErr }
      // 安装向导已起来；留 3 秒把界面提示显示完再退出，避免「点完窗口就没了」
      if (closeApp) setTimeout(() => app.quit(), 3000)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // 在资源管理器里定位安装包（用户想稍后自己装时用）
  ipcMain.handle('update:reveal-file', async (_e, filePath) => {
    try {
      const abs = path.resolve(String(filePath || ''))
      if (!isDownloadedInstaller(abs)) return { ok: false, error: '文件不在「下载」文件夹里' }
      shell.showItemInFolder(abs)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // 退出本程序（安装前腾出被占用的文件）。走 app.quit ⇒ 各窗口触发 beforeunload ⇒ 渲染层同步存盘
  ipcMain.handle('app:quit', () => {
    setTimeout(() => app.quit(), 150)
    return { ok: true }
  })

  ipcMain.handle('net:fetch', async (_e, url, init) => {
    const opts = init || {}
    /**
     * 🔴 3.2.2 · 审计 C6（P2）：**超时必须覆盖正文消费**。
     *
     * 原实现在 `await fetch()` 返回响应头后就在 finally 里 `clearTimeout` ——
     * 于是"服务端给了 200 和一点正文然后挂住"这种情况完全没有保护：
     * 审计实测等到 **33.0 秒**仍未完成，而这里承诺的是 30 秒。
     * 现在定时器一路留到读完正文（含 `arrayBuffer` 兜底路径）；`netTimedOut` 让 catch
     * 能把「真的超时」与「底层报个别的错」分开说，不再依赖错误对象的 name（undici 中断时
     * 未必是 AbortError）。
     */
    let netTimedOut = false
    try {
      const target = new URL(String(url))
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        return { ok: false, error: '不允许的协议：' + target.protocol }
      }
      const method = String(opts.method || 'GET').toUpperCase()
      const headers = {}
      for (const [k, v] of Object.entries(opts.headers || {})) {
        const lk = String(k).toLowerCase()
        if (lk === 'cookie' || lk === 'referer' || lk === 'origin' || lk === 'host' || lk === 'content-length') continue
        headers[k] = String(v)
      }
      const ctrl = new AbortController()
      const timer = setTimeout(() => { netTimedOut = true; ctrl.abort() }, NET_TIMEOUT_MS)
      // 🔴 定时器的 finally 包住**整个请求 + 读正文**（不是只包 fetch）
      try {
        const res = await fetch(target.toString(), {
          method,
          headers,
          body: (method === 'GET' || method === 'HEAD') ? undefined : (opts.body == null ? undefined : String(opts.body)),
          redirect: 'follow',
          signal: ctrl.signal,
        })
        if (res.url && !/^https?:/i.test(res.url)) {
          return { ok: false, error: '被重定向到非 http(s) 地址，已中止' }
        }
        // 流式读并在超限时立刻中止（不要先全读进内存再判大小）
        const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null
        const chunks = []
        let received = 0
        if (reader) {
          for (;;) {
            const step = await reader.read()
            if (step.done) break
            received += step.value.byteLength
            if (received > NET_MAX_BYTES) {
              try { await reader.cancel() } catch { /* 忽略 */ }
              return { ok: false, error: '响应超过 ' + Math.round(NET_MAX_BYTES / 1024 / 1024) + 'MB 上限，已中止' }
            }
            chunks.push(Buffer.from(step.value))
          }
        } else {
          const buf = Buffer.from(await res.arrayBuffer())
          received = buf.byteLength
          if (received > NET_MAX_BYTES) {
            return { ok: false, error: '响应超过 ' + Math.round(NET_MAX_BYTES / 1024 / 1024) + 'MB 上限，已中止' }
          }
          chunks.push(buf)
        }
        return {
          ok: true, status: res.status, statusText: res.statusText,
          text: Buffer.concat(chunks).toString('utf-8'),
        }
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      const msg = (netTimedOut || (err && err.name === 'AbortError'))
        ? '请求超时（' + Math.round(NET_TIMEOUT_MS / 1000) + 's，含等待响应正文）'
        : String(err && err.message ? err.message : err)
      return { ok: false, error: msg }
    }
  })

  // ---- 主窗口 ----
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 768,
    minHeight: 600,
    // 🔴 2026-09-17 老大反馈：桌面版点开后默认是个小窗，希望**窗口化全屏**。
    //    show:false 是配套动作 —— 否则会先闪一下 1280×820 的小窗、再跳成最大化，很难看。
    show: false,
    backgroundColor: '#0c0c0f', // ink-950，避免启动白闪
    autoHideMenuBar: true,
    title: '青春幻想引擎',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // 启动即「窗口化全屏」（最大化）：铺满工作区，但**保留标题栏与系统按钮**。
  // 刻意不用 fullscreen —— 那会连标题栏一起藏掉，还会和 F11 / 视频全屏的语义混淆。
  // 必须等 `ready-to-show`：那时渲染器已画好第一帧，「最大化 + 显示」同时发生，看不到跳变。
  const showMaximized = () => {
    if (win.isDestroyed()) return
    win.maximize()
    win.show()
  }
  win.once('ready-to-show', showMaximized)
  // 兜底：万一 ready-to-show 因渲染失败没触发，5 秒后也把窗口显示出来 ——
  // 否则用户面对的是「进程起来了但什么都没出现」，比小窗糟糕得多。
  setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) showMaximized() }, 5000)

  // ---- 真·全屏切换（2.5.1 · B2）----
  // F11 进出无边框全屏，与浏览器同语义；启动行为不变（仍是上面的最大化窗口）。
  // 主进程只提供「设置 / 查询 / 状态推送」三个受控口子，按键判定在渲染层做 ——
  // 这样 F11 与 ESC 的语义只写一处，且不会与系统级全局快捷键打架。
  ipcMain.handle('window:setFullscreen', (_e, on) => {
    if (win.isDestroyed()) return false
    win.setFullScreen(!!on)
    return win.isFullScreen()
  })
  ipcMain.handle('window:isFullscreen', () => (win.isDestroyed() ? false : win.isFullScreen()))
  // 状态推送：用户直接按 F11（渲染层 toggle）之外，系统也可能改变全屏态
  //（如 Win+Shift+Enter 的系统级全屏）—— 界面开关必须跟随实际状态，不能只信自己的写入。
  // 🔴 Windows 实测坑：enter-full-screen 事件触发瞬间 win.isFullScreen() **还没翻转成 true**
  //（事件先于状态更新，读到的是旧值 false）——所以事件只当「状态可能变了」的信号，
  // 延迟一拍读实际值再推；快速连按时多次推送无妨，最终一次的读数就是终态。
  const pushFullscreen = () => {
    setTimeout(() => {
      if (win.isDestroyed()) return
      win.webContents.send('window:fullscreen-changed', win.isFullScreen())
    }, 120)
  }
  win.on('enter-full-screen', pushFullscreen)
  win.on('leave-full-screen', pushFullscreen)

  // ---- 老板键（3.3.2 · 规划 §15）----
  // 🔴 默认**不在主进程自动注册**：组合键会抢占系统/其他程序，交给渲染层按用户偏好申请，
  //    失败时界面能如实显示"被占用"，而不是启动时静默抢一个键。
  // 🔴 没有可用快捷键时 `toggle()` 拒绝隐藏 —— 否则窗口藏了、没有任何恢复入口。
  ipcMain.handle('boss:apply', (_e, accel) => bossKey.apply(win, accel))
  ipcMain.handle('boss:status', () => bossKey.status(win))
  ipcMain.handle('boss:toggle', () => bossKey.toggle(win))

  // ---- 应用图标（桌面快捷方式）切换 · 3.1.2 ----
  // 桌面 / 开始菜单两条快捷方式一起改；只动 .lnk，绝不碰主 exe 的 PE 图标资源（见 appIcon.cjs 头注释）。
  ipcMain.handle('appicon:supported', () => appIcon.supported())
  ipcMain.handle('appicon:list', () => appIcon.listPresets())
  ipcMain.handle('appicon:current', () => ({
    key: appIcon.currentKey(app),
    saved: appIcon.readSavedKey(app),
    shortcuts: appIcon.shortcutPaths(app).map(p => ({ path: p, exists: require('fs').existsSync(p) })),
  }))
  ipcMain.handle('appicon:apply', (_e, key) => {
    const r = appIcon.applyPreset(app, win, key)
    // 只有真正写成功才记偏好 —— 否则下次启动的自愈会拿一个没生效的值去比对
    if (r.ok) appIcon.writeSavedKey(app, r.key)
    return r
  })
  ipcMain.handle('appicon:reset', () => {
    const r = appIcon.applyPreset(app, win, 'default')
    if (r.ok) appIcon.writeSavedKey(app, 'default')
    return r
  })

  // 启动自愈：升级安装（NSIS `createDesktopShortcut: always`）会把快捷方式图标重建回默认，
  // 用户选的图标必须在下次启动时自动补回，否则这功能活不过一次更新。
  try {
    const saved = appIcon.readSavedKey(app)
    if (saved && saved !== 'default') {
      const r = appIcon.healIfNeeded(app, win, saved)
      if (r && r.healed) console.log('[appIcon] 启动自愈：桌面图标已恢复为「' + saved + '」')
      else if (r && r.ok === false) console.warn('[appIcon] 启动自愈未生效：', r.error)
    }
  } catch (e) {
    console.warn('[appIcon] 启动自愈异常（不影响使用）：', e && e.message ? e.message : e)
  }

  // 图标自检（`--app-icon-selftest`）：真机断言「应用后读回确实变了、还原后又变回去」。
  // 🔴 断言要自证前提：若本机没有快捷方式（未安装 / 便携版），必须报 SKIP 而不是假绿。
  if (ICON_SELFTEST) {
    const log = (...a) => console.log('[icon-selftest]', ...a)
    try {
      const lnks = appIcon.existingShortcuts(app)
      const before = lnks.length ? appIcon.readIconOf(lnks[0]) : null
      log('快捷方式：', lnks.length ? lnks.join(' ; ') : '（无）')
      log('应用前图标：', before || '（读不到）')
      if (!appIcon.supported()) {
        console.log('APP_ICON_SELFTEST_SKIP 非 Windows 平台')
        app.exit(0)
      } else if (!lnks.length) {
        console.log('APP_ICON_SELFTEST_SKIP 本机没有桌面/开始菜单快捷方式（便携版或未安装）')
        app.exit(0)
      } else {
        const a = appIcon.applyPreset(app, win, 'fantasy')
        const afterA = appIcon.readIconOf(lnks[0])
        log('应用「幻想」：', JSON.stringify(a), '→ 读回：', afterA)
        const b = appIcon.applyPreset(app, win, 'elegant')
        const afterB = appIcon.readIconOf(lnks[0])
        log('应用「典雅」：', JSON.stringify(b), '→ 读回：', afterB)
        const c = appIcon.applyPreset(app, win, 'default')
        const afterC = appIcon.readIconOf(lnks[0])
        log('还原默认：', JSON.stringify(c), '→ 读回：', afterC)
        appIcon.writeSavedKey(app, 'default')
        const changed = !!afterA && afterA !== before && afterA !== afterB && /fantasy-/.test(afterA) && /elegant-/.test(afterB)
        // 「还原」的判据＝图标回到**快捷方式自己指向的那个主程序**（不是 process.execPath ——
        // dev 下那是 electron.exe，用它当基准会得出「还原失败」的假红）
        const wantDefault = appIcon.defaultIconOf(lnks[0])
        const restored = !!afterC && require('path').resolve(afterC) === require('path').resolve(wantDefault)
        log('还原基准（快捷方式 target）：', wantDefault)
        if (changed && restored) console.log('APP_ICON_SELFTEST_OK')
        else console.log(`APP_ICON_SELFTEST_FAIL changed=${changed} restored=${restored}`)
        app.exit(0)
      }
    } catch (e) {
      console.log('APP_ICON_SELFTEST_FAIL 异常：' + (e && e.message ? e.message : e))
      app.exit(0)
    }
  }

  // 所有 target="_blank" 的外链一律交给系统浏览器打开。
  // 未配置时 Electron 会在应用内再开一个无地址栏、无法登录/下载的 BrowserWindow，
  // 用户根本意识不到那是网页（B 站主页、网盘下载页都会踩这个坑）。
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {})
    return { action: 'deny' }
  })

  // 🔴 2026-10-07 六维审计 P2：上面只拦了「新窗口」（target="_blank"），**同窗口导航没人管** ——
  //    正文/设定里若出现不带 target 的外链，一点击就把主窗口导航离开应用（且没有返回路径）。
  //    统一口径：非本应用 origin 的导航一律拦下、交给系统浏览器。
  //    · dev：ELECTRON_START_URL 的 origin（如 http://localhost:5199）
  //    · prod：loadFile ⇒ file:// 开头，全部放行（本地应用正常的同文件跳转）
  const APP_ORIGIN = (() => {
    const u = process.env.ELECTRON_START_URL
    if (u) { try { return new URL(u).origin } catch { /* 非法 URL 时退回 file:// 口径 */ } }
    return 'file://'
  })()
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(APP_ORIGIN) || url.startsWith('file://')) return
    e.preventDefault()
    shell.openExternal(url).catch(() => {})
  })

  const devUrl = process.env.ELECTRON_START_URL
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  // 冒烟测试：页面加载完成后自动退出（供构建流水线验证）
  if (SMOKE_TEST) {
    win.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        console.log('SMOKE_OK')
        app.exit(0)
      }, 1500)
    })
  }
})

app.on('window-all-closed', () => {
  app.quit()
})

// 退出时释放全局热键：不释放的话，程序都退了 Ctrl+Shift+F9 仍被系统认为"已被占用"
app.on('will-quit', () => {
  bossKey.dispose()
})
