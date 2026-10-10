import { useEffect, useState } from 'react'
import { AlertTriangle, FolderOpen, RefreshCw, Unlock } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { confirmDialog, copyText, showToast } from '@/components/dialogs/dialogs'
import {
  PORTABLE,
  getPortableState,
  subscribePortable,
  unlockPortableWrite,
  portableDataPath,
} from '@/lib/storage/fileBackend'
import { Z } from '@/lib/app/zLayer'

/**
 * 「便携版数据文件写盘已锁定」的常驻告警条。
 *
 * 【与桌面版 `DesktopWriteLockBanner` 是同一件事的两副面孔】
 *   触发条件、锁的语义、三条自救路径都一致（见那边的长注释）。差别只在**能做什么**：
 *   · 桌面版有主进程 ⇒ 按钮能**直接打开资源管理器**定位到数据文件；
 *   · 便携版是普通浏览器 ⇒ 打不开文件夹，改为「复制数据文件路径」+ 打开浏览器下载目录的提示。
 *
 * 【为什么单独一个组件而不是给桌面版加 PORTABLE 分支】
 *   两端的动作集不同（`revealDesktopDataFile` 在浏览器里不存在），硬塞进一个组件会塞满
 *   条件分支；拆开后各自读各自的状态源，界线清楚。
 */
export function PortableWriteLockBanner() {
  const [st, setSt] = useState(() => getPortableState())
  useEffect(() => subscribePortable(() => setSt(getPortableState())), [])

  // 🔴 桌面版（DESKTOP）与便携版（PORTABLE）互斥 ⇒ 这个条只在便携模式出现，不会双条叠着。
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

  const onUnlock = async () => {
    const ok = await confirmDialog({
      title: '确定要用当前内容继续吗？',
      message:
        '当前内存里是「空库或残缺数据」—— 原文件没能读出来。\n\n' +
        '继续之后，只要有数据变动就会写回数据文件，磁盘上那份原文件会被覆盖，且无法恢复。\n\n' +
        '建议先把数据文件复制一份备份（可点「复制数据文件路径」定位），再决定是否继续。',
      danger: true,
    })
    if (ok) unlockPortableWrite()
  }

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 flex items-start gap-3 border-b-2 border-danger/70 bg-red-700/97 px-4 py-2.5 text-white shadow-lg backdrop-blur-xs"
      style={{ zIndex: Z.banner }}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 text-12 leading-snug">
        <div className="font-semibold">
          便携数据文件读取失败，已暂停保存 —— 你原来的数据文件没有被改动
        </div>
        <div className="mt-0.5 text-white/85">{st.writeLockReason}</div>
        <div className="mt-0.5 text-white/70">
          解除之前，本次所有编辑都不会写回数据文件。请先备份数据文件，再选择下面的操作。
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        <Button variant="secondary" size="xs" onClick={() => void onCopyPath()}>
          <FolderOpen className="h-3.5 w-3.5" />
          复制数据文件路径
        </Button>
        <Button variant="secondary" size="xs" onClick={() => location.reload()}>
          <RefreshCw className="h-3.5 w-3.5" />
          重试读取
        </Button>
        <Button variant="danger" size="xs" onClick={() => void onUnlock()}>
          <Unlock className="h-3.5 w-3.5" />
          仍用当前内容继续
        </Button>
      </div>
    </div>
  )
}
