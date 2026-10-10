import { useState, useMemo } from 'react'
import { Lock, Check } from 'lucide-react'
import { Modal } from '@/components/Modal'
import {

  TABS, GROUPS, EDITOR_TAB, EDITOR_ID,
  tierOf, STRONG_DEPS, resolveFeatures, forcedByDeps,
} from '@/lib/schema'
import { Button } from '@/components/Button'

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
    <Modal
      open
      onClose={onClose}
      title={title}
      accent="amber"
      width="2xl"
      maxHeight="88vh"
      subheader={
        <div className="px-5 py-3 text-12 text-ink-400 leading-relaxed">
          勾选本项目要启用的功能。<span className="text-amber/90">锁</span> 标记的是必选（不可取消）。
          有依赖关系的会自动连带开启（如「人物关系」带「主要角色」、酒馆模式两组互绑、控制面板是其余酒馆页签的前置），取消依赖项前无法单独关掉。
          「剧情推演」需要项目资料可喂，一个都没勾时会自动带上「主要角色」。
        </div>
      }
      footerAlign="between"
      footer={
        <>
          <div className="flex gap-2">
            <Button onClick={selectAll} variant="secondary" size="sm" className="">全选可选</Button>
            <Button onClick={reset} variant="secondary" size="sm" className="">重置</Button>
          </div>
          <div className="flex gap-2">
            <Button onClick={onClose} variant="secondary" size="md">取消</Button>
            {/* U-9 · 2.6.0：确认键改 primary 令牌（原 bare 手搓 amber/20 系样式与真源漂移）；与同排取消统一 md */}
            <Button variant="primary" size="md" onClick={() => onConfirm(resolveFeatures(selected))}>确认</Button>
          </div>
        </>
      }
    >
        <div className="space-y-5">
          {ALL_GROUPS.map(group => {
            const items = ENTRIES_BY_GROUP[group]
            if (!items) return null
            return (
              <div key={group}>
                <div className="text-12 font-semibold text-amber/90 mb-2">{group}</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {items.map(e => {
                    const locked = e.tier === 'locked' || (forced.has(e.id) && !selected.has(e.id))
                    const checked = enabled.has(e.id)
                    return (
                      <Button variant="bare"
                        key={e.id}
                        type="button"
                        onClick={() => toggle(e)}
                        className={`text-left rounded-lg border px-3 py-2 min-h-[68px] transition-colors ${locked
                          ? 'border-ink-700 bg-ink-800/60 cursor-not-allowed'
                          : checked ? 'border-amber/40 bg-amber/15 cursor-pointer'
                          : 'border-ink-700 bg-ink-800/40 hover:border-ink-500 cursor-pointer'}`}
                      >
                        <div className="w-full text-left">
                          <div className="flex items-center gap-2">
                            <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${checked ? 'bg-amber border-amber text-ink-900' : 'border-ink-500'}`}>
                              {checked && <Check size={12} strokeWidth={3} />}
                            </span>
                            <span className="text-13 text-ink-100 flex items-center gap-1.5 whitespace-nowrap">
                              {e.name}
                              {e.tier === 'locked' && <Lock size={11} className="text-amber/70" />}
                              {e.tier === 'default' && <span className="text-10 text-success/80">默认</span>}
                            </span>
                          </div>
                          <div className="mt-1 text-11 text-ink-400 leading-snug line-clamp-2">{e.desc}</div>
                          {e.requires.length > 0 && (
                            <div className="mt-1 text-10 text-rose-300/80 leading-snug">需同时启用：{e.requires.map(nameOf).join('、')}</div>
                          )}
                          {locked && e.tier !== 'locked' && (
                            <div className="mt-1 text-10 text-amber/70">已因依赖自动开启，不可单独取消</div>
                          )}
                        </div>
                      </Button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
    </Modal>
  )
}
