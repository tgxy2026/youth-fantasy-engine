import { useEffect, useState } from 'react'
import { Cloud, LogOut, FolderOpen, CloudOff } from 'lucide-react'
import PromptModal from './PromptModal'
import HelpPopover from './HelpPopover'
import { showToast } from './dialogs'
import { WEB } from '../lib/env'
import { enableCloudSync, enableWebCloudFileSync, disableWebCloudFileSync } from '../lib/db'
import {
  getSyncStatus,
  type SyncStatus,
  CloudAuthError,
  isCloudAuthFailed,
  getCloudBackupMeta,
  restoreFromCloudBackup,
  setSyncTransport,
  configureServerStore,
  isWebFileSyncOn,
} from '../lib/serverStore'
import {
  getSyncMode,
  setSyncMode,
  loadSyncFolderHandle,
  createFileTransport,
  createHttpTransport,
  DEFAULT_CLOUD_KEY,
  CLOUD_FILE_NAME,
  type SyncMode,
} from '../lib/syncTransport'
import { STATUS_META } from '../lib/syncStatusMeta'
import { confirmDialog } from './dialogs'
import { Button } from './Button'

/**
 * 网页体验版工具条（#032 收编）。
 *
 * 仅负责 WEB 平台的云端同步，内含**两条互斥路径**：
 *   ① 服务器模式（http）—— 走我们的 /api/sync，需要专属同步邀请码（YFE-SYNC- 开头）。
 *      码身兼两职：HTTP 鉴权（换服务器槽位）+ AES 加密密钥。
 *   ② 云盘文件模式（file）—— 数据加密后落成用户自选目录里的 .yfe 文件，由网盘客户端搬运。
 *      **无需任何码**：不过我们的服务器，鉴权一环不存在；加密密钥用内置常量，两端一致即可互通。
 *
 * 桌面 / 便携版的「云盘文件同步」已独立为 CloudFileSyncBar（同样无服务器、无同步码）。
 * 三者由 DataDock / Sidebar 统一排版承载，本组件不再画自己的 fixed 浮层。
 */
export default function WebTools() {
  const [syncOpen, setSyncOpen] = useState(false)
  const [busy, setBusy] = useState(false)
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
  // 已开启状态分模式判定：http 看有没有同步码，file 看有没有开启标记 + 目录
  const [hasCode, setHasCode] = useState(() => {
    try {
      return !!localStorage.getItem('yfe-sync-code')
    } catch {
      return false
    }
  })
  const [fileOn, setFileOn] = useState(() => isWebFileSyncOn())
  const synced = mode === 'file' ? fileOn : hasCode

  useEffect(() => {
    if (!WEB) return
    const onStatus = () => setStatus(getSyncStatus())
    const onConflict = () =>
      showToast('检测到云端与本地改过同一处：已保留你的版本，并在本地另存云端副本', 'info', 5000)
    const onAuthFailed = () => {
      setHasCode(false)
      showToast('云端同步邀请码已失效，已切回本地数据（数据仍在本地，不会丢失）', 'error')
    }
    if (isCloudAuthFailed()) {
      setHasCode(false)
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

  /** 切换同步方式：立即装配对应传输层，已开启的一侧回到本模式时自动恢复密钥。 */
  const switchMode = async (m: SyncMode) => {
    setMode(m)
    setSyncMode(m)
    if (m === 'file') {
      const h = await loadSyncFolderHandle().catch(() => null)
      if (h) {
        setSyncTransport(createFileTransport(h, CLOUD_FILE_NAME))
        setFolderName(h.name || null)
        // 已开启过云盘同步 → 立刻接上内置密钥，避免状态栏显示旧模式的残留状态
        if (isWebFileSyncOn()) configureServerStore(DEFAULT_CLOUD_KEY)
      } else {
        setFolderName(null)
      }
    } else {
      setSyncTransport(createHttpTransport())
      const code = (() => {
        try {
          return localStorage.getItem('yfe-sync-code') || ''
        } catch {
          return ''
        }
      })()
      if (code) configureServerStore(code)
    }
  }

  /** 云盘文件模式：选目录即开启（无需同步码）。已开启时再次选择＝更换目录。 */
  const pickFolder = async () => {
    try {
      const picker = (window as any).showDirectoryPicker
      if (typeof picker !== 'function') {
        showToast('当前浏览器不支持选择同步文件夹，请改用 Chrome / Edge，或切换到「服务器」方式', 'error', 6000)
        return
      }
      const h = await picker({ mode: 'readwrite' })
      setBusy(true)
      await enableWebCloudFileSync(h)
      setSyncMode('file')
      setMode('file')
      setFolderName(h.name)
      setFileOn(true)
      showToast(
        `已开启云盘同步：${h.name}\n数据加密存为「${CLOUD_FILE_NAME}」，把它放进网盘同步目录即可跨设备`,
        'success',
        7000,
      )
      setTimeout(() => location.reload(), 800)
    } catch (e: any) {
      if (e && e.name === 'AbortError') return
      showToast('选择文件夹失败：' + (e?.message || e), 'error')
      setBusy(false)
    }
  }

  /** 云盘文件模式：关闭并切回本机浏览器存储。 */
  const closeFileSync = async () => {
    const ok = await confirmDialog({
      title: '关闭云盘文件同步',
      message:
        '关闭后本设备将改用浏览器本地存储（IndexedDB），不再读写网盘里的同步文件。\n' +
        `网盘目录里的「${CLOUD_FILE_NAME}」不会被删除，其它设备仍可继续同步。\n\n确定关闭吗？`,
      confirmText: '关闭同步',
      danger: true,
    })
    if (!ok) return
    disableWebCloudFileSync()
    setFileOn(false)
    setFolderName(null)
    showToast('已关闭云盘文件同步，切回本机浏览器存储', 'success')
    setTimeout(() => location.reload(), 600)
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

  /** 服务器模式：用同步邀请码登录。 */
  const doSync = async (raw: string) => {
    const code = String(raw || '').replace(/\s+/g, '').toUpperCase()
    if (!code) return
    setBusy(true)
    try {
      if (code.startsWith('YFE-D')) {
        showToast('这看起来是进门用的网页邀请码，不是云同步码（云同步码以 YFE-SYNC 开头）', 'error', 5000)
        setBusy(false)
        return
      }
      await enableCloudSync(code)
      setHasCode(true)
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

  // 状态徽标文案：仅在服务器模式下才可能出现「码失效」语义
  const meta =
    status === 'auth-failed'
      ? { ...STATUS_META['auth-failed'], title: '同步邀请码已失效，已切回本地数据' }
      : STATUS_META[status]

  const isFile = mode === 'file'

  const segCls = (m: SyncMode) =>
    'rounded px-2 py-1 text-xs border transition-colors ' +
    (mode === m
      ? 'border-sky-400/60 bg-sky-400/15 text-sky-200'
      : 'border-ink-700 text-ink-400 hover:text-ink-200')

  const rowBtn =
    'flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border px-2 text-[12px] transition-colors disabled:opacity-60 '

  const helpText = isFile
    ? `【云盘文件方式】无需任何同步码，也不需要我们的服务器。
选一个文件夹后，你的创作数据会加密存成「${CLOUD_FILE_NAME}」落在其中；把它放进 OneDrive / WPS 云盘 / 百度网盘 / 坚果云 等同步目录，各设备打开同一个文件即可自动同步。
跨设备条件：所有设备都选择同一个网盘文件夹。

⚠️ 安全边界：此方式不使用同步码，加密密钥是软件内置的统一密钥，强度等同于「混淆」——能防云盘明文扫描和他人误看，但不足以对抗蓄意破解。请勿把同步目录设成公开共享文件夹，涉密稿件请用「导出备份」自行保管。`
    : `【服务器方式】需要专属同步邀请码（YFE-SYNC- 开头，与进门用的网页邀请码不是同一个）。
码同时承担两个作用：①向服务器证明你的身份、换取独立存储空间；②作为加密密钥，数据在上传前就已加密，服务器只存密文。
跨设备条件：各设备填入同一个同步邀请码。

断网或服务不可达时会自动回退本地保存、编辑不丢；恢复后自动重新同步。
云端每日保留一份滚动备份（最新一份、按天滚动）：若当天手滑推了坏数据，可点「从云端备份恢复」回退到当天/昨日的检查点。`

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
        <HelpPopover title="云端同步说明" side="right" width="24rem">
          {helpText}
        </HelpPopover>
      </div>

      {/* 同步方式切换 */}
      <div className="flex items-center gap-1.5 text-[11px] text-ink-400">
        <span className="shrink-0 opacity-70">方式</span>
        <button type="button" className={segCls('http') + ' flex-1'} onClick={() => void switchMode('http')}>
          服务器
        </button>
        <button type="button" className={segCls('file') + ' flex-1'} onClick={() => void switchMode('file')}>
          云盘文件
        </button>
      </div>

      {/* 当前方式的一句话说明：把「要不要码」讲清楚 */}
      <p className="rounded-md bg-ink-850/70 px-2 py-1 text-[11px] leading-relaxed text-ink-400">
        {isFile ? (
          <>
            走你自己的网盘目录，<span className="text-emerald-300">不需要同步码</span>
            {folderName ? ` · 当前：${folderName}` : ' · 尚未选择文件夹'}
          </>
        ) : (
          <>
            走我们的服务器，需要<span className="text-amber">专属同步邀请码</span>（YFE-SYNC- 开头）
          </>
        )}
      </p>

      {isFile ? (
        <>
          {/* 云盘文件模式：选目录即开启，无码 */}
          <Button
            variant="bare"
            onClick={pickFolder}
            disabled={busy}
            title={
              folderName
                ? `更换同步文件夹（当前：${folderName}）`
                : '选择一个文件夹存放加密同步文件，建议放在网盘同步目录内'
            }
            className={rowBtn + 'border-sky-400/40 bg-sky-400/10 text-sky-300 hover:bg-sky-400/20'}
          >
            <FolderOpen size={13} />
            <span className="truncate">{folderName ? '更换：' + folderName : '选择同步文件夹'}</span>
          </Button>

          {fileOn && (
            <Button
              variant="bare"
              onClick={closeFileSync}
              disabled={busy}
              title="关闭云盘文件同步，改回浏览器本地存储（不会删除网盘里的同步文件）"
              className={rowBtn + 'border-ink-600/80 bg-ink-800/60 text-ink-300 hover:border-red-400/50 hover:text-red-300'}
            >
              <CloudOff size={13} />
              关闭云盘同步
            </Button>
          )}
        </>
      ) : (
        <>
          {/* 服务器模式：凭同步邀请码登录 */}
          <Button
            variant="bare"
            onClick={() => setSyncOpen(true)}
            disabled={busy}
            title={synced ? `${meta.title}（点击可重新连接）` : '开启云端同步（需专属同步邀请码）'}
            className={rowBtn + 'border-sky-400/40 bg-sky-400/10 text-sky-300 hover:bg-sky-400/20'}
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
        </>
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
        title="开启云端同步（服务器方式）"
        label="输入你专属的同步邀请码（YFE-SYNC- 开头，与进门用的网页邀请码不是同一个）。开启后项目数据将实时保存并跨设备同步。"
        placeholder="同步邀请码"
        transformUppercase
        confirmText={busy ? '连接中…' : '开启同步'}
        onSubmit={doSync}
        onCancel={() => setSyncOpen(false)}
      />
    </div>
  )
}
