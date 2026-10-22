/** A1 · 正文编辑器内的章节资料抽屉。数据只读呈现，细纲编辑仍走原页面。 */
import { useState } from 'react'
import { BookOpen, FileText, Pin, PinOff, Search, Users, X } from 'lucide-react'
import type { RecordRef } from '@/lib/revision/revisionTypes'
import type { VisCtx } from '@/lib/schema'
import { getTab } from '@/lib/schema'
import { chapterContextRefKey, locateBodyQuote } from '@/lib/revision/chapterContext'
import type { RefName } from '@/components/editor/novelEditorHelpers'
import { Button } from '@/components/common/Button'
import { showToast } from '@/components/dialogs/dialogs'
import { runPlanCompareForChapter, describePlanCompareRun } from '@/lib/app/planCompareRun'
import type { PlanCompareReview } from '@/lib/aiTasks/planCompareAi'
import { Z } from '@/lib/app/zLayer'
import { foldZoomLength } from '@/lib/settings/theme'
import { useChapterContextData } from '@/components/editor/useChapterContextData'

interface Props {
  projectId: string
  chapterId: string
  chapterTitle: string
  chapterNo: number
  bodyText: string
  referenced: RefName[]
  ctx: VisCtx
  onClose: () => void
  onNavigate: (tabId: string) => void
  onOpenRecord: (ref: RecordRef) => void
}

function tabLabel(tabId: string): string {
  return getTab(tabId)?.name ?? tabId
}

export default function ChapterContextPanel({
  projectId, chapterId, chapterTitle, chapterNo, bodyText, referenced, ctx,
  onClose, onNavigate, onOpenRecord,
}: Props) {
  const [activeTab, setActiveTab] = useState<'outline' | 'materials' | 'quotes'>('outline')
  /** 3.2.1 · T-09：正文与细纲对照的即时结果（落档另存检查报告，这里只做当次展示） */
  const [planBusy, setPlanBusy] = useState(false)
  const [planReview, setPlanReview] = useState<PlanCompareReview | null>(null)
  const {
    binding, bindingLoaded, outlineCards, catalogLoaded, query, setQuery, loadingError,
    outline, groups, pinned, outlineSuggestions, results, pin, unpin, selectOutline,
  } = useChapterContextData({ projectId, chapterId, ctx })
  const outlineTab = getTab('chapter-outline')

  return (
    <section
      aria-label="本章资料"
      className="fixed right-3 top-14 bottom-10 w-72 max-w-[calc(100%-1.5rem)] bg-ink-850 border border-ink-700 rounded-xl shadow-2xl flex flex-col"
      style={{
        zIndex: Z.pageBase,
        top: foldZoomLength('3.5rem'),
        right: foldZoomLength('0.75rem'),
        bottom: foldZoomLength('2.5rem'),
        width: foldZoomLength('18rem'),
      }}
    >
      <header className="flex items-center gap-2 px-3 h-10 border-b border-ink-700 shrink-0">
        <BookOpen size={14} className="text-amber" />
        <span className="min-w-0 flex-1 text-12 font-semibold text-ink-200">本章资料</span>
        <span className="text-10 text-ink-500 truncate max-w-28" title={chapterTitle}>
          {chapterNo > 0 ? `第${chapterNo}章 · ` : ''}{chapterTitle}
        </span>
        <Button variant="icon-muted" onClick={onClose} className="p-1" title="收起"><X size={16} /></Button>
      </header>
      <nav className="flex border-b border-ink-700 px-2 pt-1 shrink-0" aria-label="章节资料类别">
        {([
          ['outline', '细纲'], ['materials', '关联资料'], ['quotes', '正文引用'],
        ] as const).map(([key, label]) => (
          <button key={key} type="button" onClick={() => setActiveTab(key)}
            className={`flex-1 px-1 py-2 text-11 border-b-2 transition-colors ${activeTab === key ? 'border-amber text-amber' : 'border-transparent text-ink-400 hover:text-ink-100'}`}>
            {label}
          </button>
        ))}
      </nav>
      {loadingError && <div role="status" className="px-3 py-1.5 text-10 text-danger">{loadingError}</div>}

      {activeTab === 'outline' && (
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          <div className="flex items-center gap-2">
            <label className="text-10 text-ink-400 shrink-0" htmlFor="chapter-outline-binding">绑定细纲</label>
            <select id="chapter-outline-binding" value={binding.outlineId ?? ''} onChange={e => selectOutline(e.target.value)}
              disabled={!bindingLoaded || !outlineTab}
              className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-11 text-ink-100">
              <option value="">未绑定</option>
              {outlineCards.map(card => <option key={card.id} value={card.id}>{card.name}</option>)}
            </select>
          </div>
          {outline ? (
            <>
              <div className="flex items-center justify-between gap-2 text-10 text-ink-500">
                <span className="truncate">资料来源：章节细纲 · {outline.name}</span>
                <button type="button" className="text-amber hover:text-amber/80 shrink-0" onClick={() => onOpenRecord({ kind: 'outline', projectId, tabId: 'chapter-outline', id: outline.id })}>打开原卡 →</button>
              </div>
              <div className="rounded-lg border border-ink-700/80 bg-ink-900/45 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-10 text-ink-300">正文与细纲对照</span>
                  <Button
                    variant="secondary"
                    size="xs"
                    disabled={planBusy}
                    onClick={async () => {
                      setPlanBusy(true)
                      try {
                        const r = await runPlanCompareForChapter({
                          projectId, chapterId, chapterNo, chapterTitle, bodyText, outline,
                        })
                        setPlanReview(r.review ?? null)
                        showToast(describePlanCompareRun(r), r.state === 'completed' ? 'success' : 'error')
                      } finally {
                        setPlanBusy(false)
                      }
                    }}
                  >
                    {planBusy ? '对照中…' : '开始核对'}
                  </Button>
                </div>
                <p className="mt-1 text-9 text-ink-500 leading-relaxed">
                  用本章细纲里已填的计划逐条对照正文，判定「已体现 / 部分体现 / 未找到体现 / 与计划不同 / 证据不足」。引文必须逐字来自正文，摘不出原句就判证据不足。
                </p>
                {planReview && (
                  <ul className="mt-1.5 space-y-1">
                    {planReview.items.map(it => {
                      const label = it.status === 'completed' ? '已体现'
                        : it.status === 'partial' ? '部分体现'
                          : it.status === 'not-found' ? '未找到体现'
                            : it.status === 'different' ? '与计划不同' : '证据不足'
                      const tone = it.status === 'completed' ? 'text-success'
                        : it.status === 'not-found' ? 'text-danger'
                          : it.status === 'different' ? 'text-amber'
                            : it.status === 'partial' ? 'text-amber' : 'text-ink-500'
                      return (
                        <li key={it.planFieldId} className="border-t border-ink-700/60 pt-1 text-10 leading-relaxed">
                          <span className={`${tone} mr-1`}>{label}</span>
                          <span className="text-ink-300">{it.planQuote.slice(0, 40)}{it.planQuote.length > 40 ? '…' : ''}</span>
                          <div className="text-9 text-ink-500">
                            {it.reason}
                            {it.bodyQuotes.length > 0 && (
                              <span className="ml-1 text-ink-400">· 正文依据：{it.bodyQuotes[0].slice(0, 30)}</span>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
              {groups.length ? groups.map((group, index) => (
                <div key={`${group.label}-${index}`} className="rounded-lg border border-ink-700/80 bg-ink-900/45 p-2">
                  <div className="text-10 font-medium text-amber/90 mb-1">{group.label}</div>
                  <dl className="space-y-2">
                    {group.values.map(item => <div key={item.label}>
                      <dt className="flex items-center gap-1.5 text-10 text-ink-500">
                        {item.label}
                        {item.purpose && <span className="rounded bg-amber/10 px-1 py-0.5 text-9 text-amber">{item.purpose}</span>}
                      </dt>
                      <dd className="text-11 text-ink-200 whitespace-pre-wrap break-words leading-relaxed">{item.value}</dd>
                    </div>)}
                  </dl>
                </div>
              )) : <p className="text-11 text-ink-500">这张细纲卡目前没有已填写的字段。</p>}
              {outlineSuggestions.length > 0 && (
                <div className="rounded-lg border border-ink-700 bg-ink-900/45 p-2 space-y-2">
                  <div className="text-10 font-medium text-ink-300">细纲中提到的登记资料</div>
                  <p className="text-9 text-ink-500 leading-relaxed">按名称、别称或编号做字面匹配。唯一匹配可直接固定；同名资料会列出候选供你选择。固定只方便本章查看，不会自动加入 AI 请求。</p>
                  {outlineSuggestions.map(suggestion => (
                    <div key={`${suggestion.fieldKey}|${suggestion.term}`} className="border-t border-ink-700/60 pt-1.5">
                      <div className="mb-1 text-9 text-ink-500">
                        <span className="text-ink-300">{suggestion.fieldLabel}</span>
                        {suggestion.purpose && <span className="ml-1 text-amber">· {suggestion.purpose}</span>}
                        <span className="ml-1">· 命中“{suggestion.term}”{suggestion.ambiguous ? '，同名多条，请选择' : '，唯一匹配'}</span>
                      </div>
                      <div className="space-y-1">
                        {suggestion.candidates.map(candidate => (
                          <button key={chapterContextRefKey(candidate.ref)} type="button"
                            disabled={!bindingLoaded || candidate.pinned} onClick={() => pin(candidate.ref)}
                            className="w-full flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-10 text-ink-300 hover:bg-ink-800 disabled:cursor-default disabled:opacity-60">
                            <Pin size={11} className="text-amber shrink-0" />
                            <span className="min-w-0 flex-1 truncate">{candidate.pinned ? '已固定：' : '固定：'}{candidate.name} · {candidate.source}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="rounded-lg border border-dashed border-ink-700 p-3 text-11 text-ink-500 leading-relaxed">
              {binding.outlineId ? '绑定的细纲卡已失效，请重新选择。' : '尚未绑定细纲。手动选择可避免同名章节或重复章号误绑。'}
              <div className="mt-2">
                <Button variant="secondary" size="xs" onClick={() => onNavigate('chapter-outline')}>
                  <FileText size={12} className="mr-1" />前往章节细纲
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'materials' && (
        <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-3">
          <div className="relative">
            <Search size={13} className="absolute left-2 top-2 text-ink-500" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索角色、设定、伏笔等资料"
              className="w-full rounded border border-ink-700 bg-ink-900 pl-7 pr-2 py-1.5 text-11 text-ink-100 outline-none focus:border-amber/50" />
          </div>
          {query.trim() && (catalogLoaded ? results.length ? results.map(item => (
            <button key={chapterContextRefKey(item.ref)} type="button" disabled={!bindingLoaded} onClick={() => pin(item.ref)}
              className="w-full text-left rounded-lg px-2 py-1.5 hover:bg-ink-800 flex items-center gap-2">
              <Pin size={12} className="text-amber shrink-0" />
              <span className="min-w-0 flex-1"><span className="block truncate text-11 text-ink-100">{item.name}</span><span className="block truncate text-10 text-ink-500">{item.source}{item.value ? ` · ${item.value}` : ''}</span></span>
              <span className="text-10 text-amber">固定</span>
            </button>
          )) : <p className="px-2 py-1 text-10 text-ink-500">没有找到可固定的资料。</p> : <p className="px-2 py-1 text-10 text-ink-500">正在读取资料…</p>)}
          <div>
            <div className="px-1 py-1 text-10 text-ink-500">固定资料 · {pinned.length}</div>
            {pinned.length === 0 ? <p className="px-2 py-2 text-11 text-ink-500">暂时没有固定资料。固定只方便本章查看，不会自动加入 AI 请求。</p> : pinned.map(({ ref, item, unavailable }) => (
              <div key={chapterContextRefKey(ref)} className="rounded-lg px-2 py-1.5 hover:bg-ink-800 flex items-start gap-2">
                <Users size={12} className="text-amber mt-0.5 shrink-0" />
                <button type="button" disabled={!item} onClick={() => onOpenRecord(ref)} className="text-left min-w-0 flex-1 disabled:cursor-default">
                  <span className="block truncate text-11 text-ink-100">{item?.name ?? ref.id}</span>
                  <span className="block text-10 text-ink-500">{item ? `${item.source}${item.value ? ` · ${item.value}` : ''}` : unavailable}</span>
                </button>
                <button type="button" disabled={!bindingLoaded} onClick={() => unpin(ref)} className="text-ink-500 hover:text-danger p-0.5 disabled:opacity-40" title="移除固定资料"><PinOff size={12} /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'quotes' && (
        <div className="flex-1 overflow-y-auto p-2">
          <p className="px-1 pb-2 text-10 text-ink-500">正文命中已登记的资料名称；“正文提及”只表示文本命中，不代表作者指定了出场安排。</p>
          {referenced.length === 0 ? <p className="p-3 text-11 text-ink-500">当前正文没有命中已登记的角色或世界设定。</p> : referenced.map((item, index) => {
            const quote = locateBodyQuote(item.name, bodyText)
            return <button key={`${chapterContextRefKey(item.ref)}|${item.name}|${index}`} type="button" onClick={() => onOpenRecord(item.ref)}
              className="w-full rounded-lg px-2 py-1.5 text-left hover:bg-ink-800 flex items-start gap-2">
              <FileText size={12} className="text-amber mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1"><span className="block truncate text-11 text-ink-100">{item.name}{item.aliasOf ? `（${item.aliasOf}的别称）` : ''}</span>
                <span className="block text-10 text-ink-500">正文提及 · {tabLabel(item.tabId)}{quote.located ? ` · 第 ${quote.paragraphIndex + 1} 段` : ''}</span></span>
              <span className="text-9 text-ink-500">→</span>
            </button>
          })}
        </div>
      )}

      <footer className="px-3 py-2 border-t border-ink-700 text-10 text-ink-500 leading-relaxed shrink-0">
        切换章节会刷新这里的资料，正文草稿与光标保持在编辑区。
      </footer>
    </section>
  )
}
