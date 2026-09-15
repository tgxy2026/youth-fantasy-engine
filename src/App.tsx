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
import { ensureDailyBackup, startAutoBackup } from './lib/backup'
import { PORTABLE, getState, subscribe, flushNow } from './lib/portable'
import { DESKTOP, initDesktopStore, flushDesktopSync, getDesktopState, subscribeDesktop } from './lib/desktop'
import { DesktopWriteLockBanner } from './components/DesktopWriteLockBanner'
import { PortableGate } from './components/Portable'
import { WEB } from './lib/env'
import WebGate, { checkInvited } from './components/WebGate'
import DataDock from './components/DataDock'
import PrivacyNotice from './components/PrivacyNotice'
import LocalDataNotice from './components/LocalDataNotice'
import BackupReminder from './components/BackupReminder'
import { markExported } from './lib/backupReminder'
import { createDemoProject } from './lib/seedData'
import FullTextSearch from './components/FullTextSearch'
import JieWenJiSprite from './components/JieWenJiSprite'
import GeoMapEditor from './components/GeoMapEditor'
import PlotCanvas from './components/PlotCanvas'
import { showToast } from './components/dialogs'
import { Button } from './components/Button'
import { applyTheme, applyZoom, getStoredTheme, getStoredZoom } from './lib/theme'
import { LS_SPRITE_ENABLED } from './lib/constants'
import { downloadBlob } from './lib/zip'
import workbenchBg from './assets/workbench-bg.png'

// 次级页签按需懒加载：把向导页 / 灵感启发·检查工具（含 AI 组件与大量交互）从首屏主包拆出去，
// 仅在用户切到对应页签时才加载对应 chunk。Sidebar/仪表盘/编辑器保持常驻以保证首屏速度。
const GuidePage = lazy(() => import('./components/GuidePage'))
const InspireTools = lazy(() => import('./components/InspireTools'))
const CheckTools = lazy(() => import('./components/CheckTools'))
const MaterialLibrary = lazy(() => import('./components/MaterialLibrary'))
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
  // 从其他页签（如章节总表）跳转正文编辑时，要直达打开的章节 id
  const [editorTarget, setEditorTarget] = useState<string | null>(null)
  // 数据体检 / 地图等跨组件跳转时，要直达高亮的具体行 id（detail 携带 rowId 时下发）
  const [focusRowId, setFocusRowId] = useState<string | null>(null)
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
  // 便携模式：U 盘数据文件连接状态（桌面模式：本地数据文件加载完成状态）
  const [fileReady, setFileReady] = useState(!PORTABLE && !DESKTOP)

  // 便携模式下订阅数据文件状态（连接 / 写盘）；桌面模式下从本地用户数据目录加载数据
  useEffect(() => {
    if (PORTABLE) {
      setFileReady(getState().connected)
      return subscribe(() => setFileReady(getState().connected))
    }
    if (DESKTOP) {
      let alive = true
      void initDesktopStore().then(() => { if (alive) setFileReady(true) })
      return () => { alive = false }
    }
  }, [])

  // 便携 / 桌面模式：关闭页面前确保未保存的修改写盘
  useEffect(() => {
    if (!PORTABLE && !DESKTOP) return

    // 便携版：FSA 只有异步 API，页面真卸载后未完成的写入会被直接中断，
    // 所以不能只守 beforeunload——那是最后一道闸，往往已经来不及。
    // visibilitychange(hidden) 与 pagehide 在关闭、刷新、切标签、最小化前
    // 都会先触发，此刻页面仍存活，提前 flush 能争取到完成写入的时间窗。
    const flushPending = () => {
      if (PORTABLE && getState().dirty) flushNow()
    }
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushPending() }

    const onLeave = (e: BeforeUnloadEvent) => {
      if (PORTABLE) {
        const s = getState()
        if (s.dirty || s.saving) {
          flushNow()
          e.preventDefault()
        }
      } else {
        // 桌面模式：同步写盘（阻塞式，保证窗口关闭前数据落盘）
        flushDesktopSync()
      }
    }

    if (PORTABLE) {
      document.addEventListener('visibilitychange', onVisibility)
      window.addEventListener('pagehide', flushPending)
    }
    window.addEventListener('beforeunload', onLeave)
    return () => {
      if (PORTABLE) {
        document.removeEventListener('visibilitychange', onVisibility)
        window.removeEventListener('pagehide', flushPending)
      }
      window.removeEventListener('beforeunload', onLeave)
    }
  }, [])

  // 便携 / 桌面模式：磁盘写盘失败时把原本静默吞掉的错误暴露给用户，避免无提示丢稿
  useEffect(() => {
    if (!PORTABLE && !DESKTOP) return
    let lastErr = ''
    const onPortable = () => {
      const e = getState().lastError
      if (e && e !== lastErr) { lastErr = e; showToast('数据保存失败：' + e, 'error', 4500) }
      else if (!e) lastErr = ''
    }
    const onDesktop = () => {
      const e = getDesktopState().lastError
      if (e && e !== lastErr) { lastErr = e; showToast('数据保存失败：' + e, 'error', 4500) }
      else if (!e) lastErr = ''
    }
    if (PORTABLE) { onPortable(); return subscribe(onPortable) }
    onDesktop(); return subscribeDesktop(onDesktop)
  }, [])

  // 启动时恢复上次打开的项目（便携模式需等数据文件连接后执行）
  useEffect(() => {
    if (!fileReady) return
    ;(async () => {
      // 🔴 整段兜底：旧实现没有 try/catch，任何一步 reject（IndexedDB 打不开、
      //    迁移抛错、读 meta 失败）都会让 setBooted(true) 执行不到 —— 界面永远黑屏，
      //    既不报错也没有重试入口。finally 保证一定会离开黑屏。
      try {
      const last = await db.getMeta('lastProject', '')
      await db.migrateProjectTypes() // 清理历史遗留的 lite/minimal 项目形态
      // 酒馆示范角色卡：示例对话升到 v1.2 的输出规范（幂等；与旧种子全等才换，
      // 作者改过的一律不动）。放在这里而不是播种处 —— 播种只在空库跑一次，
      // 老用户的库早已有卡，升级必须在每次启动时补一遍。
      try {
        const { upgradeSeedCards } = await import('./lib/tavern/seedCards')
        await upgradeSeedCards()
      } catch (e) { console.warn('[boot] 示范卡格式升级失败：', e) }
      // 首次启动且存储为空：自动创建示范项目「吞天神脉（示范）」，引导新用户了解全模块功能
      // 🔴 写盘被锁（数据文件没读出来）时**不播种**：此刻内存是空库，
      //    播种只会制造"好像有数据"的假象，还可能被误存回去覆盖原文件。
      const desktopWriteLocked = DESKTOP && getDesktopState().writeLocked
      if (!last && !desktopWriteLocked) {
        const existing = await db.getAllProjects().catch(() => [])
        if (existing.length === 0) {
          try { await createDemoProject() } catch (e) { console.warn('[boot] 自动创建示范项目失败：', e) }
        }
      }
      if (last) {
        const p = await db.getProject(last)
        if (p) {
          db.setCurrentProject(p.id)
          // 结构迁移统一入口（幂等）：必须放在 setCurrentProject 之后——迁移函数读的是当前项目。
          // 修复审计 P1-7：「启动恢复上次项目」这条路径此前只跑了 migrateProjectTypes，
          // 漏掉 ledger 拆表与全局编号，导致自动回到上次项目时台账/检索读到旧结构。
          await db.runMigrations()
          await refreshVolumeTabs()
          setProjectId(p.id)
          setProjectName(p.name)
          setVisCtx({ type: p.projectType ?? 'full', features: p.features ?? [] })
          // 与 openProject 一致的备份策略：自动恢复上次项目时也要启动自动备份，
          // 否则「关掉再开 → 回到上次项目」这条最常用路径完全没有滚动/每日备份安全网
          void ensureDailyBackup(p.id)
          backupStop.current?.()
          backupStop.current = startAutoBackup(p.id)
        }
      }
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

  // 便携模式且数据文件未连接 → 启动选择页
  if (PORTABLE && !fileReady) return <PortableGate />
  // 网页体验版（邀请制）→ 未通过邀请码前拦截
  if (WEB && !checkInvited()) return <WebGate />

  // 启动失败：给一页能读懂的错误 + 一个重试入口，而不是永远停在黑屏上
  if (bootError) {
    return (
      <>
        <DesktopWriteLockBanner />
        <div className="flex h-screen flex-col items-center justify-center gap-3 p-8 text-center">
          <div className="text-base font-semibold">启动失败</div>
          <div className="max-w-xl text-[13px] leading-relaxed text-ink-400">{bootError}</div>
          <Button variant="secondary" onClick={() => location.reload()}>重新加载</Button>
          <div className="max-w-xl text-[12px] text-ink-500">
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

  // 项目未打开 → 项目管理页
  if (!projectId) {
    return (
      <>
        <DesktopWriteLockBanner />
        <ProjectHub onOpen={openProject} />
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
    if (activeTab === 'inspire-tools') {
      return <InspireTools />
    }
    if (activeTab === 'check-tools') {
      return <CheckTools />
    }
    if (activeTab === 'material-library') {
      return <MaterialLibrary />
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
        return <TableSheet key={tab.id} tab={tab} onNavigate={navigate} ctx={visCtx} focusRowId={focusRowId} onFocusConsumed={() => setFocusRowId(null)} />
      case 'card':
        // 大纲规划下的卡片页签（分卷大纲/章节细纲）使用多记录目录管理组件
        return tab.group === '大纲规划'
          ? <OutlineSheet key={tab.id} tab={tab} />
          : <CharacterSheet key={tab.id} tab={tab} />
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
      {WEB && <PrivacyNotice />}
      {/* 网页体验版本地数据保存提醒：未开启任何云端同步时每次打开网页弹出
          （#032：服务器模式无同步码 / 云盘文件模式未选目录，均视为未开启） */}
      {WEB && <LocalDataNotice />}
      {/* #031 定期提醒把数据导出到外部文件（三端通用）。
          网页版未开启云端同步时 LocalDataNotice 每次都会弹且已含导出指引，BackupReminder 会主动让位。 */}
      <BackupReminder hasProject={!!projectId} onExport={exportCurrent} />
    </div>
  )
}
