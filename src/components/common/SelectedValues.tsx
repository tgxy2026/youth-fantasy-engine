import { X } from 'lucide-react'
import { Button } from './Button'

/** Selected values are independent of the option catalogue: legacy/manual values stay removable. */
export default function SelectedValues({ values, onRemove, onClear }: {
  values: readonly string[]; onRemove: (value: string) => void; onClear: () => void
}) {
  if (!values.length) return null
  return <div role="group" aria-label="当前已选值" className="space-y-1 px-2 py-1.5">
    <div className="flex items-center justify-between gap-2 text-10 text-ink-400">
      <span>当前已选 · 点击取消</span>
      {values.length > 1 && <Button variant="bare" size="xs" type="button" onClick={onClear} aria-label="清空当前选择">清空</Button>}
    </div>
    <div className="flex flex-wrap gap-1">
      {[...new Set(values)].map(value => <Button key={value} variant="bare" type="button" size="xs"
        aria-label={`取消选择：${value}`} onClick={() => onRemove(value)}
        className="!h-auto min-h-7 max-w-full border border-amber/30 bg-amber/10 text-amber !whitespace-normal">
        <span className="min-w-0 break-words [overflow-wrap:anywhere] text-left">{value}</span><X size={11} className="shrink-0" aria-hidden="true" />
      </Button>)}
    </div>
  </div>
}
