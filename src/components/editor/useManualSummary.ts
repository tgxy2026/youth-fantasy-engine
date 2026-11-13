/**
 * 手动「AI 生成章节压缩摘要」的执行体（3.5.4 自编辑器模型抽离）。
 *
 * 与批量重算分开：批量仍走原 API 路径；这里只处理作者在本章顶栏点的那一次。
 * ACP 模式下发任务走 `acpReportText`（先确认接收方与资料范围，再发本章正文），
 * 结果只回填**发起时**的项目/章节/草稿；切章、切项目、改正文或取消后的迟到结果一律拒绝。
 */
import { useEffect, useRef, useState } from 'react'
import { aiChapterSummary } from '@/lib/ai/aiTasks'
import { showToast, confirmDialog } from '@/components/dialogs/dialogs'
import { acpReportText } from '@/lib/agentHost/acpReport'
import { captureOwnedOperation } from '@/lib/storage/ownedOperation'

export interface ManualSummaryArgs {
  /** 当前就绪状态（ACP 已连接或 API 模型已配置） */
  ready: boolean
  projectId: string
  chapterId: string | null
  /** 发起时的正文快照 */
  text: string
  /** 当前 ACP 上下文；null = 走 API */
  acp: { generation: string; name: string } | null
  /** 结果回填（写摘要框，沿用既有保存链） */
  apply: (summary: string) => void
  /** 结果落地前读取最新归属（防止闭包里的旧值） */
  live: () => { projectId: string; chapterId: string | null; text: string }
}

export function useManualSummary(args: ManualSummaryArgs) {
  const [summarizing, setSummarizing] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const latest = useRef(args)
  latest.current = args
  useEffect(() => () => abort.current?.abort(), [])

  const genSummary = async () => {
    const a = latest.current
    if (!a.ready || !a.chapterId || summarizing) return
    const owner = captureOwnedOperation(a.projectId)
    const controller = new AbortController()
    abort.current = controller
    setSummarizing(true)
    try {
      const acpText = a.acp
        ? acpReportText({
          task: 'summary', generation: a.acp.generation, agentName: a.acp.name,
          signal: controller.signal, assertCurrent: owner.assertCurrent, ask: confirmDialog,
        })
        : undefined
      const summary = await aiChapterSummary(a.text, { signal: controller.signal, acpText })
      owner.assertCurrent()
      const now = latest.current.live()
      if (now.projectId !== a.projectId || now.chapterId !== a.chapterId || now.text !== a.text) {
        throw new Error('章节或草稿已变化，请在新正文上重新生成摘要。')
      }
      a.apply(summary)
      showToast('已用 AI 生成章节压缩摘要', 'success')
    } catch (error) {
      if (controller.signal.aborted) showToast('摘要生成已中止', 'info')
      else if (error instanceof Error && error.message === '已取消发送。') showToast('已取消发送', 'info')
      else showToast('摘要生成失败：' + (error instanceof Error ? error.message : String(error)), 'error')
    } finally {
      if (abort.current === controller) abort.current = null
      setSummarizing(false)
    }
  }

  /** 中止本次摘要（已生成的结果不写入；原文不动） */
  const stopSummary = () => abort.current?.abort()

  return { summarizing, genSummary, stopSummary }
}