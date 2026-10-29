// ============ 使用答疑助手 · 宽屏侧边面板（3.3.1 · P4） ============
//
// 规划 §5.1：宽窗口为侧边面板，小窗口为可滚动对话框或抽屉，复用现有弹层机制。
// 目前三种形态共用同一个 `HelpCenter`：
//   · 使用指南页内区块（常驻）、项目管理页弹窗（无项目）、侧边面板 / 对话框（项目内从精灵打开）。
//
// 🔴 三条纪律：
//   ① **非模态**：不遮罩、不锁焦点、不把背景设成 aria-hidden —— 作者可以一边看面板一边在正文里改字；
//   ② **不卸载正文**：面板是浮层，正文 DOM、草稿、选区、滚动位置都不动（关闭也不重挂编辑器）；
//   ③ **形态在打开时决定**：开了以后再改窗口宽度不换壳，避免把「问了一半的对话」卸载掉
//      （换壳＝换父组件＝问 AI 面板重挂载，历史会没）。
import { useEffect, useRef } from 'react'
import { MessageCircleQuestion, X } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { Z } from '@/lib/app/zLayer'

interface Props {
  onClose: () => void
  children: React.ReactNode
}

/** 侧边面板宽度：跟着界面缩放走（`--ui-zoom` 已经作用在根节点，这里用 CSS 变量换算） */
const DOCK_WIDTH = 'min(430px, 40vw)'

export default function AssistantDock({ onClose, children }: Props) {
  const panelRef = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  // Esc 只在焦点真的落在面板里时才关：它不是模态，不该抢别处的 Esc（例如正在正文里按 Esc 收提示）
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      const panel = panelRef.current
      if (!panel || !panel.contains(document.activeElement)) return
      event.preventDefault()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <aside
      ref={panelRef}
      data-assistant-dock
      aria-label="使用答疑助手"
      className="fixed right-0 top-0 bottom-0 flex flex-col border-l border-ink-700 bg-ink-900 shadow-2xl"
      style={{ width: `calc(${DOCK_WIDTH} / var(--ui-zoom, 1))`, zIndex: Z.pagePanel }}
    >
      <header className="flex items-center gap-2 px-3 h-10 border-b border-ink-700 shrink-0">
        <MessageCircleQuestion size={14} className="text-amber" />
        <span className="text-12 font-semibold text-ink-100 flex-1">使用答疑助手</span>
        <span className="text-10 text-ink-500 hidden sm:inline">查手册不需要模型</span>
        <Button variant="icon-muted" onClick={onClose} className="p-1" aria-label="收起答疑助手" title="收起（Esc）">
          <X size={16} />
        </Button>
      </header>
      {/* 面板内自己滚：正文在左边照旧，互不影响 */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {children}
      </div>
    </aside>
  )
}
