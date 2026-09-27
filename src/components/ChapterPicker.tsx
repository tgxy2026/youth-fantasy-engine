/**
 * 「整章改写」的选章器：**卷 → 章** 两层树 + 搜索框。
 *
 * 为什么不用扁平下拉（原来的实现）：章节一多就没法用 —— 示范项目 21 章还凑合，
 * 长篇几百章时要在下拉里滚着找，而且看不出章属于哪一卷。
 *
 * 三条交互约定：
 * - **搜索时强制展开**：命中的章若藏在折叠的卷里，看起来就像"没搜到"。
 * - **标题里已带「第N章」就不重复显示**（示范项目的标题本身就叫「第21章 剑应碑醒」）。
 * - **最新章单独标出来**：改它的纪律和历史章完全不同（可放开改写、落库后要同步设定）。
 */
import { useMemo, useState } from 'react'
import SelectRow from './SelectRow'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import type { RewriteCandidateGroup } from '../lib/chapterRewrite'

interface Props {
  groups: RewriteCandidateGroup[]
  /** 选中的 chapterId；空串＝未选 */
  value: string
  onChange: (id: string) => void
  disabled?: boolean
  /** 最新章的 id（末章）—— 用来打标记 */
  latestId?: string
}

export default function ChapterPicker({ groups, value, onChange, disabled, latestId }: Props) {
  const [q, setQ] = useState('')
  /** 折叠起来的卷 id（默认全展开：章节通常不多，收着反而要多点一下） */
  const [closed, setClosed] = useState<Set<string>>(new Set())

  const kw = q.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!kw) return groups
    return groups
      .map(g => ({
        ...g,
        items: g.items.filter(c =>
          `第${c.no}章`.toLowerCase().includes(kw) ||
          String(c.no) === kw ||
          c.chapter.title.toLowerCase().includes(kw),
        ),
      }))
      .filter(g => g.items.length > 0)
  }, [groups, kw])

  const isOpen = (id: string) => (kw ? true : !closed.has(id))
  const toggle = (id: string) => {
    const next = new Set(closed)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setClosed(next)
  }

  return (
    <div className="rounded border border-ink-700 bg-ink-900">
      <div className="flex items-center gap-1.5 border-b border-ink-700 px-2 py-1.5">
        <Search size={12} className="shrink-0 text-ink-500" />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          disabled={disabled}
          spellCheck={false}
          placeholder="搜章号或标题（如 21 / 剑应）"
          className="w-full bg-transparent text-12 text-ink-100 outline-none placeholder:text-ink-500 disabled:opacity-60"
        />
        {q && (
          <button
            onClick={() => setQ('')}
            disabled={disabled}
            className="shrink-0 text-11 text-ink-500 hover:text-ink-300 disabled:opacity-60"
          >
            清除
          </button>
        )}
      </div>

      <div className="max-h-64 overflow-y-auto py-1">
        {filtered.length === 0 && (
          <div className="px-3 py-2 text-11 text-ink-500">
            {groups.length === 0 ? '项目里还没有章节' : '没有匹配的章节'}
          </div>
        )}
        {filtered.map(g => (
          <div key={g.volume.id}>
            <button
              onClick={() => toggle(g.volume.id)}
              disabled={disabled}
              className="flex w-full items-center gap-1 px-2 py-1 text-left text-11 text-ink-300 hover:bg-ink-800/60 disabled:opacity-60"
            >
              {isOpen(g.volume.id) ? <ChevronDown size={11} className="shrink-0" /> : <ChevronRight size={11} className="shrink-0" />}
              <span className="truncate">{g.volume.title}</span>
              <span className="shrink-0 text-ink-500">（{g.items.length} 章）</span>
            </button>
            {isOpen(g.volume.id) && (
              <div>
                {g.items.map(c => {
                  const on = c.chapter.id === value
                  return (
                    <SelectRow
                      key={c.chapter.id}
                      selected={on}
                      onClick={() => onChange(c.chapter.id)}
                      disabled={disabled}
                      title={c.chapter.title}
                      className="items-center gap-1.5 py-1 pl-6 pr-2 text-11"
                    >
                      <span className="shrink-0 tabular-nums">{c.no > 0 ? `第${c.no}章` : '（不计号）'}</span>
                      {/* 标题里已带「第N章」就不重复显示（示范项目的标题本身就带） */}
                      <span className="truncate">{c.chapter.title.replace(/^第\s*\d+\s*章\s*/, '')}</span>
                      <span className="ml-auto flex shrink-0 items-center gap-1.5">
                        {c.chapter.id === latestId && (
                          <span className="rounded border border-success/40 px-1 text-10 text-success">最新章</span>
                        )}
                        <span className="text-ink-500">{c.chapter.content ? `${c.chapter.wordCount} 字` : '空章'}</span>
                      </span>
                    </SelectRow>
                  )
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
