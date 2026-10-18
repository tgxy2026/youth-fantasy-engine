/**
 * 表格页头「导入导出」/「更多」下拉菜单。
 *
 * 🔴 命名规则（2026-10-18 主人反馈：点开才发现是导入导出，名字在骗人）：
 *    菜单里**只有导入/导出**（没有删除类危险项）⇒ 按钮直接叫「导入导出」+ 双向箭头图标；
 *    菜单里**混着危险项**（如「清空全部」）⇒ 仍叫「更多」+ 三点图标
 *    —— 那种情况叫「导入导出」会更误导（点开里面躺着一颗红色炸弹）。
 *    判定放在组件内部按 `items` 自动做，调用方不用各写一遍（八张表各写一遍必然漏）。
 *
 * 📌 现状（2026-10-18）：所有表的「清空全部」都已挪到菜单外（独立的 icon-danger 图标键），
 *    所以全应用都显示「导入导出」。这条 danger 分支留着是给**将来**再加危险菜单项时兜底 ——
 *    别因为现在没人用就删掉它，否则下次谁往菜单里塞删除项，按钮名会立刻开始骗人。
 *
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
import { ArrowDownUp, MoreHorizontal } from 'lucide-react'
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
  /** 悬浮提示；不给则按当前命名自动生成（改写「批量导入 / 导出 CSV / 清空全部」那套旧文案会漏） */
  title?: string
}

export default function TableMoreMenu({ items, label, title }: Props) {
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

  /**
   * 无危险项 ⇒ 里面只有导入/导出，按钮就叫「导入导出」。
   * 有危险项（清空全部）⇒ 叫「更多」，否则等于承诺「这里只有导入导出」，点开却是删除入口。
   */
  const hasDanger = items.some(it => it.danger)
  const text = label ?? (hasDanger ? '更多' : '导入导出')
  const hint = title ?? (hasDanger
    ? '更多操作：批量导入 / 导出 CSV / 清空全部'
    : '导入导出：粘贴或上传表格批量导入，也可以把当前表导出成 CSV（Excel 可直接打开）')

  return (
    <div ref={boxRef} className="relative shrink-0">
      <Button variant="secondary"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-1.5 transition-colors"
        title={hint}>
        {hasDanger ? <MoreHorizontal size={14} /> : <ArrowDownUp size={14} />} {text}
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
