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
