import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  getCustomOptions,
  addCustomItem,
  removeCustomItem,
  hideBuiltinItem,
  renameBuiltinItem,
  restoreBuiltinItem,
  type CustomOptionPayload,
} from '../lib/db'
import { Plus, Check, ChevronDown, ChevronRight, Pencil, Trash2, EyeOff, RotateCcw } from 'lucide-react'
import { confirmDialog, showToast } from './dialogs'
import { Button } from './Button'
import { EmptyState } from './EmptyState'
import { Z } from '../lib/zLayer'
import { computeDropdownPos, type DropdownPos } from '../lib/dropdownPos'


/** 自定义下拉选项变更广播：任意下拉增删改选项后派发，同列其它下拉与地图图例据此刷新 */
export const CUSTOM_OPTIONS_EVENT = 'yfe:custom-options'

// 「有效选项」的解析规则已下沉到 lib/customOptions.ts —— 因为「AI 整理」也要用同一口径喂候选值，
// 而 lib 不得反向依赖 components（分层红线，见 tests/importCycles.test.ts）。
// 这里再导出，保持既有调用方（TableSheet / GeoMapEditor）的 import 路径不变。
export { resolveOptions, type ResolvedOption } from '../lib/customOptions'

interface Props {
  tabId: string
  colName: string
  options: string[]            // schema 定义的内置选项
  value: string
  onChange: (v: string) => void
  /** 选项值 → 展示文案 的映射（如保密等级 S→"S · 绝密"，存储值仍为字母，仅展示用） */
  labelMap?: Record<string, string>
  onRenameBuiltin?: (oldName: string, newName: string) => void  // 让上层把已用旧值替换为新值
  /**
   * **选项固定**：不提供增 / 改 / 删 / 移除入口（下拉底部给一行说明代替）。
   *
   * 🔴 用于「保密等级」这类被机器逻辑读取的封闭枚举：AI 上下文预算排序与角色视角可见性
   *    都按这五个字母判定，作者随手加一个自定义值或把 S 改名，两套逻辑就认不出来
   *    （排序静默失效、该档数据在角色视角下也不再被排除）。见 schema 的 `cFixed()`。
   */
  fixedOptions?: boolean
}

/**
 * 自定义下拉：
 * - 列表显示 = 内置（去掉 hidden，应用 renamed 替换为显示名）∪ 用户自定义 items
 * - 每个选项右侧菜单：编辑/删除（自定义项）/隐藏（内置项）/还原（已隐藏项）
 * - 底部"+ 添加新值…"项：输入新文本后回车即可保存
 */
export default function CustomSelect({ tabId, colName, options, value, onChange, labelMap, onRenameBuiltin, fixedOptions }: Props) {
  const [payload, setPayload] = useState<CustomOptionPayload>({ items: [], hidden: [] })
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [q, setQ] = useState('')
  /** 「已移除的内置项」是否展开（默认折叠 —— 2026-09-29：移除后下拉里不再挂着一串删除线） */
  const [showRemoved, setShowRemoved] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  // 下拉浮层用 Portal + fixed 定位渲染在 body 上，避免被表格滚动容器裁剪/遮挡
  const [pos, setPos] = useState<DropdownPos | null>(null)

  // 加载
  useEffect(() => {
    let alive = true
    // 🔴 换列/换页签时先清空再读：异步读取返回前短暂显示上一列的 items/hidden 会造成错位假象
    setPayload({ items: [], hidden: [] })
    setShowRemoved(false)
    setQ('')
    getCustomOptions(tabId, colName).then(p => { if (alive) setPayload(p) })
    return () => { alive = false }
  }, [tabId, colName])

  // 选项被别处改动时同步刷新（同一列可能同时渲染多个下拉，且地图编辑图例也依赖此广播）
  useEffect(() => {
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent<{ tabId: string; colName: string }>).detail
      if (!d || d.tabId !== tabId || d.colName !== colName) return
      void getCustomOptions(tabId, colName).then(setPayload)
    }
    window.addEventListener(CUSTOM_OPTIONS_EVENT, onChanged)
    return () => window.removeEventListener(CUSTOM_OPTIONS_EVENT, onChanged)
  }, [tabId, colName])

  /** 写入后统一：更新本地状态 + 广播，让同列其它下拉与图例跟随刷新 */
  const applyPayload = (p: CustomOptionPayload) => {
    setPayload(p)
    window.dispatchEvent(new CustomEvent(CUSTOM_OPTIONS_EVENT, { detail: { tabId, colName } }))
  }

  // 计算浮层位置：默认显示在按钮下方；下方空间不足且上方更宽敞时向上翻转
  const updatePos = () => {
    const btn = btnRef.current
    if (!btn) return
    // estH/翻转阈值/留白沿用本组件原值；几何统一走 lib，避免这份算法在多处漂移
    setPos(prev => {
      const next = computeDropdownPos(btn.getBoundingClientRect(), { estH: 288, flipBelow: 220, margin: 12, minWidth: 180, clampRight: 200 })
      return prev && prev.left === next.left && prev.top === next.top && prev.minWidth === next.minWidth
        && prev.maxHeight === next.maxHeight && prev.flip === next.flip ? prev : next
    })
  }

  // 打开时计算位置；容器滚动或窗口变化时跟随重算
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

  // 点击外部关闭（浮层渲染在 body 上，需同时检查浮层自身）
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (wrapRef.current?.contains(t) || dropRef.current?.contains(t)) return
      closeAll()
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const closeAll = () => {
    setOpen(false); setAdding(false); setDraft('')
    setRenaming(null); setRenameDraft('')
    setEditing(null); setEditDraft('')
    setQ('')
    setShowRemoved(false)
  }

  // 内置项 → 应用 renamed 替换；过滤 hidden
  const renamedMap = payload.renamed ?? {}
  const builtinDisplay = options
    .filter(o => !payload.hidden.includes(o))
    .map(o => ({ original: o, display: labelMap?.[o] ?? renamedMap[o] ?? o }))
  const userItems = payload.items

  /**
   * 任意取值 → 展示文案（labelMap > renamed > 原值）。
   * 🔴 按钮（单元格当前值）必须与列表项用同一套口径 —— 2026-09-29 社区反馈：
   *    重命名内置项后下拉列表显示新名，但按钮仍显示原名，看起来像「改了没保存」。
   */
  const displayOf = (v: string) => labelMap?.[v] ?? renamedMap[v] ?? v

  // 完整显示列表（保持稳定：先内置后用户项；同名去重）
  type Item = { key: string; original: string; display: string; kind: 'builtin' | 'user' }
  const list: Item[] = []
  const seen = new Set<string>()
  for (const b of builtinDisplay) {
    if (seen.has(b.display)) continue
    seen.add(b.display); list.push({ key: `b-${b.original}`, original: b.original, display: b.display, kind: 'builtin' })
  }
  for (const u of userItems) {
    if (seen.has(u)) continue
    seen.add(u); list.push({ key: `u-${u}`, original: u, display: u, kind: 'user' })
  }

  // 内置搜索：按输入过滤下拉项（选项变多时快速定位）
  const ql = q.trim().toLowerCase()
  const filtered = ql ? list.filter(i => i.display.toLowerCase().includes(ql)) : list

  const choose = (v: string) => {
    onChange(v)
    closeAll()
  }

  const submitDraft = async () => {
    // 固定选项列：界面已不提供入口，这里再兜一道（防未来某处直接调进来）
    if (fixedOptions) { setAdding(false); return }
    const v = draft.trim()
    if (!v) { setAdding(false); return }
    if (list.some(i => i.display === v)) { onChange(v); closeAll(); return }
    try {
      const next = await addCustomItem(tabId, colName, v)
      applyPayload(next)
      onChange(v)
      closeAll()
    } catch (e) {
      showToast(`新增选项失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  const submitEditUser = async () => {
    const v = editDraft.trim()
    if (!v || !editing) { setEditing(null); return }
    if (v === editing) { setEditing(null); return }
    if (list.some(i => i.display === v && i.original !== editing)) {
      // 🔴 重名冲突必须说出来：静默关面板会让作者以为保存成功了
      showToast(`「${v}」已存在，换一个名称`, 'info')
      return
    }
    // 用删除+新增实现改名
    try {
      await removeCustomItem(tabId, colName, editing)
      const next = await addCustomItem(tabId, colName, v)
      applyPayload(next)
      if (value === editing) onChange(v)
      onRenameBuiltin?.(editing, v)
      setEditing(null); setEditDraft('')
    } catch (e) {
      showToast(`改名失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  const submitRenameBuiltin = async () => {
    if (fixedOptions) { setRenaming(null); return }
    const v = renameDraft.trim()
    if (!v || !renaming) { setRenaming(null); return }
    if (list.some(i => i.display === v && i.original !== renaming)) {
      // 🔴 同上：重名冲突要提示，且留在编辑态让作者改
      showToast(`「${v}」已存在，换一个名称`, 'info')
      return
    }
    try {
      const next = await renameBuiltinItem(tabId, colName, renaming, v)
      applyPayload(next)
      // 🔴 2026-09-29 社区反馈修复：**不动存储值**（原名仍写在数据里，显示走 renamed 映射）。
      //    旧实现在这里 onChange(v) 把当前格的值改成新名 —— 于是同一列里有的行存原名、有的行存新名，
      //    存新名的行不在内置 options 里 ⇒ 选中态丢失、下拉里还同时出现两个同名项。
      //    需要「连数据一起换」的上层自己传 onRenameBuiltin 做全表替换（目前没有上层这么做）。
      onRenameBuiltin?.(renaming, v)
      setRenaming(null); setRenameDraft('')
    } catch (e) {
      showToast(`重命名失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  const onDeleteUser = async (v: string) => {
    if (!await confirmDialog({ title: '删除自定义项', message: `确定删除自定义项「${v}」？`, danger: true })) return
    try {
      const next = await removeCustomItem(tabId, colName, v)
      applyPayload(next)
      if (value === v) onChange('')
    } catch (e) {
      showToast(`删除失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  const onHideBuiltin = async (orig: string) => {
    if (!await confirmDialog({
      title: '移除内置项',
      message: `确定从下拉中移除内置项「${orig}」？\n（已使用此值的数据不会被改动；需要时可在下拉底部「已移除 N 项」里展开还原）`,
      danger: true,
    })) return
    try {
      const next = await hideBuiltinItem(tabId, colName, orig)
      applyPayload(next)
      if (value === (renamedMap[orig] ?? orig)) onChange('')
    } catch (e) {
      showToast(`移除失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  const onRestoreBuiltin = async (orig: string) => {
    try {
      const next = await restoreBuiltinItem(tabId, colName, orig)
      applyPayload(next)
    } catch (e) {
      showToast(`还原失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  const onStartRename = (orig: string, display: string) => {
    setRenaming(orig); setRenameDraft(display)
    setTimeout(() => renameInputRef.current?.focus(), 0)
  }

  const onStartEditUser = (v: string) => {
    setEditing(v); setEditDraft(v)
    setTimeout(() => editInputRef.current?.focus(), 0)
  }

  return (
    <div ref={wrapRef} className="relative inline-block w-full min-w-[90px]">
      <Button variant="bare"
        ref={btnRef}
        type="button"
        onClick={() => {
          // 🔴 关闭走 closeAll（清掉添加/重命名/编辑/已移除展开/搜索词的残留态）——
          //    只 setOpen(false) 的话，再点开时会直接呈现上一轮没退出的输入面板
          if (open) closeAll()
          else setOpen(true)
        }}
        className="w-full !py-1 text-12 min-w-[90px] bg-transparent text-left flex items-center justify-between gap-1 border-b border-transparent hover:border-ink-700 px-1.5 rounded"
      >
        <span className={value ? 'text-ink-100' : 'text-ink-500'}>{value ? displayOf(value) : '—'}</span>
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
              autoFocus={!renaming && !editing && !adding}
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="搜索选项…"
              className="w-full !py-0.5 text-12"
            />
          </div>
          {(filtered.length === 0 && !adding && !renaming && !editing) && (
            <EmptyState text="无匹配项，可点击下方新增" />
          )}
          {list.length === 0 && !adding && !ql && (
            <EmptyState text="暂无选项，点击下方新增" />
          )}

          {renaming && (() => {
            const item = list.find(i => i.original === renaming)
            return (
              <div className="px-2 py-1.5 border-b border-ink-700 bg-ink-900/60">
                <div className="text-10 text-ink-500 mb-1">重命名内置项</div>
                <div className="flex items-center gap-1">
                  <input
                    ref={renameInputRef}
                    value={renameDraft}
                    onChange={e => setRenameDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); submitRenameBuiltin() }
                      if (e.key === 'Escape') { setRenaming(null); setRenameDraft('') }
                    }}
                    className="flex-1 !py-0.5 text-12 min-w-0"
                  />
                  <Button type="button" onClick={submitRenameBuiltin} variant="primary" size="xs">保存</Button>
                </div>
                <div className="mt-1 text-10 text-ink-500">原名：{item?.original}</div>
                <div className="mt-0.5 text-10 text-ink-600">改名只改显示名；表里已填的数据仍保存原名，筛选按显示名匹配。</div>
              </div>
            )
          })()}

          {editing && (
            <div className="px-2 py-1.5 border-b border-ink-700 bg-ink-900/60">
              <div className="text-10 text-ink-500 mb-1">编辑自定义项</div>
              <div className="flex items-center gap-1">
                <input
                  ref={editInputRef}
                  value={editDraft}
                  onChange={e => setEditDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); submitEditUser() }
                    if (e.key === 'Escape') { setEditing(null); setEditDraft('') }
                  }}
                  className="flex-1 !py-0.5 text-12 min-w-0"
                />
                <Button type="button" onClick={submitEditUser} variant="primary" size="xs">保存</Button>
              </div>
              <div className="mt-0.5 text-10 text-ink-600">改名只同步当前格；其它行若已填旧值，需自行改为新值。</div>
            </div>
          )}

          {filtered.map(item => {
            if (renaming && item.original === renaming) return null
            if (editing && item.original === editing) return null
            // 选中态：正常是「存储值 === 内置原名」；也接受 display —— 兼容旧版把值写成新名的脏数据
            const selected = value === item.original || value === item.display
            return (
              <div
                key={item.key}
                className={`group flex items-center px-1 py-0.5 text-12 hover:bg-ink-700
                  ${selected ? 'text-amber' : 'text-ink-200'}`}
              >
                <Button variant="bare"
                  type="button"
                  onClick={() => choose(item.original)}
                  className="flex-1 text-left px-1.5 py-0.5 flex items-center gap-1.5 min-w-0"
                >
                  {selected ? <Check size={10} /> : <span className="w-10px" />}
                  <span className="truncate flex-1">{item.display}</span>
                  {item.kind === 'user' && (
                    <span className="ml-auto text-9 text-ink-500 bg-ink-900 px-1 rounded">自定义</span>
                  )}
                </Button>
                <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 pr-1">
                  {fixedOptions ? null : item.kind === 'builtin' ? (
                    <>
                      <Button variant="bare" iconOnly size="xs"
                        type="button"
                        title="重命名"
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => onStartRename(item.original, item.display)}
                        className="text-ink-500 hover:text-amber"
                      ><Pencil size={10} /></Button>
                      <Button variant="icon-danger" type="button" title="从下拉移除" onMouseDown={e => e.preventDefault()} onClick={() => onHideBuiltin(item.original)} className="p-0.5"><EyeOff size={10} /></Button>
                    </>
                  ) : (
                    <>
                      <Button variant="bare" iconOnly size="xs"
                        type="button"
                        title="编辑"
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => onStartEditUser(item.original)}
                        className="text-ink-500 hover:text-amber"
                      ><Pencil size={10} /></Button>
                      <Button variant="icon-danger" type="button" title="删除" onMouseDown={e => e.preventDefault()} onClick={() => onDeleteUser(item.original)} className="p-0.5"><Trash2 size={10} /></Button>
                    </>
                  )}
                </div>
              </div>
            )
          })}

          {/* 已移除的内置项可还原（固定选项列不会出现这种情况，一并省略）。
              🔴 2026-09-29：**默认折叠** —— 移除后下拉里只留一行「已移除 N 项（展开可还原）」，
              不再挂着一串带删除线的条目（看着像没删干净）；需要还原时点开，反悔通道仍在。 */}
          {!fixedOptions && payload.hidden.length > 0 && (
            <div className="border-t border-ink-700 mt-1 pt-1">
              {showRemoved ? (
                <>
                  <Button variant="bare" size="xs" type="button"
                    onClick={() => setShowRemoved(false)}
                    className="w-full !justify-start px-2.5 py-0.5 text-10 text-ink-500 hover:text-amber">
                    <ChevronDown size={10} /> 已移除的内置项（{payload.hidden.length}）· 收起
                  </Button>
                  {payload.hidden.map(h => (
                    <div key={`h-${h}`} className="group flex items-center px-1 py-0.5 text-12 text-ink-500 hover:bg-ink-700">
                      <span className="flex-1 px-1.5 py-0.5 line-through truncate">{h}</span>
                      <Button variant="bare" iconOnly size="xs"
                        type="button"
                        onClick={() => onRestoreBuiltin(h)}
                        className="opacity-40 group-hover:opacity-100 hover:text-amber"
                        title="还原"
                      ><RotateCcw size={10} /></Button>
                    </div>
                  ))}
                </>
              ) : (
                <Button variant="bare" size="xs" type="button"
                  onClick={() => setShowRemoved(true)}
                  title="展开可把移除过的内置项还原回来"
                  className="w-full !justify-start px-2.5 py-1 text-10 text-ink-500 hover:text-amber">
                  <ChevronRight size={10} /> 已移除 {payload.hidden.length} 项（展开可还原）
                </Button>
              )}
            </div>
          )}

          {fixedOptions ? (
            <div className="px-2.5 py-1.5 border-t border-ink-700 text-10 leading-relaxed text-ink-500">
              固定档位，不可增改 —— 它决定「谁看得到」与「谁先占 AI 上下文预算」，多一个值就认不出来。
            </div>
          ) : adding ? (
            <div className="px-2 py-1.5 border-t border-ink-700 flex items-center gap-1">
              <input
                ref={inputRef}
                autoFocus
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); submitDraft() }
                  if (e.key === 'Escape') { setAdding(false); setDraft('') }
                }}
                placeholder="输入新选项"
                className="flex-1 !py-0.5 text-12 min-w-0"
              />
              <Button type="button"
                onClick={submitDraft} variant="primary" size="xs">保存</Button>
            </div>
          ) : (
            <Button variant="bare"
              type="button"
              onClick={() => { setAdding(true); setTimeout(() => inputRef.current?.focus(), 0) }}
              className="w-full text-left !justify-start px-2.5 py-1.5 text-11 text-amber/90 border-t border-ink-700 flex items-center gap-1.5 hover:bg-ink-700"
            >
              <Plus size={11} /> 添加新值…
            </Button>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}
