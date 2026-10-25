import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App'
import ErrorBoundary from '@/components/common/ErrorBoundary'
import './index.css'
import { installGlobalErrorHooks } from '@/lib/app/errorLog'
import { installWebTabGuard } from '@/lib/app/tabGuard'
import { installMobileHint } from '@/lib/app/mobileHint'
import { installFileDropGuard } from '@/lib/app/dropGuard'
import { initializeAppearance } from '@/lib/settings/appearance'

initializeAppearance()

// 全局错误留痕（2026-10-06 · 可观测性）：脚本错误与未处理的 Promise 拒绝都记进内存环形缓冲，
// 供「关于打赏 → 复制诊断信息」带上。不落盘、不外发、不弹窗（取舍见 lib/errorLog.ts 顶部）。
installGlobalErrorHooks()

// 网页版多标签页互斥提示（WEB-02）：同一账号在多个标签页编辑会互相覆盖，这里用 BroadcastChannel
// 探测并提示。非网页版（桌面 / 便携）内部第一行即返回，是空操作。
installWebTabGuard()

// 网页版窄屏提示（WEB-11）：界面按桌面布局，手机上基本不可用，这里给一句告知但不阻止访问。
installMobileHint()

// 图片拖拽上传的兜底：拖文件没落进图片区域时，别让浏览器拿它替换整个页面
// （桌面版整页跳走 = 未保存正文当场没了）。只在拖「文件」时拦，不影响章节拖拽调序与正文选区拖动。
installFileDropGuard()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
