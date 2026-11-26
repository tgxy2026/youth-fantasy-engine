/// <reference types="vite/client" />
/**
 * 桌面端 preload 注入的 WCP-Local（3.7.4）工作区桥。
 * 仅在 Electron 安装版存在；网页 / 便携版由 `wcpWorkspaceClient` 降级为 `.zip` 导出。
 */
import type { ElectronWcpWorkspaceAPI } from './lib/wcp/wcpWorkspaceClient'

declare global {
  interface Window {
    electronWcpWorkspace?: ElectronWcpWorkspaceAPI
  }
}