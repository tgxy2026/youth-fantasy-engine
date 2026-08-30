import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CalendarDef } from '../lib/types'
import { Plus, Check, ChevronDown, Pencil, Trash2 } from 'lucide-react'
import { confirmDialog } from './dialogs'
import { Modal } from './Modal'
import { Button } from './Button'

interface Props {
  /** 当前选中的历法名称 */
  value: string
  onChange: (name: string) => void
  /** 项目级历法配置列表 */
  calendars: CalendarDef[]
  /** 历法配置变更（新增/改名/改数值/删除）时回调，由上层持久化 */
  onCalendarsChange: (next: CalendarDef[]) => void
}

/**
 * 历法下拉：选项来自项目级历法配置（多历法数值体系）。
 * - 选择：写入选中历法名称到单元格
 * - 新增 / 编辑：弹窗输入名称 + 数值（默认 0；数值越小越早，如 上古历=-1 早于 灵历=0）
 * - 删除：从配置移除（已选用该历法的单元格保留名称文本，但下拉不再出现）
 */
export default function CalendarSelect({ value, onChange, calendars, onCalendarsChange }: Props) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; minWidth: number; flip: boolean } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  // 新增/编辑弹窗：null=关闭；editing.name 为空表示「新增」
  const [editing, setEditing] = useState<CalendarDef | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftValue, setDraftValue] = useState(0)

  const updatePos = () => {
    const btn = btnRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom
    const spaceAbove = r.top
    const flip = spaceBelow < 240 && spaceAbove > spaceBelow
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - 220)),
      top: flip ? r.top - 4 : r.bottom + 4,
      minWidth: Math.max(160, Math.round(r.width)),
      flip,
    })
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

  const openEditor = (cal?: CalendarDef) => {
    setEditing(cal ?? { name: '', value: 0 })
    setDraftName(cal?.name ?? '')
    setDraftValue(cal?.value ?? 0)
  }
  const closeEditor = () => { setEditing(null); setDraftName(''); setDraftValue(0) }

  const saveEditor = () => {
    const name = draftName.trim()
    if (!name) { closeEditor(); return }
    const val = Number.isFinite(Number(draftValue)) ? Number(draftValue) : 0
    if (editing && editing.name) {
      const next = calendars.map(c => (c.name === editing.name ? { name, value: val } : c))
      onCalendarsChange(next)
      if (value === editing.name && name !== editing.name) onChange(name)
    } else {
      if (calendars.some(c => c.name === name)) { onChange(name); closeEditor(); return }
      onCalendarsChange([...calendars, { name, value: val }])
      onChange(name)
    }
    closeEditor()
  }

  const onDelete = async (cal: CalendarDef) => {
    if (!await confirmDialog({ title: '删除历法', message: `确定删除历法「${cal.name}」？\n已选择该历法的事件会保留此名称文本，但下拉中不再出现。`, danger: true })) return
    onCalendarsChange(calendars.filter(c => c.name !== cal.name))
    if (value === cal.name) onChange('')
  }

  const choose = (name: string) => { onChange(name); setOpen(false) }

  return (
    <div ref={wrapRef} className="relative inline-block w-full min-w-[90px]">
      <Button variant="bare"
        ref={btnRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full !py-1 text-[12px] min-w-[90px] bg-transparent text-left flex items-center justify-between gap-1 border-b border-transparent hover:border-ink-700 px-1.5 rounded"
      >
        <span className={value ? 'text-ink-100' : 'text-ink-500'}>{value || '—'}</span>
        <ChevronDown size={11} className="text-ink-500 shrink-0" />
      </Button>
      {open && pos && createPortal(
        <div
          ref={dropRef}
          style={{ left: pos.left, top: pos.top, minWidth: pos.minWidth, transform: pos.flip ? 'translateY(-100%)' : undefined }}
          className="fixed z-[10001] overflow-y-auto rounded-md bg-ink-800 border border-ink-600 shadow-xl py-1 max-h-72"
        >
          {calendars.length === 0 && (
            <div className="px-2.5 py-2 text-[11px] text-ink-500">暂无历法，点击下方新增</div>
          )}
          {calendars.map(cal => {
            const selected = value === cal.name
            return (
              <div
                key={cal.name}
                className={`group flex items-center px-1 py-0.5 text-[12px] hover:bg-ink-700 ${selected ? 'text-amber' : 'text-ink-200'}`}
              >
                <Button variant="bare"
                  type="button"
                  onClick={() => choose(cal.name)}
                  className="flex-1 text-left px-1.5 py-0.5 flex items-center gap-1.5 min-w-0"
                >
                  {selected ? <Check size={10} /> : <span className="w-[10px]" />}
                  <span className="truncate flex-1">{cal.name}</span>
                  <span className="text-[10px] text-ink-500">({cal.value})</span>
                </Button>
                <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 pr-1">
                  <Button variant="bare"
                    type="button"
                    title="编辑名称/数值"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => openEditor(cal)}
                    className="p-0.5 text-ink-500 hover:text-amber"
                  ><Pencil size={10} /></Button>
                  <Button variant="icon-danger" type="button" title="删除" onMouseDown={e => e.preventDefault()} onClick={() => onDelete(cal)} className="p-0.5"><Trash2 size={10} /></Button>
                </div>
              </div>
            )
          })}
          <Button variant="bare"
            type="button"
            onClick={() => openEditor()}
            className="w-full text-left !justify-start px-2.5 py-1.5 text-[11.5px] text-amber/90 border-t border-ink-700 flex items-center gap-1.5 hover:bg-ink-700"
          >
            <Plus size={11} /> 新增历法…
          </Button>
        </div>,
        document.body
      )}
      {editing && (
        <Modal open onClose={closeEditor} width={320} bodyClassName="p-4" title={editing.name ? '编辑历法' : '新增历法'}>
            <label className="block text-[11px] text-ink-500 mb-1">历法名称</label>
            <input
              value={draftName}
              onChange={e => setDraftName(e.target.value)}
              placeholder="如 灵历 / 上古历"
              className="w-full !py-1.5 text-[13px] mb-3"
            />
            <label className="block text-[11px] text-ink-500 mb-1">数值（默认 0；数值越小越早，如 上古历=-1 表示早于灵历）</label>
            <input
              type="number"
              value={draftValue}
              onChange={e => setDraftValue(Number(e.target.value))}
              className="w-full !py-1.5 text-[13px] mb-1"
            />
            <div className="text-[10px] text-ink-500 mb-3">
              用于跨历法先后顺序与延续性判断：时间轴先按数值排序，再按故事内时间。
            </div>
            <div className="flex gap-2 justify-end">
              <Button onClick={closeEditor} variant="secondary" size="md" className="text-[12px]">取消</Button>
              <Button onClick={saveEditor} variant="primary" size="md" className="text-[12px]">保存</Button>
            </div>
        </Modal>
      )}
    </div>
  )
}
