import { useState } from 'react'
import { Cloud, LogOut } from 'lucide-react'
import PromptModal from './PromptModal'
import { showToast } from './dialogs'
import { enableCloudSync } from '../lib/db'

// 网页体验版专属工具条（项目管理主页左下角常驻，由 App 统一包容器定位）：
//  - 云端同步：输入专属同步邀请码开启（#003），开启后项目数据实时存云端、可跨设备访问
//  - 退出体验：清除「已通过邀请」标记并重载，回到邀请码填写页（便于重新验证/换设备）
export default function WebTools() {
  const [syncOpen, setSyncOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const synced = (() => {
    try {
      return !!localStorage.getItem('yfe-sync-code')
    } catch {
      return false
    }
  })()

  const doSync = async (code: string) => {
    setBusy(true)
    try {
      await enableCloudSync(code.trim())
      showToast('云端同步已开启，正在载入云端数据…', 'success')
      // 重载以让 boot 以云端存储状态重新拉取数据
      setTimeout(() => location.reload(), 600)
    } catch {
      showToast('同步码无效或连接失败', 'error')
      setBusy(false)
      setSyncOpen(false)
    }
  }

  return (
    <>
      <div className="flex flex-col items-start gap-2">
        <button
          onClick={() => setSyncOpen(true)}
          disabled={busy}
          title={synced ? '已开启云端同步（点击可重新连接）' : '开启云端同步（需专属同步邀请码）'}
          className="flex items-center gap-2 rounded-full border border-sky-400/40 bg-ink-900/90 px-4 py-2 text-sm text-sky-300 shadow-lg backdrop-blur hover:bg-ink-800 disabled:opacity-60"
        >
          <Cloud size={16} />
          {synced ? '云端同步·已开' : '云端同步'}
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
        label="输入你专属的同步邀请码。开启后项目数据将实时保存在云端，可在其它设备登录同一邀请码继续创作。"
        placeholder="同步邀请码"
        confirmText={busy ? '连接中…' : '开启同步'}
        onSubmit={doSync}
        onCancel={() => setSyncOpen(false)}
      />
    </>
  )
}
