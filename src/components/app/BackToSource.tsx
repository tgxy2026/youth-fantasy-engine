/** Return belongs to project navigation. It never overlays editor controls or consumes main height. */
export interface ReturnSource { label: string; onBack: () => void }
export default function BackToSource({ label, onBack, compact = false }: ReturnSource & { compact?: boolean }) {
  const text = label.trim() ? `返回：${label.trim()}` : '返回上一页'
  return (
      <button
        type="button"
        onClick={onBack}
        aria-label={text}
        title={`${text}（回到你跳转前所在的位置）`}
        className={`flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-ink-600 bg-ink-800 text-ink-200 transition-colors hover:border-amber/50 hover:text-amber focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber ${compact ? 'h-8 w-8 text-16' : 'mt-2 min-h-8 w-full px-2 py-1 text-11'}`}
      >
        <span aria-hidden>←</span>
        {!compact && <span className="min-w-0 truncate">{text}</span>}
      </button>
  )
}
