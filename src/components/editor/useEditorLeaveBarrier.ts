/**
 * 编辑器的**离页屏障登记**（3.3.0 · UX06）。
 *
 * 【为什么单独一层】
 *   `useNovelEditorModel.ts` 已经贴着 1200 行硬上限（结构闸 ①），而这段逻辑只做一件事：
 *   把「脏了没」「冲干净没」翻译成 `App` 能问的一对函数（见 `lib/editor/leaveBarrier.ts`）。
 *   抽出来既让主链路文件留在上限内，也让这块判断可以被人一眼读完。
 *
 * 【只传 ref，不传 state】
 *   屏障是**在 React 渲染之外**被调用的（`App` 的点击回调里），必须读到当刻最新值，
 *   所以这里一律用 ref：`isDirty` 同步读、`flush` 异步等，不需要触发重渲染。
 *
 * 【失败口径】
 *   · 写失败 ⇒ 返回 `{ ok: false, scope }`，`App` **不跳转**，原 DOM / 原草稿留在原地；
 *   · 失败后**恢复 2 秒防抖**（`retry` 回调），作者继续打字时仍有一次自动重试；
 *   · 绝不调用 `flushEditorDraftNow()` —— 那个是关窗兜底，故意吞失败，拿来当离页判据就是静默丢稿。
 */
import { useEffect, type MutableRefObject } from 'react'
import { registerLeaveGuard, type LeaveFlushResult } from '@/lib/editor/leaveBarrier'
import type { Chapter } from '@/lib/types'

export type CommitResult = { ok: boolean; error?: unknown }
export type MetaFlushResult = { ok: boolean; errors: unknown[] }

export interface EditorLeaveBarrierArgs {
  /** 当前章（最新值） */
  activeRef: MutableRefObject<Chapter | null>
  /** 未落库的正文草稿 */
  draftRef: MutableRefObject<string>
  /** 当前章的正文保存（带成败） */
  commitContentRef: MutableRefObject<(content?: string) => Promise<CommitResult>>
  /** 按章节 id 记账的标题/摘要待冲刷任务 */
  metaPending: MutableRefObject<Map<string, () => Promise<void>>>
  /** 一起冲刷标题/摘要（带成败） */
  metaFlush: MutableRefObject<() => Promise<MetaFlushResult>>
  /** 2 秒自动保存定时器（失败后要在原定时器上恢复重试） */
  autosaveTimer: MutableRefObject<ReturnType<typeof setTimeout> | undefined>
}

export function useEditorLeaveBarrier({
  activeRef,
  draftRef,
  commitContentRef,
  metaPending,
  metaFlush,
  autosaveTimer,
}: EditorLeaveBarrierArgs): void {
  useEffect(() => {
    const contentDirty = () => {
      const cur = activeRef.current
      return !!cur && draftRef.current !== cur.content
    }
    registerLeaveGuard({
      isDirty() {
        // 同步且便宜：App 每次导航都会问一次，干净时不加任何等待
        return contentDirty() || metaPending.current.size > 0
      },
      async flush(): Promise<LeaveFlushResult> {
        if (contentDirty()) {
          // 先停掉 2 秒防抖，免得它在我们等写盘时又发一笔同内容的保存
          clearTimeout(autosaveTimer.current)
          const r = await commitContentRef.current(draftRef.current)
          if (!r.ok) {
            // 失败：恢复防抖，作者继续打字时仍有一次自动重试（不是「失败一次就再也不管」）
            autosaveTimer.current = setTimeout(() => { void commitContentRef.current(draftRef.current) }, 2000)
            return { ok: false, scope: 'content', error: r.error }
          }
        }
        const m = await metaFlush.current()
        if (!m.ok) return { ok: false, scope: 'meta', error: m.errors[0] }
        return { ok: true }
      },
    })
    return () => registerLeaveGuard(null)
  }, [activeRef, draftRef, commitContentRef, metaPending, metaFlush, autosaveTimer])
}
