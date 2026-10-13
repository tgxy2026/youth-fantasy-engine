import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import {
  DESKTOP,
  getDesktopState,
  subscribeDesktop,
  unlockDesktopWrite,
  revealDesktopDataFile,
} from '@/lib/app/desktop'
import { WriteLockBanner } from '@/components/app/WriteLockBanner'

/**
 * 桌面版：「数据文件写盘已锁定」的常驻告警条。
 *
 * 骨架、三条自救路径与解锁确认文案见 `WriteLockBanner`（2026-10-13 六维审计把两端的
 * 22 行逐字相同的 JSX 收成一处）。本文件只负责**桌面版特有的两件事**：
 *   · 订阅 `desktop` 的状态源；
 *   · 第一条路径＝**直接打开资源管理器**定位数据文件（有主进程才做得到）。
 */
export function DesktopWriteLockBanner() {
  const [st, setSt] = useState(() => getDesktopState())
  useEffect(() => subscribeDesktop(() => setSt(getDesktopState())), [])

  if (!DESKTOP || !st.writeLocked) return null

  return (
    <WriteLockBanner
      subject="数据文件"
      reason={st.writeLockReason}
      writeBackTo="磁盘"
      primary={{
        label: '打开数据文件夹',
        icon: <FolderOpen className="h-3.5 w-3.5" />,
        onClick: () => void revealDesktopDataFile(),
      }}
      backupHint="建议先点「打开数据文件夹」把原文件复制一份备份，再决定是否继续。"
      onUnlock={() => unlockDesktopWrite()}
    />
  )
}
