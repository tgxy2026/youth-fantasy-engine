import { useEffect, useState } from 'react'
import { Cloud, LogOut, FolderOpen } from 'lucide-react'
import PromptModal from './PromptModal'
import HelpPopover from './HelpPopover'
import { showToast } from './dialogs'
import { WEB } from '../lib/env'
import { enableCloudSync } from '../lib/db'
import { getSyncStatus, type SyncStatus, CloudAuthError, isCloudAuthFailed, getCloudBackupMeta, restoreFromCloudBackup } from '../lib/serverStore'
import { setSyncTransport } from '../lib/serverStore'
import {
  getSyncMode,
  setSyncMode,
  saveSyncFolderHandle,
  loadSyncFolderHandle,
  createFileTransport,
  createHttpTransport,
  type SyncMode,
} from '../lib/syncTransport'
import { STATUS_META } from '../lib/syncStatusMeta'
import { confirmDialog } from './dialogs'
import { Button } from './Button'

/**
 * 网页体验版工具条（#032 收编）。
 *
 * 仅负责 WEB 平台的云端同步（服务器 / 云盘文件中转，含进门邀请码与「退出网页体验」）。
 * 桌面 / 便携版的「云盘文件同步」已独立为 CloudFileSyncBar（无服务器、无同步码），
 * 两者由 DataDock / Sidebar 统一排版承载，本组件不再画自己的 fixed 浮层。
 */
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
  const [backupDay, setBackupDay] = useState<string | null>(null)

  // #031：同步方式（服务器 / 云盘文件中转）
  const [mode, setMode] = useState<SyncMode>(() => {
    try {
      return getSyncMode()
    } catch {
      return 'http'
    }
  })
  const [folderName, setFolderName] = useState<string | null>(null)

  useEffect(() => {
    if (!WEB) return
    const onStatus = () => setStatus(getSyncStatus())
    const onConflict = () =>
      showToast('检测到云端与本地改过同一处：已保留你的版本，并在本地另存云端副本', 'info', 5000)
    const onAuthFailed = () => {
      setSynced(false)
      showToast('云端同步邀请码已失效，已切回本地数据（数据仍在本地，不会丢失）', 'error')
    }
    if (isCloudAuthFailed()) {
      setSynced(false)
      onAuthFailed()
    }
    window.addEventListener('yfe:sync-status', onStatus)
    window.addEventListener('yfe:cloud-auth-failed', onAuthFailed)
    window.addEventListener('yfe:sync-conflict', onConflict)
    if (getSyncMode() === 'file') {
      loadSyncFolderHandle()
        .then((h) => {
          if (h && h.name) setFolderName(h.name)
        })
        .catch(() => {})
    }
    const tick = () => setBackupDay(getCloudBackupMeta()?.day ?? null)
    tick()
    const id = setInterval(tick, 3000)
    return () => {
      window.removeEventListener('yfe:sync-status', onStatus)
      window.removeEventListener('yfe:cloud-auth-failed', onAuthFailed)
      window.removeEventListener('yfe:sync-conflict', onConflict)
      clearInterval(id)
    }
  }, [])

  const switchMode = (m: SyncMode) => {
    setMode(m)
    setSyncMode(m)
    if (m === 'file') {
      loadSyncFolderHandle()
        .then((h) => {
          if (h) {
            setSyncTransport(createFileTransport(h))
            if (h.name) setFolderName(h.name)
          }
        })
        .catch(() => {})
    } else {
      setSyncTransport(createHttpTransport())
    }
  }

  const pickFolder = async () => {
    try {
      const picker = (window as any).showDirectoryPicker
      if (typeof picker !== 'function') {
        showToast('当前浏览器不支持选择同步文件夹，请改用 Chrome / Edge，或使用手动导入导出', 'error', 6000)
        return
      }
      const h = await picker({ mode: 'readwrite' })
      setSyncTransport(createFileTransport(h))
      await saveSyncFolderHandle(h)
      setSyncMode('file')
      setMode('file')
      setFolderName(h.name)
      showToast('已选定同步文件夹：' + h.name + '（建议把它放进 OneDrive / Dropbox / 百度网盘 / WPS 云盘 等同步目录，即可跨设备同步）', 'success', 7000)
    } catch (e: any) {
      if (e && e.name === 'AbortError') return
      showToast('选择文件夹失败：' + (e?.message || e), 'error')
    }
  }

  const onRestore = async () => {
    const ok = await confirmDialog({
      title: '从云端备份恢复',
      message: `将把当前数据回滚到云端每日备份（${backupDay || '未知日期'}）并重新同步。\n此操作会丢弃该备份时间点之后的本地改动，确定继续吗？`,
      confirmText: '恢复',
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      const done = await restoreFromCloudBackup()
      if (done) {
        showToast('已从云端备份恢复，正在重新同步…', 'success')
        setTimeout(() => location.reload(), 600)
      } else {
        showToast('暂无可用的云端备份', 'error')
        setBusy(false)
      }
    } catch {
      showToast('恢复失败，请稍后重试', 'error')
      setBusy(false)
    }
  }

  const doSync = async (raw: string) => {
    const code = String(raw || '').replace(/\s+/g, '').toUpperCase()
    if (mode === 'file' && !folderName) {
      showToast('云盘文件中转模式需要先「选择同步文件夹」', 'error', 5000)
      return
    }
    setBusy(true)
    try {
      if (code.startsWith('YFE-D')) {
        showToast('这看起来是进门用的网页邀请码，不是云同步码（云同步码以 YFE-SYNC 开头）', 'error', 5000)
        setBusy(false)
        return
      }
      await enableCloudSync(code)
      setSynced(true)
      showToast('云端同步已开启，正在载入云端数据…', 'success')
      setTimeout(() => location.reload(), 600)
    } catch (e) {
      showToast(
        e instanceof CloudAuthError ? '同步邀请码无效或已失效，请核对后重试' : '连接失败，请检查网络后重试',
        'error',
      )
      setBusy(false)
      setSyncOpen(false)
    }
  }

  // 网页版沿用「同步邀请码」语义，状态徽标文案保持与码相关
  const meta =
    status === 'auth-failed'
      ? { ...STATUS_META['auth-failed'], title: '同步邀请码已失效，已切回本地数据' }
      : STATUS_META[status]

  const segCls = (m: SyncMode) =>
    'rounded px-2 py-1 text-xs border transition-colors ' +
    (mode === m
      ? 'border-sky-400/60 bg-sky-400/15 text-sky-200'
      : 'border-ink-700 text-ink-400 hover:text-ink-200')

  const rowBtn =
    'flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border px-2 text-[12px] transition-colors disabled:opacity-60 '

  if (!WEB) return null

  return (
    <div className="flex flex-col gap-1.5">
      {/* 标题行 */}
      <div className="flex items-center gap-1.5 text-xs text-ink-300">
        <Cloud size={13} className="text-sky-300/90" />
        <span className="font-medium">云端同步</span>
        {synced && (
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-ink-300">
            <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
            {meta.text || '待命'}
          </span>
        )}
        <HelpPopover title="云端同步说明" side="right" width="22rem">
          {`云端同步把项目数据实时保存到${mode === 'file' ? '你选定的云盘同步文件夹' : '云端服务器'}，可在其它设备登录同一同步邀请码继续创作。
断网或服务不可达时会自动回退本地保存、编辑不丢；恢复后自动重新同步。
云端每日保留一份滚动备份（最新一份、按天滚动）：若当天手滑推了坏数据，可点「从云端备份恢复」回退到当天/昨日的检查点。
注意：同步邀请码（YFE-SYNC- 开头）与进门的网页邀请码不是同一个。${
            mode === 'file'
              ? '\n当前为「云盘文件中转」模式：数据以加密文件落在你选的同步文件夹里，由 OneDrive / WPS 云盘 等客户端负责跨设备同步。'
              : ''
          }`}
        </HelpPopover>
      </div>

      {/* 同步方式切换 */}
      <div className="flex items-center gap-1.5 text-[11px] text-ink-400">
        <span className="shrink-0 opacity-70">方式</span>
        <button type="button" className={segCls('http') + ' flex-1'} onClick={() => switchMode('http')}>
          服务器
        </button>
        <button type="button" className={segCls('file') + ' flex-1'} onClick={() => switchMode('file')}>
          云盘文件
        </button>
      </div>

      {mode === 'file' && (
        <Button
          variant="bare"
          onClick={pickFolder}
          disabled={busy}
          title="选择用于跨设备同步的本地文件夹（建议放进 OneDrive / WPS 云盘 等同步目录）"
          className={rowBtn + 'border-ink-600/80 bg-ink-800/60 text-ink-300 hover:border-amber/50 hover:text-ink-100'}
        >
          <FolderOpen size={13} />
          <span className="truncate">{folderName ? '更换：' + folderName : '选择同步文件夹'}</span>
        </Button>
      )}

      <Button
        variant="bare"
        onClick={() => setSyncOpen(true)}
        disabled={busy}
        title={synced ? `${meta.title}（点击可重新连接）` : '开启云端同步（需专属同步邀请码）'}
        className={
          rowBtn +
          (synced
            ? 'border-sky-400/40 bg-sky-400/10 text-sky-300 hover:bg-sky-400/20'
            : 'border-sky-400/40 bg-sky-400/10 text-sky-300 hover:bg-sky-400/20')
        }
      >
        <Cloud size={13} />
        {synced ? '已开启·重新连接' : '开启云端同步'}
      </Button>

      {synced && backupDay && (
        <Button
          variant="bare"
          onClick={onRestore}
          disabled={busy}
          title={`云端每日备份（${backupDay}）· 点击回滚到该检查点`}
          className={rowBtn + 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          从云端备份恢复（{backupDay}）
        </Button>
      )}

      <Button
        variant="bare"
        onClick={() => {
          try {
            localStorage.removeItem('yfe-invite-ok')
          } catch {
            /* 忽略 */
          }
          location.reload()
        }}
        title="退出网页体验（回到邀请码输入页，已开启的云端同步将保留）"
        className={rowBtn + 'border-ink-600/80 bg-ink-800/60 text-ink-300 hover:border-amber/50 hover:text-ink-100'}
      >
        <LogOut size={13} />
        退出网页体验
      </Button>

      <PromptModal
        open={syncOpen}
        title="开启云端同步"
        label="输入你专属的同步邀请码（YFE-SYNC- 开头，与进门用的邀请码不是同一个）。开启后项目数据将实时保存并跨设备同步。"
        placeholder="同步邀请码"
        transformUppercase
        confirmText={busy ? '连接中…' : '开启同步'}
        onSubmit={doSync}
        onCancel={() => setSyncOpen(false)}
      />
    </div>
  )
}
