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
import { PORTABLE, getState, subscribe, flush } from './lib/portable'
import { DESKTOP, initDesktopStore, flushDesktopSync, getDesktopState, subscribeDesktop } from './lib/desktop'
import { PortableGate } from './components/Portable'
import { WEB } from './lib/env'
import WebGate, { checkInvited } from './components/WebGate'
import DataDock from './components/DataDock'
import PrivacyNotice from './components/PrivacyNotice'
import LocalDataNotice from './components/LocalDataNotice'
import FullTextSearch from './components/FullTextSearch'
import JieWenJiSprite from './components/JieWenJiSprite'
import GeoMapEditor from './components/GeoMapEditor'
import PlotCanvas from './components/PlotCanvas'
import { showToast } from './components/dialogs'
import { applyTheme, applyZoom, getStoredTheme, getStoredZoom } from './lib/theme'
import { downloadBlob } from './lib/zip'
import workbenchBg from './assets/workbench-bg.png'

// 次级页签按需懒加载：把向导页 / 灵感启发·检查工具（含 AI 组件与大量交互）从首屏主包拆出去，
// 仅在用户切到对应页签时才加载对应 chunk。Sidebar/仪表盘/编辑器保持常驻以保证首屏速度。
const GuidePage = lazy(() => import('./components/GuidePage'))
const InspireTools = lazy(() => import('./components/InspireTools'))
const CheckTools = lazy(() => import('./components/CheckTools'))
const MaterialLibrary = lazy(() => import('./components/MaterialLibrary'))

export default function App() {
  const [projectId, setProjectId] = useState<string | null>(null)
  const [projectName, setProjectName] = useState('')
  const [visCtx, setVisCtx] = useState<VisCtx>({ type: 'full', features: [] })
  const [activeTab, setActiveTab] = useState('dashboard')
  const [refreshKey, setRefreshKey] = useState(0)
  const [booted, setBooted] = useState(false)
  // 从其他页签（如章节总表）跳转正文编辑时，要直达打开的章节 id
  const [editorTarget, setEditorTarget] = useState<string | null>(null)
  // 数据体检 / 地图等跨组件跳转时，要直达高亮的具体行 id（detail 携带 rowId 时下发）
  const [focusRowId, setFocusRowId] = useState<string | null>(null)
  // 全文检索命令面板（v1.3）：Ctrl/Cmd+K 唤起
  const [searchOpen, setSearchOpen] = useState(false)
  // 颉文姬 Q 版精灵开关（面板内可切换，localStorage 持久化）
  const [spriteEnabled, setSpriteEnabled] = useState(() => localStorage.getItem('yfe-sprite-enabled') !== '0')
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
    const onLeave = (e: BeforeUnloadEvent) => {
      if (PORTABLE) {
        const s = getState()
        if (s.dirty || s.saving) {
          void flush()
          e.preventDefault()
        }
      } else {
        // 桌面模式：同步写盘（阻塞式，保证窗口关闭前数据落盘）
        flushDesktopSync()
      }
    }
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
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
      const last = await db.getMeta('lastProject', '')
      if (last) {
        const p = await db.getProject(last)
        if (p) {
          db.setCurrentProject(p.id)
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
      setBooted(true)
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
    // 按卷建表：旧项目打开时把单表章节总表迁移为各卷分表，并刷新侧栏卷缓存
    await db.migrateChapterLedger()
    // 1.9.2：章节号改为全局连续（幂等，已是正确的就不写库）
    await db.migrateChapterNumbering()
    await refreshVolumeTabs()
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

  if (!booted) return <div className="h-screen bg-ink-950" />

  // 项目未打开 → 项目管理页
  if (!projectId) {
    return (
      <>
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
      {/* 网页体验版本地数据保存提醒：未配置同步码时每次打开网页弹出（详见组件内注释） */}
      {WEB && <LocalDataNotice />}
    </div>
  )
}
