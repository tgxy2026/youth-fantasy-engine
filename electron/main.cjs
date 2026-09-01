// Electron 主进程：窗口 + 本地数据文件读写（IPC）
// 数据文件保存在系统用户数据目录（Windows: C:\Users\<用户>\AppData\Roaming\青春幻想引擎\），
// 格式与便携（U 盘）版完全一致 —— 可互相导出导入。
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')

const SMOKE_TEST = process.argv.includes('--smoke-test')

/** 本地数据文件路径（用户数据目录，随安装自动创建） */
function dataFile() {
  return path.join(app.getPath('userData'), 'novel-studio-data.json')
}

function readDataFileSync() {
  try {
    return fs.readFileSync(dataFile(), 'utf-8')
  } catch {
    return null // 文件不存在（首次使用）属正常情况
  }
}

app.whenReady().then(() => {
  // ---- 存储相关 IPC ----
  // 启动时读取本地数据文件
  ipcMain.handle('store:load', () => {
    try {
      return { text: readDataFileSync(), path: dataFile(), error: null }
    } catch (e) {
      return { text: null, path: dataFile(), error: String(e) }
    }
  })

  // 防抖后的异步写盘（渲染层每次数据变更后调用）
  ipcMain.handle('store:save', async (_e, text) => {
    try {
      await fsp.writeFile(dataFile(), String(text), 'utf-8')
      return { ok: true, error: null }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // 同步写盘：窗口关闭（beforeunload）时保证未保存数据落盘
  ipcMain.on('store:save-sync', (e, text) => {
    try {
      fs.writeFileSync(dataFile(), String(text), 'utf-8')
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
