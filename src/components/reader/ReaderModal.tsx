/**
 * 沉浸式阅读模式（3.7.5 · Q-03）
 *
 * 【为什么要有】此前作者只能在正文编辑器里"看"自己的书 —— 那里是写作界面（工具条、高亮、
 * 草稿态），没有一处能安静往下读。这里补一个**只读**的小说阅读器：左侧卷章、右侧正文，
 * 滚轮往下读，一章读完自动接下一章。
 *
 * 🔴 三条边界（主人明确要求）：
 *   ① **只读**：不写库、不动草稿、不 touchProject；正文按纯文本分段渲染（编辑器本身也是纯文本，
 *      不是 HTML，所以不存在富文本注入问题）。
 *   ② **弹窗形态**：复用 `Modal` 的大尺寸档，不进路由 —— 关掉就回到原来的页签，不打断写作上下文。
 *   ③ **进度只存本机**：`yfe-ui:reader:<项目id>`（章 id + 滚动比例），走 uiPrefs 的命名空间，
 *      不进项目数据、不参与云同步（换台机器重新翻一次即可）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, ChevronLeft, ChevronRight } from 'lucide-react'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import { getChaptersFor, getVolumesFor } from '@/lib/db'
import { readTextPref, writeTextPref } from '@/lib/settings/uiPrefs'
import type { Chapter, Volume } from '@/lib/types'

interface Props {
  open: boolean
  onClose: () => void
  projectId: string
  projectName: string
  /** 从正文页进来时，直接落在当前这一章 */
  initialChapterId?: string | null
}

interface VolumeGroup {
  id: string
  title: string
  chapters: Chapter[]
}

const progressKey = (projectId: string) => `reader:${projectId}`

/** 读上次进度：`{ c: 章id, r: 滚动比例 0-1 }`；格式不对就当没有 */
function readProgress(projectId: string): { c?: string; r?: number } {
  const raw = readTextPref(progressKey(projectId))
  if (!raw) return {}
  try {
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object') return {}
    const o = v as { c?: unknown; r?: unknown }
    return {
      ...(typeof o.c === 'string' ? { c: o.c } : {}),
      ...(typeof o.r === 'number' && Number.isFinite(o.r) ? { r: Math.min(1, Math.max(0, o.r)) } : {}),
    }
  } catch {
    return {}
  }
}

function saveProgress(projectId: string, chapterId: string, ratio: number) {
  writeTextPref(progressKey(projectId), JSON.stringify({ c: chapterId, r: Math.round(Math.min(1, Math.max(0, ratio)) * 1000) / 1000 }))
}

/** 正文按空行分段（纯文本）；段内换行保留 */
function toParagraphs(content: string): string[] {
  return content
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
}

export default function ReaderModal({ open, onClose, projectId, projectName, initialChapterId }: Props) {
  const [volumes, setVolumes] = useState<Volume[]>([])
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [activeId, setActiveId] = useState<string>('')
  const [loaded, setLoaded] = useState(false)
  const [atEnd, setAtEnd] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const dwellRef = useRef<number | null>(null)
  const savedRef = useRef(0)

  /** 载入卷章（只读；不改任何数据） */
  useEffect(() => {
    if (!open || !projectId) return
    let cancelled = false
    setLoaded(false)
    // 🔴 必须按 pid 读：首页打开阅读器时没有"当前项目"，getAllVolumes/getAllChapters 会按空 pid 过滤成空
    void Promise.all([getVolumesFor(projectId), getChaptersFor(projectId)])
      .then(([vs, cs]) => {
        if (cancelled) return
        setVolumes(vs)
        setChapters(cs)
        setLoaded(true)
      })
      .catch(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [open, projectId])

  /** 卷 → 章分组（未归卷的章节归到「自由章节」，排最后） */
  const groups = useMemo<VolumeGroup[]>(() => {
    const byVolume = new Map<string, Chapter[]>()
    for (const c of chapters) {
      const list = byVolume.get(c.volumeId) ?? []
      list.push(c)
      byVolume.set(c.volumeId, list)
    }
    const out: VolumeGroup[] = []
    for (const v of volumes) {
      const list = (byVolume.get(v.id) ?? []).sort((a, b) => a.order - b.order)
      if (list.length) out.push({ id: v.id, title: v.title || '未命名卷', chapters: list })
      byVolume.delete(v.id)
    }
    const orphans = chapters
      .filter(c => byVolume.has(c.volumeId))
      .sort((a, b) => a.order - b.order)
    if (orphans.length) out.push({ id: '__free__', title: '自由章节', chapters: orphans })
    return out
  }, [volumes, chapters])

  const flat = useMemo(() => groups.flatMap(g => g.chapters), [groups])
  const index = flat.findIndex(c => c.id === activeId)
  const current = index >= 0 ? flat[index] : null
  const prev = index > 0 ? flat[index - 1] : null
  const next = index >= 0 && index < flat.length - 1 ? flat[index + 1] : null

  /** 打开时定章节：显式指定 > 上次进度 > 第一章 */
  useEffect(() => {
    if (!open || !loaded || flat.length === 0) return
    if (activeId && flat.some(c => c.id === activeId)) return
    const saved = readProgress(projectId).c
    const fallback = initialChapterId && flat.some(c => c.id === initialChapterId)
      ? initialChapterId
      : saved && flat.some(c => c.id === saved) ? saved : flat[0].id
    setActiveId(fallback)
  }, [open, loaded, flat, activeId, projectId, initialChapterId])

  /** 换章：正文回到顶部，并按进度恢复上次位置（仅当回到的是上次那章） */
  useEffect(() => {
    const el = bodyRef.current
    if (!el || !current) return
    const { c, r } = readProgress(projectId)
    const ratio = c === current.id && typeof r === 'number' ? r : 0
    el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * ratio)
    setAtEnd(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, current?.id, projectId])

  const go = useCallback((target: Chapter | null) => {
    if (target) setActiveId(target.id)
  }, [])

  /** 记进度（滚动节流 500ms + 关窗时补一次） */
  const recordProgress = useCallback((el: HTMLDivElement) => {
    if (!current) return
    const now = Date.now()
    if (now - savedRef.current < 500) return
    savedRef.current = now
    const max = el.scrollHeight - el.clientHeight
    const ratio = max > 0 ? el.scrollTop / max : 0
    saveProgress(projectId, current.id, ratio)
  }, [current, projectId])

  /**
   * 一章读完自动跳下一章。
   * 🔴 必须"停留 300ms"再跳：触控板惯性滚动会一路滑到底，立刻切章等于替作者翻页。
   *    滚回上面 / 换章都要清掉计时器。
   */
  const onScroll = () => {
    const el = bodyRef.current
    if (!el || !current) return
    recordProgress(el)
    const bottom = el.scrollHeight - el.clientHeight - el.scrollTop < 24
    if (!bottom) {
      if (dwellRef.current) { window.clearTimeout(dwellRef.current); dwellRef.current = null }
      if (atEnd) setAtEnd(false)
      return
    }
    if (next && !dwellRef.current) {
      dwellRef.current = window.setTimeout(() => {
        dwellRef.current = null
        setActiveId(next.id)
      }, 300)
    } else if (!next && !atEnd) {
      setAtEnd(true)
    }
  }

  useEffect(() => () => { if (dwellRef.current) window.clearTimeout(dwellRef.current) }, [])

  const progressText = flat.length ? `${index + 1} / ${flat.length}` : ''
  const paragraphs = current ? toParagraphs(current.content) : []

  return (
    // bodyClassName 三项缺一不可：去掉内边距（两栏自排）、去掉滚动（正文自己滚）、
    // 去掉 min-h-0 会让 body 被内容撑高、只剩面板溢出，左右 flex-1 与滚轮一起失效。
    <Modal
      open={open}
      onClose={() => {
        const el = bodyRef.current
        if (el && current) {
          const max = el.scrollHeight - el.clientHeight
          saveProgress(projectId, current.id, max > 0 ? el.scrollTop / max : 0)
        }
        onClose()
      }}
      width={1120}
      maxHeight="92vh"
      hideHeader
      ariaLabel={`阅读模式 · ${projectName}`}
      bodyClassName="!p-0 !overflow-hidden !min-h-0 flex"
    >
        {/* 左：卷章目录（只读） */}
        <aside className="w-56 shrink-0 border-r border-ink-700/70 flex flex-col min-h-0 bg-ink-900/40">
          <div className="flex items-center gap-2 px-3 h-11 border-b border-ink-700/60 shrink-0">
            <BookOpen size={13} className="text-amber shrink-0" />
            <span className="text-12 font-medium text-ink-100 truncate" title={projectName}>{projectName}</span>
            <span className="ml-auto text-10 text-ink-500 ws-num shrink-0">{progressText}</span>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto py-1.5">
            {!loaded && <div className="px-3 py-3 text-11 text-ink-500">正在读取章节…</div>}
            {loaded && flat.length === 0 && <div className="px-3 py-3 text-11 text-ink-500">这本书还没有章节。</div>}
            {groups.map(group => (
              <div key={group.id} className="mb-1.5">
                <div className="px-3 py-1 text-10 text-ink-500 sticky top-0 bg-ink-900/85 backdrop-blur-sm">{group.title}</div>
                {group.chapters.map(c => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => go(c)}
                    className={`w-full text-left px-3 py-1.5 text-12 truncate transition-colors ${c.id === activeId ? 'bg-amber/15 text-amber' : 'text-ink-300 hover:bg-ink-800/60 hover:text-ink-100'}`}
                    title={c.title}
                  >
                    {c.title || '未命名章节'}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="shrink-0 border-t border-ink-700/60 px-2 py-2 flex items-center gap-1.5">
            <Button variant="secondary" size="sm" onClick={() => go(prev)} disabled={!prev} className="flex-1 justify-center" title="上一章">
              <ChevronLeft size={13} /> 上一章
            </Button>
            <Button variant="secondary" size="sm" onClick={() => go(next)} disabled={!next} className="flex-1 justify-center" title="下一章">
              下一章 <ChevronRight size={13} />
            </Button>
          </div>
        </aside>

        {/* 右：正文（只读） */}
        <section className="flex-1 min-w-0 min-h-0 flex flex-col">
          <div className="h-11 shrink-0 border-b border-ink-700/60 flex items-center gap-2 px-4">
            <span className="text-12 text-ink-200 truncate">{current?.title || '—'}</span>
            <span className="ml-auto text-10 text-ink-500 shrink-0">只读 · 滚轮向下阅读，本章读完自动接下一章</span>
            <Button variant="secondary" size="sm" onClick={onClose} className="shrink-0">关闭</Button>
          </div>
          <div
            ref={bodyRef}
            onScroll={onScroll}
            data-reader-body
            className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-6 py-8"
          >
            <article className="mx-auto w-full max-w-[44rem]">
              <h1 className="text-18 font-semibold text-ink-50 mb-6">{current?.title || ''}</h1>
              {paragraphs.length === 0 && (
                <p className="text-13 text-ink-500">这一章还没有正文。</p>
              )}
              {paragraphs.map((p, i) => (
                <p key={i} className="mb-4 text-14 leading-[2] text-ink-200 whitespace-pre-line">{p}</p>
              ))}
              {current && (
                <div className="mt-10 pt-4 border-t border-ink-700/50 text-11 text-ink-500">
                  {next ? '本章读完会自动翻到下一章；也可以点右下「下一章」。' : (atEnd ? '已经是最后一章了。' : '这是最后一章。')}
                </div>
              )}
            </article>
          </div>
        </section>
    </Modal>
  )
}
