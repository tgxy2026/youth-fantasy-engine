import { AlertTriangle, AlertCircle, Info, ArrowRight } from 'lucide-react'
import type { AuditIssue, IssueSeverity } from '../lib/audit'
import { SEVERITY_ORDER, SEVERITY_LABEL } from '../lib/audit'
import { Button } from './Button'

interface Props {
  issues: AuditIssue[]
  emptyText?: string
  onNavigateTab?: (tabId: string) => void
  onOpenChapter?: (chapterId: string) => void
}

const META: Record<IssueSeverity, { icon: React.ReactNode; cls: string; dot: string }> = {
  error: { icon: <AlertTriangle size={13} />, cls: 'text-red-300 border-red-500/30 bg-red-500/10', dot: 'text-red-400' },
  warn: { icon: <AlertCircle size={13} />, cls: 'text-amber border-amber/30 bg-amber/10', dot: 'text-amber' },
  info: { icon: <Info size={13} />, cls: 'text-sky-300 border-sky-500/25 bg-sky-500/10', dot: 'text-sky-400' },
}

export default function AuditPanel({ issues, emptyText, onNavigateTab, onOpenChapter }: Props) {
  const sorted = [...issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
  const counts = {
    error: issues.filter(i => i.severity === 'error').length,
    warn: issues.filter(i => i.severity === 'warn').length,
    info: issues.filter(i => i.severity === 'info').length,
  }

  if (issues.length === 0) {
    return (
      <div className="py-10 text-center text-13 text-emerald-400">
        {emptyText ?? '未发现可定位问题 ✓'}
      </div>
    )
  }

  return (
    <div>
      <div className="flex gap-2 mb-3 text-11">
        <span className="px-2 py-0.5 rounded bg-red-500/10 text-red-300 border border-red-500/25">冲突 {counts.error}</span>
        <span className="px-2 py-0.5 rounded bg-amber/10 text-amber border border-amber/25">注意 {counts.warn}</span>
        <span className="px-2 py-0.5 rounded bg-sky-500/10 text-sky-300 border border-sky-500/25">提示 {counts.info}</span>
      </div>
      <div className="space-y-2">
        {sorted.map(issue => {
          const m = META[issue.severity]
          const loc = issue.location
          const onJump = loc?.kind === 'chapter' ? () => onOpenChapter?.(loc.chapterId) : loc?.kind === 'tab' ? () => onNavigateTab?.(loc.tabId) : undefined
          return (
            <div key={issue.id} className={`rounded-lg border px-3 py-2.5 ${m.cls}`}>
              <div className="flex items-start gap-2">
                <span className={`mt-0.5 shrink-0 ${m.dot}`}>{m.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-12 font-medium text-ink-100">{issue.title}</div>
                  <div className="text-11 text-ink-300 leading-relaxed whitespace-pre-wrap mt-0.5">{issue.detail}</div>
                  {loc && onJump && (
                    <Button variant="icon-amber" onClick={onJump} className="mt-1.5 inline-flex items-center gap-1 text-10">
                      <ArrowRight size={10} /> 跳转{loc.hint ? `「${loc.hint}」` : ''}
                    </Button>
                  )}
                </div>
                <span className="shrink-0 text-9 px-1.5 py-px rounded bg-ink-800 text-ink-500 border border-ink-700">{SEVERITY_LABEL[issue.severity]}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
