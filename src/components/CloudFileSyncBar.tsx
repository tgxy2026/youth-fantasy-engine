import { useEffect, useRef, useState } from 'react'
import { Cloud, FolderOpen, LogOut, History } from 'lucide-react'
import HelpPopover from './HelpPopover'
import { showToast, confirmDialog } from './dialogs'
import { Button } from './Button'
import { enableDesktopCloudSync, disableDesktopCloudSync } from '../lib/db'
import { STATUS_META } from '../lib/syncStatusMeta'
import {
  chooseDesktopCloudDir,
  getDesktopCloudStatus,
  getDesktopCloudBackupMeta,
  restoreDesktopFromCloudBackup,
  isDesktopCloudEnabled,
  getDesktopCloudDirName,
  type SyncStatus,
} from '../lib/desktopCloudSync'

/**
 * 「云盘文件同步」操作条（#032：去掉同步码）。
 *
 * 这是本项目**唯一形态**的跨设备同步（网页版服务器同步已于 2026-09-15 下线），
 * 全程**不依赖任何服务器**：数据以加密文件落在用户自选的云盘目录，
 * 由 OneDrive / WPS 云盘 / 坚果云 等客户端负责搬运。
 * 开启流程就一步：选目录（内置默认密钥保证多设备互通，无需任何码）。
 *
 * 两种形态：
 * - variant='panel'：用于左下角「数据坞」DataDock 内，等宽铺满、行距宽松。
 * - variant='sidebar'：用于侧栏底部内嵌，紧凑排版、不铺满宽度（避免撑破侧栏）。
 */
export default function CloudFileSyncBar({ variant = 'panel' }: { variant?: 'panel' | 'sidebar' }) {
  const [busy, setBusy] = useState(false)
  const [connected, setConnected] = useState(() => isDesktopCloudEnabled())
  const [status, setStatus] = useState<SyncStatus>(getDesktopCloudStatus())
  const [dirName, setDirName] = useState<string | null>(null)
  const [backupDay, setBackupDay] = useState<string | null>(null)
  const handleRef = useRef<any>(null)
  const inSidebar = variant === 'sidebar'

  useEffect(() => {
    const onStatus = () => setStatus(getDesktopCloudStatus())
    window.addEventListener('yfe:sync-status', onStatus)
    getDesktopCloudDirName()
      .then((n) => n && setDirName(n))
      .catch(() => {})
    const tick = () => setBackupDay(getDesktopCloudBackupMeta()?.day ?? null)
    tick()
    const id = setInterval(tick, 3000)
    return () => {
      window.removeEventListener('yfe:sync-status', onStatus)
      clearInterval(id)
    }
  }, [])

  const meta = STATUS_META[status]

  /** 选择目录并直接开启（无需同步码）。 */
  const pickDir = async () => {
    if (busy) return
    try {
      const res = await chooseDesktopCloudDir()
      if (!res) return // 用户取消
      handleRef.current = res.handle
      setDirName(res.name)
      setBusy(true)
      await enableDesktopCloudSync(res.handle)
      setConnected(true)
      showToast(
        '云盘文件同步已开启：' + res.name + '\n此后数据会自动保存到该目录，把目录放进网盘同步即可跨设备继续。',
        'success',
        6000,
      )
      setTimeout(() => location.reload(), 800)
    } catch (e: any) {
      if (e && e.name === 'AbortError') return
      showToast('开启失败：' + (e?.message || e), 'error')
      setBusy(false)
    }
  }

  const onDisable = async () => {
    const ok = await confirmDialog({
      title: '关闭云盘文件同步',
      message: '将停止跨设备同步并切回本机存储。\n同步目录里的数据文件会保留，重新开启可继续使用。确定吗？',
      confirmText: '关闭',
      danger: true,
    })
    if (!ok) return
    disableDesktopCloudSync()
    showToast('已关闭云盘文件同步，切回本机存储', 'success')
    setTimeout(() => location.reload(), 400)
  }

  const onRestore = async () => {
    const ok = await confirmDialog({
      title: '从同步备份恢复',
      message: `将把当前数据回滚到每日备份（${backupDay || '未知日期'}）并重新同步。\n此操作会丢弃该备份时间点之后的本机改动，确定继续吗？`,
      confirmText: '恢复',
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      const done = await restoreDesktopFromCloudBackup()
      if (done) {
        showToast('已从备份恢复，正在重新同步…', 'success')
        setTimeout(() => location.reload(), 600)
      } else {
        showToast('暂无可用的同步备份', 'error')
        setBusy(false)
      }
    } catch {
      showToast('恢复失败，请稍后重试', 'error')
      setBusy(false)
    }
  }

  // —— 形态相关的样式 ——
  const headCls = inSidebar
    ? 'flex items-center gap-1.5 pt-1 text-[12px] text-ink-300'
    : 'flex items-center gap-1.5 text-xs text-ink-300'
  const rowBtn =
    'flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 text-[12px] transition-colors disabled:opacity-60 '

  return (
    <div className={inSidebar ? 'flex flex-col gap-1.5' : 'flex flex-col gap-1.5'}>
      {/* 标题行 */}
      <div className={headCls}>
        <Cloud size={13} className="text-sky-300/90" />
        <span className="font-medium">云盘文件同步</span>
        {connected && (
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-ink-300">
            <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
            {meta.text || '待命'}
          </span>
        )}
        <HelpPopover title="云盘文件同步说明" side="right" width="22rem">
          {`云盘文件同步把项目数据实时保存为加密文件（${'青春幻想引擎-同步数据.yfe'}）落到你选定的同步文件夹，
由 OneDrive / WPS 云盘 / 百度网盘 / 坚果云 等客户端负责跨设备搬运——无需我们的服务器，也没有账号和同步码。

怎么用：在两台设备上都选「同一个网盘目录」即可自动同步，不需要任何密码或邀请码。
断网或网盘未同步时自动回退本机存储、编辑不丢；网盘目录更新后会自动拉取合并。
每日保留一份滚动备份，可点「从同步备份恢复」回退到当天/昨日的检查点。

安全提示：文件使用内置密钥加密，可防止被明文浏览或误看，但密钥是公开的（源码常量），
不足以对抗蓄意破解。请勿把同步目录设为公开共享文件夹；涉密稿件请改用导出备份自行保管。`}
        </HelpPopover>
      </div>

      {!connected ? (
        /* —— 未开启：一个按钮搞定（选目录即开启） —— */
        <>
          <Button
            variant="bare"
            onClick={pickDir}
            disabled={busy}
            title="选择一个网盘同步目录来开启跨设备同步（如 OneDrive / WPS 云盘 / 坚果云的文件夹）"
            className={
              rowBtn +
              'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-60'
            }
          >
            <FolderOpen size={14} />
            {busy ? '开启中…' : '选择同步目录'}
          </Button>
          <p className="text-[11px] leading-snug text-ink-500">
            选一个网盘文件夹即可开启，无需账号或同步码
          </p>
        </>
      ) : (
        /* —— 已开启：状态 + 目录名 + 操作 —— */
        <>
          <div
            className="flex items-center gap-1.5 text-[11px] text-ink-400"
            title={dirName ? '当前同步目录' : undefined}
          >
            <FolderOpen size={12} className="shrink-0 text-ink-500" />
            <span className="truncate">{dirName || '未选择目录'}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="bare"
              onClick={pickDir}
              disabled={busy}
              title="更换同步目录"
              className={rowBtn + 'border-ink-600/80 bg-ink-800/60 text-ink-300 hover:border-amber/50 hover:text-ink-100'}
            >
              <FolderOpen size={13} />
              更换
            </Button>
            <Button
              variant="bare"
              onClick={onDisable}
              disabled={busy}
              title="关闭云盘文件同步并切回本机存储"
              className={rowBtn + 'border-ink-600/80 bg-ink-800/60 text-ink-300 hover:border-rose-400/60 hover:text-rose-300'}
            >
              <LogOut size={13} />
              关闭
            </Button>
          </div>
          {backupDay && (
            <Button
              variant="bare"
              onClick={onRestore}
              disabled={busy}
              title={`每日备份（${backupDay}）· 点击回滚到该检查点`}
              className={rowBtn + 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'}
            >
              <History size={13} />
              从备份恢复（{backupDay}）
            </Button>
          )}
        </>
      )}
    </div>
  )
}
