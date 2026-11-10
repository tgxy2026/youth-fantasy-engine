import { leaveGuardDirty, runLeaveGuard } from '@/lib/editor/leaveBarrier'
import { candidateApplyContext } from '@/lib/ai/candidateContext'
import { showNativeNotice } from '@/lib/app/nativeNotices'

/** Switch views only after saving the current editor; neither data set is modified. */
export async function switchAccountStorage(local: boolean): Promise<boolean> {
  const user = (window as unknown as { __YFE_USER__?: { id?: string; cloudSync?: boolean } }).__YFE_USER__
  if (!user?.id || !user.cloudSync) return false
  const owner = candidateApplyContext()
  if (leaveGuardDirty()) {
    const result = await runLeaveGuard()
    if (!result.ok || owner !== candidateApplyContext()) return false
  }
  try {
    const key = `yfe:account-local:${user.id}`
    if (local) localStorage.setItem(key, '1')
    else localStorage.removeItem(key)
  } catch {
    showNativeNotice('account-local-switch', '无法保存存储切换设置，请检查浏览器存储权限。', '关闭', () => {})
    return false
  }
  location.reload()
  return true
}
