import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getTableRows } from '@/lib/db'
import { ChevronDown, Check, Plus } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { EmptyState } from '@/components/common/EmptyState'
import { Z } from '@/lib/app/zLayer'
import { computeDropdownPos, type DropdownPos } from '@/lib/app/dropdownPos'

interface Props {
  value: string
  onChange: (v: string) => void
  /** 来源设定表的 tabId（如 'nations'） */
  refTabId: string
  /** 来源表取名的列（如 '名称'） */
  refCol: string
  placeholder?: string
  /** 下拉中隐藏的名字（自引用父级时排除自身 + 子孙，防止把祖先挂到自己下面形成环） */
  excludeNames?: string[]
  /**
   * 多选（2.4.4）：可同时选多个值，以「，」连接存储（与 CharacterSelect multi 同格式）。
   * 多选模式下点选项**不关闭下拉**，方便连续勾选；手动输入为追加（去重）。
   */
  multi?: boolean
}

/**
 * 跨表引用组合框：选项来自某张设定表（refTabId）的指定列（refCol）当前已有值，
 * 通过 Portal 渲染到 body，避免被表格 / 卡片的 overflow 裁剪。
 * 优先从已有设定中选择（根治"青岚宗"写成"青岚派"导致的归属错乱）；
 * 当来源表为空 / 被项目形态隐藏（如极简项目砍掉世界构建）无法选择时，
 * 允许在搜索框中手动输入，保证字段不被完全锁死（三形态兼容）。
 */
export default function TableRefSelect({ value, onChange, refTabId, refCol, placeholder = '选择', excludeNames, multi = false }: Props) {
  const [names, setNames] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<DropdownPos | null>(null)

  useEffect(() => {
    let alive = true
    getTableRows(refTabId).then(rows => {
      if (!alive) return
      const s = new Set<string>()
      rows.forEach(r => {
        const v = (r.data[refCol] || '').trim()
        if (v) s.add(v)
      })
      setNames([...s].sort((a, b) => a.localeCompare(b, 'zh')))
    })
    return () => { alive = false }
  }, [refTabId, refCol])

  const updatePos = () => {
    const btn = btnRef.current
    if (!btn) return
    setPos(computeDropdownPos(btn.getBoundingClientRect()))
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
      setOpen(false); setQ('')
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const close = () => { setOpen(false); setQ('') }
  const selectedNames = multi
    ? (value || '').split(/[，,]/).map(x => x.trim()).filter(Boolean)
    : (value ? [value] : [])
  const isSel = (n: string) => selectedNames.includes(n)
  const toggle = (n: string) => {
    if (!multi) { onChange(n); close(); return }
    const set = new Set(selectedNames)
    if (set.has(n)) set.delete(n); else set.add(n)
    onChange([...set].join('，'))
  }
  // 内置搜索：按输入过滤下拉项；来源表为空 / 被项目形态隐藏（如极简项目）时允许手动输入
  const ql = q.trim().toLowerCase()
  const list0 = excludeNames && excludeNames.length ? names.filter(n => !excludeNames.includes(n)) : names
  const filtered = ql ? list0.filter(n => n.toLowerCase().includes(ql)) : list0
  const exact = ql !== '' && names.some(n => n.toLowerCase() === ql)
  const applyManualInput = () => {
    const v = q.trim()
    if (!v) return
    if (multi) {
      const set = new Set([...selectedNames, v])
      onChange([...set].join('，'))
    } else {
      onChange(v)
    }
    close()
  }
  const display = multi ? selectedNames.join('，') : value

  return (
    <div ref={wrapRef} className="relative inline-block w-full min-w-[90px]">
      <Button variant="bare"
        ref={btnRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full !py-1 text-12 min-w-[90px] bg-transparent text-left flex items-center !justify-between gap-1 border-b border-transparent hover:border-ink-700 px-1.5 rounded"
      >
        <span className={display ? 'text-ink-100 truncate' : 'text-ink-500 truncate'}>{display || placeholder}</span>
        <ChevronDown size={11} className="text-ink-500 shrink-0" />
      </Button>
      {open && pos && createPortal(
        <div
          ref={dropRef}
          style={{
            left: pos.left,
            zIndex: Z.dropdown,
            top: pos.top,
            minWidth: pos.minWidth,
            maxHeight: pos.maxHeight,
            transform: pos.flip ? 'translateY(-100%)' : undefined,
          }}
          className="fixed overflow-y-auto rounded-md bg-ink-800 border border-ink-600 shadow-xl py-1"
        >
          <div className="px-2 py-1.5 border-b border-ink-700 bg-ink-900/60 sticky top-0">
            <input
              autoFocus
              value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => {
                // 🔴 2.4.4 六维审计：下拉键盘可达 —— Esc 关闭；Enter 确认（精确匹配选中之，
                //    否则按「使用手动输入」走，与下方按钮同语义）
                if (e.key === 'Escape') { e.stopPropagation(); close() }
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  if (exact) toggle(names.find(n => n.toLowerCase() === ql)!)
                  else applyManualInput()
                }
              }}
              placeholder="搜索或手动输入…"
              className="w-full !py-0.5 text-12"
            />
          </div>
          {q.trim() && !exact && (
            <Button type="button"
              onClick={applyManualInput} variant="secondary" size="md" className="w-full text-left border-b flex items-center">
              <Plus size={11} /> 使用「{q.trim()}」
            </Button>
          )}
          {filtered.length === 0 && !q.trim() && (
            <EmptyState text="暂无可选数据，可直接在上方输入" />
          )}
          {filtered.map(n => (
            <Button variant="bare"
              key={n}
              type="button"
              onClick={() => toggle(n)}
              className={`flex items-center gap-1.5 w-full text-left px-2.5 py-1 text-12 hover:bg-ink-700 ${isSel(n) ? 'text-amber' : 'text-ink-200'}`}
            >
              {isSel(n) ? <Check size={10} className="shrink-0" /> : <span className="w-10px shrink-0" />}
              <span className="truncate flex-1">{n}</span>
            </Button>
          ))}
          {multi && selectedNames.length > 0 && (
            <div className="px-2.5 py-1 text-10 text-ink-500 border-t border-ink-700 leading-relaxed">
              已选 {selectedNames.length} 项（点选项可取消；⚠️ 多个势力可能让 AI 对人物从属关系判断不清）
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}
