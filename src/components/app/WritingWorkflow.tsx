import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, BookOpen, ChevronDown, ChevronRight, Compass, FileText, History, X } from 'lucide-react'
import Panel from '@/components/common/Panel'
import { Button } from '@/components/common/Button'
import type { CardRecord, Chapter, TableRow, Volume } from '@/lib/types'
import type { VisCtx } from '@/lib/schema'
import { tabVisible, getTab } from '@/lib/schema'
import { readSetPref, readStringPref, writeSetPref, writeStringPref, usePersistedBool } from '@/lib/settings/uiPrefs'
import { showToast } from '@/components/dialogs/dialogs'
import { humanAgo } from '@/lib/outline/chapterAudit'
import { chapterStatusMismatch } from '@/lib/app/chapterBoardView'
import { describeChapterContext, type ChapterContextBrief } from '@/lib/app/chapterBoardContext'
import ChapterSetsPanel from '@/components/app/ChapterSetsPanel'
import QuickInspiration from '@/components/app/QuickInspiration'
import { flattenAll } from '@/lib/outline/chapterSeq'
import {
  loadBoardState, saveBoardState, limitCovering, locateBoardAnchor,
  BOARD_STATUSES, type BoardStatus, type BoardView, type ChapterBoardState,
} from '@/lib/app/chapterBoardState'

interface Props {
  projectId: string
  chapters: Chapter[]
  chapterOutlines: CardRecord[]
  volumes: Volume[]
  ideas: TableRow[]
  foreshadows: TableRow[]
  ctx: VisCtx
  /**
   * 3.4.0 · A.3：章节 → 细纲绑定 / 固定条数（来源 `chapterContext32:<章>`，由写作面板批量读入）。
   * 没有条目 = 未绑定；有 outlineId 但卡片不在项目里 = 失效。
   */
  chapterContexts?: Record<string, ChapterContextBrief>
  onNavigate: (id: string, chapterId?: string) => void
  onExport: () => void | Promise<void>
  /** The dashboard owns its metrics; this slot places them ahead of optional planning panels. */
  summary?: ReactNode
}

const finished = new Set<Chapter['status']>(['完稿', '已发布'])

/**
 * 找到真正负责滚动的祖先（写作面板外层是 `<main overflow-y-auto>`）。
 *
 * 🔴 不能假设 `window` 滚动：本项目所有页签都滚在 main 里，window.scrollTop 恒为 0 ——
 *    把 window 当滚动容器会让「记住滚动位置」永远记住 0，而且查不出原因。
 */
function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null
  while (node) {
    const overflowY = getComputedStyle(node).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return node
    node = node.parentElement
  }
  return null
}

/** 挂载时算一次「回来该恢复成什么样」——之后作者怎么滚、怎么筛都不再改写它 */
interface BoardRestorePlan {
  scrollTop: number
  anchor: ReturnType<typeof locateBoardAnchor> | null
  anchorTitle: string
  /** 锚点在筛选结果里的下标超出了已显示数量 ⇒ 需要先抬到这么多 */
  limitBump: number | null
}

export default function WritingWorkflow({ projectId, chapters, chapterOutlines, volumes, ideas, foreshadows, ctx, chapterContexts = {}, onNavigate, onExport, summary }: Props) {
  const [guideHidden, setGuideHidden] = usePersistedBool(`writing-guide-hidden:${projectId}`, chapters.length > 0)
  const [ignored, setIgnored] = useState<Set<string>>(() => new Set(readSetPref(`writing-next-ignored:${projectId}`) ?? []))
  const [snoozed, setSnoozed] = useState<Record<string, number>>(() => {
    try {
      const value: unknown = JSON.parse(readStringPref(`writing-next-snoozed:${projectId}`) || '{}')
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, number> : {}
    }
    catch { return {} }
  })
  /**
   * 规划板往返状态（3.4.0 · A）：只在本机记住「作者离开时看到的视图」。
   *
   * 🔴 初始化只读一次。写进依赖就会出事：作者筛到一半新建/删除一卷，volumes 一变
   *    就会重新读档、把筛选打回全部 —— 那正是「视图在作者眼皮底下自己跳」的经典事故。
   */
  const [initial] = useState(() => {
    const outlineTab = getTab('chapter-outline')
    return loadBoardState(projectId, {
      volumeIds: volumes.map(v => v.id),
      outlinesAvailable: !!outlineTab && tabVisible(outlineTab.id, ctx),
    })
  })
  const [boardOpen, setBoardOpen] = useState(initial.state.open)
  const [setsOpen, setSetsOpen] = useState(false)
  const [boardView, setBoardView] = useState<BoardView>(initial.state.view)
  const [chapterLimit, setChapterLimit] = useState(initial.state.chapterLimit)
  const [outlineLimit, setOutlineLimit] = useState(initial.state.outlineLimit)
  const [query, setQuery] = useState(initial.state.query)
  const [status, setStatus] = useState<BoardStatus>(initial.state.status)
  const [volumeId, setVolumeId] = useState(initial.state.volumeId)
  const [restoreNotices, setRestoreNotices] = useState<string[]>(initial.notices)
  const [anchorNotice, setAnchorNotice] = useState<string | null>(null)
  const anchorRef = useRef<string | null>(initial.state.anchorId)
  const scrollTopRef = useRef(initial.state.scrollTop)
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollElRef = useRef<HTMLElement | null>(null)
  const restorePlanRef = useRef<BoardRestorePlan | null>(null)
  const boardStateRef = useRef<ChapterBoardState>(initial.state)

  const visible = (id: string) => {
    const tab = getTab(id)
    return !tab || tabVisible(tab.id, ctx)
  }
  /**
   * A.3：细纲卡 id → 卡名。绑定只认这张表 —— 卡片名与章节名相同**不代表有关联**，
   * 规划明确禁止按名称猜关系（同名章节 / 重复章号会猜错）。
   */
  const outlineNames = useMemo(
    () => new Map(chapterOutlines.map(card => [card.id, card.name?.trim() || '未命名细纲'])),
    [chapterOutlines],
  )
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
  const hasFilter = query.trim() !== '' || status !== 'all' || volumeId !== 'all'
  const clearFilters = () => { setQuery(''); setStatus('all'); setVolumeId('all') }

  /**
   * 挂载时算一次「回来该恢复成什么样」。
   * 🔴 用 **首帧** 的 filtered 快照：之后再算就变成「按当前筛选判断上次」，锚点永远判不到。
   */
  if (restorePlanRef.current === null) {
    const st = initial.state
    const ids = filtered.map(c => c.id)
    const at = st.anchorId ? ids.indexOf(st.anchorId) : -1
    restorePlanRef.current = {
      scrollTop: st.scrollTop,
      anchor: st.anchorId ? locateBoardAnchor(st.anchorId, ids) : null,
      anchorTitle: chapters.find(c => c.id === st.anchorId)?.title || '未命名章',
      limitBump: at >= 0 && at >= st.chapterLimit ? limitCovering(at, st.chapterLimit) : null,
    }
  }

  // 记录滚动位置。滚动容器是外层 <main>，不是 window（见 scrollParentOf 的说明）。
  useEffect(() => {
    const el = scrollParentOf(rootRef.current)
    scrollElRef.current = el
    if (!el) return
    const onScroll = () => { scrollTopRef.current = el.scrollTop }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // 回来时：先补足显示数量（锚点超出首批 60 条也能定位），再复原滚动位置；锚点不在了如实说。
  useEffect(() => {
    const plan = restorePlanRef.current
    if (!initial.state.open || !plan) return
    if (plan.limitBump) setChapterLimit(prev => Math.max(prev, plan.limitBump as number))
    if (plan.anchor === 'missing') setAnchorNotice(`上次进入的「${plan.anchorTitle}」已不在项目中（可能被删到回收站）；筛选条件已保留。`)
    else if (plan.anchor === 'filtered-out') setAnchorNotice(`上次进入的「${plan.anchorTitle}」不在当前筛选结果里；筛选条件已保留，可清除筛选后再找。`)
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        const el = scrollElRef.current
        if (el) el.scrollTop = plan.scrollTop
      })
    })
    return () => { cancelAnimationFrame(outer); if (inner) cancelAnimationFrame(inner) }
  }, [initial])

  // 视图状态 → 本机偏好（防抖 400ms；切走/关页时由卸载清理再落一次）
  boardStateRef.current = {
    version: 1,
    open: boardOpen,
    view: boardView,
    query,
    status,
    volumeId,
    chapterLimit,
    outlineLimit,
    scrollTop: scrollTopRef.current,
    anchorId: anchorRef.current,
    savedAt: initial.state.savedAt,
  }
  useEffect(() => {
    const timer = setTimeout(() => {
      saveBoardState(projectId, { ...boardStateRef.current, scrollTop: scrollTopRef.current, anchorId: anchorRef.current })
    }, 400)
    return () => clearTimeout(timer)
  }, [projectId, boardOpen, boardView, query, status, volumeId, chapterLimit, outlineLimit])
  useEffect(() => () => {
    saveBoardState(projectId, { ...boardStateRef.current, scrollTop: scrollTopRef.current, anchorId: anchorRef.current })
  }, [projectId])

  /** 从卡片进正文：先把锚点与当前位置写死，再跳 —— 回来才知道「刚才进的是哪一章」 */
  const openChapterFromBoard = (id: string) => {
    anchorRef.current = id
    saveBoardState(projectId, { ...boardStateRef.current, scrollTop: scrollTopRef.current, anchorId: id })
    setAnchorNotice(null)
    onNavigate('editor', id)
  }

  return (
    <div ref={rootRef} className="space-y-4 mb-6">
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

      {visible('inspire-tools') && <Panel><QuickInspiration projectId={projectId} chapters={flattenAll(volumes, chapters)} onOpen={() => onNavigate('inspire-tools')} /></Panel>}

      <Panel>
        <Button variant="bare" className="w-full flex items-center !justify-start text-left" onClick={() => setSetsOpen(!setsOpen)} aria-expanded={setsOpen}>
          <span className="text-13 font-semibold text-ink-100 flex items-center gap-2"><BookOpen size={14} className="text-amber" /> 章节收藏集 {setsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
        </Button>
        {setsOpen && <div className="mt-3 h-96 border border-ink-700 rounded-lg overflow-hidden">
          <ChapterSetsPanel key={projectId} projectId={projectId} chapters={flattenAll(volumes, chapters)} onNavigate={openChapterFromBoard} />
        </div>}
      </Panel>
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
          {/* 3.4.0 · A：回来时视图被降级 / 上次进的章不在了 —— 都要说清原因，不静默改筛选 */}
          {(restoreNotices.length > 0 || anchorNotice) && <div role="status" className="mb-3 space-y-1 rounded-lg border border-amber/30 bg-amber/5 px-3 py-2 text-11 text-amber">
            {anchorNotice && <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1">{anchorNotice}</span>
              <Button variant="ghost" size="xs" aria-label="关闭提示" onClick={() => setAnchorNotice(null)}><X size={12} /></Button>
            </div>}
            {restoreNotices.map((notice, index) => <div key={`${notice}-${index}`} className="flex items-start gap-2">
              <span className="min-w-0 flex-1">{notice}</span>
              {index === restoreNotices.length - 1 && <Button variant="ghost" size="xs" aria-label="关闭提示" onClick={() => setRestoreNotices([])}><X size={12} /></Button>}
            </div>)}
          </div>}
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
            <select value={status} onChange={e => setStatus(e.target.value as BoardStatus)} aria-label="筛选章节状态" className="rounded-lg border border-ink-700 bg-ink-900 px-2 text-12"><option value="all">全部状态</option>{BOARD_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}</select>
            {hasFilter && <Button variant="ghost" size="sm" onClick={clearFilters} title="清除分卷、状态与关键词筛选">清除筛选</Button>}
          </div>
          <p className="mb-2 text-11 text-ink-500">正文章节 · 来自正文编辑器（只读，点卡片进入该章）· 细纲绑定与固定条数取自正文「本章资料」，不按名称匹配</p>
          {mismatchCount > 0 && <p className="mb-3 flex items-center gap-1 text-11 text-amber">
            <AlertTriangle size={11} className="shrink-0" /> 本页已显示的章节里有 {mismatchCount} 章的状态与正文对不上（仅提示，不会自动修改）
          </p>}
          {groups.length === 0 ? <div className="flex flex-col items-center gap-2 py-6 text-center text-12 text-ink-500">
            <span>{chapters.length ? (hasFilter ? `没有符合当前筛选的章节（共 ${chapters.length} 章）` : '没有符合条件的章节') : '还没有章节，先去正文编辑器建立第一章'}</span>
            {chapters.length > 0 && hasFilter && <Button variant="secondary" size="sm" onClick={clearFilters}>清除筛选，查看全部章节</Button>}
          </div> : groups.map(group => <section key={group.volume.id} className="mb-4">
            <h3 className="mb-2 text-12 text-ink-300">{group.volume.title} · {group.chapters.length} 章</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">{group.chapters.map(c => {
              const mismatch = chapterStatusMismatch(c)
              // A.3：只展示有据可查的绑定；未绑定照实说，不按名称猜
              const contextLine = visible('chapter-outline') ? describeChapterContext(chapterContexts[c.id], outlineNames) : null
              return <Button key={c.id} variant="bare" data-board-card={c.id} className="min-w-0 rounded-lg border border-ink-700 bg-ink-800/50 p-3 text-left hover:border-amber/40" onClick={() => openChapterFromBoard(c.id)}>
                <span className="flex justify-between gap-2 text-12 text-ink-100"><span className="truncate">{c.title || '未命名章'}</span><span className="shrink-0 text-amber">{c.status}</span></span>
                <span className="mt-1 block text-11 text-ink-400 line-clamp-2">{c.summary.trim() || '暂无章节摘要'}</span>
                <span className="mt-2 flex items-center gap-1 text-10 text-ink-500"><History size={10} /> {c.wordCount} 字 · {c.content.trim() ? '已有正文' : '尚无正文'} · 更新于 {humanAgo(c.updatedAt)}</span>
                {contextLine && <span
                  className={`mt-1 flex items-center gap-1 text-10 ${contextLine.kind === 'stale' ? 'text-amber' : contextLine.kind === 'unbound' ? 'text-ink-600' : 'text-ink-400'}`}
                  title={contextLine.title}
                ><BookOpen size={10} className="shrink-0" /> {contextLine.text}</span>}
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
