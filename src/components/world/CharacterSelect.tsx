import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isOverlayObscured, usePopupLayer } from '@/lib/app/overlayScope'
import { getCardRecords } from '@/lib/db'
import type { CardRecord } from '@/lib/types'
import { tabVisible, type VisCtx, TABS } from '@/lib/schema'
import { ChevronDown, Check } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { EmptyState } from '@/components/common/EmptyState'
import SelectedValues from '@/components/common/SelectedValues'
import { Z } from '@/lib/app/zLayer'
import { computeDropdownPos, type DropdownPos } from '@/lib/app/dropdownPos'

interface Props {
  value: string
  onChange: (v: string) => void
  /** 多选模式：值以中文逗号"，"连接 */
  multi?: boolean
  placeholder?: string
  /** 项目形态：极简项目隐藏 NPC 角色卡，下拉不列出 NPC（与设定检索一致） */
  ctx: VisCtx
}

/**
 * 角色选择下拉：选项来自已创建的角色卡（主要 / 次要 / NPC），
 * 通过 Portal 渲染到 body，避免被表格 / 卡片的 overflow 裁剪。
 * 不允许手动输入新值 —— 强制从已有角色中选，防止关系网 / 知情权限出现无主人物。
 */
export default function CharacterSelect({ value, onChange, multi = false, placeholder = '选择角色', ctx = { type: 'full', features: [] } }: Props) {
  const [names, setNames] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const portalHost = usePopupLayer(open, () => setOpen(false), btnRef)
  const dropRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<DropdownPos | null>(null)

  useEffect(() => {
    let alive = true
    const npcDef = TABS.find(t => t.id === 'char-npc')
    // NPC 页签「可见」才纳入：此处不可写成 !tabVisible —— 那会让完整项目的下拉里反而没有 NPC
    const showNpc = npcDef ? tabVisible(npcDef.id, ctx) : false
    const reads: Promise<CardRecord[]>[] = [
      getCardRecords('char-main'),
      getCardRecords('char-secondary'),
    ]
    if (showNpc) reads.push(getCardRecords('char-npc'))
    Promise.all(reads).then(lists => {
      if (!alive) return
      const s = new Set<string>()
      const main = lists[0] ?? []
      const sec = lists[1] ?? []
      const npc = showNpc ? (lists[2] ?? []) : []
      ;[...main, ...sec, ...npc].forEach(r => { if (r.name && r.name.trim()) s.add(r.name.trim()) })
      setNames([...s])
    })
    return () => { alive = false }
  }, [ctx])

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
      if (isOverlayObscured(btnRef.current)) return
      const t = e.target as Node
      if (wrapRef.current?.contains(t) || dropRef.current?.contains(t)) return
      setOpen(false); setQ('')
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // 内置搜索：角色变多时按输入过滤下拉项
  const ql = q.trim().toLowerCase()
  const filtered = ql ? names.filter(n => n.toLowerCase().includes(ql)) : names

  const selected = multi
    ? (value || '').split(/[,，]/).map(s => s.trim()).filter(Boolean)
    : (value ? [value] : [])
  const isSel = (n: string) => selected.includes(n)
  const toggle = (n: string) => {
    if (!multi) { onChange(value === n ? '' : n); setOpen(false); setQ(''); return }
    const set = new Set(selected)
    if (set.has(n)) set.delete(n); else set.add(n)
    onChange([...set].join('，'))
  }
  const removeSelected = (name: string) => {
    onChange(multi ? selected.filter(value => value !== name).join('，') : '')
    if (!multi) { setOpen(false); setQ('') }
    else requestAnimationFrame(() => dropRef.current?.querySelector('input')?.focus({ preventScroll: true }))
  }
  const display = multi ? selected.join('，') : value

  return (
    <div ref={wrapRef} className="relative inline-block w-full min-w-[90px]">
      <Button variant="bare"
        ref={btnRef}
        aria-expanded={open}
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
            width: pos.minWidth,
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
              placeholder="搜索角色…"
              className="w-full !py-0.5 text-12"
            />
          </div>
          <SelectedValues values={selected} onRemove={removeSelected} onClear={() => { onChange(''); setOpen(false); setQ('') }} />
          {filtered.length === 0 && (
            <EmptyState text="无匹配角色" />
          )}
          {filtered.map(n => (
            <Button variant="bare"
              key={n}
              type="button"
              onClick={() => toggle(n)}
              className={`flex items-center gap-1.5 !justify-start w-full text-left px-2.5 py-1 text-12 hover:bg-ink-700 ${isSel(n) ? 'text-amber' : 'text-ink-200'}`}
            >
              {multi && (isSel(n) ? <Check size={10} className="shrink-0" /> : <span className="w-10px shrink-0" />)}
              <span className="truncate flex-1">{n}</span>
            </Button>
          ))}
        </div>,
        portalHost()
      )}
    </div>
  )
}
