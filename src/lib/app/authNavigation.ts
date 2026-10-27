import { leaveGuardDirty, runLeaveGuard } from '@/lib/editor/leaveBarrier'
import { candidateApplyContext } from '@/lib/ai/candidateContext'
import { captureWorkspaceView } from '@/lib/settings/workspaceRuntime'
import { showNativeNotice } from './nativeNotices'
let pending = false
export async function navigateAuth(path: '/login' | '/logout'): Promise<boolean> {
  if (pending) return false
  captureWorkspaceView()
  if (!leaveGuardDirty()) { location.assign(path); return true }
  const context = candidateApplyContext(); pending = true
  try {
    const result = await runLeaveGuard()
    if (context !== candidateApplyContext()) return false
    if (!result.ok) {
      showNativeNotice('yfe-auth-navigation-error', '上次打开账号页面时未确认保存，已留在原页面。请先保存或导出草稿，再打开账号页面。', '关闭账号跳转提示', () => {})
      return false
    }
    location.assign(path); return true
  } finally { pending = false }
}
/** Capture normal same-window account links, preserving browser new-tab and copy-link behavior. */
export function installAuthNavigation(): void {
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (!(anchor instanceof HTMLAnchorElement) || anchor.target === '_blank' || anchor.hasAttribute('download')) return
    const url = new URL(anchor.href, location.href)
    if (url.origin !== location.origin || !['/login', '/logout'].includes(url.pathname) || !leaveGuardDirty()) return
    event.preventDefault(); void navigateAuth(url.pathname as '/login' | '/logout')
  }, true)
}
