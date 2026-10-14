/**
 * 章节选择树（卷 / 章 · 可折叠 + 可搜索）
 *
 * 用途：「本章体检」「节奏与章末钩子」这类**先挑一章再操作**的面板，替代原生 `<select>`。
 *
 * 🔴🔴 顺序**只能**来自 `lib/outline/chapterSeq`（卷序 → 章序）。
 *    `Chapter.order` 是**卷内**序号：卷二第 1 章的 order 同样是 0
 *    ⇒ `[...chs].sort((a, b) => a.order - b.order)` 会**跨卷串号**，
 *    症状正是主人 2026-10-14 报的「第1章下面接着第11章、再下面第21章」。
 *    `chapterSeq.ts` 顶部与 `sortChapters()` 的注释里早写明这条禁令 —— 这里照办，别再裸排。
 *
 * 视觉刻意与 `NovelEditorChapterTree`（正文编辑页左栏）同款：卷头一行 + 章节缩进一级，
 * 两处的「卷 / 章」观感保持一致。
 */
import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Inbox, Search } from 'lucide-react'
import type { Chapter, Volume } from '@/lib/types'
import { chapterSeqMap } from '@/lib/outline/chapterSeq'
import { isFreeVolume } from '@/lib/outline/freeVolume'

interface Props {
  volumes: Volume[]
  chapters: Chapter[]
  /** 当前选中的章节 id（空串＝未选） */
  value: string
  onChange: (id: string) => void
  /** 树区最大高度类。默认 `max-h-56`；外层已限高时传更小的档 */
  listClass?: string
}

/** 卷内章节按 order 排序是正确的（order 就是卷内序号）；跨卷才必须靠卷序 */
const byOrder = (a: Chapter, b: Chapter) => a.order - b.order

export default function ChapterTreeSelect({ volumes, chapters, value, onChange, listClass }: Props) {
  const [q, setQ] = useState('')
  /** 折叠的卷 id 集合（默认全展开 —— 体检时大多数人是"扫一眼再点") */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const seqMap = useMemo(() => chapterSeqMap(volumes, chapters), [volumes, chapters])

  const orderedVols = useMemo(
    () => [...volumes].sort((a, b) => a.order - b.order),
    [volumes],
  )

  /** 卷 id → 该卷章节（卷内按 order 排） */
  const byVol = useMemo(() => {
    const m = new Map<string, Chapter[]>()
    for (const v of volumes) m.set(v.id, [])
    for (const c of chapters) {
      const arr = m.get(c.volumeId)
      if (arr) arr.push(c)
    }
    for (const arr of m.values()) arr.sort(byOrder)
    return m
  }, [volumes, chapters])

  /** 孤儿章（volumeId 找不到对应卷）—— 不静默吞掉，单独兜底一组 */
  const orphans = useMemo(() => {
    const ids = new Set(volumes.map(v => v.id))
    return chapters.filter(c => !ids.has(c.volumeId)).sort(byOrder)
  }, [volumes, chapters])

  const keyword = q.trim().toLowerCase()
  const hit = (c: Chapter) => {
    if (!keyword) return true
    const seq = seqMap.get(c.id) ?? 0
    return (c.title || '').toLowerCase().includes(keyword)
      || String(seq) === keyword
      || (seq > 0 && `第${seq}章`.includes(keyword))
  }

  const sel = chapters.find(c => c.id === value) ?? null
  /** 标题里已写「第N章」就不再补前缀（多数作者的章名自带号，硬补会成「第1章 第1章 废脉」） */
  const selSeq = sel ? (seqMap.get(sel.id) ?? 0) : 0
  const selLabel = sel
    ? (selSeq > 0 && !new RegExp(`^第\\s*${selSeq}\\s*章`).test(sel.title || '')
      ? `第${selSeq}章 ${sel.title || ''}`.trim()
      : (sel.title || '（未命名）'))
    : ''

  if (chapters.length === 0) {
    return <div className="text-11 text-ink-500">这个项目还没有章节。</div>
  }

  /**
   * 一个可折叠分组（卷 / 兜底组）。
   * `forceOpen` 用于搜索态：有命中就必须看得见，不能因用户之前折了它而藏结果。
   */
  const group = (key: string, title: string, list: Chapter[], opts?: { free?: boolean; forceOpen?: boolean }) => {
    const shown = list.filter(hit)
    if (keyword && shown.length === 0) return null
    const open = opts?.forceOpen || !collapsed.has(key)
    return (
      <div key={key} className="mb-0.5">
        <div
          data-volume-id={key}
          onClick={() => setCollapsed(prev => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key); else next.add(key)
            return next
          })}
          className="group flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1.5 transition-colors hover:bg-ink-800"
          title={open ? '收起本卷' : '展开本卷'}
        >
          {open ? <ChevronDown size={12} className="shrink-0 text-ink-500" /> : <ChevronRight size={12} className="shrink-0 text-ink-500" />}
          {opts?.free && <Inbox size={11} className="shrink-0 text-ink-500" />}
          <span className={`min-w-0 flex-1 truncate text-12 font-semibold ${opts?.free ? 'text-ink-400' : 'text-ink-100'}`}>{title}</span>
          <span className="shrink-0 text-9 text-ink-600">
            {keyword ? `${shown.length}/${list.length}` : list.length}章
          </span>
        </div>
        {open && (
          <div className="ml-3 mt-0.5 space-y-0.5 border-l border-ink-700 pl-1">
            {shown.map(c => {
              const isActive = value === c.id
              const seq = seqMap.get(c.id) ?? 0
              return (
                <button
                  type="button"
                  key={c.id}
                  data-chapter-id={c.id}
                  onClick={() => onChange(c.id)}
                  aria-current={isActive || undefined}
                  className={`flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left transition-colors
                    ${isActive ? 'bg-amber/15 text-amber' : 'text-ink-300 hover:bg-ink-800'}`}
                >
                  <span className={`w-6 shrink-0 text-right text-10 tabular-nums ${isActive ? 'text-amber/80' : 'text-ink-600'}`}>
                    {seq > 0 ? seq : '·'}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-11" title={c.title || '（未命名）'}>
                    {c.title || '（未命名）'}
                  </span>
                  {c.excludeFromNumbering && <span className="shrink-0 text-9 text-ink-600">不计号</span>}
                </button>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  const nothingHit = keyword
    && orderedVols.every(v => (byVol.get(v.id) ?? []).filter(hit).length === 0)
    && orphans.filter(hit).length === 0

  return (
    <div data-chapter-tree className="space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={11} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-500" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="搜索章节（标题或序号）"
            aria-label="搜索章节"
            className="w-full rounded border border-ink-700 bg-ink-950 py-1 pl-6 pr-2 text-11 text-ink-200 outline-none placeholder:text-ink-600 focus:border-amber"
          />
        </div>
        {sel && (
          <span className="shrink-0 text-10 text-ink-400">
            当前：<b className="text-ink-200">{selLabel}</b>
          </span>
        )}
      </div>

      <div className={`rounded border border-ink-700 bg-ink-950/60 p-1 ${listClass ?? 'max-h-56'} overflow-y-auto`}>
        {orderedVols.map(v => group(
          v.id,
          v.title || '（未命名卷）',
          byVol.get(v.id) ?? [],
          { free: isFreeVolume(v), forceOpen: !!keyword },
        ))}
        {orphans.length > 0 && group('__orphan__', '未归类章节', orphans, { forceOpen: !!keyword })}
        {nothingHit && (
          <div className="px-2 py-3 text-center text-11 text-ink-500">没有匹配「{q.trim()}」的章节</div>
        )}
      </div>
    </div>
  )
}
