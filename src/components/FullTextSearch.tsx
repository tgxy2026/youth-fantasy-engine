/**
 * 统一全文检索命令面板（v1.3 新增 · P0）
 * 覆盖 章节正文 / 角色卡 / 设定表 三类文档，Ctrl/Cmd+K 唤起。
 * 结果按类型分组，键盘上下选择、回车跳转；章节跳正文，角色/设定跳对应页签。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Search, FileText, Users, BookMarked, CornerDownLeft, Hash, X } from 'lucide-react'
import { SearchEngine, SEARCH_TYPE_LABEL, type SearchDocType, type SearchResult } from '../lib/search'
import HelpPopover from './HelpPopover'
import { tabVisible, type VisCtx } from '../lib/schema'

interface Props {
  onClose: () => void
  /** 打开某章节正文 */
  onOpenChapter: (chapterId: string) => void
  /** 跳转到某设定/角色页签 */
  onNavigateTab: (tabId: string) => void
  /** 可见性上下文；精简 / 极简项目下被隐藏的页签数据不纳入检索，自定义项目按启用功能集过滤 */
  ctx: VisCtx
}

const TYPE_ORDER: SearchDocType[] = ['chapter', 'character', 'setting']
const TYPE_ICON: Record<SearchDocType, typeof FileText> = {
  chapter: FileText,
  character: Users,
  setting: BookMarked,
}

export default function FullTextSearch({ onClose, onOpenChapter, onNavigateTab, ctx }: Props) {
  const [engine] = useState(() => new SearchEngine())
  const [ready, setReady] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    engine.build(ctx).then(() => setReady(true))
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [engine, ctx])

  useEffect(() => {
    setResults(engine.search(query))
    setSel(0)
  }, [query, engine, ready])

  const groups = useMemo(() => {
    const g: Record<SearchDocType, SearchResult[]> = { chapter: [], character: [], setting: [] }
    for (const r of results) g[r.type].push(r)
    return g
  }, [results])

  const flat = useMemo(() => TYPE_ORDER.flatMap(t => groups[t]), [groups])

  const open = (r: SearchResult) => {
    if (r.type === 'chapter' && r.chapterId) onOpenChapter(r.chapterId)
    else if (r.tabId) onNavigateTab(r.tabId)
    onClose()
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(flat.length - 1, s + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (flat[sel]) open(flat[sel]) }
  }

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  let runningIdx = -1

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-start justify-center bg-black/60 pt-[12vh] px-4"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-2xl bg-ink-850 border border-ink-700 rounded-xl shadow-2xl overflow-hidden"
        onMouseDown={e => e.stopPropagation()}
        onKeyDown={onKey}
      >
        {/* 搜索框 */}
        <div className="flex items-center gap-2 px-4 h-12 border-b border-ink-700">
          <Search size={15} className="text-amber shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜全书：章节正文 / 角色名 / 设定（名词、地名、伏笔…）"
            className="flex-1 !bg-transparent !border-0 !px-0 text-[14px] text-ink-50 focus:!outline-none"
          />
          {!ready && <span className="text-[11px] text-ink-500 shrink-0">建索引…</span>}
          <HelpPopover title="全文检索怎么用" width="24rem" size={13} className="shrink-0">
            {'全书级检索：章节正文、角色卡、全部设定表（国家/地理/术语/伏笔/关系…）一次搜尽。\n\n· Ctrl/Cmd + K 随时唤起；\n· 输入即出结果，按 章节 / 角色 / 设定 分组；\n· ↑ ↓ 选择，回车跳转：章节直达正文编辑，角色/设定直达所在页签；\n· Esc 关闭。\n\n中文按词/字切分，英文按单词；标题命中优先置顶。'}
          </HelpPopover>
          <button onClick={onClose} className="p-1 text-ink-500 hover:text-ink-200 transition-colors shrink-0" title="关闭"><X size={16} /></button>
        </div>

        {/* 结果 */}
        <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-2">
          {query.trim() && flat.length === 0 && (
            <div className="text-center text-ink-500 text-[12px] py-10">
              {ready ? `没有匹配「${query.trim()}」的内容` : '索引构建中…'}
            </div>
          )}
          {!query.trim() && (
            <div className="text-center text-ink-500 text-[12px] py-10">
              输入关键词，搜遍全书正文与设定
            </div>
          )}
          {TYPE_ORDER.map(type => {
            const items = groups[type]
            if (items.length === 0) return null
            const Icon = TYPE_ICON[type]
            return (
              <div key={type} className="mb-1">
                <div className="flex items-center gap-1.5 px-4 py-1 text-[10px] text-ink-500 sticky top-0 bg-ink-850/95">
                  <Icon size={11} className="text-amber/70" />
                  {SEARCH_TYPE_LABEL[type]} · {items.length}
                </div>
                {items.map(r => {
                  runningIdx++
                  const idx = runningIdx
                  const active = idx === sel
                  return (
                    <button
                      key={r.id}
                      data-idx={idx}
                      onMouseEnter={() => setSel(idx)}
                      onClick={() => open(r)}
                      className={`w-full text-left px-4 py-2 flex items-start gap-2.5 transition-colors
                        ${active ? 'bg-amber/10' : 'hover:bg-ink-800/60'}`}
                    >
                      <span className={`mt-0.5 text-[10px] px-1.5 py-px rounded shrink-0 border
                        ${type === 'chapter' ? 'border-sky-400/30 text-sky-300' : type === 'character' ? 'border-violet-400/30 text-violet-300' : 'border-emerald-400/30 text-emerald-300'}`}>
                        {r.source}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="text-[13px] text-ink-100 font-medium truncate block">{r.title}</span>
                        <span className="text-[11px] text-ink-500 line-clamp-1 block">{r.snippet || '（无正文摘要）'}</span>
                      </span>
                      <CornerDownLeft size={12} className={`mt-1 shrink-0 ${active ? 'text-amber' : 'text-ink-700'}`} />
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>

        {/* 底部提示 */}
        <div className="flex items-center gap-3 px-4 h-9 border-t border-ink-700 text-[10px] text-ink-600 bg-ink-900/60">
          <span className="flex items-center gap-1"><Hash size={10} />{flat.length} 条结果</span>
          <span className="flex-1" />
          <span>↑↓ 选择 · 回车打开 · Esc 关闭</span>
        </div>
      </div>
    </div>,
    document.body
  )
}
