import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App'
import ErrorBoundary from '@/components/common/ErrorBoundary'
import './index.css'
import { installGlobalErrorHooks } from '@/lib/app/errorLog'
import { installWebTabGuard } from '@/lib/app/tabGuard'

// 全局错误留痕（2026-10-06 · 可观测性）：脚本错误与未处理的 Promise 拒绝都记进内存环形缓冲，
// 供「关于打赏 → 复制诊断信息」带上。不落盘、不外发、不弹窗（取舍见 lib/errorLog.ts 顶部）。
installGlobalErrorHooks()

// 网页版多标签页互斥提示（WEB-02）：同一账号在多个标签页编辑会互相覆盖，这里用 BroadcastChannel
// 探测并提示。非网页版（桌面 / 便携）内部第一行即返回，是空操作。
installWebTabGuard()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
