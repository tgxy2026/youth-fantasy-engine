import { useEffect, useState } from 'react'
import { AlertTriangle, FolderOpen, RefreshCw, Unlock } from 'lucide-react'
import { Button } from './Button'
import { confirmDialog } from './dialogs'
import {
  DESKTOP,
  getDesktopState,
  subscribeDesktop,
  unlockDesktopWrite,
  revealDesktopDataFile,
} from '../lib/desktop'
import { Z } from '../lib/zLayer'

/**
 * 「数据文件写盘已锁定」的常驻告警条（只有桌面版会出现）。
 *
 * 【什么时候出现】
 *   应用启动时**读不出**数据文件 —— 被云盘客户端/杀软短暂占用、权限不足、
 *   JSON 被同步过程截断，等等。这时内存里只有一份空库。
 *
 * 【为什么必须锁】
 *   一旦允许落盘，第一次写就会把磁盘上那份真实数据永久覆盖掉（不可逆）。
 *   所以引擎此时拒绝一切写操作 —— 数据这次用不了，但**还在**。
 *
 * 【为什么必须是常驻条而不是弹一次 toast】
 *   锁不解开，作者一个字都存不下来；而 toast 三秒后消失，
 *   作者只会觉得"软件坏了"，甚至反复重启 —— 每次都触发同样的锁定。
 *   所以这里给的是：说清楚 + 三条自救路径。
 */
export function DesktopWriteLockBanner() {
  const [st, setSt] = useState(() => getDesktopState())
  useEffect(() => subscribeDesktop(() => setSt(getDesktopState())), [])

  if (!DESKTOP || !st.writeLocked) return null

  const onUnlock = async () => {
    const ok = await confirmDialog({
      title: '确定要用当前内容继续吗？',
      message:
        '当前内存里是「空库或残缺数据」—— 原文件没能读出来。\n\n' +
        '继续之后，只要有数据变动就会写回数据文件，磁盘上那份原文件会被覆盖，且无法恢复。\n\n' +
        '建议先点「打开数据文件夹」把原文件复制一份备份，再决定是否继续。',
      danger: true,
    })
    if (ok) unlockDesktopWrite()
  }

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 flex items-start gap-3 border-b-2 border-red-400/70 bg-red-700/97 px-4 py-2.5 text-white shadow-lg backdrop-blur-sm"
      style={{ zIndex: Z.banner }}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 text-12 leading-snug">
        <div className="font-semibold">
          数据文件读取失败，已暂停保存 —— 你原来的数据文件没有被改动
        </div>
        <div className="mt-0.5 text-white/85">{st.writeLockReason}</div>
        <div className="mt-0.5 text-white/70">
          解除之前，本次所有编辑都不会写回磁盘。请先备份数据文件，再选择下面的操作。
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        <Button variant="secondary" size="xs" onClick={() => void revealDesktopDataFile()}>
          <FolderOpen className="h-3.5 w-3.5" />
          打开数据文件夹
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
