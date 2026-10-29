import { useEffect, useState, type ComponentProps } from 'react'
import { Menu, Settings2 } from 'lucide-react'
import Sidebar from '@/components/app/Sidebar'
import { Button } from '@/components/common/Button'
import BrandMark from '@/components/common/BrandMark'
import BackToSource from '@/components/app/BackToSource'
import { Modal } from '@/components/dialogs/Modal'
import { currentUiZoom } from '@/lib/settings/theme'

/** 按实际布局宽度切换导航形态；缩放也会影响可用宽度。 */
export default function WorkspaceSidebar(props: ComponentProps<typeof Sidebar>) {
  const [width, setWidth] = useState(() => window.innerWidth / currentUiZoom())
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState(false)
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
  const close = () => setOpen(false)
  const sidebar = <Sidebar {...props} overlay={compact} focusTools={compact && settings}
    onNavigate={id => { props.onNavigate(id); close() }}
    onExitProject={() => { props.onExitProject(); close() }} />
  if (!compact) return sidebar
  return (
    <>
      <div className="flex w-12 shrink-0 flex-col items-center gap-3 border-r border-ink-700 bg-ink-900/95 py-3" aria-label="项目快捷导航">
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
