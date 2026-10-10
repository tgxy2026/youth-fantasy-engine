// preload：向渲染进程安全暴露存储 IPC（contextIsolation 开启，无 Node 能力泄漏）
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronStore', {
  /** 启动时读取本地数据文件，返回 { text, path, error } */
  load: () => ipcRenderer.invoke('store:load'),
  /** 异步保存（防抖后调用） */
  save: text => ipcRenderer.invoke('store:save', text),
  /** 同步保存（窗口关闭 beforeunload 时调用，阻塞保证写入完成） */
  saveSync: text => ipcRenderer.sendSync('store:save-sync', text),
  /** 导出全部数据到用户选择的位置（U 盘），返回文件路径或 null（取消） */
  exportFile: text => ipcRenderer.invoke('store:export', text),
  /** 把 HTML 渲染成 PDF 并保存（中文走 Chromium 打印引擎），返回文件路径或 null（取消） */
  exportPdf: (html, defaultName) => ipcRenderer.invoke('export:pdf', html, defaultName),
  /** 从用户选择的文件导入（便携版数据文件），返回文件文本或 null（取消） */
  importFile: () => ipcRenderer.invoke('store:import'),
  /** 在资源管理器中显示本地数据文件 */
  revealDataFile: () => ipcRenderer.invoke('store:reveal'),
  /** 本地数据文件完整路径（提示用） */
  dataPath: () => ipcRenderer.invoke('store:path'),
  /** 数据文件是否已被改到自定义位置（决定要不要显示「恢复默认」） */
  isCustomPath: () => ipcRenderer.invoke('store:isCustomPath'),
  /** 选择数据文件的新存放位置，返回完整文件路径或 null（取消） */
  chooseDataDir: () => ipcRenderer.invoke('store:chooseDataDir'),
  /** 迁移数据文件到新位置，返回 { ok, path, adopted, error }；adopted=目标已有数据文件，改用那份 */
  setDataPath: (target, text) => ipcRenderer.invoke('store:setDataPath', target, text),
  /** 恢复默认存放位置，返回 { ok, path, adopted, error } */
  resetDataPath: (text) => ipcRenderer.invoke('store:resetDataPath', text),
  /** 云盘文件同步：弹出原生目录选择对话框，返回目录路径或 null（取消） */
  chooseSyncDir: () => ipcRenderer.invoke('sync:chooseDir'),
  /** 云盘文件同步：读取同步目录下的文件（经主进程 fs，渲染进程 nodeIntegration=false 不可用 require） */
  syncRead: (p) => ipcRenderer.invoke('sync:readFile', p),
  /** 云盘文件同步：原子写文件（tmp + .bak 回退），避免写崩导致 .yfe 损坏 */
  syncWrite: (p, text) => ipcRenderer.invoke('sync:writeFile', p, text),
  // ---- 外置大块数据（sidecar）：备份载荷存独立文件，主 JSON 只留元数据 ----
  /** 读一条外置记录；{ ok:true, missing:true } = 还没有 */
  payloadRead: (store, id) => ipcRenderer.invoke('payload:read', store, id),
  /** 写一条外置记录（text 为该记录的 JSON 串） */
  payloadWrite: (store, id, text) => ipcRenderer.invoke('payload:write', store, id, text),
  /** 删一条外置记录（幂等） */
  payloadDel: (store, id) => ipcRenderer.invoke('payload:del', store, id),
  /** 列该 store 的全部外置 id */
  payloadList: (store) => ipcRenderer.invoke('payload:list', store),
})

// 联网检索：由主进程代发请求。搜索接口大多不带 CORS 头，渲染进程直连会被同源策略拦掉，
// 而桌面版唯一的「后端」就是这个主进程。（便携版是单文件 HTML、跑在浏览器里，没有这一层。）
contextBridge.exposeInMainWorld('electronNet', {
  /**
   * 代发一次 HTTP 请求。
   * @returns {Promise<{ok:true,status:number,statusText:string,text:string}|{ok:false,error:string}>}
   *          **永不 reject** —— 失败以 ok:false 返回，调用方必须如实告诉作者（别静默退化成瞎编）。
   */
  fetch: (url, init) => ipcRenderer.invoke('net:fetch', url, init),
  /**
   * 推送网络代理配置（2026-09-28）：用户在「模型设置 → 网络代理」自填的出口地址。
   * 配置持久化在渲染层 localStorage（仅本机、不进云盘同步），主进程不落盘 —— 每次启动由渲染层重推。
   * @returns {Promise<{ok:true}|{ok:false,error:string}>}
   */
  setProxy: (cfg) => ipcRenderer.invoke('net:set-proxy', cfg),
  // 2.6.3 · 检查更新：用系统默认浏览器打开下载链接（主进程侧只放行 http/https）
  openExternal: (url) => ipcRenderer.invoke('net:open-external', url),
})

// 窗口控制（2.5.1 · B2）：只暴露全屏切换三个口子，按键判定（F11/ESC）在渲染层。
contextBridge.exposeInMainWorld('electronWindow', {
  /** 设置真全屏（无边框）；返回实际全屏态 */
  setFullScreen: (on) => ipcRenderer.invoke('window:setFullscreen', on),
  /** 查询当前全屏态 */
  isFullscreen: () => ipcRenderer.invoke('window:isFullscreen'),
  /** 订阅全屏态变化（主进程 enter/leave-full-screen 推送）；返回退订函数 */
  onFullscreenChange: (cb) => {
    const h = (_e, on) => cb(on)
    ipcRenderer.on('window:fullscreen-changed', h)
    return () => ipcRenderer.removeListener('window:fullscreen-changed', h)
  },
})

// 应用内下载安装包（2.9.0 · 检查更新 2.0）：把「点下载＝开系统浏览器」换成
// 「下到「下载」文件夹 → 拉起安装向导」。🔴 目标目录由主进程钉死在 app.getPath('downloads')，
// 渲染层只给文件名（主进程还要清洗）；进度由主进程节流后推送。
contextBridge.exposeInMainWorld('electronUpdate', {
  /** 下载安装包；返回 { ok:true, path, size } 或 { ok:false, cancelled?, error }（永不 reject） */
  download: (url, fileName) => ipcRenderer.invoke('update:download', url, fileName),
  /** 取消进行中的下载；返回 { ok }（true = 确实中止了一个） */
  cancel: () => ipcRenderer.invoke('update:cancel'),
  /** 拉起刚下好的安装器；closeApp=true 则随后退出本程序（覆盖更新须旧文件不被占用） */
  launchInstaller: (filePath, closeApp) => ipcRenderer.invoke('update:launch-installer', filePath, closeApp),
  /** 在资源管理器中定位安装包 */
  revealFile: (filePath) => ipcRenderer.invoke('update:reveal-file', filePath),
  /** 退出本程序（安装前腾出被占用的文件；走 app.quit ⇒ 触发渲染层 beforeunload 的同步存盘） */
  quitApp: () => ipcRenderer.invoke('app:quit'),
  /** 订阅下载进度；返回退订函数 */
  onProgress: (cb) => {
    const h = (_e, p) => cb(p)
    ipcRenderer.on('update:progress', h)
    return () => ipcRenderer.removeListener('update:progress', h)
  },
})

// 3.0 · W0-2 老用户数据迁移：探测旧版（novel-studio）数据、读旧整库 JSON、写新整库 JSON、
// 复制 Chromium profile、定位并拉起旧版卸载器。remap 逻辑在渲染层（纯函数可单测），这层只搬运。
contextBridge.exposeInMainWorld('electronMigration', {
  /** 探测旧版数据是否存在（含旧 JSON / IDB / profile / 自定义数据路径），返回结构化结果 */
  probe: () => ipcRenderer.invoke('migration:probe'),
  /** 读旧整库 JSON 原文，返回 { ok, text, path } 或 { ok:false, error } */
  readLegacyJson: () => ipcRenderer.invoke('migration:readLegacyJson'),
  /** 把 remap 后的整库 JSON 写入新 userData，返回 { ok, path } 或 { ok:false, error } */
  writeNewJson: (text) => ipcRenderer.invoke('migration:writeNewJson', text),
  /** 复制旧 Chromium profile 文件（已存在项自动跳过），返回 { ok, copied[] } */
  copyProfile: () => ipcRenderer.invoke('migration:copyProfile'),
  /** 尽力定位旧版卸载器，返回 { ok, hits:[{dir, uninstaller}] } */
  findUninstaller: () => ipcRenderer.invoke('migration:findUninstaller'),
  /** 拉起指定卸载器，返回 { ok } 或 { ok:false, error } */
  runUninstaller: (p) => ipcRenderer.invoke('migration:runUninstaller', p),
  /** 在资源管理器里打开旧版数据目录 —— 作者确认数据已迁移后，可手动清理残留 */
  revealLegacyDir: () => ipcRenderer.invoke('migration:revealLegacyDir'),
})
