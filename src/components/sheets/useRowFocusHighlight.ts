/**
 * 跨组件跳转聚焦（`focusRowId`）的高亮与滚动。
 *
 * 调用方：`useTableSheetModel`（把状态与 effect 一并放这里，主文件已贴 1200 行硬上限）。
 *
 * 🔴 3.2.3 · P2 行窗口化之后目标行**可能还没挂载**（只挂视口附近的行）：
 *    表格侧会先把容器滚到目标行附近（`useRowWindow.revealId`），这边必须用**有界轮询**接住 ——
 *    原来的写法是「一次找不到 ref 就 return」，虚拟化后会静默丢掉高亮与滚动（看起来像跳转失效）。
 *    上限 20×60ms ≈ 1.2 秒：够一次滚动 + 一帧渲染；超时就如实交差，不无限等。
 */
import { useEffect, useState } from 'react'

export interface RowFocusOptions {
  focusRowId?: string | null
  /** 行元素登记表（`TableSheetRow` 挂进去的那份；调用方用 useRef 持有，这里只读） */
  rowRefs: { current: Record<string, HTMLTableRowElement | null> | null }
  /** 行集合（换行/重排后要重试一次，与原先的依赖口径保持一致） */
  rows: unknown
  onFocusConsumed?: () => void
  /** 高亮保持时长（毫秒） */
  holdMs?: number
}

export function useRowFocusHighlight({ focusRowId, rowRefs, rows, onFocusConsumed, holdMs = 2600 }: RowFocusOptions): string | null {
  const [hlRowId, setHlRowId] = useState<string | null>(null)

  useEffect(() => {
    if (!focusRowId) return
    let cancelled = false
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const attempt = () => {
      if (cancelled) return
      const el = rowRefs.current?.[focusRowId]
      if (!el) {
        if (++tries > 20) { onFocusConsumed?.(); return }
        timer = setTimeout(attempt, 60)
        return
      }
      setHlRowId(focusRowId)
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      timer = setTimeout(() => {
        setHlRowId(null)
        onFocusConsumed?.()
      }, holdMs)
    }
    attempt()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
    // onFocusConsumed 由 App.tsx 用 useCallback 钉住引用（clearFocusRow），不会每次渲染重跑
  }, [focusRowId, rows, onFocusConsumed, rowRefs, holdMs])

  return hlRowId
}
