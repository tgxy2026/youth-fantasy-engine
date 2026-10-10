/**
 * 剧情推演 · **检查点 / 回滚 / 撤销**（从 `TavernPlot.tsx` 拆出来的，2026-09-19 D4-3）。
 *
 * 与「分支」的区别（两者常被混）：
 *   · 检查点 = 在**同一场**里记住此刻进度，之后一键回到这里，且可撤销；
 *   · 分支 = **另开一场**、只保留到某一条，原场原封不动（那个留在主文件，因为它要新建会话）。
 *
 * 🔴 回滚连**本场记忆与记忆水位线**一起还原（`store.rollbackToCheckpoint`）；
 *   回滚前自动留一份 `undoSnapshot`，所以「撤销上次回滚」是可靠的退路。
 */
import { useState } from 'react'
import { showToast, confirmDialog } from '@/components/dialogs/dialogs'
import * as store from '@/lib/tavern/store'
import type { TavernSession } from '@/lib/tavern/types'

type PlotCheckpointsArgs = {
  session: TavernSession | null
  /** 生成中禁止回滚 / 存点：在途结果落库会与回滚打架 */
  streaming: boolean
  /** 消息改动统一入口（落库 + 刷新左栏），由主文件提供 */
  commit: (next: TavernSession) => void | Promise<void>
}

export function usePlotCheckpoints({ session, streaming, commit }: PlotCheckpointsArgs) {
  /** 「存检查点」的命名弹窗（null = 关着） */
  const [cpNaming, setCpNaming] = useState(false)

  const saveCheckpoint = () => {
    if (!session) return
    setCpNaming(true)
  }

  const commitCheckpoint = (label: string) => {
    setCpNaming(false)
    if (!session) return
    void commit(store.addCheckpoint(session, label))
    showToast(`已存检查点（第 ${session.messages.length} 条），之后随时可以回到这里`, 'info')
  }

  const rollbackTo = async (cpId: string) => {
    if (!session || streaming) return
    const cp = (session.checkpoints ?? []).find(c => c.id === cpId)
    if (!cp) return
    const name = cp.label || `第 ${cp.messageCount} 条`
    const okGo = await confirmDialog({
      title: `回到「${name}」？`,
      message: [
        `消息会截回 ${cp.messageCount} 条，本场记忆与记忆水位线也一并还原到那一刻。`,
        '回滚前会自动留一份当前进度 —— 不满意可以点「撤销上次回滚」退回来。',
      ].join('\n'),
      confirmText: '回到这里',
    })
    if (!okGo) return
    const next = store.rollbackToCheckpoint(session, cpId)
    if (!next) return
    void commit(next)
    showToast(`已回到「${name}」（可撤销）`)
  }

  const undoRollback = () => {
    if (!session?.undoSnapshot) return
    void commit(store.undoRollback(session))
    showToast('已撤销这次回滚')
  }

  const dropCp = (cpId: string) => {
    if (!session) return
    void commit(store.dropCheckpoint(session, cpId))
  }

  return { cpNaming, setCpNaming, saveCheckpoint, commitCheckpoint, rollbackTo, undoRollback, dropCp }
}
