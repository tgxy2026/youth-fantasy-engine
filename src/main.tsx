import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App'
import ErrorBoundary from '@/components/common/ErrorBoundary'
import './index.css'
import { installGlobalErrorHooks } from '@/lib/app/errorLog'

// 全局错误留痕（2026-10-06 · 可观测性）：脚本错误与未处理的 Promise 拒绝都记进内存环形缓冲，
// 供「关于打赏 → 复制诊断信息」带上。不落盘、不外发、不弹窗（取舍见 lib/errorLog.ts 顶部）。
installGlobalErrorHooks()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
