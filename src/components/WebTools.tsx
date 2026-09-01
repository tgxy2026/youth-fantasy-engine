import { useEffect, useRef, useState } from 'react'
import { Cloud, LogOut, FolderOpen } from 'lucide-react'
import PromptModal from './PromptModal'
import HelpPopover from './HelpPopover'
import { showToast, confirmDialog } from './dialogs'
import { WEB } from '../lib/env'
import { enableCloudSync, enableDesktopCloudSync, disableDesktopCloudSync } from '../lib/db'
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
import {
  CLOUD_FILE_SYNC,
  chooseDesktopCloudDir,
  getDesktopCloudStatus,
  getDesktopCloudBackupMeta,
  restoreDesktopFromCloudBackup,
  isDesktopCloudEnabled,
  getDesktopCloudDirName,
} from '../lib/desktopCloudSync'
import { Button } from './Button'

// 同步状态徽标（#008）：推送失败必须可见，不能让用户零感知地"写了一整晚白工"
const STATUS_META: Record<SyncStatus, { dot: string; text: string; title: string }> = {
  idle: { dot: 'bg-ink-500', text: '', title: '云端同步待命' },
  syncing: { dot: 'bg-amber animate-pulse', text: '同步中', title: '正在上传到云端…' },
  ok: { dot: 'bg-emerald-400', text: '已同步', title: '数据已保存到云端' },
  error: { dot: 'bg-rose-400', text: '同步失败', title: '上传失败，编辑已保留在本地，稍后自动重试' },
  'auth-failed': { dot: 'bg-rose-500', text: '码已失效', title: '同步邀请码已失效，已切回本地数据' },
  'rate-limited': { dot: 'bg-orange-400', text: '已限流', title: '操作过于频繁，已暂时暂停同步，稍后自动恢复' },
  // #025：推送体积超限（413）——必须让用户知道是"数据太大"而非网络/鉴权问题
  'too-large': { dot: 'bg-rose-500', text: '数据过大', title: '云端同步数据体积过大，已暂停上传；请精简项目内容或联系作者扩容后重试' },
  // #011：断网/服务不可达 —— 关键是让用户知道编辑留在本地、没丢，恢复后会自动接管
  offline: { dot: 'bg-ink-400', text: '离线', title: '网络不可用，已切回本地保存（编辑不会丢）；网络恢复后自动重新同步' },
}

// 网页体验版 / 桌面·便携版 共用工具条（项目管理主页左下角常驻，由 App 统一包容器定位）。
// 两块 UI 按平台门控互斥显示：
//   · WEB → 网页版云端同步（服务器 / 云盘文件中转二选一，含进门邀请码与「退出网页体验」）
//   · CLOUD_FILE_SYNC（桌面/便携）→ 独立的「云盘文件同步」（不走服务器，不进门）
export default function WebTools() {
  // ============ 网页版状态 ============
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
    if (!WEB) return // 桌面/便携版不挂载网页版同步事件，避免与桌面云同步事件冲突
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

  // ============ 桌面/便携版状态（CLOUD_FILE_SYNC）============
  const [desktopSyncOpen, setDesktopSyncOpen] = useState(false)
  const [desktopBusy, setDesktopBusy] = useState(false)
  const [desktopConnected, setDesktopConnected] = useState(() => isDesktopCloudEnabled())
  const [desktopStatus, setDesktopStatus] = useState<SyncStatus>(getDesktopCloudStatus())
  const [desktopDirName, setDesktopDirName] = useState<string | null>(null)
  const [desktopBackupDay, setDesktopBackupDay] = useState<string | null>(null)
  const desktopHandleRef = useRef<any>(null)

  useEffect(() => {
    if (!CLOUD_FILE_SYNC) return
    const onStatus = () => setDesktopStatus(getDesktopCloudStatus())
    window.addEventListener('yfe:sync-status', onStatus)
    getDesktopCloudDirName()
      .then((n) => n && setDesktopDirName(n))
      .catch(() => {})
    const tick = () => setDesktopBackupDay(getDesktopCloudBackupMeta()?.day ?? null)
    tick()
    const id = setInterval(tick, 3000)
    return () => {
      window.removeEventListener('yfe:sync-status', onStatus)
      clearInterval(id)
    }
  }, [])

  const pickDesktopDir = async () => {
    try {
      const res = await chooseDesktopCloudDir()
      if (!res) return
      desktopHandleRef.current = res.handle
      setDesktopDirName(res.name)
      showToast('已选定同步文件夹：' + res.name + '（建议放进 OneDrive / WPS 云盘 等同步目录，即可跨设备同步）', 'success', 7000)
    } catch (e: any) {
      if (e && e.name === 'AbortError') return
      showToast('选择文件夹失败：' + (e?.message || e), 'error')
    }
  }

  const doDesktopSync = async (raw: string) => {
    const code = String(raw || '').replace(/\s+/g, '').toUpperCase()
    if (!desktopHandleRef.current) {
      showToast('请先「选择同步文件夹」', 'error', 5000)
      return
    }
    if (code.startsWith('YFE-D')) {
      showToast('这看起来是进门用的网页邀请码，不是云同步码（云同步码以 YFE-SYNC 开头）', 'error', 5000)
      return
    }
    setDesktopBusy(true)
    try {
      await enableDesktopCloudSync(code, desktopHandleRef.current)
      setDesktopConnected(true)
      showToast('云盘文件同步已开启，正在载入数据…', 'success')
      setTimeout(() => location.reload(), 600)
    } catch {
      showToast('开启失败，请检查同步码后重试', 'error')
      setDesktopBusy(false)
      setDesktopSyncOpen(false)
    }
  }

  const onDesktopRestore = async () => {
    const ok = await confirmDialog({
      title: '从云端备份恢复',
      message: `将把当前数据回滚到云端每日备份（${desktopBackupDay || '未知日期'}）并重新同步。\n此操作会丢弃该备份时间点之后的本地改动，确定继续吗？`,
      confirmText: '恢复',
      danger: true,
    })
    if (!ok) return
    setDesktopBusy(true)
    try {
      const done = await restoreDesktopFromCloudBackup()
      if (done) {
        showToast('已从云端备份恢复，正在重新同步…', 'success')
        setTimeout(() => location.reload(), 600)
      } else {
        showToast('暂无可用的云端备份', 'error')
        setDesktopBusy(false)
      }
    } catch {
      showToast('恢复失败，请稍后重试', 'error')
      setDesktopBusy(false)
    }
  }

  const onDesktopDisable = async () => {
    const ok = await confirmDialog({
      title: '关闭云盘文件同步',
      message: '将停止跨设备同步并切回本机存储，确定吗？',
      confirmText: '关闭',
      danger: true,
    })
    if (!ok) return
    disableDesktopCloudSync()
    setTimeout(() => location.reload(), 300)
  }

  const meta = STATUS_META[status]
  const desktopMeta = STATUS_META[desktopStatus]

  const segCls = (m: SyncMode) =>
    'rounded px-2 py-1 text-xs border transition-colors ' +
    (mode === m
      ? 'border-sky-400/60 bg-sky-400/15 text-sky-200'
      : 'border-ink-700 text-ink-400 hover:text-ink-200')

  return (
    <>
      {/* ===== 网页版云端同步（仅 WEB）===== */}
      {WEB && (
        <div className="flex flex-col items-start gap-2">
          <div className="flex items-center gap-2 text-xs text-ink-300">
            <span className="opacity-70">同步方式</span>
            <button type="button" className={segCls('http')} onClick={() => switchMode('http')}>
              服务器
            </button>
            <button type="button" className={segCls('file')} onClick={() => switchMode('file')}>
              云盘文件
            </button>
          </div>
          {mode === 'file' && (
            <div className="flex items-center gap-2">
              <Button
                variant="bare"
                onClick={pickFolder}
                disabled={busy}
                title="选择用于跨设备同步的本地文件夹（建议放进 OneDrive / WPS 云盘 等同步目录）"
                className="flex items-center gap-2 rounded-full border border-emerald-500/40 bg-ink-900/90 px-3 py-1.5 text-xs text-emerald-300 shadow-lg backdrop-blur hover:bg-ink-800 disabled:opacity-60"
              >
                <FolderOpen size={14} />
                {folderName ? '更换同步文件夹' : '选择同步文件夹'}
              </Button>
              {folderName && <span className="max-w-[14rem] truncate text-xs text-ink-400">{folderName}</span>}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button
              variant="bare"
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
            </Button>
            <HelpPopover title="云端同步说明" side="right" width="22rem">
              {`云端同步把项目数据实时保存到${mode === 'file' ? '你选定的云盘同步文件夹' : '云端服务器'}，可在其它设备登录同一同步邀请码继续创作。
断网或服务不可达时会自动回退本地保存、编辑不丢；恢复后自动重新同步。
云端每日保留一份滚动备份（最新一份、按天滚动）：若当天手滑推了坏数据，可点下方「从云端备份恢复」回退到当天/昨日的检查点。
注意：同步邀请码（YFE-SYNC- 开头）与进门的网页邀请码不是同一个。${
                mode === 'file'
                  ? '\n当前为「云盘文件中转」模式：数据以加密文件落在你选的同步文件夹里，由 OneDrive / WPS 云盘 等客户端负责跨设备同步，无需我们的服务器。'
                  : ''
              }`}
            </HelpPopover>
          </div>
          {synced && backupDay && (
            <Button
              variant="bare"
              onClick={onRestore}
              disabled={busy}
              title={`云端每日备份（${backupDay}）· 点击回滚到该检查点`}
              className="flex items-center gap-2 rounded-full border border-emerald-500/30 bg-ink-900/90 px-3 py-1.5 text-xs text-emerald-300 shadow-lg backdrop-blur hover:bg-ink-800 disabled:opacity-60"
            >
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
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
            className="flex items-center gap-2 rounded-full border border-ink-700 bg-ink-900/90 px-4 py-2 text-sm text-ink-300 shadow-lg backdrop-blur hover:bg-ink-800"
          >
            <LogOut size={16} />
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
      )}

      {/* ===== 桌面/便携版 云盘文件同步（仅 CLOUD_FILE_SYNC，不走服务器）===== */}
      {CLOUD_FILE_SYNC && (
        <div className="flex flex-col items-start gap-2">
          <div className="flex items-center gap-2 text-xs text-ink-300">
            <span className="opacity-70">云盘文件同步</span>
            <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-emerald-300">桌面/便携版 · 无需服务器</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="bare"
              onClick={pickDesktopDir}
              disabled={desktopBusy}
              title="选择用于跨设备同步的本地文件夹（建议放进 OneDrive / WPS 云盘 等同步目录）"
              className="flex items-center gap-2 rounded-full border border-emerald-500/40 bg-ink-900/90 px-3 py-1.5 text-xs text-emerald-300 shadow-lg backdrop-blur hover:bg-ink-800 disabled:opacity-60"
            >
              <FolderOpen size={14} />
              {desktopDirName ? '更换同步文件夹' : '选择同步文件夹'}
            </Button>
            {desktopDirName && <span className="max-w-[14rem] truncate text-xs text-ink-400">{desktopDirName}</span>}
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="bare"
              onClick={() => setDesktopSyncOpen(true)}
              disabled={desktopBusy}
              title={desktopConnected ? `${desktopMeta.title}（点击可重新连接）` : '开启云盘文件同步（需同步码）'}
              className="flex items-center gap-2 rounded-full border border-sky-400/40 bg-ink-900/90 px-4 py-2 text-sm text-sky-300 shadow-lg backdrop-blur hover:bg-ink-800 disabled:opacity-60"
            >
              <Cloud size={16} />
              {desktopConnected ? '云盘同步·已开' : '云盘同步'}
              {desktopConnected && (
                <span className="flex items-center gap-1.5 text-xs text-ink-300">
                  <span className={`h-2 w-2 rounded-full ${desktopMeta.dot}`} />
                  {desktopMeta.text}
                </span>
              )}
            </Button>
            <HelpPopover title="云盘文件同步说明" side="right" width="22rem">
              {`云盘文件同步把项目数据实时保存为加密文件（.yfe）落到你选定的同步文件夹，
由 OneDrive / WPS 云盘 / 百度网盘 / 坚果云 等客户端负责跨设备搬运——无需我们的服务器，数据主权完全在你手里。
同步码（YFE-SYNC- 开头）同时作为加密密钥：两端填同一个码、指向同一个云盘目录即可跨设备同步。
断网或云盘未同步时自动回退本机存储、编辑不丢；云盘目录更新后自动拉取合并。
云端每日保留一份滚动备份，可点下方「从云端备份恢复」回退到当天/昨日检查点。`}
            </HelpPopover>
          </div>
          {desktopConnected && desktopBackupDay && (
            <Button
              variant="bare"
              onClick={onDesktopRestore}
              disabled={desktopBusy}
              title={`云端每日备份（${desktopBackupDay}）· 点击回滚到该检查点`}
              className="flex items-center gap-2 rounded-full border border-emerald-500/30 bg-ink-900/90 px-3 py-1.5 text-xs text-emerald-300 shadow-lg backdrop-blur hover:bg-ink-800 disabled:opacity-60"
            >
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              从云端备份恢复（{desktopBackupDay}）
            </Button>
          )}
          {desktopConnected && (
            <Button
              variant="bare"
              onClick={onDesktopDisable}
              disabled={desktopBusy}
              title="关闭云盘文件同步并切回本机存储"
              className="flex items-center gap-2 rounded-full border border-ink-700 bg-ink-900/90 px-4 py-2 text-sm text-ink-300 shadow-lg backdrop-blur hover:bg-ink-800"
            >
              <LogOut size={16} />
              关闭云盘同步
            </Button>
          )}

          <PromptModal
            open={desktopSyncOpen}
            title="开启云盘文件同步"
            label="输入同步码（YFE-SYNC- 开头）。它同时是加密密钥：其他设备用同一码指向同一云盘目录即可同步。开启后数据实时保存为加密文件到所选同步文件夹。"
            placeholder="同步码"
            transformUppercase
            confirmText={desktopBusy ? '连接中…' : '开启同步'}
            onSubmit={doDesktopSync}
            onCancel={() => setDesktopSyncOpen(false)}
          />
        </div>
      )}
    </>
  )
}
