// Electron 主进程：窗口 + 本地数据文件读写（IPC）
// 数据文件保存在系统用户数据目录（Windows: C:\Users\<用户>\AppData\Roaming\青春幻想引擎\），
// 格式与便携（U 盘）版完全一致 —— 可互相导出导入。
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')

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
 * 默认在用户数据目录（Windows: C:\Users\<用户>\AppData\Roaming\novel-studio\），
 * 用户可改到云盘同步目录里（WPS 云盘 / OneDrive 等）实现跨设备同步。
 */
function dataFile() {
  return customDataPath || path.join(app.getPath('userData'), 'novel-studio-data.json')
}

function readDataFileSync() {
  try {
    return fs.readFileSync(dataFile(), 'utf-8')
  } catch {
    return null // 文件不存在（首次使用）属正常情况
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
function writeAtomicSync(file, text) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, text, 'utf-8')
  fs.renameSync(tmp, file)
}

async function writeAtomic(file, text) {
  const tmp = file + '.tmp'
  await fsp.writeFile(tmp, String(text), 'utf-8')
  await fsp.rename(tmp, file)
}

app.whenReady().then(() => {
  loadCustomPath() // 恢复用户自定义的数据文件位置（若有）
  // ---- 存储相关 IPC ----
  // 启动时读取本地数据文件
  ipcMain.handle('store:load', () => {
    try {
      return { text: readDataFileSync(), path: dataFile(), error: null }
    } catch (e) {
      return { text: null, path: dataFile(), error: String(e) }
    }
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
    return path.join(r.filePaths[0], 'novel-studio-data.json')
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
      const p = path.join(app.getPath('userData'), 'novel-studio-data.json')
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
      return await fsp.readFile(p, 'utf-8')
    } catch {
      return null // 文件不存在（首次）或读取失败，视为空
    }
  })
  ipcMain.handle('sync:writeFile', async (_e, p, text) => {
    try {
      // 原子写：先写 tmp，再把旧文件改名 .bak（回退用），最后 rename tmp 为正文件，避免写崩损坏。
      const tmp = p + '.tmp'
      await fsp.writeFile(tmp, String(text), 'utf-8')
      try {
        await fsp.rename(p, p + '.bak')
      } catch {
        /* 首次写入无旧文件，忽略 */
      }
      await fsp.rename(tmp, p)
      return { ok: true, error: null }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // ---- 主窗口 ----
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 640,
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

  // 所有 target="_blank" 的外链一律交给系统浏览器打开。
  // 未配置时 Electron 会在应用内再开一个无地址栏、无法登录/下载的 BrowserWindow，
  // 用户根本意识不到那是网页（B 站主页、网盘下载页都会踩这个坑）。
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {})
    return { action: 'deny' }
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
