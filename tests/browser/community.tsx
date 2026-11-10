// 投稿广场视觉验收夹具（3.5.0）
//
// 只做一件事：把真实组件挂到空页面上，让 Playwright 用**拦截的接口数据**渲染不同状态。
// 🔴 不复制组件内部结构、不改产品代码；截图反映的就是当前源码的样式。
// 🔴 必须应用真实主题：`index.css` 的 :root 只是兜底，产品的默认主题是「护眼」，
//    由 `applyTheme` 在运行时写入 CSS 变量；不调用它截图会得到一套不存在的暗色。
// 🔴 数据全部是夹具，不连接真实服务、不读真实账号。

import '@/index.css'
import { createRoot } from 'react-dom/client'
import { applyTheme, type ThemeId } from '@/lib/settings/theme'
import CommunitySquare from '@/components/community/CommunitySquare'

const params = new URLSearchParams(location.search)
const mode = params.get('mode') === 'overlay' ? 'overlay' : 'page'
const layoutParam = params.get('layout')
const forceLayout = layoutParam === 'wide' || layoutParam === 'narrow' ? layoutParam : undefined
const theme = (params.get('theme') || 'eye-care')
applyTheme(theme as ThemeId)
document.documentElement.dataset.communityFixture = '1'

const host = document.getElementById('root')
if (!host) throw new Error('缺少 #root')
createRoot(host).render(
  <div className={mode === 'overlay' ? 'h-full' : 'h-full bg-surface-app p-4'}>
    <CommunitySquare
      mode={mode}
      forceLayout={forceLayout}
      onClose={() => { /* 夹具不需要关闭行为 */ }}
    />
  </div>,
)