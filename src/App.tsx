import { useState, useCallback, useEffect, useRef, lazy, Suspense } from 'react'
import Sidebar from './components/Sidebar'
import Dashboard from './components/Dashboard'
import NovelEditor from './components/NovelEditor'
import FormSheet from './components/FormSheet'
import TableSheet from './components/TableSheet'
import CharacterSheet from './components/CharacterSheet'
import OutlineSheet from './components/OutlineSheet'
import ProjectHub from './components/ProjectHub'
import AboutPage from './components/AboutPage'
import { getTab, tabVisible, refreshVolumeTabs, type VisCtx } from './lib/schema'
import * as db from './lib/db'
import { ensureDailyBackup, startAutoBackup, takeBackupFailure } from './lib/backup'
import { DESKTOP, initDesktopStore, flushDesktopSync, getDesktopState, subscribeDesktop } from './lib/desktop'
import { DesktopWriteLockBanner } from './components/DesktopWriteLockBanner'
import DataDock from './components/DataDock'
import BackupReminder from './components/BackupReminder'
import { markExported } from './lib/backupReminder'
import WelcomeWizard from './components/WelcomeWizard'
import FullTextSearch from './components/FullTextSearch'
import JieWenJiSprite from './components/JieWenJiSprite'
import GeoMapEditor from './components/GeoMapEditor'
import PlotCanvas from './components/PlotCanvas'
import { showToast } from './components/dialogs'
import { Button } from './components/Button'
import { applyTheme, applyZoom, getStoredTheme, getStoredZoom, isZoomAuto } from './lib/theme'
import { loadPromptOverrides } from './lib/promptSettings'
import { LS_SPRITE_ENABLED } from './lib/constants'
import { downloadBlob } from './lib/zip'
import workbenchBg from './assets/workbench-bg.png'

// 次级页签按需懒加载：把向导页 / 灵感启发·检查工具（含 AI 组件与大量交互）从首屏主包拆出去，
// 仅在用户切到对应页签时才加载对应 chunk。Sidebar/仪表盘/编辑器保持常驻以保证首屏速度。
const GuidePage = lazy(() => import('./components/GuidePage'))
const InspireTools = lazy(() => import('./components/InspireTools'))
const ModelSettingsPanel = lazy(() => import('./components/ModelSettingsPanel'))
const CheckTools = lazy(() => import('./components/CheckTools'))
const MaterialLibrary = lazy(() => import('./components/MaterialLibrary'))
const BookBreakPanel = lazy(() => import('./components/BookBreakPanel'))
const CreativeWritingPanel = lazy(() => import('./components/CreativeWritingPanel'))
// 酒馆模式四页：剧情推演 / 推演报告 / 角色卡 / 自由对话（各自含 AI 交互，按需懒加载）
const TavernPlot = lazy(() => import('./components/TavernPlot'))
const TavernReport = lazy(() => import('./components/TavernReport'))
const TavernCard = lazy(() => import('./components/TavernCard'))
const TavernFree = lazy(() => import('./components/TavernFree'))
const TavernControl = lazy(() => import('./components/TavernControl'))
const TavernScript = lazy(() => import('./components/TavernScript'))
const TavernWorld = lazy(() => import('./components/TavernWorld'))

export default function App() {
  const [projectId, setProjectId] = useState<string | null>(null)
  const [projectName, setProjectName] = useState('')
  const [visCtx, setVisCtx] = useState<VisCtx>({ type: 'full', features: [] })
  const [activeTab, setActiveTab] = useState('dashboard')
  const [refreshKey, setRefreshKey] = useState(0)
  const [booted, setBooted] = useState(false)
  /** 启动流程抛出的错误（非空则渲染错误页，而不是永远卡在黑屏上） */
  const [bootError, setBootError] = useState('')
  /**
   * 首启向导开关（2.4.0 · A1）：仅在「从没走过向导」且「库里一个项目都没有」时为 true。
   * 走过一次即写全局 meta `welcomeDone`，此后不再出现。
   */
  const [needWelcome, setNeedWelcome] = useState(false)
  // 从其他页签（如章节总表）跳转正文编辑时，要直达打开的章节 id
  const [editorTarget, setEditorTarget] = useState<string | null>(null)
  // 数据体检 / 地图等跨组件跳转时，要直达高亮的具体行 id（detail 携带 rowId 时下发）
  const [focusRowId, setFocusRowId] = useState<string | null>(null)
  /**
   * 跨页签跳转聚焦的「已消费」回调。
   * 🔴 必须用 useCallback 钉住引用：它是 TableSheet 滚动高亮 effect 的依赖之一，
   *    若写成内联箭头（每次渲染新建），该 effect 会在每次渲染重跑，
   *    2.6 秒后清除高亮的定时器被反复重置 —— 高亮将永不消失。
   */
  const clearFocusRow = useCallback(() => setFocusRowId(null), [])
  // 全文检索命令面板（v1.3）：Ctrl/Cmd+K 唤起
  const [searchOpen, setSearchOpen] = useState(false)
  // 颉文姬 Q 版精灵开关（面板内可切换，localStorage 持久化）
  const [spriteEnabled, setSpriteEnabled] = useState(() => localStorage.getItem(LS_SPRITE_ENABLED) !== '0')
  useEffect(() => {
    const onSetting = (e: Event) => {
      const v = (e as CustomEvent<boolean>).detail
      setSpriteEnabled(v)
    }
    window.addEventListener('jiewenji:sprite-setting', onSetting)
    return () => window.removeEventListener('jiewenji:sprite-setting', onSetting)
  }, [])
  // 自动备份定时器句柄（打开项目时启动，退出时停止）
  const backupStop = useRef<(() => void) | null>(null)
  // 本地数据文件加载完成状态（未加载完不出主界面，避免闪一下空库）
  const [fileReady, setFileReady] = useState(!DESKTOP)

  // 从本地用户数据目录加载数据
  useEffect(() => {
    if (!DESKTOP) return
    let alive = true
    void initDesktopStore().then(() => { if (alive) setFileReady(true) })
    return () => { alive = false }
  }, [])

  // 关闭页面前确保未保存的修改写盘（桌面版走同步阻塞写，保证窗口关闭前数据落盘）
  useEffect(() => {
    if (!DESKTOP) return
    const onLeave = () => { flushDesktopSync() }
    window.addEventListener('beforeunload', onLeave)
    return () => { window.removeEventListener('beforeunload', onLeave) }
  }, [])

  // 磁盘写盘失败时把原本静默吞掉的错误暴露给用户，避免无提示丢稿
  useEffect(() => {
    if (!DESKTOP) return
    let lastErr = ''
    const onDesktop = () => {
      const e = getDesktopState().lastError
      if (e && e !== lastErr) { lastErr = e; showToast('数据保存失败：' + e, 'error', 4500) }
      else if (!e) lastErr = ''
    }
    onDesktop(); return subscribeDesktop(onDesktop)
  }, [])

  // 启动引导（便携模式需等数据文件连接后执行）
  //
  // 2026-09-19 前这里会**自动打开上次的项目**；老大要求启动默认停在「项目管理首页」，
  // 所以现在只做三件与「有没有项目」无关的事：结构归一 → 首次使用播示范项目 → 装载提示词覆写。
  useEffect(() => {
    if (!fileReady) return
    ;(async () => {
      // 🔴 整段兜底：旧实现没有 try/catch，任何一步 reject（IndexedDB 打不开、
      //    迁移抛错、读 meta 失败）都会让 setBooted(true) 执行不到 —— 界面永远黑屏，
      //    既不报错也没有重试入口。finally 保证一定会离开黑屏。
      try {
      await db.migrateProjectTypes() // 清理历史遗留的 lite/minimal 项目形态（全局、幂等）
      // 🆕 2.4.0 · A1：这里原先会**静默自动创建**示范项目「吞天神脉」—— 软件替新用户做了决定，
      //    他既看不到「还有别的选择」，也不知道那本不是自己的书。现在改为首启向导里的显式三选一
      //    （写我的第一本书 / 先看看示例 / 我有备份），播种动作移到用户点选之后执行。
      // 🔴 写盘被锁（数据文件没读出来）时**不弹向导**：此刻内存是空库，
      //    「库里一个项目都没有」是假象，弹向导只会误导用户去建第二本书、还可能覆盖原文件。
      const desktopWriteLocked = DESKTOP && getDesktopState().writeLocked
      if (!desktopWriteLocked) {
        const [welcomed, existing] = await Promise.all([
          db.getMeta('welcomeDone', '').catch(() => '1'), // 读失败按「已走过」处理，不拿一次异常当首次
          db.getAllProjects().catch(() => []),
        ])
        if (!welcomed && existing.length === 0) setNeedWelcome(true)
      }
      // AI 提示词的作者覆写要在任何 AI 调用之前生效（登记在各 lib 模块顶层，import 即完成）。
      // 它存在**全局 meta**（`ai.promptOverrides`，不是项目级 —— 与 lastProject 同一个 meta 区），
      // 所以放在这里调用、与「有没有打开项目」无关。
      await loadPromptOverrides()
      // 🔴 2026-09-19 老大要求：**启动后默认停在「项目管理首页」**，不再自动打开上次的项目。
      //    于是现在进项目只有一条路径 —— 作者在首页挑一个 → `openProject()`，
      //    那里的 runMigrations / refreshVolumeTabs / 自动备份 / setActiveTab('dashboard')
      //    本来就是主路径（点项目卡片走的就是它），不会漏步骤。
      //    `lastProject` 保留写入（退出项目时清空），但 2.4.0 起**不再**用它判断「是不是首次使用」——
      //    那件事已交给首启向导与 `welcomeDone`。
      } catch (e) {
        console.error('[boot] 启动流程失败：', e)
        setBootError(e instanceof Error ? e.message : String(e))
      } finally {
        setBooted(true)
      }
    })()
  }, [fileReady])

  // 应用上次选择的主题与界面缩放（在首次渲染前设置，避免闪烁）
  useEffect(() => {
    applyTheme(getStoredTheme())
    applyZoom(getStoredZoom())
  }, [])

  // 🔴 自动备份失败必须让用户看见（2026-09-19 六维审计修复）
  // 此前备份失败只 console.warn：作者会以为「每 5 分钟一份、留 30 份」还在保护他，
  // 实际可能一份都没存成功（磁盘满 / 数据文件只读 / 桌面写盘失败）。等要恢复时才发现没有。
  // lib 侧负责记录（takeBackupFailure 取走即清空 ⇒ 同一条最多提示一次），此处只负责展示。
  useEffect(() => {
    const timer = setInterval(() => {
      const f = takeBackupFailure()
      if (!f) return
      const label = f.kind === 'daily' ? '每日备份' : '自动备份'
      showToast(
        `${label}失败：${f.message}。请尽快用「导出备份」另存到外部文件，避免数据丢失`,
        'error',
        8000,
      )
    }, 30_000)
    return () => clearInterval(timer)
  }, [])

  // 「跟随窗口」模式下，窗口尺寸变化时重算缩放（防抖 300ms）。
  // 例：窗口化 ↔ 全屏切换、把窗口拖到另一块屏 —— 字号自动适配，不必手动调。
  useEffect(() => {
    if (!isZoomAuto()) return
    let t: ReturnType<typeof setTimeout> | null = null
    const onResize = () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        if (isZoomAuto()) applyZoom(getStoredZoom())
      }, 300)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (t) clearTimeout(t)
    }
  }, [])

  // 全局快捷键：Ctrl/Cmd+K 唤起全文检索命令面板（v1.3）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(o => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visCtx])

  const openProject = useCallback(async (id: string) => {
    const p = await db.getProject(id)
    if (!p) return
    db.setCurrentProject(id)
    // 结构迁移统一入口（幂等），与「启动恢复上次项目」共用同一个入口，
    // 杜绝两条路径跑的迁移集合不一致（审计 P1-7）。
    // 内部顺序：项目形态归一化 → ledger 拆表 → 全局连续编号（numbering 依赖 ledger 的结果）
    await db.runMigrations()
    await refreshVolumeTabs() // UI 侧缓存刷新，db 层不引用 schema 以免循环依赖
    db.setMeta('lastProject', id)
    setProjectId(id)
    setProjectName(p.name)
    setVisCtx({ type: p.projectType ?? 'full', features: p.features ?? [] })
    setActiveTab('dashboard')
    setRefreshKey(k => k + 1)
    // 备份策略加固：每天首次打开自动备一份；打开期间每 5 分钟滚动备一份
    void ensureDailyBackup(id)
    backupStop.current?.()
    backupStop.current = startAutoBackup(id)
  }, [])

  const exitProject = useCallback(() => {
    backupStop.current?.()
    backupStop.current = null
    db.setMeta('lastProject', '')
    db.setCurrentProject('')
    setProjectId(null)
    setProjectName('')
  }, [])

  /** 首启向导收尾：选定/导入了项目就直接进项目；跳过一次则留在项目管理页 */
  const onWelcomeDone = useCallback((id: string | null) => {
    setNeedWelcome(false)
    if (id) void openProject(id)
  }, [openProject])

  const exportCurrent = useCallback(async () => {
    if (!projectId) return
    const bundle = await db.exportProject(projectId)
    downloadBlob(
      `青春幻想引擎备份-${projectName}-${new Date().toISOString().slice(0, 10)}.json`,
      new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
    )
    markExported() // 记录「已导出到外部文件」，#031 提醒据此重新计时
  }, [projectId, projectName])

  const navigate = useCallback((id: string, chapterId?: string) => {
    const t = getTab(id)
    if (t && !tabVisible(t.id, visCtx)) return
    setActiveTab(id)
    if (id === 'editor' && chapterId) setEditorTarget(chapterId)
  }, [visCtx])

  // 跨组件跳转事件（地图详情「跳到地理风物」、数据体检「跳转修复」等场景派发 yfe:navigate）
  // detail 兼容两种形式：字符串 tabId，或 { tabId, rowId } 对象（直达并高亮具体行）
  useEffect(() => {
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (typeof detail === 'string') {
        navigate(detail)
        setFocusRowId(null)
        return
      }
      if (detail && typeof detail === 'object') {
        if (detail.tabId) navigate(detail.tabId)
        setFocusRowId(detail.rowId ?? null)
      }
    }
    window.addEventListener('yfe:navigate', onNav as EventListener)
    return () => window.removeEventListener('yfe:navigate', onNav as EventListener)
  }, [navigate])

  const onStatsChange = useCallback(() => {
    setRefreshKey(k => k + 1)
  }, [])


  // 启动失败：给一页能读懂的错误 + 一个重试入口，而不是永远停在黑屏上
  if (bootError) {
    return (
      <>
        <DesktopWriteLockBanner />
        <div className="flex h-screen flex-col items-center justify-center gap-3 p-8 text-center">
          <div className="text-base font-semibold">启动失败</div>
          <div className="max-w-xl text-13 leading-relaxed text-ink-400">{bootError}</div>
          <Button variant="secondary" onClick={() => location.reload()}>重新加载</Button>
          <div className="max-w-xl text-12 text-ink-500">
            若反复失败，请先备份数据文件（左下角「数据坞」），再重新加载。
          </div>
        </div>
      </>
    )
  }

  if (!booted) {
    return (
      <>
        <DesktopWriteLockBanner />
        <div className="h-screen bg-ink-950" />
      </>
    )
  }

  // 项目未打开：首次使用先走首启向导（2.4.0 · A1），其余情况进项目管理页
  if (!projectId) {
    return (
      <>
        <DesktopWriteLockBanner />
        {needWelcome ? <WelcomeWizard onDone={onWelcomeDone} /> : <ProjectHub onOpen={openProject} />}
        {/* 左下角统一「数据坞」：本机存储 + 云盘文件同步 + 网页版同步三合一（#032）。
            此前三者各画一个 fixed 浮层，定位/层级/圆角都不一致，桌面版会互相遮挡。 */}
        <DataDock />
      </>
    )
  }

  const renderContent = () => {
    if (activeTab === 'dashboard') {
      return <Dashboard onNavigate={navigate} refreshKey={refreshKey} ctx={visCtx} />
    }
    const guardTab = getTab(activeTab)
    if (guardTab && !tabVisible(guardTab.id, visCtx)) {
      return <Dashboard onNavigate={navigate} refreshKey={refreshKey} ctx={visCtx} />
    }
    if (activeTab === 'editor') {
      return <NovelEditor onStatsChange={onStatsChange} onNavigate={navigate} onOpenSearch={() => setSearchOpen(true)} projectName={projectName} openChapterId={editorTarget} ctx={visCtx} />
    }
    if (activeTab === 'model-settings') {
      return <ModelSettingsPanel />
    }
    if (activeTab === 'inspire-tools') {
      return <InspireTools />
    }
    if (activeTab === 'check-tools') {
      return <CheckTools />
    }
    if (activeTab === 'material-library') {
      return <MaterialLibrary />
    }
    if (activeTab === 'bookbreak') {
      return <BookBreakPanel />
    }
    if (activeTab === 'creative-writing') {
      return <CreativeWritingPanel />
    }
    if (activeTab === 'tavern-world') {
      return <TavernWorld />
    }
    if (activeTab === 'tavern-plot') {
      return <TavernPlot />
    }
    if (activeTab === 'tavern-report') {
      return <TavernReport />
    }
    if (activeTab === 'tavern-card') {
      return <TavernCard />
    }
    if (activeTab === 'tavern-script') {
      return <TavernScript />
    }
    if (activeTab === 'tavern-free') {
      return <TavernFree />
    }
    if (activeTab === 'tavern-control') {
      return <div className="p-6"><TavernControl /></div>
    }
    if (activeTab === 'guide') {
      return <GuidePage onNavigate={navigate} ctx={visCtx} />
    }
    const tab = getTab(activeTab)
    if (!tab) return <div className="p-8">页签不存在</div>
    switch (tab.type) {
      case 'form':
        return <FormSheet key={tab.id} tab={tab} />
      case 'table':
        return <TableSheet key={tab.id} tab={tab} onNavigate={navigate} ctx={visCtx} focusRowId={focusRowId} onFocusConsumed={clearFocusRow} />
      case 'card':
        // 大纲规划下的卡片页签（分卷大纲/章节细纲）使用多记录目录管理组件
        return tab.group === '大纲规划'
          ? <OutlineSheet key={tab.id} tab={tab} />
          // focusRowId 也要下发：card 类页签（主要/次要/NPC 角色）同样会被报告指向（审计 P1-5）
          : <CharacterSheet key={tab.id} tab={tab} focusRowId={focusRowId} onFocusConsumed={clearFocusRow} />
      case 'about':
        return <AboutPage />
      case 'map':
        return <GeoMapEditor tab={tab} />
      case 'canvas':
        return <PlotCanvas tab={tab} />
      default:
        return <div className="p-8">未知页签类型</div>
    }
  }

  const isEditor = activeTab === 'editor'

  return (
    <div key={`proj-${projectId}`} className="relative flex h-screen overflow-hidden bg-transparent">
      <DesktopWriteLockBanner />
      {/* v1.3 幻想工作台背景：纯线条浅金线稿，透明底、若隐若现。
          负 z-index 子元素绘制于 body 背景之上、半透明面板之下，故可从面板后透出；
          父容器设为 bg-transparent，避免不透明背景把装饰层盖住；
          主题色由 CSS 变量驱动，切换主题时底色随变；pointer-events-none 不挡交互，层级远低于弹窗(z-50) */}
      <div
        className="absolute inset-0 -z-10 pointer-events-none bg-cover bg-center bg-no-repeat opacity-100"
        style={{ backgroundImage: `url(${workbenchBg})` }}
        aria-hidden
      />
      <Sidebar
        activeTab={activeTab}
        onNavigate={navigate}
        collapsed={false}
        projectName={projectName}
        onExitProject={exitProject}
        onExport={exportCurrent}
        ctx={visCtx}
      />
      <main className={`flex-1 overflow-y-auto ${isEditor ? '!overflow-hidden' : 'p-6 lg:p-8'}`}>
        <Suspense fallback={<div className="h-full w-full flex items-center justify-center text-ink-500 text-sm">加载中…</div>}>
          {renderContent()}
        </Suspense>
      </main>
      {/* 本机存储 / 云盘同步状态在「项目内」由 Sidebar Footer 内嵌承载，
          不再使用全局 fixed 浮层——避免压住侧栏底部的「界面缩放 / 主题」等控件。 */}
      {/* 颉文姬桌面精灵：全局右缘驻留（可在 AI 编辑面板底部开关关闭） */}
      {spriteEnabled && <JieWenJiSprite isEditor={activeTab === 'editor'} onNavigate={navigate} />}
      {searchOpen && (
        <FullTextSearch
          onClose={() => setSearchOpen(false)}
          onOpenChapter={(id) => { setSearchOpen(false); navigate('editor', id) }}
          onNavigateTab={(tabId) => { setSearchOpen(false); navigate(tabId) }}
          ctx={visCtx}
        />
      )}
      {/* #031 定期提醒把数据导出到外部文件。 */}
      <BackupReminder hasProject={!!projectId} onExport={exportCurrent} />
    </div>
  )
}
