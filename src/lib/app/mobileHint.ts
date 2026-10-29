// Native DOM remains available even when the React application fails to render.
import { WEB } from '@/lib/app/platform'
import { showNativeNotice, removeNativeNotice } from './nativeNotices'
const DISMISS_KEY = 'yfe-mobile-hint-off'
const NARROW = 768
let installed = false
export function installMobileHint(): void {
  if (!WEB || typeof window === 'undefined' || installed) return
  installed = true
  let dismissed = false
  try { dismissed = sessionStorage.getItem(DISMISS_KEY) === '1' } catch { /* Optional dismissal only. */ }
  const check = () => {
    if (window.innerWidth >= NARROW || dismissed) { removeNativeNotice('yfe-mobile-hint'); return }
    showNativeNotice('yfe-mobile-hint', '本工具为长篇写作设计，界面按电脑屏幕布局；手机上建议先用「导出数据」留档，再换电脑访问。', '关闭窄屏提示', () => {
      dismissed = true
      try { sessionStorage.setItem(DISMISS_KEY, '1') } catch { /* Private browsing must still allow closing this notice. */ }
    })
  }
  check(); window.addEventListener('resize', check, { passive: true }); window.addEventListener('pageshow', check)
}
