import { Z } from '../lib/zLayer'
import { BookOpen, ChevronDown, Users, Globe, Map, PenTool, Activity, Wrench, LayoutDashboard, ArrowLeft, Upload, Sparkles, Palette, ZoomIn, ZoomOut, FolderPlus, Trash2, Beer } from 'lucide-react'
import BrandMark from './BrandMark'
import HelpPopover from './HelpPopover'
import { confirmDialog } from './dialogs'
import { useState, useEffect } from 'react'
import { GROUPS, TABS, EDITOR_TAB, tabVisible, getVolumeTabs, getVolumeLedgerTabId, getVolumeIdFromLedgerTab, refreshVolumeTabs, type VisCtx } from '../lib/schema'
import type { TabDef } from '../lib/types'
import * as db from '../lib/db'
import { uid } from '../lib/id'
import { THEMES, applyTheme, applyZoom, getStoredTheme, getStoredZoom, autoZoom, isZoomAuto } from '../lib/theme'
import { DESKTOP } from '../lib/desktop'
import { DesktopDataBar } from './Desktop'
import CloudFileSyncBar from './CloudFileSyncBar'
import { CLOUD_FILE_SYNC } from '../lib/desktopCloudSync'
import { useResizable } from '../lib/useResizable'
import { usePersistedBool, usePersistedSet } from '../lib/uiPrefs'
import { APP_VERSION_LABEL } from '../lib/env'
import { Button } from './Button'

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
  // 主题与界面缩放（与 <html data-theme> / zoom 同步）
  const [theme, setTheme] = useState(getStoredTheme())
  const [zoom, setZoom] = useState(getStoredZoom())
  // 「跟随窗口」模式：窗口尺寸变化时缩放会被自动重算（见 App.tsx 的 resize 监听）
  const [zoomAuto, setZoomAuto] = useState(isZoomAuto())
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
  // 界面缩放：支持手动输入百分比（80% ~ 160%），回车或失焦生效
  const [zoomText, setZoomText] = useState(String(zoom))
  useEffect(() => { setZoomText(String(zoom)) }, [zoom])
  // 缩放在别处被自动重算时（跟随窗口），让本组件的显示同步过来
  useEffect(() => {
    const onZoom = (e: Event) => {
      const z = (e as CustomEvent<number>).detail
      if (typeof z === 'number') { setZoom(z); setZoomAuto(isZoomAuto()) }
    }
    window.addEventListener('yfe:zoom-changed', onZoom)
    return () => window.removeEventListener('yfe:zoom-changed', onZoom)
  }, [])
  const commitZoom = () => {
    const v = Number(zoomText)
    if (Number.isFinite(v) && v > 0) {
      setZoom(applyZoom(v, { manual: true }))
      setZoomAuto(false)
    } else setZoomText(String(zoom))
  }
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
    const n = volumeTabs.length + 1
    const vol = { id: uid(), projectId: db.getCurrentProjectId(), order: volumeTabs.length, title: `第${n}卷`, description: '', createdAt: Date.now() }
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
              
              title="返回项目列表" variant="secondary" size="md" className="flex-1 flex items-center justify-center text-11 rounded">
              <ArrowLeft size={10} /> 切换项目
            </Button>
            <Button onClick={onExport}
              
              title="导出当前项目 JSON 备份" variant="secondary" size="md" className="flex-1 flex items-center justify-center text-11 rounded">
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
                                ? 'bg-amber/10 text-amber font-medium border border-amber/25'
                                : 'text-ink-300 hover:text-ink-100 hover:bg-ink-800 border border-transparent'}`}
                          >
                            {tab.name}
                            <ChevronDown size={11} className={`ml-auto transition-transform duration-200 ${volOpen ? '' : '-rotate-90'}`} />
                          </Button>
                          {volOpen && (
                            <div className="mt-0.5 space-y-0.5">
                              {volumeTabs.length === 0 && (
                                <Button onClick={createVolume} variant="secondary" size="md" className="w-full text-left text-12 flex items-center">
                                  <FolderPlus size={11} /> 新建第一卷
                                </Button>
                              )}
                              {volumeTabs.map(v => (
                                <div key={v.id} className="group flex items-center gap-0.5">
                                  <Button variant="bare"
                                    onClick={() => onNavigate(v.id)}
                                    className={`flex-1 text-left !justify-start px-2.5 py-1 pl-12 rounded-md text-13 transition-all duration-150
                                      ${v.id === activeTab
                                        ? 'bg-amber/10 text-amber font-medium border border-amber/25'
                                        : 'text-ink-300 hover:text-ink-100 hover:bg-ink-800 border border-transparent'}`}
                                  >
                                    {v.name}
                                  </Button>
                                  <Button variant="bare"
                                    onClick={() => removeVolume(v)}
                                    title="删除该卷"
                                    className="shrink-0 px-1.5 py-1 rounded-md text-ink-500 hover:text-red-400 hover:bg-ink-800 transition-colors"
                                  >
                                    <Trash2 size={13} />
                                  </Button>
                                </div>
                              ))}
                              {volumeTabs.length > 0 && (
                                <Button onClick={createVolume} variant="secondary" size="md" className="w-full text-left text-12 flex items-center">
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
                            ? 'bg-amber/10 text-amber font-medium border border-amber/25'
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
      <div className="px-4 py-3 border-t border-ink-700 shrink-0 space-y-2.5">
        {/* 主题切换 */}
        <div>
          <div className="flex items-center gap-1.5 mb-1.5">
            <Palette size={11} />
            <span>主题</span>
          </div>
          {/* 允许换行：主题增至 8 套后单行会挤压色块，侧栏偏窄时自动折行 */}
          <div className="flex flex-wrap gap-1.5">
            {THEMES.map(t => (
              <Button variant="bare"
                key={t.id}
                title={`${t.name}（${t.desc}）`}
                onClick={() => changeTheme(t.id)}
                className={`w-5 h-5 rounded-full border transition-transform hover:scale-110 ${theme === t.id ? 'border-amber ring-1 ring-amber/50' : 'border-ink-600'}`}
                style={{ background: t.swatch }}
              />
            ))}
          </div>
        </div>

        {/* 界面缩放 */}
        <div className="flex items-center gap-2 pt-1">
          <span className="flex items-center gap-1">界面缩放
            <HelpPopover title="界面缩放怎么用" width="20rem" size={11}>
              {'调整整个软件的字号与元素大小（80% ~ 160%）。\n\n· 默认「跟随窗口」：按窗口宽度自动取一个舒适值，窗口大小变化时自动重算，大屏不再卡在 100%；\n· 用 +/− 或直接输入百分比即视为手动指定，此后不再自动适配；点「自动」可切回跟随；\n· 设置保存在本地，下次打开沿用；\n· 缩放与主题切换相互独立，互不影响。'}
            </HelpPopover>
          </span>
          <Button variant="toggle" size="xs" selected={zoomAuto} onClick={toAutoZoom} className="shrink-0"
            title={zoomAuto ? '当前为「跟随窗口」模式（窗口尺寸变化时自动重算）' : '切回「跟随窗口」：按当前窗口宽度重新适配'}>
            自动
          </Button>
          <div className="flex items-center gap-1 ml-auto">
            <Button variant="icon-amber" onClick={() => changeZoom(-10)} className="p-0.5" title="缩小界面">
              <ZoomOut size={12} />
            </Button>
            <span className="flex items-center gap-0.5">
              <input
                type="number"
                min={80}
                max={160}
                value={zoomText}
                onChange={(e) => setZoomText(e.target.value)}
                onBlur={commitZoom}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { commitZoom(); (e.target as HTMLInputElement).blur() } }}
                title="手动输入缩放比例（80% ~ 160%），回车或失焦生效"
                className="w-12 rounded border border-ink-700 bg-ink-950 px-1 py-0.5 text-center text-ink-200 tabular-nums outline-none focus:border-amber"
              />
              <span className="text-ink-400 text-xs">%</span>
            </span>
            <Button variant="icon-amber" onClick={() => changeZoom(10)} className="p-0.5" title="放大界面">
              <ZoomIn size={12} />
            </Button>
          </div>
        </div>
        {/* 本机存储：数据文件保存 / 导出 / 导入。
            内嵌进侧栏而非全局 fixed 浮层，避免压住左下角（#032 布局规范化）。 */}
        {DESKTOP && <DesktopDataBar embedded />}
        {/* 云盘文件同步：项目内也能看到同步状态并随时开关 / 换目录 */}
        {CLOUD_FILE_SYNC && <CloudFileSyncBar variant="sidebar" />}
      </div>
    </aside>
  )
}
