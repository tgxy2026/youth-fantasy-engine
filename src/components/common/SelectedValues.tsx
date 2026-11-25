import { X } from 'lucide-react'
import { Button } from './Button'

/** Selected values are independent of the option catalogue: legacy/manual values stay removable. */
export default function SelectedValues({ values, onRemove, onClear }: {
  values: readonly string[]; onRemove: (value: string) => void; onClear: () => void
}) {
  if (!values.length) return null
  return <div role="group" aria-label="当前已选值" className="space-y-1.5 px-2.5 py-2 border-b border-ink-700/60">
    <div className="flex items-center justify-between gap-2 text-11 text-ink-400">
      <span>当前已选 · 点击取消</span>
      {values.length > 1 && (
        <Button
          variant="bare"
          size="xs"
          type="button"
          onClick={onClear}
          aria-label="清空当前选择"
          className="px-1.5 py-0.5 text-11 text-ink-400 hover:text-amber"
        >
          清空
        </Button>
      )}
    </div>
    <div className="flex flex-wrap gap-1.5">
      {[...new Set(values)].map(value => (
        <Button
          key={value}
          variant="bare"
          shape="pill"
          type="button"
          size="xs"
          aria-label={`取消选择：${value}`}
          onClick={() => onRemove(value)}
          className="!h-auto min-h-6 max-w-full px-2.5 py-1 text-11 leading-tight border border-amber/30 bg-amber/10 text-amber hover:bg-amber/20 !whitespace-normal"
        >
          <span className="min-w-0 break-words [overflow-wrap:anywhere] text-left">{value}</span>
          <X size={11} className="shrink-0 opacity-75" aria-hidden="true" />
        </Button>
      ))}
    </div>
  </div>
}
