// ============ 内置使用手册（3.3.1 · P1） ============
//
// 规划 §4.2 / §5.1：手册提供「快速开始 / 按功能查阅 / 常见问题」，不要求作者先懂产品术语；
// 未配置模型也能读、能搜 —— 本组件**不发任何请求**，检索全在本地。
//
// 🔴 三条产品纪律：
//   ① 只说真话：底部如实写「已收录 N 篇 / 覆盖 M 个页签」，没写的页签明确显示「暂无手册」，
//      不拿十几篇文章冒充完整手册（规划 §10.1 要求逐页映射）；
//   ② 动作从注册表解析：文章里的「前往功能」只跳页签，目标未启用时禁用并说明，
//      不猜路径、不让内容自己写 URL；
//   ③ 阅读现场要保住：打开文章、跳来源、返回搜索都保留查询词与已读文章，
//      从搜索结果点进来要落到那一段（规划 §4.4）。
import { useMemo, useRef, useState, useEffect } from 'react'
import { BookOpen, ChevronLeft, Compass, Lightbulb, ListTree, MessageCircleQuestion, Search, Sparkles } from 'lucide-react'
import AskPanel from '@/components/help/AskPanel'
import { TABS, EDITOR_TAB, tabVisible, type VisCtx } from '@/lib/schema'
import {
  HELP_ARTICLES, HELP_GROUPS, getHelpArticle, helpArticlesInGroup,
  searchHelp, suggestHelpGroups, tabsWithoutHelp, type HelpArticle, type HelpGroup,
} from '@/lib/help'
import { getPageGuide } from '@/lib/help/guides'
import { peekHelpRequest, requestPageGuide, subscribeHelpRequests, takeHelpRequest } from '@/lib/help/helpNav'
import { Button } from '@/components/common/Button'
import '@/components/help/helpMobile.css'

interface Props {
  /** 页签跳转（走既有 navigate，含离页保存屏障） */
  onNavigate: (id: string) => void
  /** 项目形态：判断某个功能当前是否启用 */
  ctx: VisCtx
  /** 当前所在页签：用于「本页帮助」与检索加权 */
  currentTabId?: string
  /**
   * 是否已打开项目。项目管理页（未进项目）也能读手册，但那里所有「前往功能」都必须先开项目 ——
   * 给个能点亮却跳不动的按钮等于骗人，所以此时按钮禁用并写明原因。
   */
  projectOpen?: boolean
  /** 只有使用指南页面接收跨页文章请求；独立弹窗不抢占导航意图。 */
  receiveArticleRequests?: boolean
  onSamePageGuideStarted?: () => void
}

const tabName = (tabId: string): string =>
  tabId === EDITOR_TAB.id ? EDITOR_TAB.name : (TABS.find(tab => tab.id === tabId)?.name ?? tabId)

type CatalogView = 'start' | 'by-tab' | 'faq'

/** 3.3.1 · P4：同一个入口里区分「查手册」与「问 AI」（规划 §5.1 用词） */
type AssistMode = 'manual' | 'ask'

export default function HelpCenter({ onNavigate, ctx, currentTabId, projectOpen = true, receiveArticleRequests = true, onSamePageGuideStarted }: Props) {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<AssistMode>('manual')
  const [askOpened, setAskOpened] = useState(false)
  const [view, setView] = useState<CatalogView>('start')
  const [openId, setOpenId] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<string | null>(null)
  /** 从搜索结果返回时保留的现场 */
  const [lastQuery, setLastQuery] = useState('')
  const sectionRefs = useRef(new Map<string, HTMLElement>())

  const results = useMemo(
    () => (query.trim() ? searchHelp(query, { currentTabId }) : []),
    [query, currentTabId],
  )
  const suggestions = useMemo(
    () => (query.trim() && results.length === 0 ? suggestHelpGroups(query, HELP_GROUPS) : []),
    [query, results.length],
  )
  const article = openId ? getHelpArticle(openId) : null
  const missingTabs = useMemo(() => tabsWithoutHelp(), [])
  const coveredCount = useMemo(() => new Set(HELP_ARTICLES.flatMap(item => item.tabIds)).size, [])
  const currentPageArticles = currentTabId ? HELP_ARTICLES.filter(item => item.tabIds.includes(currentTabId)) : []

  const openArticle = (id: string, sectionId?: string) => {
    setOpenId(id)
    setAnchor(sectionId ?? null)
    if (query.trim()) setLastQuery(query)
    // 段落锚点在渲染后滚动（手动 rAF，避免依赖 effect 顺序）
    if (sectionId) {
      requestAnimationFrame(() => {
        sectionRefs.current.get(sectionId)?.scrollIntoView({ block: 'start' })
      })
    }
  }

  /**
   * 消费「打开某篇文章」的跨页请求。
   *
   * 🔴 两处都要：挂载时消费一次（从引导卡片点进来是「先导航、后挂载」，
   *    订阅建好时那条请求已经发出去了），之后再订阅（已经在这一页时点手册链接）。
   */
  const openArticleRef = useRef(openArticle)
  openArticleRef.current = openArticle
  useEffect(() => {
    if (!receiveArticleRequests) return
    const consume = () => {
      const request = takeHelpRequest('article')
      if (request && request.kind === 'article') openArticleRef.current(request.articleId)
    }
    consume()
    return subscribeHelpRequests(consume)
  }, [receiveArticleRequests])
  const backToSearch = () => {
    setOpenId(null)
    setAnchor(null)
    if (lastQuery) setQuery(lastQuery)
  }

  /**
   * 文章视图。
   *
   * 🔴 从「早返回」改成先算好再渲染：问 AI 点依据会打开文章，如果这时整棵树换掉，
   *    对话历史就被卸载清空了 —— 作者回不到刚才那句追问。现在文章与答疑面板并存，
   *    只是同一时刻只显示一个。
   */
  const guideTabId = article ? (article.tabIds.find(id => !!getPageGuide(id)) ?? null) : null
  const articleView = article ? (
      <section data-help-article={article.id} className="bg-ink-850 rounded-xl border border-ink-700 overflow-hidden">
        <header className="px-5 py-3 bg-ink-800 border-b border-ink-700 flex flex-wrap items-center gap-2">
          <Button variant="bare" onClick={backToSearch} className="shrink-0 px-2 py-1 rounded-md text-11 text-ink-300 border border-ink-700 hover:text-amber hover:border-amber/40 transition-colors">
            <ChevronLeft size={12} className="inline" /> 返回
          </Button>
          <h2 className="text-13 font-semibold text-ink-100 min-w-0 truncate">{article.title}</h2>
          <span className="text-10 px-1.5 py-0.5 rounded bg-ink-700 text-ink-300 border border-ink-600 shrink-0">{article.group}</span>
          <div className="flex-1" />
          <span className="text-10 text-ink-500 shrink-0" title={`内容最近一次人工核对的软件版本：${article.verifiedAgainst}`}>
            核对于 {article.reviewedAt}
          </span>
        </header>
        <div className="p-5 space-y-4">
          <p className="text-12 text-ink-300 leading-relaxed">{article.summary}</p>
          {article.prerequisites && article.prerequisites.length > 0 && (
            <div className="rounded-lg bg-amber/10 border border-amber/25 px-3 py-2 text-11 text-amber/90">
              前提：{article.prerequisites.join('；')}
            </div>
          )}
          {article.aiRequirement === 'model' && (
            <div className="rounded-lg bg-ink-800 border border-ink-700 px-3 py-2 text-11 text-ink-300">
              这一页的操作需要先配置可用的 AI 模型；未配置时相关按钮会禁用，本地功能不受影响。
            </div>
          )}
          {article.sections.map(section => (
            <div key={section.id}
              ref={node => { if (node) sectionRefs.current.set(section.id, node); else sectionRefs.current.delete(section.id) }}
              data-help-section={section.id}
              className={`rounded-lg border px-4 py-3 transition-colors ${anchor === section.id ? 'border-amber/50 bg-amber/5' : 'border-ink-700/60 bg-ink-800/40'}`}>
              <h3 className="text-12 font-semibold text-amber/90 mb-1.5">{section.heading}</h3>
              <div className="space-y-1.5">
                {section.body.map((paragraph, index) => (
                  <p key={index} className="text-12 text-ink-300 leading-relaxed whitespace-pre-wrap">{paragraph}</p>
                ))}
              </div>
            </div>
          ))}
          {guideTabId && projectOpen && (
            <div className="pt-1">
              <Button variant="secondary" size="sm"
                title={`跳到「${tabName(guideTabId)}」并重新分步介绍（不影响任何数据）`}
                onClick={() => {
                  requestPageGuide(guideTabId)
                  if (currentTabId === guideTabId && !peekHelpRequest('guide')) onSamePageGuideStarted?.()
                }}
                className="flex items-center gap-1.5 text-11">
                <Compass size={11} /> 重看这页的引导
              </Button>
            </div>
          )}
          {article.actions && article.actions.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {article.actions.map(action => {
                const enabled = projectOpen && tabVisible(action.tabId, ctx)
                const reason = !projectOpen
                  ? '先打开一个项目，才能跳到这个功能页'
                  : `当前项目未启用「${tabName(action.tabId)}」，无法跳转`
                return (
                  <Button key={action.tabId} variant="secondary" size="sm"
                    disabled={!enabled}
                    title={enabled ? `跳转到「${tabName(action.tabId)}」` : reason}
                    onClick={() => enabled && onNavigate(action.tabId)}
                    className="text-11">
                    {action.label}
                  </Button>
                )
              })}
            </div>
          )}
          {article.related && article.related.length > 0 && (
            <div className="pt-1 border-t border-ink-700">
              <div className="text-11 text-ink-500 mb-1.5">相关</div>
              <div className="flex flex-wrap gap-1.5">
                {article.related.map(id => {
                  const related = getHelpArticle(id)
                  if (!related) return null
                  return (
                    <Button key={id} variant="bare" onClick={() => openArticle(id)}
                      className="px-2 py-1 rounded-md text-11 text-ink-200 border border-ink-700 hover:text-amber hover:border-amber/40 transition-colors">
                      {related.title}
                    </Button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </section>
  ) : null

  const catalog = (list: HelpArticle[], empty: string) => (
    list.length === 0
      ? <div className="py-8 text-center text-12 text-ink-500">{empty}</div>
      : <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2">
        {list.map(item => (
          <Button key={item.id} variant="bare" onClick={() => openArticle(item.id)}
            className="group flex-col items-stretch w-full text-left py-2 border-b border-ink-700/50 hover:border-amber/30 transition-colors">
            <span className="text-12 font-medium text-ink-100 group-hover:text-amber transition-colors">{item.title}</span>
            <span className="text-11 text-ink-400 mt-0.5 line-clamp-2">{item.summary}</span>
          </Button>
        ))}
      </div>
  )

  return (
    <section data-help-center className="bg-ink-850 rounded-xl border border-ink-700 overflow-hidden">
      <header className="px-5 py-3 bg-ink-800 border-b border-ink-700 flex flex-wrap items-center gap-2">
        <BookOpen size={14} className="text-amber" />
        <h2 className="text-13 font-semibold text-ink-100">使用答疑助手</h2>
        <span className="text-10 text-ink-500">手册 {HELP_ARTICLES.length} 篇 · 覆盖 {coveredCount} 个页签</span>
        <div className="flex-1" />
        {/* 查手册 = 只读本地；问 AI = 用手册内容回答。两者明确分开，不含糊成一个「搜索框」 */}
        <div className="flex items-center gap-1">
          {([
            ['manual', '查手册', BookOpen],
            ['ask', '问 AI', MessageCircleQuestion],
          ] as [AssistMode, string, typeof BookOpen][]).map(([key, label, Icon]) => (
            <Button key={key} variant="toggle" size="sm" selected={mode === key}
              title={key === 'ask' ? '按内置手册回答你的问题；未配置模型时只给手册片段' : '直接翻内置手册，不联网、不用模型'}
              onClick={() => { setMode(key); if (key === 'ask') { setAskOpened(true); setOpenId(null); setAnchor(null) } }}
              className="text-11">
              <Icon size={12} /> {label}
            </Button>
          ))}
        </div>
        {mode === 'manual' && !article && (
          <div className="flex items-center gap-1 rounded-lg border border-ink-700 bg-ink-900/60 px-2 py-1">
            <Search size={12} className="text-ink-500" />
            <input
              aria-label="搜索使用手册"
              value={query}
              onChange={event => { setQuery(event.target.value); setOpenId(null) }}
              placeholder="搜一句：字太小怎么放大 / 校对怎么定位原文"
              className="w-64 max-w-full bg-transparent text-11 text-ink-100 placeholder:text-ink-600 outline-none"
            />
          </div>
        )}
      </header>

      <div className="p-5 space-y-4">
        {/* 首次打开后保持挂载：切回手册或打开依据都不能清空对话、草稿或中断正在进行的提问。 */}
        {askOpened && (
          <div className={mode !== 'ask' || article ? 'hidden' : ''}>
            <AskPanel currentTabId={currentTabId} onOpenArticle={openArticle} />
          </div>
        )}

        {article ? articleView : mode === 'ask' ? null : (
        <>
        {/* 搜索优先：有查询词就给片段结果，不给「假装是 AI 回答」的任何东西 */}
        {query.trim() ? (
          <div className="space-y-3">
            <div className="text-11 text-ink-500">
              本地手册检索结果（{results.length} 段）· 不联网、不调用模型
            </div>
            {results.length === 0 ? (
              <div className="py-6 text-center space-y-2">
                <div className="text-12 text-ink-300">手册里没有找到直接对应的段落。</div>
                <div className="text-11 text-ink-500">
                  {suggestions.length > 0 ? '可以先去这些栏目找：' : '换个说法试试，例如把「放大」换成「界面缩放」。'}
                </div>
                {suggestions.length > 0 && (
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {suggestions.map(group => (
                      <Button key={group} variant="bare" onClick={() => { setQuery(''); setView('by-tab') }}
                        className="px-2 py-1 rounded-md text-11 text-ink-200 border border-ink-700 hover:text-amber transition-colors">
                        {group}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {results.map(hit => (
                  <Button key={`${hit.articleId}-${hit.sectionId}`} variant="bare"
                    onClick={() => openArticle(hit.articleId, hit.sectionId)}
                    className="flex-col items-stretch w-full text-left rounded-lg bg-ink-800 border border-ink-700 px-4 py-2.5 hover:border-amber/40 transition-colors">
                    <div className="flex items-center gap-2">
                      <span className="text-12 font-semibold text-ink-100">{hit.articleTitle}</span>
                      <span className="text-10 px-1.5 py-0.5 rounded bg-ink-700 text-ink-300 border border-ink-600">{hit.group}</span>
                    </div>
                    <div className="text-11 text-amber/80 mt-0.5">{hit.heading}</div>
                    <div className="text-11 text-ink-400 mt-1 leading-relaxed">{hit.excerpt}</div>
                  </Button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            {currentPageArticles.length > 0 && (
              <div className="rounded-lg bg-ink-800/60 border border-ink-700/60 px-3 py-2">
                <div className="text-11 text-ink-400 mb-1">本页帮助</div>
                <div className="flex flex-wrap gap-1.5">
                  {currentPageArticles.map(item => (
                    <Button key={item.id} variant="bare" onClick={() => openArticle(item.id)}
                      className="px-2 py-1 rounded-md text-11 text-ink-200 border border-ink-700 hover:text-amber hover:border-amber/40 transition-colors">
                      {item.title}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-1.5">
              {([
                ['start', '快速开始', Sparkles],
                ['by-tab', '按功能查阅', ListTree],
                ['faq', '常见问题', Lightbulb],
              ] as [CatalogView, string, typeof Sparkles][]).map(([key, label, Icon]) => (
                <Button key={key} variant="toggle" size="sm" selected={view === key} onClick={() => setView(key)}
                  className="text-11">
                  <Icon size={12} /> {label}
                </Button>
              ))}
            </div>

            {view === 'start' && catalog(helpArticlesInGroup('快速开始'), '还没有快速开始文章')}
            {view === 'by-tab' && (
              <div className="space-y-4">
                {HELP_GROUPS.filter(group => group !== '快速开始' && group !== '常见问题与任务教程').map((group: HelpGroup) => {
                  const list = helpArticlesInGroup(group)
                  if (list.length === 0) return null
                  return (
                    <div key={group}>
                      <div className="flex items-center gap-2 mb-2 px-1">
                        <span className="w-1 h-3 rounded-full bg-amber/70" />
                        <span className="text-12 font-semibold text-ink-200">{group}</span>
                        <span className="text-10 text-ink-600">{list.length} 篇</span>
                      </div>
                      {catalog(list, '')}
                    </div>
                  )
                })}
                <div className="rounded-lg border border-ink-700/60 bg-ink-800/40 px-3 py-2 text-11 text-ink-400 leading-relaxed">
                  还有 {missingTabs.length} 个页签暂无手册（{missingTabs.slice(0, 6).map(tabName).join('、')}
                  {missingTabs.length > 6 ? ` 等 ${missingTabs.length} 个` : ''}）。这些页签的功能说明仍可
                  点页头的 ? 查看；手册内容会按版本补齐，补齐前这里不会假装它们已经写好。
                </div>
              </div>
            )}
            {view === 'faq' && catalog(helpArticlesInGroup('常见问题与任务教程'), '还没有常见问题文章')}
          </>
        )}
        </>
        )}
      </div>
    </section>
  )
}
