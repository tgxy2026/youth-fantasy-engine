import { Z } from '@/lib/app/zLayer'
import { BookOpen, ChevronDown, ChevronUp, Users, Globe, Map, PenTool, Activity, Wrench, LayoutDashboard, ArrowLeft, Upload, Sparkles, Palette, SlidersHorizontal, ZoomIn, ZoomOut, FolderPlus, Trash2, Beer, Maximize2, Image as ImageIcon, Type } from 'lucide-react'
import BrandMark from '@/components/common/BrandMark'
import HelpPopover from '@/components/common/HelpPopover'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import NumberField from '@/components/common/NumberField'
import { useState, useEffect } from 'react'
import { GROUPS, TABS, EDITOR_TAB, tabVisible, getVolumeTabs, getVolumeLedgerTabId, getVolumeIdFromLedgerTab, refreshVolumeTabs, type VisCtx } from '@/lib/schema'
import type { TabDef } from '@/lib/types'
import * as db from '@/lib/db'
import { uid } from '@/lib/app/id'
import { nextVolumeNo, nextVolumeOrder, isFreeVolume } from '@/lib/outline/freeVolume'
import { THEMES, applyTheme, applyZoom, getStoredTheme, getStoredZoom, autoZoom, isZoomAuto, getStoredCustomTheme } from '@/lib/settings/theme'
import { DESKTOP, HAS_WINDOW_BRIDGE, toggleFullscreen } from '@/lib/app/desktop'
import { DesktopDataBar } from '@/components/app/Desktop'
import CloudFileSyncBar from '@/components/app/CloudFileSyncBar'
import { CLOUD_FILE_SYNC } from '@/lib/sync/desktopCloudSync'
import { useResizable } from '@/lib/app/useResizable'
import { usePersistedBool, usePersistedSet } from '@/lib/settings/uiPrefs'
import { APP_VERSION_LABEL } from '@/lib/app/env'
import { Button } from '@/components/common/Button'
import CustomThemeDialog from '@/components/settings/CustomThemeDialog'
import FontSettingsDialog from '@/components/settings/FontSettingsDialog'
import TaskIndicator from '@/components/common/TaskIndicator'

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
  activeTab: string
  onNavigate: (id: string) => void
  collapsed: boolean
  projectName: string
  onExitProject: () => void
  onExport: () => void
  /** 可见性上下文：项目形态 + 自定义项目启用的功能全集，驱动页签显隐与基础设施开关 */
  ctx: VisCtx
}

export default function Sidebar({ activeTab, onNavigate, projectName, onExitProject, onExport, ctx }: Props) {
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
  const sidebar = useResizable({ key: 'yfe-sidebar-w', initial: 224, initialWide: 300, min: 200, max: 560, side: 'right' })

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

  return (
    <aside
      className="relative h-full flex flex-col border-r border-ink-700 bg-ink-900/95 shrink-0"
      style={{ width: sidebar.size, minWidth: sidebar.size }}
    >
      {/* 拖拽调整侧栏宽度 */}
      <div
        onMouseDown={sidebar.onDragStart}
        className="absolute top-0 right-0 h-full w-1 cursor-col-resize bg-transparent hover:bg-amber/40 transition-colors"
style={{ zIndex: Z.pageBase }}
        title="拖拽调整侧栏宽度"
      />
      {/* Logo */}
      <div className="px-4 h-14 border-b border-ink-700 shrink-0 flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-amber/15 border border-amber/30 flex items-center justify-center shrink-0">
          <BrandMark size={16} className="text-amber" />
        </div>
        <div className="min-w-0">
          <div className="text-14 font-bold text-ink-50 tracking-wide">青春幻想引擎 <span className="text-10 font-normal text-ink-400 ml-1">{APP_VERSION_LABEL}</span></div>
          <div className="text-10 text-ink-400 -mt-0.5 truncate">小说创作工作台</div>
        </div>
      </div>

      {/* 当前项目条 */}
      <div className="px-3 py-2.5 border-b border-ink-700 shrink-0">
        <div className="rounded-lg bg-ink-800/70 border border-ink-700 px-2.5 py-2">
          <div className="text-9 text-ink-500 mb-0.5">当前项目</div>
          <div className="text-13 font-semibold text-amber truncate leading-tight" title={projectName}>{projectName}</div>
          <div className="flex gap-1 mt-2">
            <Button onClick={onExitProject}
              
              title="返回项目列表" variant="secondary" size="md" className="flex-1 flex items-center justify-center rounded">
              <ArrowLeft size={10} /> 切换项目
            </Button>
            <Button onClick={onExport}
              
              title="导出当前项目 JSON 备份" variant="secondary" size="md" className="flex-1 flex items-center justify-center rounded">
              <Upload size={10} /> 备份
            </Button>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
        {GROUPS.map(group => {
          const isOpen = !collapsedGroups.has(group)
          const tabs = group === '正文写作'
            ? [EDITOR_TAB, ...TABS.filter(t => t.group === group && tabVisible(t.id, ctx))]
            : TABS.filter(t => t.group === group && tabVisible(t.id, ctx))
          if (tabs.length === 0 && group !== '正文写作') return null
          return (
            <div key={group}>
              <Button variant="bare"
                onClick={() => toggleGroup(group)}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-12 font-medium text-ink-400 hover:text-ink-200 transition-colors uppercase tracking-wider"
              >
                {GROUP_ICONS[group]}
                <span>{group}</span>
                <ChevronDown
                  size={12}
                  className={`ml-auto transition-transform duration-200 ${isOpen ? '' : '-rotate-90'}`}
                />
              </Button>
              {isOpen && (
                <div className="mt-0.5 space-y-0.5">
                  {tabs.map(tab => {
                    const active = activeTab === tab.id
                    // 「章节总表」展开为各卷子表（按卷建表）：每卷一张独立台账表
                    if (tab.id === 'chapter-master') {
                      return (
                        <div key={tab.id}>
                          <Button variant="bare"
                            onClick={() => { setVolOpen(!volOpen); onNavigate(tab.id) }}
                            className={`w-full text-left !justify-start px-2.5 py-1.5 pl-8 rounded-md text-sm transition-all duration-150 flex items-center
                              ${active
                                ? 'bg-amber/15 text-amber font-medium border border-amber/25'
                                : 'text-ink-300 hover:text-ink-100 hover:bg-ink-800 border border-transparent'}`}
                          >
                            {tab.name}
                            <ChevronDown size={11} className={`ml-auto transition-transform duration-200 ${volOpen ? '' : '-rotate-90'}`} />
                          </Button>
                          {volOpen && (
                            <div className="mt-0.5 space-y-0.5">
                              {volumeTabs.length === 0 && (
                                <Button onClick={createVolume} variant="secondary" size="md" className="w-full text-left flex items-center">
                                  <FolderPlus size={11} /> 新建第一卷
                                </Button>
                              )}
                              {volumeTabs.map(v => (
                                <div key={v.id} className="group flex items-center gap-0.5">
                                  <Button variant="bare"
                                    onClick={() => onNavigate(v.id)}
                                    className={`flex-1 text-left !justify-start px-2.5 py-1 pl-12 rounded-md text-13 transition-all duration-150
                                      ${v.id === activeTab
                                        ? 'bg-amber/15 text-amber font-medium border border-amber/25'
                                        : 'text-ink-300 hover:text-ink-100 hover:bg-ink-800 border border-transparent'}`}
                                  >
                                    {v.name}
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
                                <Button onClick={createVolume} variant="secondary" size="md" className="w-full text-left flex items-center">
                                  <FolderPlus size={11} /> 新建卷
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
                        className={`w-full text-left !justify-start px-2.5 py-1.5 pl-8 rounded-md text-sm transition-all duration-150
                          ${active
                            ? 'bg-amber/15 text-amber font-medium border border-amber/25'
                            : 'text-ink-300 hover:text-ink-100 hover:bg-ink-800 border border-transparent'}`}
                      >
                        {tab.name}
                      </Button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </nav>

      {/* Footer */}
      {/* 🔴 收起态整体固定 h-10（border-box 含 border-t 自身 1px）——露出的上边框与编辑器状态条 /
          检索栏底条三条横线对齐（2.5.2 UI 修复）；展开态高度由内容撑，不用管 */}
      <div className={`border-t border-ink-700 shrink-0 flex flex-col ${footerCollapsed ? 'h-10' : ''}`}>
        {/* 🔴 B6（2026-09-22 老大新增）：左下角工具栏折叠把手。
            收起后内容高度归零，上方页签区（`nav.flex-1`）自动吃掉释放的空间 —— 即"菜单栏自然延伸"。
            把手带 title / aria-label / aria-expanded，键盘与读屏可达。 */}
        <button
          type="button"
          onClick={() => setFooterCollapsed(!footerCollapsed)}
          title={footerCollapsed ? '展开左下角工具栏（主题 / 界面缩放 / 存储 / 云盘文件同步）' : '收起左下角工具栏（收起后菜单区变高）'}
          aria-label={footerCollapsed ? '展开左下角工具栏' : '收起左下角工具栏'}
          aria-expanded={!footerCollapsed}
          className={`w-full flex items-center justify-center text-ink-500 hover:text-amber hover:bg-ink-800/40 transition-colors ${
            footerCollapsed ? 'flex-1' : 'py-1'
          }`}
        >
          {footerCollapsed ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        </button>
        {/* 内容层：收起用 max-height 归零 —— 🔴 不写死 vh（<html> 的 zoom 变化时 vh 不随动，项目红线） */}
        <div className={`px-4 space-y-2.5 overflow-hidden transition-[max-height,opacity] duration-200 ${
          footerCollapsed ? 'max-h-0 opacity-0' : 'max-h-[30rem] opacity-100 pb-3'
        }`}>
        {/* 后台任务（2.6.3 · 跨页签任务存活）：有任务才渲染，无任务时整节不占位。
            🔴 内嵌进这块既有工具栏，**不新开浮层**（项目红线：左下角只准一个浮层）。 */}
        <TaskIndicator onNavigate={onNavigate} activeTab={activeTab} />
        {/* 主题切换 */}
        <div>
          <div className="flex items-center gap-1.5 mb-1.5">
            <Palette size={11} />
            <span>主题</span>
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
          {/* 允许换行：主题增至 9 套后单行会挤压色块，侧栏偏窄时自动折行 */}
          <div className="flex flex-wrap gap-1.5">
            {THEMES.map(t => (
              <Button variant="bare"
                key={t.id}
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
        </div>

        {/* 界面缩放
            🔴 2026-10-09：这行原先 `flex items-center gap-2` + 只有「自动」带 shrink-0，
            而「界面缩放」标签默认可压缩 ⇒ 侧栏内容区只有 192px、这行需求约 210px，
            多出来的 18px **全由标签承担** ⇒ 被压成一个字宽、「界面缩放」竖排。
            改成允许折行 + 标签不可压缩：折行后第一行是「标签 + 自动」，第二行是右侧那组，
            两组都完整。 */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1">
          <span className="flex shrink-0 items-center gap-1">界面缩放
            <HelpPopover title="界面缩放怎么用" width="20rem" size={11}>
              {'调整整个软件的字号与元素大小（80% ~ 160%）。\n\n· 默认「跟随窗口」：按窗口宽度自动取一个舒适值，窗口大小变化时自动重算，大屏不再卡在 100%；\n· 用 +/− 或直接输入百分比即视为手动指定，此后不再自动适配；点「自动」可切回跟随；\n· 设置保存在本地，下次打开沿用；\n· 缩放与主题切换相互独立，互不影响。'}
            </HelpPopover>
          </span>
          <Button variant="toggle" size="xs" selected={zoomAuto} onClick={toAutoZoom} className="shrink-0"
            title={zoomAuto ? '当前为「跟随窗口」模式（窗口尺寸变化时自动重算）' : '切回「跟随窗口」：按当前窗口宽度重新适配'}>
            自动
          </Button>
          <div className="flex items-center gap-1 ml-auto">
            <Button variant="icon-amber" size="xs" onClick={() => changeZoom(-10)} className="p-0.5" title="缩小界面">
              <ZoomOut size={12} />
            </Button>
            <span className="flex items-center gap-0.5">
              {/* U-1 · 2.6.0：改走 NumberField（允许自由输入、提交时钳到 80~160），替换手写 type=number + blur 提交 */}
              {/* 🔴 3.0 修复（2026-10-10）：此处原先的类名**大半是无效的** —— index.css 里那条全局
                  `input, textarea, select` 规则**不在 @layer 内**，而未分层样式优先于 Tailwind 的
                  @layer utilities ⇒ px-1 / py-0.5 / rounded / bg-* / border-* / text-* 全被
                  全局的 12px 内边距 + 14px 字号压掉：48px 宽的框只剩 22px 可用，
                  「132」只显示成「1」，高度 34px 也比同排控件高一截。
                  需覆盖的一律加 `!`；h-6 与同排 toggle（size=xs）对齐。 */}
              <NumberField
                value={zoom}
                onChange={(v) => { if (typeof v === 'number') { setZoom(applyZoom(v, { manual: true })); setZoomAuto(false) } }}
                min={80}
                max={160}
                title="手动输入缩放比例（80% ~ 160%），回车或失焦生效"
                className="h-6 w-12 !px-1 !py-0 !rounded-lg text-11 text-center tabular-nums"
              />
              <span className="text-ink-400 text-xs">%</span>
            </span>
            <Button variant="icon-amber" size="xs" onClick={() => changeZoom(10)} className="p-0.5" title="放大界面">
              <ZoomIn size={12} />
            </Button>
          </div>
        </div>
        {/* 真·全屏（2.5.1 · B2）+ 内置背景开关（2.6.1）：同一行两组，填满版面。
            🔴 只有全屏组受 HAS_WINDOW_BRIDGE 门控——背景任何窗口形态都该可关（实机浏览器验证踩过） */}
        <AppearanceToggles />
        {/* 本机存储：数据文件保存 / 导出 / 导入。
            内嵌进侧栏而非全局 fixed 浮层，避免压住左下角（#032 布局规范化）。 */}
        {DESKTOP && <DesktopDataBar />}
        {/* 云盘文件同步：项目内也能看到同步状态并随时开关 / 换目录 */}
        {CLOUD_FILE_SYNC && <CloudFileSyncBar variant="sidebar" />}
        </div>
      </div>
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
    </aside>
  )
}

/**
 * 外观开关行（2.6.1）：全屏 + 内置背景，两组同排。
 * —— 主人哥哥的要求：全屏开关紧跟「全屏」两字和问号（不再甩到行尾），后边并排一个背景开关，
 *    把中间的空白填上。背景组不受 HAS_WINDOW_BRIDGE 门控（任何形态的窗口都有背景可关）。
 * 背景图 = 金色书本与房子的线条图案（assets/workbench-bg.png），App / 首页 / 向导三处共用同一偏好键。
 */
function AppearanceToggles() {
  const [on, setOn] = useState(false)
  const [bgHidden, setBgHidden] = usePersistedBool('workbench-bg-hidden', false)
  useEffect(() => {
    const w = window.electronWindow
    if (!w) return
    let alive = true
    void w.isFullscreen().then(v => { if (alive) setOn(v) })
    const unsub = w.onFullscreenChange(v => setOn(v))
    return () => { alive = false; unsub?.() }
  }, [])
  return (
    <div className="flex items-center gap-2">
      {HAS_WINDOW_BRIDGE && (<>
        <span className="flex items-center gap-1"><Maximize2 size={11} />全屏
          <HelpPopover title="全屏模式" width="20rem" size={11}>
            {'进入无边框全屏，再按 F11 或 ESC 退出（ESC 仅在全屏时生效，不影响弹窗关闭）。\n\n· 旁边的开关与实际状态实时同步 —— 直接按 F11 它也会跟着变；\n· 启动时不会自动进入全屏，仍是常规的最大化窗口；\n· 该设置不跨启动记忆，重启后恢复普通窗口。'}
          </HelpPopover>
        </span>
        <Button variant="toggle" size="xs" selected={on} className="shrink-0"
          onClick={() => { void toggleFullscreen() }}
          title={on ? '退出全屏（F11 / ESC）' : '进入无边框全屏（F11）'}>
          {on ? '已开' : '关'}
        </Button>
      </>)}
      <span className={`${HAS_WINDOW_BRIDGE ? 'ml-auto' : ''} flex items-center gap-1`}><ImageIcon size={11} />背景
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
  )
}
