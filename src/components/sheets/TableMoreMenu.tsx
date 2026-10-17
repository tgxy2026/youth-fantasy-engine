/**
 * 表格页头「更多」下拉菜单。
 *
 * 为什么要它（3.1.2 视觉巡检 B 条）：
 *   人物关系 / 历史事件这类表的页头有 9-10 个按钮，一行放不下就折行，
 *   而折下来的第二行只剩「AI 新增 / AI 整理」孤零零靠右，左边空一大片 —— 观感像排版坏了。
 *   把低频的「导入 / 导出 / 清空全部」收进这个菜单 ⇒ 常用按钮能在一行内排完。
 *
 * 顺带修掉一条与上一轮教训冲突的旧账：
 *   「清空全部」原先是**常驻的红色 danger 按钮**，一进页面就有一块红压在页头
 *   （教训：危险色不能常驻，常态应中性、hover 才染色）。收进菜单后常态是中性灰，
 *   只在菜单里 hover 到它时才转红。
 *
 * 🔴 刻意做成**页内绝对定位**（不 Portal）：它挂在页头里，页头是 sticky + z-index
 *    的层叠上下文，内部浮层不会跑去压弹窗；也不用引 dropdownPos 那套坐标计算。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { Z } from '@/lib/app/zLayer'

export interface MoreMenuItem {
  key: string
  label: string
  icon?: ReactNode
  onClick: () => void
  /** 危险项：常态中性，hover 才转红（见文件头说明） */
  danger?: boolean
  title?: string
}

interface Props {
  items: MoreMenuItem[]
  /** 无可用项时整个菜单不渲染（母表等场景不该留一个点开是空的「更多」） */
  label?: string
}

export default function TableMoreMenu({ items, label = '更多' }: Props) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  // 点外面 / 按 Esc 收起；监听只在展开期间挂上，收起即摘（不留悬挂监听）
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (items.length === 0) return null

  return (
    <div ref={boxRef} className="relative shrink-0">
      <Button variant="secondary"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-1.5 transition-colors"
        title="更多操作：批量导入 / 导出 CSV / 清空全部">
        <MoreHorizontal size={14} /> {label}
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 w-44 rounded-lg border border-ink-700 bg-ink-850 shadow-xl overflow-hidden"
          style={{ zIndex: Z.dropdown }}
        >
          {items.map(it => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              title={it.title}
              onClick={() => { setOpen(false); it.onClick() }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-12 text-left transition-colors
                ${it.danger
                  ? 'text-ink-400 hover:text-danger hover:bg-danger/10'
                  : 'text-ink-300 hover:text-ink-50 hover:bg-ink-800'}`}
            >
              {it.icon}
              <span className="truncate">{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
