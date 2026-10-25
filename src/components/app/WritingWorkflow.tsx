import { useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, BookOpen, ChevronDown, ChevronRight, Compass, FileText, History } from 'lucide-react'
import Panel from '@/components/common/Panel'
import { Button } from '@/components/common/Button'
import type { CardRecord, Chapter, TableRow, Volume } from '@/lib/types'
import type { VisCtx } from '@/lib/schema'
import { tabVisible, getTab } from '@/lib/schema'
import { readSetPref, readStringPref, writeSetPref, writeStringPref, usePersistedBool } from '@/lib/settings/uiPrefs'
import { showToast } from '@/components/dialogs/dialogs'
import { humanAgo } from '@/lib/outline/chapterAudit'
import { chapterStatusMismatch } from '@/lib/app/chapterBoardView'

interface Props {
  projectId: string
  chapters: Chapter[]
  chapterOutlines: CardRecord[]
  volumes: Volume[]
  ideas: TableRow[]
  foreshadows: TableRow[]
  ctx: VisCtx
  onNavigate: (id: string, chapterId?: string) => void
  onExport: () => void | Promise<void>
  /** The dashboard owns its metrics; this slot places them ahead of optional planning panels. */
  summary?: ReactNode
}

const finished = new Set<Chapter['status']>(['完稿', '已发布'])

export default function WritingWorkflow({ projectId, chapters, chapterOutlines, volumes, ideas, foreshadows, ctx, onNavigate, onExport, summary }: Props) {
  const [guideHidden, setGuideHidden] = usePersistedBool(`writing-guide-hidden:${projectId}`, chapters.length > 0)
  const [ignored, setIgnored] = useState<Set<string>>(() => new Set(readSetPref(`writing-next-ignored:${projectId}`) ?? []))
  const [snoozed, setSnoozed] = useState<Record<string, number>>(() => {
    try {
      const value: unknown = JSON.parse(readStringPref(`writing-next-snoozed:${projectId}`) || '{}')
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, number> : {}
    }
    catch { return {} }
  })
  const [boardOpen, setBoardOpen] = useState(false)
  const [boardView, setBoardView] = useState<'chapters' | 'outlines'>('chapters')
  const [chapterLimit, setChapterLimit] = useState(60)
  const [outlineLimit, setOutlineLimit] = useState(60)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [volumeId, setVolumeId] = useState('all')

  const visible = (id: string) => {
    const tab = getTab(id)
    return !tab || tabVisible(tab.id, ctx)
  }
  const { recent, recentSource } = useMemo(() => {
    const lastOpened = readStringPref(`editor-last-chapter:${projectId}`)
    const opened = chapters.find(c => c.id === lastOpened)
    return { recent: opened ?? [...chapters].sort((a, b) => b.updatedAt - a.updatedAt)[0], recentSource: opened ? '最近打开' : '最近更新' }
  }, [chapters, projectId])
  const recentVolume = volumes.find(v => v.id === recent?.volumeId)
  const recentTimestamp = recent && Number.isFinite(recent.updatedAt) && recent.updatedAt > 0 ? recent.updatedAt : null
  const unfinished = useMemo(() => [...chapters].filter(c => !finished.has(c.status)).sort((a, b) => b.updatedAt - a.updatedAt)[0], [chapters])
  const unusedIdeas = ideas.filter(r => r.data['状态'] === '未用').length
  const openForeshadows = foreshadows.filter(r => r.data['状态'] === '未回收').length

  const items = [
    ...(chapters.length === 0 ? [{ key: 'create', title: '建立第一章', detail: '项目还没有章节', tab: 'editor', chapterId: undefined }] : []),
    ...(unfinished ? [{ key: `chapter:${unfinished.id}`, title: `继续「${unfinished.title || '未命名章'}」`, detail: `${unfinished.status} · ${unfinished.wordCount} 字`, tab: 'editor', chapterId: unfinished.id }] : []),
    ...(unusedIdeas > 0 && visible('ideas') ? [{ key: 'ideas', title: `查看 ${unusedIdeas} 条未用灵感`, detail: '来自灵感素材', tab: 'ideas', chapterId: undefined }] : []),
    ...(openForeshadows > 0 && visible('foreshadow') ? [{ key: 'foreshadow', title: `点检 ${openForeshadows} 条未回收伏笔`, detail: '来自伏笔追踪', tab: 'foreshadow', chapterId: undefined }] : []),
  ].filter(i => i.key !== 'create' && i.key !== `chapter:${recent?.id}` && !ignored.has(i.key) && !(snoozed[i.key] > Date.now()))

  const dismiss = (key: string) => {
    const next = new Set(ignored)
    next.add(key)
    setIgnored(next)
    writeSetPref(`writing-next-ignored:${projectId}`, next)
  }
  const postpone = (key: string) => {
    const next = { ...snoozed, [key]: Date.now() + 24 * 60 * 60 * 1000 }
    setSnoozed(next)
    writeStringPref(`writing-next-snoozed:${projectId}`, JSON.stringify(next))
  }
  const resetIgnored = () => {
    setIgnored(new Set())
    writeSetPref(`writing-next-ignored:${projectId}`, [])
    setSnoozed({})
    writeStringPref(`writing-next-snoozed:${projectId}`, '{}')
  }
  const exportBackup = async () => {
    try { await onExport(); showToast('项目备份已导出', 'success') }
    catch (e) { showToast(`导出备份失败：${e instanceof Error ? e.message : String(e)}`, 'error') }
  }

  const filtered = useMemo(() => chapters.filter(c => {
    if (volumeId !== 'all' && c.volumeId !== volumeId) return false
    if (status !== 'all' && c.status !== status) return false
    const text = `${c.title} ${c.summary}`.toLowerCase()
    return text.includes(query.trim().toLowerCase())
  }), [chapters, query, status, volumeId])
  const shown = useMemo(() => {
    const volumeOrder = new Map(volumes.map(v => [v.id, v.order]))
    return [...filtered].sort((a, b) => (volumeOrder.get(a.volumeId) ?? Number.MAX_SAFE_INTEGER) - (volumeOrder.get(b.volumeId) ?? Number.MAX_SAFE_INTEGER) || a.order - b.order)
      .slice(0, chapterLimit)
  }, [filtered, volumes, chapterLimit])
  const groups = useMemo(() => {
    const sortedVolumes = [...volumes].sort((a, b) => a.order - b.order)
    return sortedVolumes.map(v => ({ volume: v, chapters: shown.filter(c => c.volumeId === v.id) }))
      .filter(g => g.chapters.length > 0)
  }, [shown, volumes])
  // 「状态与正文对不上」的章数 —— 只数**实际渲染出来的卡片**（与逐条 ⚠ 严格一致）
  const mismatchCount = useMemo(
    () => groups.reduce((n, g) => n + g.chapters.filter(c => chapterStatusMismatch(c)).length, 0),
    [groups],
  )

  return (
    <div className="space-y-4 mb-6">
      <Panel className="border-amber/25" aria-labelledby="continue-writing-title" data-continue-writing>
        {/* 🔴 快捷钮跟标题走、不贴行末（主人 2026-10-17 要求）：去掉 justify-between，
            钮紧随 h2（gap-2）；窗口不够时 flex-wrap 让它整条落到下一行，也不挤成一条缝。 */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <h2 id="continue-writing-title" className="text-14 font-semibold text-content-primary flex items-center gap-2"><Compass size={16} className="text-amber" /> 继续创作</h2>
          <Button variant="primary" size="sm" onClick={() => onNavigate('editor', recent?.id)} aria-label={recent ? `继续写作：${recent.title || '未命名章'}` : '进入正文编辑，建立第一章'}>
            {recent ? '继续写作' : '开始建立章节'} <ChevronRight size={14} />
          </Button>
        </div>
        {recent ? <div className="mb-4 min-w-0" data-continue-target={recent.id}>
          <p className="text-12 text-content-muted [overflow-wrap:anywhere]">{recentSource}{recentVolume?.title ? ` · ${recentVolume.title}` : ''}</p>
          <h3 className="mt-1 text-xl font-semibold leading-relaxed text-content-primary [overflow-wrap:anywhere]">{recent.title || '未命名章'}</h3>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-12 text-content-secondary">
            <span className="rounded border border-line-subtle px-2 py-0.5">{recent.status}</span>
            <span>{Number.isFinite(recent.wordCount) ? `${recent.wordCount.toLocaleString()} 字` : '字数待统计'}</span>
            <time dateTime={recentTimestamp ? new Date(recentTimestamp).toISOString() : undefined} title={recentTimestamp ? new Date(recentTimestamp).toLocaleString() : undefined}>
              {recentTimestamp ? `更新于 ${humanAgo(recentTimestamp)}` : '更新时间未知'}
            </time>
          </div>
        </div> : <div className="mb-4 text-13 leading-relaxed text-content-secondary">
          <p className="font-medium text-content-primary">项目还没有章节</p>
          <p className="mt-1">进入正文编辑器，新建或导入章节；之后可以在这里接着上次的创作。</p>
        </div>}
        {items.length > 0 && <h3 className="mb-2 text-12 font-medium text-content-secondary">接下来可以处理</h3>}
        {items.length > 0 ? <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {items.map(item => <div key={item.key} className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-800/60 p-2.5">
            <Button variant="bare" className="min-w-0 flex-1 !justify-start text-left text-12 text-ink-200 hover:text-amber" onClick={() => onNavigate(item.tab, item.chapterId)}>
              <span className="min-w-0"><span className="block [overflow-wrap:anywhere]">{item.title}</span><span className="mt-1 block text-11 text-content-muted">{item.detail}</span></span>
            </Button>
            <Button variant="ghost" size="xs" onClick={() => postpone(item.key)} aria-label={`稍后处理：${item.title}`} title="24 小时后再显示">稍后</Button>
            <Button variant="ghost" size="xs" onClick={() => dismiss(item.key)} aria-label={`忽略建议：${item.title}`} title="仅在本机隐藏这条建议">忽略</Button>
          </div>)}
        </div> : <div className="text-12 text-ink-500">暂无待处理建议。{(ignored.size > 0 || Object.keys(snoozed).length > 0) && <Button variant="bare" className="ml-2 text-amber" onClick={resetIgnored}>恢复隐藏建议</Button>}</div>}
        {items.length > 0 && (ignored.size > 0 || Object.keys(snoozed).length > 0) && <Button variant="bare" className="mt-2 text-10 text-ink-500 hover:text-amber" onClick={resetIgnored}>恢复隐藏建议</Button>}
      </Panel>

      {summary}

      <Panel>
        {/* 🔴 折叠钮跟标题走、不贴行末（主人 2026-10-17 要求）：去掉 justify-between，
            「展开/收起」紧随「项目起步清单」标题。 */}
        <div className="flex items-center gap-2">
          <h2 className="text-13 font-semibold text-ink-100 flex items-center gap-2"><BookOpen size={14} className="text-amber" /> 项目起步清单</h2>
          <Button variant="bare" className="text-11 text-ink-400" onClick={() => setGuideHidden(!guideHidden)}>{guideHidden ? '展开' : '收起'}</Button>
        </div>
        {!guideHidden && <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-11">
          <Button variant="bare" className="rounded-lg border border-ink-700 p-2 text-left" onClick={() => onNavigate('editor')}>{chapters.length ? '✓' : '○'} 建卷与建章</Button>
          <Button variant="bare" className="rounded-lg border border-ink-700 p-2 text-left" onClick={() => onNavigate('editor', recent?.id)}>{chapters.some(c => c.wordCount > 0) ? '✓' : '○'} 写入正文</Button>
          <Button variant="bare" className="rounded-lg border border-ink-700 p-2 text-left" onClick={() => setBoardOpen(true)}>{chapterOutlines.length || chapters.some(c => c.summary.trim()) ? '✓' : '○'} 查看章节规划</Button>
          <Button variant="bare" className="rounded-lg border border-ink-700 p-2 text-left" onClick={() => void exportBackup()}>↗ 导出项目备份</Button>
        </div>}
      </Panel>

      <Panel>
        {/* 🔴 折叠箭头跟标题走、不贴行末（主人 2026-10-17 要求，细化了 3.1.2 首轮的
            「左对齐」）：箭头并进标题 span 尾部 ⇒ 整行只剩一个子元素。此时左对齐必须
            `!justify-start` —— Button 基类自带 justify-center，className 是纯字符串拼接
            （非 tailwind-merge），单孩+空余空间同样会被居中 ⇒ 裸 justify-start 是死类名。
            与 AIOrganize / FullTextSearch / NovelEditorChapterTree 的 `!justify-start`
            同一约定。改前先跑 tests/collapseHeaderAlign.test.ts。 */}
        <Button variant="bare" className="w-full flex items-center !justify-start text-left" onClick={() => setBoardOpen(!boardOpen)} aria-expanded={boardOpen}>
          <span className="text-13 font-semibold text-ink-100 flex items-center gap-2"><FileText size={14} className="text-amber" /> 章节规划板 <span className="text-11 font-normal text-ink-500">{boardView === 'outlines' && visible('chapter-outline') ? `${chapterOutlines.length} 张细纲卡` : `${chapters.length} 章`} · 只读视图</span>{boardOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
        </Button>
        {boardOpen && <div className="mt-4">
          {visible('chapter-outline') && <div role="group" aria-label="章节规划板视图" className="mb-4 flex flex-wrap gap-2">
            <Button variant="toggle" size="sm" selected={boardView === 'chapters'} aria-pressed={boardView === 'chapters'} onClick={() => setBoardView('chapters')}>正文章节摘要（{chapters.length}）</Button>
            <Button variant="toggle" size="sm" selected={boardView === 'outlines'} aria-pressed={boardView === 'outlines'} onClick={() => setBoardView('outlines')}>章节细纲卡（{chapterOutlines.length}）</Button>
          </div>}
          <div className="mb-3 flex flex-wrap items-center gap-2 text-11 text-ink-500">
            <span>相关规划资料：</span>
            {(['chapter-master', 'timeline', 'foreshadow', 'hookpoints'] as const).filter(visible).map(id =>
              <Button key={id} variant="bare" className="rounded border border-ink-700 px-2 py-1 text-ink-300 hover:text-amber" onClick={() => onNavigate(id)}>
                {({ 'chapter-master': '章节总表', timeline: '时间脉络', foreshadow: '伏笔追踪', hookpoints: '爽点节奏' })[id]}
              </Button>)}
          </div>
          {(boardView === 'chapters' || !visible('chapter-outline')) ? <>
          <div className="flex flex-wrap gap-2 mb-4">
            <input value={query} onChange={e => setQuery(e.target.value)} aria-label="搜索章节标题或摘要" placeholder="搜索标题或摘要" className="min-w-40 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-12 text-ink-100" />
            <select value={volumeId} onChange={e => setVolumeId(e.target.value)} aria-label="筛选分卷" className="rounded-lg border border-ink-700 bg-ink-900 px-2 text-12"><option value="all">全部分卷</option>{volumes.map(v => <option key={v.id} value={v.id}>{v.title}</option>)}</select>
            <select value={status} onChange={e => setStatus(e.target.value)} aria-label="筛选章节状态" className="rounded-lg border border-ink-700 bg-ink-900 px-2 text-12"><option value="all">全部状态</option>{['构思', '细纲', '草稿', '修改', '完稿', '已发布'].map(s => <option key={s}>{s}</option>)}</select>
          </div>
          <p className="mb-2 text-11 text-ink-500">正文章节 · 来自编辑器</p>
          {mismatchCount > 0 && <p className="mb-3 flex items-center gap-1 text-11 text-amber">
            <AlertTriangle size={11} className="shrink-0" /> 本页已显示的章节里有 {mismatchCount} 章的状态与正文对不上（仅提示，不会自动修改）
          </p>}
          {groups.length === 0 ? <div className="py-6 text-center text-12 text-ink-500">{chapters.length ? '没有符合条件的章节' : '还没有章节，先去正文编辑器建立第一章'}</div> : groups.map(group => <section key={group.volume.id} className="mb-4">
            <h3 className="mb-2 text-12 text-ink-300">{group.volume.title} · {group.chapters.length} 章</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">{group.chapters.map(c => {
              const mismatch = chapterStatusMismatch(c)
              return <Button key={c.id} variant="bare" className="min-w-0 rounded-lg border border-ink-700 bg-ink-800/50 p-3 text-left hover:border-amber/40" onClick={() => onNavigate('editor', c.id)}>
                <span className="flex justify-between gap-2 text-12 text-ink-100"><span className="truncate">{c.title || '未命名章'}</span><span className="shrink-0 text-amber">{c.status}</span></span>
                <span className="mt-1 block text-11 text-ink-400 line-clamp-2">{c.summary.trim() || '暂无章节摘要'}</span>
                <span className="mt-2 flex items-center gap-1 text-10 text-ink-500"><History size={10} /> {c.wordCount} 字 · {c.content.trim() ? '已有正文' : '尚无正文'} · 更新于 {humanAgo(c.updatedAt)}</span>
                {mismatch && <span className="mt-1 flex items-center gap-1 text-10 text-amber"><AlertTriangle size={10} className="shrink-0" /> {mismatch}</span>}
              </Button>
            })}</div>
          </section>)}
          {shown.length < filtered.length && <Button variant="secondary" onClick={() => setChapterLimit(n => n + 60)} className="w-full">继续显示章节（{shown.length}/{filtered.length}）</Button>}
          </> : <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-12 text-ink-200">章节细纲卡 · {chapterOutlines.length} 张</h3>
              <Button variant="bare" className="text-11 text-amber" onClick={() => onNavigate('chapter-outline')}>打开章节细纲 <ChevronRight size={12} /></Button>
            </div>
            <p className="mb-3 text-11 text-ink-500">章节细纲卡与正文章节目前没有稳定的关联编号，分别展示以免错配。</p>
            {chapterOutlines.length === 0 ? <p className="text-11 text-ink-500">尚无章节细纲卡</p> : <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
              {chapterOutlines.slice(0, outlineLimit).map(card => {
                const lines = Object.entries(card.data ?? {}).filter(([key, value]) =>
                  (key.includes('本章一句话事件') || key.includes('本章功能') || key.includes('场景')) && typeof value === 'string' && value.trim())
                  .map(([, value]) => value.trim())
                return <div key={card.id} className="min-w-0 rounded-lg border border-ink-700 bg-ink-800/50 p-3 text-left">
                  <span className="block truncate text-12 text-ink-100">{card.name || '未命名细纲'}</span>
                  <span className="mt-1 block text-11 text-ink-400 line-clamp-3">{lines.join(' · ') || '尚未填写事件、功能或场景'}</span>
                </div>
              })}
            </div>}
            {chapterOutlines.length > outlineLimit && <Button variant="secondary" className="mt-2 w-full" onClick={() => setOutlineLimit(n => n + 60)}>继续显示细纲（{Math.min(outlineLimit, chapterOutlines.length)}/{chapterOutlines.length}）</Button>}
          </section>}
        </div>}
      </Panel>
    </div>
  )
}
