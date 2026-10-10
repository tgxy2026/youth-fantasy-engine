// Electron 主进程：窗口 + 本地数据文件读写（IPC）
// 数据文件保存在系统用户数据目录（Windows: C:\Users\<用户>\AppData\Roaming\<应用名>\），
// 格式与便携（U 盘）版完全一致 —— 可互相导出导入。
const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
// 2.9.0 · 应用内下载安装包的内核（只允许 http/https、先写 .part、下完比对大小）
const { downloadInstaller, cancelActiveDownload } = require('./updateDownload.cjs')
// 3.0 · W0-2 老用户数据迁移内核（探测旧 userData / 窗口前复制旧 IDB / 读写整库 JSON / profile / 卸载引导）
const migration = require('./migration.cjs')
// 3.0 · W3-2 同步文件路径闸（2026-10-10 从本文件抽出成独立模块 —— 规则可读、可被单测审读）
const { assertSyncPath } = require('./syncPath.cjs')

const SMOKE_TEST = process.argv.includes('--smoke-test')

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

  /** 迁移数据文件到新位置。目标已存在数据文件时「改用那份」（adopted），不覆盖。 */
  ipcMain.handle('store:setDataPath', async (_e, target, text) => {
    try {
      const p = String(target || '')
      if (!p || !path.isAbsolute(p)) return { ok: false, path: null, adopted: false, error: '路径无效' }
      await fsp.mkdir(path.dirname(p), { recursive: true })
      let adopted = false
      try {
        await fsp.access(p)
        adopted = true // 目标已有数据文件 → 通常是另一台设备同步过来的，改用那份
      } catch {
        await writeAtomic(p, String(text ?? ''))
      }
      await fsp.writeFile(locationFile(), JSON.stringify({ path: p }), 'utf-8')
      customDataPath = p
      return { ok: true, path: p, adopted, error: null }
    } catch (err) {
      return { ok: false, path: null, adopted: false, error: String(err) }
    }
  })

  /** 恢复默认存放位置（userData 目录）。原位置的数据文件不会被删除。 */
  ipcMain.handle('store:resetDataPath', async (_e, text) => {
    try {
      const p = path.join(app.getPath('userData'), 'youth-fantasy-engine-data.json')
      let adopted = false
      try {
        await fsp.access(p)
        adopted = true // 默认位置原本就有数据 → 沿用那份
      } catch {
        await writeAtomic(p, String(text ?? ''))
      }
      try {
        await fsp.unlink(locationFile())
      } catch {
        /* 本来就没有自定义配置 */
      }
      customDataPath = null
      return { ok: true, path: p, adopted, error: null }
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
        .replace(/[^a-zA-Z0-9.\-_:,;=<>\s*]/g, '').slice(0, max)
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
      const timer = setTimeout(() => ctrl.abort(), NET_TIMEOUT_MS)
      let res
      try {
        res = await fetch(target.toString(), {
          method,
          headers,
          body: (method === 'GET' || method === 'HEAD') ? undefined : (opts.body == null ? undefined : String(opts.body)),
          redirect: 'follow',
          signal: ctrl.signal,
        })
      } finally {
        clearTimeout(timer)
      }
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
    } catch (err) {
      const msg = err && err.name === 'AbortError'
        ? '请求超时（' + Math.round(NET_TIMEOUT_MS / 1000) + 's）'
        : String(err && err.message ? err.message : err)
      return { ok: false, error: msg }
    }
  })

  // ---- 主窗口 ----
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 640,
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
      sandbox: false,
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
