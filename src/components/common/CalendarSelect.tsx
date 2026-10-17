import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CalendarDef } from '@/lib/types'
import { Check, ChevronDown } from 'lucide-react'
import { Z } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import { EmptyState } from '@/components/common/EmptyState'
import { computeDropdownPos } from '@/lib/app/dropdownPos'

interface Props {
  /** 当前选中的历法名称 */
  value: string
  onChange: (name: string) => void
  /** 项目级历法配置列表 */
  calendars: CalendarDef[]
}

/**
 * 历法下拉：**只选不建**（2.7.2 起）。
 *
 * 🔴 历法的「新增 / 改名 / 删除 / 改数值」全部收进页头「历法规则」弹窗
 *    （`CalendarRuleModal`）—— 这里只负责从已有历法里挑一个写进单元格。
 *
 * 为什么砍掉就地编辑：原先单元格下拉能直接新增/改名/删除，导致同一个历法有两处入口，
 * 且**在单元格里改名**时别处引用同一历法的行不会跟着变（下拉里出现孤儿值）。
 * 收成一处后，改名才能在 `CalendarRuleModal` 保存时连带更新已引用的行。
 */
export default function CalendarSelect({ value, onChange, calendars }: Props) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; minWidth: number; flip: boolean } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)

  const updatePos = () => {
    const btn = btnRef.current
    if (!btn) return
    // 本组件的浮层靠自身 max-h-72 限高，故 estH 传 null（不产出 maxHeight）
    setPos(computeDropdownPos(btn.getBoundingClientRect(), { estH: null, flipBelow: 240, clampRight: 220 }))
  }

  useEffect(() => {
    if (!open) { setPos(null); return }
    updatePos()
    const onMove = () => updatePos()
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (wrapRef.current?.contains(t) || dropRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const choose = (name: string) => { onChange(name); setOpen(false) }

  return (
    <div ref={wrapRef} className="relative inline-block w-full min-w-[90px]">
      <Button variant="bare"
        ref={btnRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full !py-1 text-12 min-w-[90px] bg-transparent text-left flex items-center !justify-between gap-1 border-b border-transparent hover:border-ink-700 px-1.5 rounded"
      >
        <span className={value ? 'text-ink-100' : 'text-ink-500'}>{value || '—'}</span>
        <ChevronDown size={11} className="text-ink-500 shrink-0" />
      </Button>
      {open && pos && createPortal(
        <div
          ref={dropRef}
          style={{ zIndex: Z.dropdownNested, left: pos.left, top: pos.top, minWidth: pos.minWidth, transform: pos.flip ? 'translateY(-100%)' : undefined }}
          className="fixed overflow-y-auto rounded-md bg-ink-800 border border-ink-600 shadow-xl py-1 max-h-72"
        >
          {calendars.length === 0 && (
            <EmptyState text="暂无历法，请到页头「历法规则」里添加" />
          )}
          {calendars.map(cal => {
            const selected = value === cal.name
            return (
              <Button
                key={cal.name}
                variant="bare"
                type="button"
                onClick={() => choose(cal.name)}
                className={`w-full text-left !justify-start px-2.5 py-1 text-12 flex items-center gap-1.5 min-w-0 hover:bg-ink-700 ${selected ? 'text-amber' : 'text-ink-200'}`}
              >
                {selected ? <Check size={10} className="shrink-0" /> : <span className="w-10px shrink-0" />}
                <span className="truncate flex-1">{cal.name}</span>
                <span className="text-10 text-ink-500 shrink-0">({cal.value})</span>
              </Button>
            )
          })}
          <div className="mt-1 px-2.5 pt-1.5 pb-0.5 text-10 text-ink-500 border-t border-ink-700 leading-relaxed">
            新增 / 改名 / 删除历法 → 页头「历法规则」
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
