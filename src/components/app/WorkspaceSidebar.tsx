import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from 'react'
import {
  Activity, ArrowLeft, Beer, BookOpen, Globe, LayoutDashboard, Map, Menu,
  PanelLeftClose, PanelLeftOpen, PenTool, Search, Settings2, Sparkles, Users, Wrench,
} from 'lucide-react'
import Sidebar from '@/components/app/Sidebar'
import { Button } from '@/components/common/Button'
import BrandMark from '@/components/common/BrandMark'
import BackToSource from '@/components/app/BackToSource'
import { Modal } from '@/components/dialogs/Modal'
import { currentUiZoom } from '@/lib/settings/theme'
import { GROUPS, TABS, getTab, tabVisible } from '@/lib/schema'
import { usePersistedBool } from '@/lib/settings/uiPrefs'

const RAIL_ICONS: Record<string, ReactNode> = {
  '工作面板': <LayoutDashboard size={17} />,
  '正文写作': <PenTool size={17} />,
  '灵感工具': <Sparkles size={17} />,
  '开书定位': <BookOpen size={17} />,
  '角色管理': <Users size={17} />,
  '世界构建': <Globe size={17} />,
  '大纲规划': <Map size={17} />,
  '酒馆模式': <Beer size={17} />,
  '创作管理': <Activity size={17} />,
  '运营维护': <Wrench size={17} />,
}

function resolveTabGroup(activeTab: string): string {
  if (activeTab === 'dashboard') return '工作面板'
  if (activeTab === 'editor') return '正文写作'
  return getTab(activeTab)?.group ?? '工作面板'
}

/** 按实际布局宽度切换导航形态；缩放也会影响可用宽度。 */
export default function WorkspaceSidebar(props: ComponentProps<typeof Sidebar>) {
  const [width, setWidth] = useState(() => window.innerWidth / currentUiZoom())
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState(false)
  const [panelCollapsed, setPanelCollapsed] = usePersistedBool('ws-rail-panel-collapsed', false)
  const [showAllGroups, setShowAllGroups] = usePersistedBool('ws-nav-show-all', false)
  const [selectedGroup, setSelectedGroup] = useState(() => resolveTabGroup(props.activeTab))
  const [toolsOpen, setToolsOpen] = useState(false)

  const compact = width < 900
  useEffect(() => {
    const measure = () => setWidth(window.innerWidth / currentUiZoom())
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('yfe:zoom-changed', measure)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('yfe:zoom-changed', measure)
    }
  }, [])

  useEffect(() => {
    setSelectedGroup(resolveTabGroup(props.activeTab))
  }, [props.activeTab])

  const visibleGroups = useMemo(
    () => GROUPS.filter(g => g === '正文写作' || TABS.some(t => t.group === g && tabVisible(t.id, props.ctx))),
    [props.ctx],
  )

  const close = () => setOpen(false)
  const sidebar = (
    <Sidebar
      {...props}
      overlay={compact}
      focusTools={compact && settings}
      onNavigate={id => { props.onNavigate(id); close() }}
      onExitProject={() => { props.onExitProject(); close() }}
    />
  )

  if (compact) {
    return (
      <>
        <div className="flex w-12 shrink-0 flex-col items-center gap-3 border-r border-ink-700/70 yfe-surface-1 py-3" aria-label="项目快捷导航">
          <BrandMark size={22} className="text-amber" />
          <Button variant="ghost" iconOnly size="sm" onClick={() => { setSettings(false); setOpen(true) }}
            aria-label="打开项目菜单" aria-expanded={open} title="打开项目菜单">
            <Menu size={18} />
          </Button>
          {props.returnSource && <BackToSource {...props.returnSource} compact />}
          <Button variant="ghost" iconOnly size="sm" onClick={() => { setSettings(true); setOpen(true) }} className="mt-auto"
            aria-label="界面与数据设置" title="界面缩放、主题、保存与同步设置">
            <Settings2 size={18} />
          </Button>
        </div>
        {/* 收起时仍订阅后台任务与保存状态；隐藏容器不参与布局或键盘导航。 */}
        {!open && <div className="hidden">{sidebar}</div>}
        <Modal open={open} onClose={close} title="项目菜单" width={300} align="left" maxHeight="100vh"
          className="!rounded-none" bodyClassName="!p-0 min-h-0 !overflow-hidden flex flex-col">
          {sidebar}
        </Modal>
      </>
    )
  }

  const desktopSidebar = (
    <Sidebar
      {...props}
      collapsed={panelCollapsed}
      overlay={false}
      toolsOpen={toolsOpen}
      onCloseTools={() => setToolsOpen(false)}
      focusGroup={selectedGroup}
      navMode={showAllGroups ? 'all' : 'focus'}
      onToggleNavMode={() => setShowAllGroups(!showAllGroups)}
    />
  )

  return (
    <div className="flex h-full min-h-0 shrink-0">
      <nav
        className="flex w-12 shrink-0 flex-col items-center border-r border-ink-700/70 yfe-surface-1 pb-2.5 gap-1"
        aria-label="工坊功能图标轨"
      >
        <div className="h-12 w-full flex items-center justify-center border-b border-ink-700/70 shrink-0">
          <Button
            variant="ghost"
            iconOnly
            size="sm"
            onClick={() => props.onNavigate('dashboard')}
            title="青春幻想引擎 · 回到仪表盘"
            aria-label="回到仪表盘"
          >
            <BrandMark size={19} className="text-amber" />
          </Button>
        </div>
        <div className="flex-1 min-h-0 w-full flex flex-col items-center gap-1 overflow-y-auto px-1 py-2">
          {visibleGroups.map(group => {
            const active = selectedGroup === group && !panelCollapsed
            return (
              <Button
                key={group}
                variant="ghost"
                iconOnly
                size="sm"
                onClick={() => {
                  setSelectedGroup(group)
                  if (panelCollapsed) setPanelCollapsed(false)
                }}
                title={group}
                aria-label={group}
                aria-pressed={active}
                className={`shrink-0 ${active ? '!bg-amber/15 !text-amber border border-amber/30' : ''}`}
              >
                {RAIL_ICONS[group]}
              </Button>
            )
          })}
        </div>
        <div className="w-6 h-px bg-ink-700/60 my-1 shrink-0" />
        {props.onOpenSearch && (
          <Button
            variant="ghost"
            iconOnly
            size="sm"
            onClick={props.onOpenSearch}
            title="快速搜索与跳转 (Ctrl+K)"
            aria-label="快速搜索与跳转"
          >
            <Search size={16} />
          </Button>
        )}
        <Button
          variant="ghost"
          iconOnly
          size="sm"
          onClick={() => setPanelCollapsed(!panelCollapsed)}
          title={panelCollapsed ? '展开二级导航栏' : '收起二级导航栏'}
          aria-label={panelCollapsed ? '展开二级导航栏' : '收起二级导航栏'}
          aria-expanded={!panelCollapsed}
        >
          {panelCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </Button>
        <Button
          variant="ghost"
          iconOnly
          size="sm"
          onClick={props.onExitProject}
          title="返回项目列表"
          aria-label="返回项目列表"
        >
          <ArrowLeft size={16} />
        </Button>
        <Button
          variant="ghost"
          iconOnly
          size="sm"
          data-settings-trigger="1"
          onClick={() => setToolsOpen(o => !o)}
          title="界面缩放、主题、保存与同步设置"
          aria-label="界面与数据设置"
          aria-expanded={toolsOpen}
          className={toolsOpen ? '!bg-amber/15 !text-amber border border-amber/30' : ''}
        >
          <Settings2 size={16} />
        </Button>
      </nav>
      {desktopSidebar}
    </div>
  )
}
