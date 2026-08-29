import { useState, useMemo } from 'react'
import { Lock, Check, X } from 'lucide-react'
import {
  TABS, GROUPS, EDITOR_TAB, EDITOR_ID,
  tierOf, STRONG_DEPS, resolveFeatures, forcedByDeps,
} from '../lib/schema'

interface FeatureEntry {
  id: string
  name: string
  group: string
  tier: 'locked' | 'default' | 'optional'
  desc: string
  requires: string[]
}

function buildEntries(): FeatureEntry[] {
  const entries: FeatureEntry[] = []
  for (const group of GROUPS) {
    if (group === '正文写作') {
      entries.push({
        id: EDITOR_ID, name: EDITOR_TAB.name, group, tier: tierOf(EDITOR_ID),
        desc: '小说的正文创作面板——没有它就无法写作，故为必选，不可取消。',
        requires: [],
      })
    }
    for (const t of TABS) {
      if (t.group !== group) continue
      entries.push({
        id: t.id, name: t.name, group, tier: tierOf(t.id),
        desc: t.description ?? '',
        requires: STRONG_DEPS[t.id] ?? [],
      })
    }
  }
  return entries
}

// 模块级构建一次，避免每次渲染重复计算
const ENTRIES = buildEntries()
const ENTRIES_BY_GROUP: Record<string, FeatureEntry[]> = {}
for (const e of ENTRIES) (ENTRIES_BY_GROUP[e.group] ??= []).push(e)
const ALL_GROUPS = [...GROUPS]

interface Props {
  title?: string
  /** 当前已开启的可选功能 id（不含锁定项）；新建时传 []，编辑时传项目 features 减去锁定项 */
  initialSelected: string[]
  onConfirm: (features: string[]) => void
  onClose: () => void
}

export default function FeatureSelectModal({ title = '选择项目功能', initialSelected, onConfirm, onClose }: Props) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelected))

  const enabled = useMemo(() => new Set(resolveFeatures(selected)), [selected])
  const forced = useMemo(() => forcedByDeps(enabled), [enabled])

  const nameOf = (id: string) => ENTRIES.find(e => e.id === id)?.name ?? id

  const toggle = (e: FeatureEntry) => {
    const locked = e.tier === 'locked' || (forced.has(e.id) && !selected.has(e.id))
    if (locked) return
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(e.id)) next.delete(e.id); else next.add(e.id)
      return next
    })
  }

  const selectAll = () => setSelected(new Set(ENTRIES.filter(e => e.tier !== 'locked').map(e => e.id)))
  const reset = () => setSelected(new Set(initialSelected))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-3xl max-h-[88vh] flex flex-col rounded-2xl border border-amber/30 bg-ink-850 shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-ink-700">
          <h3 className="text-[14px] font-semibold text-ink-50">{title}</h3>
          <button onClick={onClose} className="text-ink-500 hover:text-ink-200"><X size={16} /></button>
        </div>
        <div className="px-5 py-3 text-[12px] text-ink-400 border-b border-ink-700 leading-relaxed">
          勾选本项目要启用的功能。<span className="text-amber/90">锁</span> 标记的是必选（不可取消）；
          <span className="text-emerald-300/80">默认</span> 标记的项会预先勾选，可手动取消。
          勾选依赖其他表的功能会自动连带开启对应基础表，取消依赖项前无法单独关掉基础表。
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {ALL_GROUPS.map(group => {
            const items = ENTRIES_BY_GROUP[group]
            if (!items) return null
            return (
              <div key={group}>
                <div className="text-[12px] font-semibold text-amber/90 mb-2">{group}</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {items.map(e => {
                    const locked = e.tier === 'locked' || (forced.has(e.id) && !selected.has(e.id))
                    const checked = enabled.has(e.id)
                    return (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() => toggle(e)}
                        className={`text-left rounded-lg border px-3 py-2 transition-colors ${locked
                          ? 'border-ink-700 bg-ink-800/60 cursor-not-allowed'
                          : checked ? 'border-amber/40 bg-amber/10 cursor-pointer'
                          : 'border-ink-700 bg-ink-800/40 hover:border-ink-500 cursor-pointer'}`}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${checked ? 'bg-amber border-amber text-ink-900' : 'border-ink-500'}`}>
                            {checked && <Check size={12} strokeWidth={3} />}
                          </span>
                          <span className="text-[13px] text-ink-100 flex items-center gap-1.5">
                            {e.name}
                            {e.tier === 'locked' && <Lock size={11} className="text-amber/70" />}
                            {e.tier === 'default' && <span className="text-[10px] text-emerald-300/80">默认</span>}
                          </span>
                        </div>
                        <div className="mt-1 text-[11px] text-ink-400 leading-snug line-clamp-2">{e.desc}</div>
                        {e.requires.length > 0 && (
                          <div className="mt-1 text-[10.5px] text-rose-300/80">依赖：{e.requires.map(nameOf).join('、')}（自动开启）</div>
                        )}
                        {locked && e.tier !== 'locked' && (
                          <div className="mt-1 text-[10.5px] text-amber/70">已因依赖自动开启，不可单独取消</div>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-ink-700">
          <div className="flex gap-2">
            <button onClick={selectAll} className="px-3 h-8 text-[12px] text-ink-300 border border-ink-600 rounded-lg hover:bg-ink-700 transition-colors">全选可选</button>
            <button onClick={reset} className="px-3 h-8 text-[12px] text-ink-300 border border-ink-600 rounded-lg hover:bg-ink-700 transition-colors">重置</button>
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3.5 h-9 text-[13px] text-ink-300 border border-ink-600 rounded-lg hover:bg-ink-700 transition-colors">取消</button>
            <button onClick={() => onConfirm(resolveFeatures(selected))} className="px-4 h-9 text-[13px] font-medium bg-amber/20 text-amber border border-amber/40 rounded-lg hover:bg-amber/30 transition-colors">确认</button>
          </div>
        </div>
      </div>
    </div>
  )
}
