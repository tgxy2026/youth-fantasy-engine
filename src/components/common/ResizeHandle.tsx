import { GripVertical } from 'lucide-react'
import { Button } from '@/components/common/Button'
import HelpPopover from '@/components/common/HelpPopover'
import { Z } from '@/lib/app/zLayer'
import type { useResizable } from '@/lib/app/useResizable'

export type ResizablePane = ReturnType<typeof useResizable>
export default function ResizeHandle({ pane, label, layer = Z.pageHandle }: { pane: ResizablePane; label: string; layer?: number }) {
  return <>
    <div role="separator" aria-label={label} aria-orientation="vertical" tabIndex={0}
      aria-valuemin={pane.min} aria-valuemax={pane.max} aria-valuenow={Math.round(pane.size)}
      aria-valuetext={`${Math.round(pane.size)} 像素`}
      onPointerDown={pane.onDragStart}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          pane.adjust((event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 48 : 16))
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          pane.setWidth(event.key === 'Home' ? pane.min : pane.max)
        }
      }}
      title={`${label}：拖动，或用方向键调整；点中间手柄查看宽度操作`}
      className="absolute top-0 right-0 translate-x-1/2 h-full w-6 cursor-col-resize group outline-none focus-visible:outline-2 focus-visible:outline-amber"
      style={{ zIndex: layer, touchAction: 'none' }}>
      <div className={`absolute inset-y-0 left-1/2 w-0.5 ${pane.dragging ? 'bg-amber/60' : 'bg-transparent group-hover:bg-amber/40'}`} />
    </div>
    <div className="absolute right-0 translate-x-1/2 top-1/2 -translate-y-1/2" style={{ zIndex: layer + 1 }}>
      <HelpPopover title={label} trigger={<GripVertical size={14} />} triggerTitle={`${label}：打开调整菜单`} pin
        triggerClassName="h-8 w-6 rounded border border-ink-700 bg-ink-900 text-ink-400 hover:text-amber" width="18rem">
        <div className="space-y-2">
          <p>当前宽度 {Math.round(pane.size)} 像素，也可用下方按钮调整。</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => pane.adjust(-24)} disabled={pane.size <= pane.min}>收窄</Button>
            <Button size="sm" variant="secondary" onClick={() => pane.adjust(24)} disabled={pane.size >= pane.max}>加宽</Button>
            <Button size="sm" variant="secondary" onClick={pane.reset}>恢复默认</Button>
          </div>
        </div>
      </HelpPopover>
    </div>
  </>
}
