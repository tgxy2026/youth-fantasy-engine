import ResizeHandle from '@/components/common/ResizeHandle'
import { Z } from '@/lib/app/zLayer'
import { BookOpen, ChevronDown, ChevronRight, ChevronUp, Users, Globe, Map, PenTool, Activity, Wrench, LayoutDashboard, ArrowLeft, Upload, Sparkles, Palette, SlidersHorizontal, ZoomIn, ZoomOut, FolderPlus, Trash2, Beer, Maximize2, Image as ImageIcon, Type, Compass, X, BookText } from 'lucide-react'
import { getTabIcon, getTabSubtitle } from '@/components/app/sidebarTabMeta'
import BrandMark from '@/components/common/BrandMark'
import BackToSource, { type ReturnSource } from '@/components/app/BackToSource'
import HelpPopover from '@/components/common/HelpPopover'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import NumberField from '@/components/common/NumberField'
import { useState, useEffect, useRef } from 'react'
import { GROUPS, TABS, EDITOR_TAB, tabVisible, getVolumeTabs, getVolumeLedgerTabId, getVolumeIdFromLedgerTab, refreshVolumeTabs, type VisCtx } from '@/lib/schema'
import type { TabDef } from '@/lib/types'
import * as db from '@/lib/db'
import { uid } from '@/lib/app/id'
import { nextVolumeNo, nextVolumeOrder, isFreeVolume } from '@/lib/outline/freeVolume'
import { THEMES, applyTheme, applyZoom, getStoredTheme, getStoredZoom, autoZoom, isZoomAuto, getStoredCustomTheme, foldVh } from '@/lib/settings/theme'
import { DESKTOP } from '@/lib/app/desktop'
import { useAppFullscreen } from '@/lib/app/useAppFullscreen'
import { DesktopDataBar } from '@/components/app/Desktop'
import { PortableDataBar } from '@/components/app/Portable'
import { WebDataBar } from '@/components/app/Web'
import { GuestDataBar } from '@/components/app/Guest'
import { WEB, WEB_ACCOUNT_LOCAL } from '@/lib/app/platform'
import { GUEST } from '@/lib/db/guestData'
import CloudFileSyncBar from '@/components/app/CloudFileSyncBar'
import BossKeySettings from '@/components/app/BossKeySettings'
import DesktopCloudAccount from '@/components/app/DesktopCloudAccount'
import CloudSyncPanel from '@/components/app/CloudSyncPanel'
import { CLOUD_FILE_SYNC } from '@/lib/sync/desktopCloudSync'
import { PORTABLE } from '@/lib/storage/fileBackend'
import { useResizable } from '@/lib/app/useResizable'
import { usePersistedBool, usePersistedSet } from '@/lib/settings/uiPrefs'
import { APP_VERSION_LABEL } from '@/lib/app/env'
import { Button } from '@/components/common/Button'
import CustomThemeDialog from '@/components/settings/CustomThemeDialog'
import FontSettingsDialog from '@/components/settings/FontSettingsDialog'
import DensityControl from '@/components/settings/DensityControl'
import BackupReminder from '@/components/app/BackupReminder'
import { isDemoProjectName } from '@/lib/constants'

const GROUP_ICONS: Record<string, React.ReactNode> = {
  '工作面板': <LayoutDashboard size={15} />,
  '正文写作': <PenTool size={15} />,
  '灵感工具': <Sparkles size={15} />,
  '开书定位': <BookOpen size={15} />,
  '角色管理': <Users size={15} />,
  '世界构建': <Globe size={15} />,
  '大纲规划': <Map size={15} />,
  '创作管理': <Activity size={15} />,
  '运营维护': <Wrench size={15} />,
  '酒馆模式': <Beer size={15} />,
}

interface Props {
  /** 窄窗口的导航抽屉使用父容器宽度，不沿用桌面拖拽宽度。 */
  overlay?: boolean
  focusTools?: boolean
  returnSource?: ReturnSource
  activeTab: string
  onNavigate: (id: string) => void
  onOpenSearch?: () => void
  /** 桌面端：由图标轨底部设置键从左向右弹出的「界面与数据」浮层 */
  toolsOpen?: boolean
  onCloseTools?: () => void
  /** 桌面双层工坊导航联动：当前图标轨选中的分组与展示模式 */
  focusGroup?: string | null
  navMode?: 'focus' | 'all'
  onToggleNavMode?: () => void
  collapsed: boolean
  projectName: string
  onExitProject: () => void
  onExport: () => void
  /** 可见性上下文：项目形态 + 自定义项目启用的功能全集，驱动页签显隐与基础设施开关 */
  ctx: VisCtx
  /**
   * 3.3.1 · P2/P3：「本页指引」入口。由 App 传入 —— 只有**当前页签有引导**且不由页面组件自己
   * 托管时才传，避免同一个按钮在页头和侧栏各出现一次。
   */
  onPageGuide?: () => void
}

export default function Sidebar({ activeTab, onNavigate, focusGroup, navMode = 'all', onToggleNavMode, collapsed, projectName, onExitProject, onExport, ctx, overlay = false, focusTools = false, toolsOpen = false, onCloseTools, returnSource, onPageGuide }: Props) {
  // 折叠状态**跨会话记忆**（见 lib/uiPrefs）：
  //   · 分组存的是「已折叠的分组」而不是「已展开的分组」→ 以后新增分组时，
  //     老用户的记录里没有它，落回默认值（展开）；反之新分组一上来就是收起的，很别扭。
  //   · 首次安装（无记录）＝空集合＝全部分组展开，符合"第一眼看到全部功能"。
  const [collapsedGroups, updateCollapsedGroups] = usePersistedSet('sidebar-collapsed-groups')
  const [volOpen, setVolOpen] = usePersistedBool('sidebar-volume-open', true)
  // 🔴 B6（2026-09-22 老大新增）：左下角工具栏可折叠。
  //   与上面两条同一个原则 —— **存「偏离默认的那一侧」**：默认是展开，所以只记「用户把它收了」。
  //   收起的收益：Footer 高度归零，上方 `<nav className="flex-1">` 自动吃掉释放的空间
  //   （这就是老大要的"菜单栏自然延伸"，靠既有的 flex 布局天然实现，不需要额外量高度）。
  //   ⚠️ 键与项目管理页的 `DataDock` **共用**（`dock-collapsed`）—— 两者是同一个「左下角工具栏」
  //   在"有侧栏 / 无侧栏"两种形态下的呈现，共用一个记忆才符合直觉（在哪页收起，换页也是收起的）。
  const [footerCollapsed, setFooterCollapsed] = usePersistedBool('dock-collapsed', false)
  const [appearanceOpen, setAppearanceOpen] = usePersistedBool('sidebar-appearance-open', false)
  const toolsRef = useRef<HTMLDivElement>(null)
  const flyoutRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!focusTools) return
    setFooterCollapsed(false)
    const frame = requestAnimationFrame(() => toolsRef.current?.scrollIntoView({ block: 'end' }))
    return () => cancelAnimationFrame(frame)
  }, [focusTools, setFooterCollapsed])
  useEffect(() => {
    if (overlay || !toolsOpen || !onCloseTools) return
    const onDown = (e: MouseEvent) => {
      const el = e.target as Element | null
      if (el?.closest('[data-settings-trigger], [role="dialog"], [role="menu"]')) return
      if (flyoutRef.current && !flyoutRef.current.contains(e.target as Node)) onCloseTools()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) onCloseTools()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [overlay, toolsOpen, onCloseTools])
  // 主题与界面缩放（与 <html data-theme> / zoom 同步）
  const [theme, setTheme] = useState(getStoredTheme())
  const [zoom, setZoom] = useState(getStoredZoom())
  // 「跟随窗口」模式：窗口尺寸变化时缩放会被自动重算（见 App.tsx 的 resize 监听）
  const [zoomAuto, setZoomAuto] = useState(isZoomAuto())
  const [customThemeOpen, setCustomThemeOpen] = useState(false)
  // 字体设置弹窗（2026-09-28 · 社区需求）：正文编辑器 + 界面全站两口
  const [fontOpen, setFontOpen] = useState(false)
  const changeTheme = (id: typeof theme) => setTheme(applyTheme(id))
  /** 手动调整即退出跟随模式，此后只认这个值 */
  const changeZoom = (d: number) => {
    setZoom(applyZoom(zoom + d, { manual: true }))
    setZoomAuto(false)
  }
  /** 切回「跟随窗口」：按当前窗口宽度重算 */
  const toAutoZoom = () => {
    setZoom(applyZoom(autoZoom(), { manual: false }))
    setZoomAuto(true)
  }
  // 界面缩放的手动输入已改走 NumberField（U-1 · 2.6.0）——原 zoomText/commitZoom 中间态随之删除
  // 缩放在别处被自动重算时（跟随窗口），让本组件的显示同步过来
  useEffect(() => {
    const onZoom = (e: Event) => {
      const z = (e as CustomEvent<number>).detail
      if (typeof z === 'number') { setZoom(z); setZoomAuto(isZoomAuto()) }
    }
    window.addEventListener('yfe:zoom-changed', onZoom)
    return () => window.removeEventListener('yfe:zoom-changed', onZoom)
  }, [])
  // 侧栏宽度可拖拽调整
  const sidebar = useResizable({ key: 'yfe-sidebar-w', initial: 224, initialWide: 300, min: 224, max: 560, side: 'right' })

  // 卷台账子项：从运行期缓存读取（编辑器增删改卷后会刷新缓存并广播事件）
  const [volumeTabs, setVolumeTabs] = useState(getVolumeTabs())
  useEffect(() => {
    let alive = true
    const refresh = () => { if (alive) setVolumeTabs(getVolumeTabs()) }
    void refreshVolumeTabs().then(refresh)
    const onVol = () => refresh()
    window.addEventListener('yfe:volumes-changed', onVol)
    return () => { alive = false; window.removeEventListener('yfe:volumes-changed', onVol) }
  }, [])

  /** 在「章节总表」下新建一卷（= 一张新的章节台账表），建完直接跳进该卷 */
  const createVolume = async () => {
    // 🔴 序号 / order 只数真卷：自由卷不占卷号，且它 order 是哨兵值（恒排最前），
    //    拿 volumeTabs.length 当基准会让新卷排到自由卷后面（见 lib/freeVolume.ts）
    const vols = await db.getAllVolumes()
    const n = nextVolumeNo(vols)
    const vol = { id: uid(), projectId: db.getCurrentProjectId(), order: nextVolumeOrder(vols), title: `第${n}卷`, description: '', createdAt: Date.now() }
    await db.saveVolume(vol)
    await refreshVolumeTabs()
    setVolumeTabs(getVolumeTabs())
    window.dispatchEvent(new Event('yfe:volumes-changed'))
    onNavigate(getVolumeLedgerTabId(vol.id))
  }

  /** 在「章节总表」下删除一卷（= 删掉该卷的章节台账表 + 卷记录，章节移入回收站可恢复） */
  const removeVolume = async (vol: TabDef) => {
    // vol.id 是卷台账 tabId（chapter-vol-<真实卷id>），须反解出真实卷库 id 再删，否则按 tabId 查 volumes 库会查无此键、静默失败
    const volumeId = getVolumeIdFromLedgerTab(vol.id)
    // 🔴 自由卷是系统保留的托管卷：删它会级联把里面的自由章节全推进回收站（卷删除在存储层是级联的）
    if (isFreeVolume((await db.getAllVolumes()).find(v => v.id === volumeId))) {
      showToast('「自由章节」是托管未归类章节的系统保留卷，不能删除', 'error')
      return
    }
    if (!await confirmDialog({ title: '删除分卷', message: `此操作会同时删除【章节总表】与【正文编辑·章节管理】两处的分卷「${vol.name}」及其全部章节，数据将移入回收站（可恢复）。确定要删除吗？`, danger: true })) return
    await db.deleteVolume(volumeId)
    await refreshVolumeTabs()
    setVolumeTabs(getVolumeTabs())
    window.dispatchEvent(new Event('yfe:volumes-changed'))
    if (activeTab === vol.id) onNavigate('chapter-master')
  }

  const toggleGroup = (g: string) => {
    updateCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(g)) next.delete(g); else next.add(g)
      return next
    })
  }

  const toolsContent = (
    <>
      {/* 导出备份提示（3.5.1 · U4）：不再弹全屏 Modal，改成这块工具栏里的内联提示条。
          只在「确实很久没导出 + 有真实作品」时出现；示范项目不提醒。 */}
      <BackupReminder variant="sidebar" hasProject isDemo={isDemoProjectName(projectName)} onExport={onExport} />
      {/* 3.5.6：任务列表已拆为独立页签「工作面板 → 后台任务」；此处不再内嵌（见 TaskCenterPanel）。 */}
      {/* 低频外观设置按需展开，主题/字体/全屏不再常驻堆在缩放周围。 */}
      <section className="rounded-lg border border-ink-700/70 bg-ink-850/60">
        <Button variant="bare" onClick={() => setAppearanceOpen(!appearanceOpen)}
          aria-label={appearanceOpen ? '收起外观设置' : '展开外观设置'} aria-expanded={appearanceOpen}
          className="flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-11 text-ink-300 hover:text-amber">
          <Palette size={12} className="shrink-0" />
          <span>外观设置</span>
          <span className="ml-auto truncate text-ink-500">{THEMES.find(t => t.id === theme)?.name}</span>
          <ChevronDown size={11} className={`shrink-0 transition-transform ${appearanceOpen ? 'rotate-180' : ''}`} />
        </Button>
        <div className={`space-y-2 px-2 pb-2 ${appearanceOpen ? '' : 'hidden'}`}>
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="text-11 text-ink-400">主题与字体</span>
          {/* 字体设置入口（2026-09-28 · 社区需求）：正文编辑器 + 界面全站两口 */}
          <Button
            variant="ghost" iconOnly size="xs" type="button"
            onClick={() => setFontOpen(true)}
            title="字体设置（正文编辑器与界面）"
            aria-label="字体设置"
            className="ml-auto -mr-1"
          >
            <Type size={11} />
          </Button>
          {/* 自定义主题入口（2.5.0 · C1）：总是打开弹窗（已存参数则载入当前参数继续调） */}
          <Button
            variant="ghost" iconOnly size="xs" type="button"
            onClick={() => setCustomThemeOpen(true)}
            title="自定义主题（母版 + 强调色 + 色相偏移）"
            aria-label="自定义主题"
            className="-mr-1"
          >
            <SlidersHorizontal size={11} />
          </Button>
        </div>
        <div className="grid grid-cols-5 justify-items-center gap-2">
          {THEMES.map(t => (
            <Button variant="bare"
              key={t.id}
              aria-label={`${t.name}主题`}
              aria-pressed={theme === t.id}
              title={t.id === 'custom'
                ? `${t.name}（${t.desc}）—— 点这里${getStoredCustomTheme() ? '切换，旁边的滑杆图标可调整参数' : '开始配置'}`
                : `${t.name}（${t.desc}）`}
              onClick={() => {
                // custom 圆点：已有参数直接切换生效；首次（无参数）打开配置弹窗
                if (t.id === 'custom' && !getStoredCustomTheme()) setCustomThemeOpen(true)
                else changeTheme(t.id)
              }}
              className={`w-5 h-5 rounded-full border transition-transform hover:scale-110 ${theme === t.id ? 'border-amber ring-1 ring-amber/50' : 'border-ink-600'}`}
              style={{ background: t.swatch }}
            />
          ))}
        </div>
        <AppearanceToggles />
        </div>
      </section>

      {/* 缩放标题与操作固定分两行，避免侧栏宽度或缩放变化时随机折行。 */}
      <div className="space-y-1.5" data-zoom-panel>
        <div className="flex items-center justify-between gap-2 text-11 text-ink-300">
        <span className="flex shrink-0 items-center gap-1">界面缩放
          <HelpPopover title="界面缩放怎么用" width="20rem" size={11}>
            {'调整整个软件的字号与元素大小（80%–160%）。\n\n· 默认「跟随窗口」：按窗口宽度自动取一个舒适值，窗口大小变化时自动重算，大屏不再卡在 100%；\n· 用 +/− 或直接输入百分比即视为手动指定，此后不再自动适配；点「自动」可切回跟随；\n· 设置保存在本地，下次打开沿用；\n· 缩放与主题切换相互独立，互不影响。'}
          </HelpPopover>
        </span>
        </div>
        <div className="flex w-full flex-wrap items-center gap-x-1 gap-y-1">
        <div className="flex min-w-0 flex-1 items-center justify-between gap-1 rounded-lg border border-ink-700 bg-ink-800/40 px-1 py-1">
        <Button variant="toggle" size="xs" selected={zoomAuto} aria-label="跟随窗口自动调整" aria-pressed={zoomAuto} onClick={toAutoZoom} className="shrink-0 !px-1.5 !text-11"
          title={zoomAuto ? '当前为「跟随窗口」模式（窗口尺寸变化时自动重算）' : '切回「跟随窗口」：按当前窗口宽度重新适配'}>
          自动
        </Button>
          {/* 数值组：− / 比例 / % / + 整体靠右，与左边的「自动」分列两端 */}
          <span className="flex min-w-0 items-center gap-0.5">
          <Button variant="icon-amber" size="xs" onClick={() => changeZoom(-10)} aria-label="缩小界面" title="缩小界面（按 10% 递减）" className="!min-w-6">
            <ZoomOut size={12} />
          </Button>
          <span className="flex min-w-0 items-center justify-center gap-1">
            <NumberField
              value={zoom}
              onChange={(v) => { if (typeof v === 'number') { setZoom(applyZoom(v, { manual: true })); setZoomAuto(false) } }}
              min={80}
              max={160}
              ariaLabel="界面缩放百分比"
              title="手动输入缩放比例（80%–160%），回车或失焦生效"
              className="h-6 w-9 !px-1 !py-0 !rounded-lg text-11 text-center tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <span className="text-ink-400 text-11">%</span>
          </span>
          <Button variant="icon-amber" size="xs" onClick={() => changeZoom(10)} aria-label="放大界面" title="放大界面（按 10% 递增）" className="!min-w-6">
            <ZoomIn size={12} />
          </Button>
          </span>
        </div>
        <DensityControl inline />
        </div>
      </div>
      {DESKTOP && <DesktopDataBar />}
      {WEB ? (GUEST || WEB_ACCOUNT_LOCAL ? <GuestDataBar /> : <WebDataBar />) : PORTABLE && <PortableDataBar />}
      {CLOUD_FILE_SYNC && <CloudFileSyncBar variant="sidebar" />}
      {DESKTOP && <DesktopCloudAccount />}
      {DESKTOP && <CloudSyncPanel inline />}
      <Button variant="secondary" size="xs" onClick={onPageGuide}
        disabled={!onPageGuide}
        className="w-full !justify-start gap-1.5"
        title={onPageGuide
          ? '分步认识当前页签（随时可重看，不新建记录、不改数据）'
          : '当前页签没有分步指引'}>
        <Compass size={12} /> 本页指引
        {!onPageGuide && <span className="ml-auto text-11 text-ink-600">此页无</span>}
      </Button>
      <BossKeySettings />
    </>
  )

  return (
    <>
    <aside
      className={`relative h-full min-h-0 flex flex-col border-r border-ink-700/70 bg-ink-900/95 shrink-0 ${overlay ? 'overflow-y-auto' : collapsed ? 'hidden' : ''}`}
      style={{ width: overlay ? '100%' : `min(${sidebar.size}px, ${foldVh('35vw')})`, minWidth: overlay ? 0 : 224 }}
    >
      {/* 拖拽调整侧栏宽度 */}
      {!overlay && <ResizeHandle pane={sidebar} label="侧栏宽度" layer={Z.pageBase} />}
      {/* 工坊顶部项目头：固定 48px 高度，与左侧图标轨、章节树、正文标题栏顶部横线对齐 */}
      <div className="h-12 px-3 border-b border-ink-700/70 shrink-0 flex items-center gap-2 min-w-0">
        {overlay && (
          <div className="w-7 h-7 rounded-lg bg-amber/15 border border-amber/30 flex items-center justify-center shrink-0">
            <BrandMark size={14} className="text-amber" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-13 font-semibold text-ink-50 truncate tracking-tight" title={projectName}>{projectName}</span>
            <span className="text-10 text-ink-500 shrink-0 ws-num">{APP_VERSION_LABEL}</span>
          </div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <Button onClick={onExitProject} title="返回项目列表" aria-label="切换项目" variant="ghost" iconOnly size="xs">
            <ArrowLeft size={13} />
          </Button>
          <Button onClick={onExport} title="导出当前项目 JSON 备份" aria-label="备份当前项目" variant="ghost" iconOnly size="xs">
            <Upload size={13} />
          </Button>
        </div>
      </div>
      {returnSource && (
        <div className="px-3 py-1.5 border-b border-ink-700/60 shrink-0">
          <BackToSource {...returnSource} />
        </div>
      )}

      {/* Nav */}
      <nav className={`min-h-0 py-2.5 px-2 space-y-1 ${overlay ? 'shrink-0' : 'flex-1 overflow-y-auto'}`}>
        {!overlay && focusGroup && onToggleNavMode && (
          <div className="flex items-center justify-between gap-2 px-2 py-1 mb-1.5 border-b border-ink-700/60 pb-2">
            <span className="flex items-center gap-1.5 min-w-0 text-12 font-semibold text-ink-200 tracking-wide truncate">
              {navMode === 'focus' && GROUP_ICONS[focusGroup] && (
                <span className="text-amber shrink-0" aria-hidden="true">{GROUP_ICONS[focusGroup]}</span>
              )}
              <span className="truncate">{navMode === 'focus' ? focusGroup : '全部目录'}</span>
            </span>
            <Button variant="bare" onClick={onToggleNavMode} title={navMode === 'focus' ? '展开全部功能目录' : '仅看当前所选分组'} className="h-6 px-2 rounded-md text-11 text-ink-300 hover:text-ink-100 bg-ink-800/50 hover:bg-ink-800 border border-ink-700/60 shrink-0">{navMode === 'focus' ? '全部目录' : '仅当前组'}</Button>
          </div>
        )}
        {GROUPS.map(group => {
          const focusActive = !overlay && !!focusGroup && navMode === 'focus'
          const isOpen = focusActive ? true : !collapsedGroups.has(group)
          const tabs = group === '正文写作'
            ? [EDITOR_TAB, ...TABS.filter(t => t.group === group && tabVisible(t.id, ctx))]
            : TABS.filter(t => t.group === group && tabVisible(t.id, ctx))
          if (tabs.length === 0 && group !== '正文写作') return null
          if (focusActive && group !== focusGroup) return null
          return (
            <div key={group}>
              {!focusActive && (
                <Button variant="bare"
                  onClick={() => toggleGroup(group)}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-12 font-semibold text-ink-300 hover:text-ink-100 transition-colors tracking-wide"
                >
                  {GROUP_ICONS[group]}
                  <span>{group}</span>
                  <ChevronDown
                    size={12}
                    className={`ml-auto transition-transform duration-200 ${isOpen ? '' : '-rotate-90'}`}
                  />
                </Button>
              )}
              {isOpen && (
                <div className={focusActive ? 'space-y-1.5' : 'mt-0.5 space-y-0.5'}>
                  {tabs.map(tab => {
                    const active = activeTab === tab.id
                    const subPadLeft = focusActive ? 'pl-8' : 'pl-9'
                    const tabClass = focusActive
                      ? `group w-full text-left !justify-start px-2.5 py-2.5 rounded-xl transition-all duration-150 flex items-center gap-2.5 border ${active
                        ? 'bg-amber/12 text-amber border-amber/35 shadow-sm'
                        : 'text-ink-200 hover:text-ink-50 hover:bg-ink-800/75 border-ink-700/35 hover:border-ink-700/70'}`
                      : `group w-full text-left !justify-start px-2.5 py-1.5 pl-4 rounded-lg text-13 transition-all duration-150 flex items-center gap-2 border ${active
                        ? 'bg-amber/12 text-amber font-medium border-amber/30'
                        : 'text-ink-300 hover:text-ink-100 hover:bg-ink-800/70 border-transparent'}`
                    const renderTabBody = (trailing: React.ReactNode) => (focusActive ? (
                      <>
                        <span
                          aria-hidden="true"
                          className={`w-8 h-8 rounded-lg shrink-0 flex items-center justify-center transition-colors ${active
                            ? 'bg-amber/18 text-amber border border-amber/25'
                            : 'bg-ink-800/80 text-ink-400 group-hover:text-ink-200 group-hover:bg-ink-700/70'}`}
                        >
                          {getTabIcon(tab, 16)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-14 font-medium leading-tight truncate">{tab.name}</span>
                          <span aria-hidden="true" className={`block text-11 leading-tight truncate mt-0.5 ${active ? 'text-amber/75' : 'text-ink-400/90 group-hover:text-ink-300'}`}>
                            {getTabSubtitle(tab)}
                          </span>
                        </span>
                        {trailing}
                      </>
                    ) : (
                      <>
                        <span aria-hidden="true" className={`shrink-0 ${active ? 'text-amber' : 'text-ink-400 group-hover:text-ink-200'}`}>
                          {getTabIcon(tab, 14)}
                        </span>
                        <span className="truncate flex-1">{tab.name}</span>
                        {trailing}
                      </>
                    ))
                    // 「章节总表」展开为各卷子表（按卷建表）：每卷一张独立台账表
                    if (tab.id === 'chapter-master') {
                      return (
                        <div key={tab.id}>
                          <Button variant="bare"
                            onClick={() => { setVolOpen(!volOpen); onNavigate(tab.id) }}
                            aria-current={active ? 'page' : undefined}
                            aria-label={tab.name}
                            className={tabClass}
                          >
                            {renderTabBody(
                              <ChevronDown aria-hidden="true" size={focusActive ? 13 : 12} className={`shrink-0 transition-transform duration-200 ${volOpen ? '' : '-rotate-90'}`} />
                            )}
                          </Button>
                          {volOpen && (
                            <div className="mt-1 space-y-0.5">
                              {volumeTabs.length === 0 && (
                                <Button onClick={createVolume} variant="secondary" size="sm" className="w-full text-left flex items-center">
                                  <FolderPlus size={12} /> 新建第一卷
                                </Button>
                              )}
                              {volumeTabs.map(v => (
                                <div key={v.id} className="group flex items-center gap-0.5">
                                  <Button variant="bare"
                                    onClick={() => onNavigate(v.id)}
                                    aria-current={v.id === activeTab ? 'page' : undefined}
                                    aria-label={v.name}
                                    className={`flex-1 text-left !justify-start px-2.5 py-1.5 ${subPadLeft} rounded-lg text-13 transition-all duration-150 flex items-center gap-1.5
                                      ${v.id === activeTab
                                        ? 'bg-amber/12 text-amber font-medium border border-amber/30'
                                        : 'text-ink-300 hover:text-ink-100 hover:bg-ink-800/70 border border-transparent'}`}
                                  >
                                    <BookText size={12} aria-hidden="true" className="shrink-0 opacity-75" />
                                    <span className="truncate">{v.name}</span>
                                  </Button>
                                  <Button variant="bare"
                                    onClick={() => removeVolume(v)}
                                    title="删除该卷"
                                    className="shrink-0 px-1.5 py-1 rounded-md text-ink-500 hover:text-danger hover:bg-ink-800 transition-colors"
                                  >
                                    <Trash2 size={13} />
                                  </Button>
                                </div>
                              ))}
                              {volumeTabs.length > 0 && (
                                <Button onClick={createVolume} variant="secondary" size="sm" className="w-full text-left flex items-center mt-1">
                                  <FolderPlus size={12} /> 新建卷
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    }
                    return (
                      <Button variant="bare"
                        key={tab.id}
                        onClick={() => onNavigate(tab.id)}
                        aria-current={active ? 'page' : undefined}
                        aria-label={tab.name}
                        className={tabClass}
                      >
                        {renderTabBody(focusActive ? (
                          <ChevronRight
                            aria-hidden="true"
                            size={14}
                            className={active ? 'shrink-0 text-amber/80' : 'shrink-0 text-ink-500 opacity-0 group-hover:opacity-70 transition-opacity'}
                          />
                        ) : null)}
                      </Button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </nav>

      {/* Footer：窄屏抽屉保持内联折叠条；桌面端改为点击左下角设置键从左向右弹出浮层 */}
      {overlay && (
      <div className={`min-h-0 border-t border-ink-700/70 shrink-0 flex flex-col ${footerCollapsed ? 'h-10' : ''}`}>
        <button
          type="button"
          onClick={() => setFooterCollapsed(!footerCollapsed)}
          title={footerCollapsed ? '展开左下角工具栏（主题 / 界面缩放 / 存储 / 云盘文件同步）' : '收起左下角工具栏（收起后菜单区变高）'}
          aria-label={footerCollapsed ? '展开左下角工具栏' : '收起左下角工具栏'}
          aria-expanded={!footerCollapsed}
          className={`w-full shrink-0 flex items-center justify-between gap-2 px-3 text-11 text-ink-400 hover:text-amber hover:bg-ink-800/40 transition-colors ${
            footerCollapsed ? 'flex-1' : 'h-8'
          }`}
        >
          <span>界面与数据</span>
          {footerCollapsed ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        </button>
        <div ref={toolsRef} data-sidebar-tools className={`min-h-0 space-y-2 px-3 pb-2 ${footerCollapsed ? 'hidden' : ''}`}>
          {toolsContent}
        </div>
      </div>
      )}
    </aside>
    {!overlay && (
      <div
        ref={flyoutRef}
        role="region"
        aria-label="界面与数据设置面板"
        className={`fixed left-12 bottom-0 rounded-tr-xl border-t border-r border-ink-700/80 bg-ink-900/98 backdrop-blur-md shadow-2xl ws-surface ws-flyout-right flex flex-col overflow-hidden ${toolsOpen ? '' : 'hidden'}`}
        style={{ zIndex: Z.dropdown, width: collapsed ? '224px' : `min(${sidebar.size}px, ${foldVh('35vw')})`, minWidth: 224, maxHeight: `min(${foldVh('78vh')}, calc(${foldVh('100vh')} - 3.5rem))` }}
      >
        <div className="h-10 shrink-0 px-3 border-b border-ink-700/70 flex items-center justify-between gap-2">
          <span className="text-12 font-semibold text-ink-200 tracking-wide">界面与数据</span>
          <Button
            variant="ghost"
            iconOnly
            size="xs"
            onClick={onCloseTools}
            title="收起设置面板"
            aria-label="关闭设置面板"
          >
            <X size={13} />
          </Button>
        </div>
        <div ref={toolsRef} data-sidebar-tools className="min-h-0 flex-1 overflow-y-auto overscroll-contain space-y-2 px-2.5 py-2.5">
          {toolsContent}
        </div>
      </div>
    )}
    {/* 自定义主题弹窗（2.5.0 · C1）：
          · 关闭未应用 → 弹窗内部已回滚，这里读回真实主题同步 state；
          · 应用 → yfe-theme 已落盘 'custom'，直接对齐。 */}
      <CustomThemeDialog
        open={customThemeOpen}
        onClose={() => { setCustomThemeOpen(false); setTheme(getStoredTheme()) }}
        onApplied={() => { setTheme('custom'); setCustomThemeOpen(false) }}
      />
      {/* 字体设置弹窗（2026-09-28）：应用/取消都在弹窗内部完成（CSS 变量即时生效，
          不影响 React 状态），关闭无需同步任何 state。 */}
      <FontSettingsDialog open={fontOpen} onClose={() => setFontOpen(false)} />
    </>
  )
}

/**
 * 外观开关：全屏与背景各占一行，保证 200px 侧栏与大比例缩放时不互相挤压。
 * 背景组不受 HAS_WINDOW_BRIDGE 门控（任何形态的窗口都有背景可关）。
 * 背景图 = 金色书本与房子的线条图案（assets/workbench-bg.png），App / 首页 / 向导三处共用同一偏好键。
 */
function AppearanceToggles() {
  /**
   * 3.3.4 · C2：全屏入口不再只对桌面窗口桥开放 —— 浏览器走 Fullscreen API（运行时探测），
   * 两者都没有时不显示入口（改用编辑器的「专注模式」，规划 §4.1 末段）。
   * 状态一律来自 `useAppFullscreen`（桌面：主进程推送；浏览器：fullscreenchange）。
   */
  const { mode, supported, active, error, toggle } = useAppFullscreen()
  const [bgHidden, setBgHidden] = usePersistedBool('workbench-bg-hidden', false)

  // 被拒 / 无 API 时给一次明确反馈，而不是「点了没反应」（§4.1「受支持但被拒绝时保留可理解反馈」）
  useEffect(() => {
    if (!error) return
    showToast(
      error === 'denied'
        ? '这次全屏请求被拒绝了：浏览器策略或权限不允许，可以按 F11，或改用编辑器的「专注模式」'
        : '当前环境没有全屏接口：可用编辑器的「专注模式」代替（它不隐藏地址栏，也不等于全屏）',
      'error',
      6000,
    )
  }, [error])

  return (
    <div className="space-y-1.5 text-11 text-ink-300">
      {supported && (<div className="flex items-center justify-between gap-2">
        <span className="flex shrink-0 items-center gap-1"><Maximize2 size={11} />全屏
          <HelpPopover title="全屏模式" width="20rem" size={11}>
            {mode === 'desktop'
              ? '进入无边框全屏，再按 F11 或 ESC 退出（ESC 仅在全屏时生效，不影响弹窗关闭）。\n\n· 旁边的开关与实际状态实时同步 —— 直接按 F11 它也会跟着变；\n· 启动时不会自动进入全屏，仍是常规的最大化窗口；\n· 该设置不跨启动记忆，重启后恢复普通窗口。'
              : '进入浏览器全屏（菜单、弹窗、下拉与提示都在全屏范围内），按 Esc 或再点一次退出。\n\n· 状态以浏览器的全屏事件为准 —— 按 Esc、系统退出后开关会跟着变；\n· 能否真正进入取决于本页权限与浏览器策略，被拒绝会给出提示，不会假装已全屏；\n· 手机浏览器可能只隐藏部分界面；若环境不支持全屏，请用编辑器的「专注模式」—— 它不隐藏地址栏，也不等于全屏。'}
          </HelpPopover>
        </span>
        <Button variant="toggle" size="xs" selected={active} className="shrink-0"
          onClick={() => void toggle()}
          title={active
            ? (mode === 'desktop' ? '退出全屏（F11 / ESC）' : '退出全屏（Esc）')
            : (mode === 'desktop' ? '进入无边框全屏（F11）' : '进入浏览器全屏')}>
          {active ? '已开' : '关'}
        </Button>
      </div>)}
      <div className="flex items-center justify-between gap-2">
      <span className="flex shrink-0 items-center gap-1"><ImageIcon size={11} />背景
        <HelpPopover title="内置背景" width="20rem" size={11}>
          {'界面底层的金色书本与房子线条图案。关掉后只留主题底色，界面更素净、对截屏和低配设备更友好；随时可以再打开。\n\n· 三处一起生效：工作区、项目管理首页、新手向导；\n· 该设置跨启动记忆。'}
        </HelpPopover>
      </span>
      <Button variant="toggle" size="xs" selected={!bgHidden} className="shrink-0"
        onClick={() => setBgHidden(!bgHidden)}
        title={bgHidden ? '显示内置背景图案' : '隐藏内置背景图案'}>
        {!bgHidden ? '显示中' : '已隐藏'}
      </Button>
      </div>
    </div>
  )
}
