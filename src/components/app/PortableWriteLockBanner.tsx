import { useEffect, useState } from 'react'
import { FolderOpen, HardDriveDownload } from 'lucide-react'
import { copyText, showToast } from '@/components/dialogs/dialogs'
import {
  PORTABLE,
  getPortableState,
  subscribePortable,
  unlockPortableWrite,
  portableDataPath,
  exportPortableData,
} from '@/lib/storage/fileBackend'
import { WriteLockBanner } from '@/components/app/WriteLockBanner'
import { WEB } from '@/lib/app/platform'

/**
 * 便携版：「数据文件写盘已锁定」的常驻告警条。
 *
 * 骨架见 `WriteLockBanner`。本文件只负责**便携版特有的两件事**：
 *   · 订阅 `fileBackend`（便携存储）的状态源；
 *   · 第一条路径＝**复制数据文件路径**（跑在普通浏览器里，打不开资源管理器）。
 *
 * 🔴 桌面版（DESKTOP）与便携版（PORTABLE）互斥 ⇒ 这个条只在便携模式出现，不会双条叠着。
 */
export function PortableWriteLockBanner() {
  const [st, setSt] = useState(() => getPortableState())
  useEffect(() => subscribePortable(() => setSt(getPortableState())), [])

  if (!PORTABLE || !st.writeLocked) return null

  const onCopyPath = async () => {
    const p = portableDataPath()
    if (!p) { showToast('暂时拿不到数据文件路径', 'error'); return }
    // 用全局 copyText（自带 execCommand 兜底 + 失败提示），别再手写一份剪贴板逻辑
    await copyText(
      p,
      '已复制数据文件路径：\n' + p + '\n\n在文件资源管理器地址栏粘贴即可打开所在文件夹，先把原文件复制一份备份。',
    )
  }

  // 网页版没有「本地数据文件路径」可复制 ⇒ 主操作换成「导出全部数据」，
  // 文案也全部换成云端口径。桌面版 / 便携版走原分支，逐字不变。
  const webMode = WEB
  const subject = webMode ? '云端数据' : '便携数据文件'
  const writeBackTo = webMode ? '云端' : '数据文件'

  const doExport = async () => {
    const r = await exportPortableData()
    if (r.ok) showToast(`已导出全部数据（浏览器下载）：${r.fileName ?? ''}`)
    else showToast(r.error || '导出失败', 'error')
  }

  return (
    <WriteLockBanner
      subject={subject}
      reason={st.writeLockReason}
      writeBackTo={writeBackTo}
      primary={webMode
        ? {
            label: '导出全部数据',
            icon: <HardDriveDownload className="h-3.5 w-3.5" />,
            onClick: () => void doExport(),
          }
        : {
            label: '复制数据文件路径',
            icon: <FolderOpen className="h-3.5 w-3.5" />,
            onClick: () => void onCopyPath(),
          }}
      backupHint={webMode
        ? '建议先导出一份 JSON 备份（可导入桌面版），再决定是否继续。'
        : '建议先把数据文件复制一份备份（可点「复制数据文件路径」定位），再决定是否继续。'}
      onUnlock={() => unlockPortableWrite()}
    />
  )
}
