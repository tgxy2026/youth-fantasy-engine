import { useEffect, useState } from 'react'
import { Cloud, LogOut } from 'lucide-react'
import PromptModal from './PromptModal'
import { showToast } from './dialogs'
import { enableCloudSync } from '../lib/db'
import { getSyncStatus, type SyncStatus, CloudAuthError, isCloudAuthFailed } from '../lib/serverStore'

// 同步状态徽标（#008）：推送失败必须可见，不能让用户零感知地"写了一整晚白工"
const STATUS_META: Record<SyncStatus, { dot: string; text: string; title: string }> = {
  idle: { dot: 'bg-ink-500', text: '', title: '云端同步待命' },
  syncing: { dot: 'bg-amber-400 animate-pulse', text: '同步中', title: '正在上传到云端…' },
  ok: { dot: 'bg-emerald-400', text: '已同步', title: '数据已保存到云端' },
  error: { dot: 'bg-rose-400', text: '同步失败', title: '上传失败，编辑已保留在本地，稍后自动重试' },
  'auth-failed': { dot: 'bg-rose-500', text: '码已失效', title: '同步码已失效，已切回本地数据' },
}

// 网页体验版专属工具条（项目管理主页左下角常驻，由 App 统一包容器定位）：
//  - 云端同步：输入专属同步邀请码开启（#003），开启后项目数据实时存云端、可跨设备访问
//  - 退出体验：清除「已通过邀请」标记并重载，回到邀请码填写页（便于重新验证/换设备）
export default function WebTools() {
  const [syncOpen, setSyncOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [synced, setSynced] = useState(() => {
    try {
      return !!localStorage.getItem('yfe-sync-code')
    } catch {
      return false
    }
  })
  const [status, setStatus] = useState<SyncStatus>(getSyncStatus())

  useEffect(() => {
    const onStatus = () => setStatus(getSyncStatus())
    const onConflict = () =>
      showToast('检测到云端与本地改过同一处：已保留你的版本，并在本地另存云端副本', 'info', 5000)
    const onAuthFailed = () => {
      setSynced(false)
      showToast('云端同步码已失效，已切回本地数据（数据仍在本地，不会丢失）', 'error')
    }
    // 兜底：启动时（db.ts）的失效事件可能早于本组件挂载而被漏听，这里补查一次当前状态
    if (isCloudAuthFailed()) {
      setSynced(false)
      onAuthFailed()
    }
    window.addEventListener('yfe:sync-status', onStatus)
    window.addEventListener('yfe:cloud-auth-failed', onAuthFailed)
    window.addEventListener('yfe:sync-conflict', onConflict)
    return () => {
      window.removeEventListener('yfe:sync-status', onStatus)
      window.removeEventListener('yfe:cloud-auth-failed', onAuthFailed)
      window.removeEventListener('yfe:sync-conflict', onConflict)
    }
  }, [])

  const doSync = async (code: string) => {
    setBusy(true)
    try {
      await enableCloudSync(code.trim())
      setSynced(true)
      showToast('云端同步已开启，正在载入云端数据…', 'success')
      // 重载以让 boot 以云端存储状态重新拉取数据
      setTimeout(() => location.reload(), 600)
    } catch (e) {
      // #007：明确区分「码无效」与「网络异常」，不再一律提示含糊的"无效或连接失败"
      showToast(
        e instanceof CloudAuthError ? '同步码无效或已失效，请核对后重试' : '连接失败，请检查网络后重试',
        'error',
      )
      setBusy(false)
      setSyncOpen(false)
    }
  }

  const meta = STATUS_META[status]

  return (
    <>
      <div className="flex flex-col items-start gap-2">
        <button
          onClick={() => setSyncOpen(true)}
          disabled={busy}
          title={synced ? `${meta.title}（点击可重新连接）` : '开启云端同步（需专属同步邀请码）'}
          className="flex items-center gap-2 rounded-full border border-sky-400/40 bg-ink-900/90 px-4 py-2 text-sm text-sky-300 shadow-lg backdrop-blur hover:bg-ink-800 disabled:opacity-60"
        >
          <Cloud size={16} />
          {synced ? '云端同步·已开' : '云端同步'}
          {synced && (
            <span className="flex items-center gap-1.5 text-xs text-ink-300">
              <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
              {meta.text}
            </span>
          )}
        </button>
        <button
          onClick={() => {
            try {
              localStorage.removeItem('yfe-invite-ok')
            } catch {
              /* 忽略 */
            }
            location.reload()
          }}
          title="退出邀请（重新输入邀请码）"
          className="flex items-center gap-2 rounded-full border border-ink-700 bg-ink-900/90 px-4 py-2 text-sm text-ink-300 shadow-lg backdrop-blur hover:bg-ink-800"
        >
          <LogOut size={16} />
          退出体验
        </button>
      </div>
      <PromptModal
        open={syncOpen}
        title="开启云端同步"
        label="输入你专属的同步邀请码（YFE-SYNC- 开头，与进门用的邀请码不是同一个）。开启后项目数据将实时保存在云端，可在其它设备登录同一邀请码继续创作。"
        placeholder="同步邀请码"
        confirmText={busy ? '连接中…' : '开启同步'}
        onSubmit={doSync}
        onCancel={() => setSyncOpen(false)}
      />
    </>
  )
}
