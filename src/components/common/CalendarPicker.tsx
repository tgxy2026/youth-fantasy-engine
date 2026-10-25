import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { isOverlayObscured, usePopupLayer } from '@/lib/app/overlayScope'
import { Calendar } from 'lucide-react'
import { todayKey } from '@/lib/app/date'
import { Button } from '@/components/common/Button'
import { Z } from '@/lib/app/zLayer'
import { computeDropdownPos, type DropdownPos } from '@/lib/app/dropdownPos'

/** 视图年月 + 日号 → YYYY-MM-DD（统一走 lib/date，与写作统计同口径） */
const dayKey = (y: number, m: number, d: number) => todayKey(new Date(y, m - 1, d))

interface Props {
  value: string
  onChange: (v: string) => void
}

/** 解析 YYYY-MM-DD；非标准格式返回 null（保留原值，由用户重新选择） */
function parseYMD(s: string): { y: number; m: number; d: number } | null {
  const m = (s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  return { y: +m[1], m: +m[2], d: +m[3] }
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

/**
 * 真实日历日期选择器：点击弹出月历，选择后写回 YYYY-MM-DD。
 * 用于写作进度「日期」、设定变更「变更日期」等真实日期列（区别于故事内时间的结构化输入）。
 *
 * 弹层通过 Portal 渲染到 body，层级取自 zLayer 真源（Z.dropdown），避免被表格单元格 / 滚动容器 / 其它浮层遮挡；
 * 空间不足时自动翻转到按钮上方。
 */
export default function CalendarPicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const init = parseYMD(value)
  const today = new Date()
  const [view, setView] = useState({ y: init?.y ?? today.getFullYear(), m: init?.m ?? today.getMonth() + 1 })
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const portalHost = usePopupLayer(open, () => setOpen(false), btnRef)
  const dropRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<DropdownPos | null>(null)

  useEffect(() => {
    if (!open) { setPos(null); return }
    const updatePos = () => {
      const btn = btnRef.current
      if (!btn) return
      setPos(computeDropdownPos(btn.getBoundingClientRect(), { estH: 264, flipBelow: 248, minWidth: 180, minHeight: 208 }))
    }
    updatePos()
    const onScroll = () => updatePos()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (isOverlayObscured(btnRef.current)) return
      const t = e.target as Node
      if (wrapRef.current?.contains(t) || dropRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const firstDay = new Date(view.y, view.m - 1, 1).getDay()
  const days = new Date(view.y, view.m, 0).getDate()
  const cells: (number | null)[] = []
  for (let i = 0; i < firstDay; i++) cells.push(null)
  for (let d = 1; d <= days; d++) cells.push(d)

  const pick = (d: number) => {
    onChange(dayKey(view.y, view.m, d))
    setOpen(false)
  }
  const shiftMonth = (delta: number) => {
    setView(v => {
      const m = v.m + delta
      if (m < 1) return { y: v.y - 1, m: 12 }
      if (m > 12) return { y: v.y + 1, m: 1 }
      return { ...v, m }
    })
  }

  return (
    <div className="relative inline-block w-full" ref={wrapRef}>
      <Button variant="bare"
        ref={btnRef}
        aria-expanded={open}
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 !justify-start w-full text-left px-1.5 py-1 text-12 bg-ink-800/60 border border-ink-700 rounded text-ink-100 hover:border-amber/50 transition-colors"
      >
        <Calendar size={12} className="text-amber/80 shrink-0" />
        <span className={value ? '' : 'text-ink-500'}>{value || '选择日期'}</span>
      </Button>
      {open && pos && createPortal(
        <div
          ref={dropRef}
          style={{
            zIndex: Z.dropdown,
            left: pos.left,
            top: pos.top,
            minWidth: pos.minWidth,
            maxHeight: pos.maxHeight,
            transform: pos.flip ? 'translateY(-100%)' : undefined,
          }}
          className="fixed overflow-y-auto rounded-lg bg-ink-850 border border-ink-700 shadow-xl p-2.5"
        >
          <div className="flex items-center justify-between mb-2">
            <Button variant="bare" type="button" onClick={() => shiftMonth(-1)} className="px-2 py-0.5 text-ink-300 hover:text-amber text-14">‹</Button>
            <span className="text-12 text-ink-100 font-medium">{view.y} 年 {view.m} 月</span>
            <Button variant="bare" type="button" onClick={() => shiftMonth(1)} className="px-2 py-0.5 text-ink-300 hover:text-amber text-14">›</Button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-10 text-ink-500 text-center mb-1">
            {WEEK.map(w => <div key={w}>{w}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((d, i) => d === null ? <div key={i} /> : (
              <Button variant="bare"
                key={i}
                type="button"
                onClick={() => pick(d)}
                className={`py-1 rounded text-11 transition-colors
                  ${value === dayKey(view.y, view.m, d) ? 'bg-amber/20 text-amber' : 'text-ink-200 hover:bg-ink-700'}`}
              >{d}</Button>
            ))}
          </div>
          {/* 🔴 不能用 icon-muted（定宽 w-8）—— 它是图标键，塞「清除日期」文字全靠 w-full
              覆盖宽度才没炸，属于脆弱依赖（2026-10-12 同批收敛）。文字键用 secondary。 */}
          <Button variant="secondary" type="button" onClick={() => { onChange(''); setOpen(false) }} className="mt-2 w-full text-11">清除日期</Button>
        </div>,
        portalHost(),
      )}
    </div>
  )
}
