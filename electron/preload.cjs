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
  /** 从用户选择的文件导入（便携版数据文件），返回文件文本或 null（取消） */
  importFile: () => ipcRenderer.invoke('store:import'),
  /** 在资源管理器中显示本地数据文件 */
  revealDataFile: () => ipcRenderer.invoke('store:reveal'),
  /** 本地数据文件完整路径（提示用） */
  dataPath: () => ipcRenderer.invoke('store:path'),
})
