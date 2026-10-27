import { Save } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { storageWriteStatus, type StorageWriteFacts } from '@/lib/app/storageWriteStatus'

const dotColor = { danger: 'bg-danger', warning: 'bg-amber', success: 'bg-success', muted: 'bg-ink-500' }
/** Shares status language without changing backend subscriptions, write scheduling, or sync policy. */
export default function StorageWriteStatus({ facts, onSave, title }: {
  facts: StorageWriteFacts; onSave: () => void; title?: string
}) {
  const status = storageWriteStatus(facts)
  return <Button variant="bare" onClick={onSave} disabled={!status.canSave}
    data-storage-write-status={status.kind}
    title={!status.canSave ? status.description : title ?? status.description}
    aria-label={`${status.label}：${status.description}`}
    className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full border border-ink-700 bg-ink-800/60 px-3 text-12 text-ink-300 transition-colors hover:border-amber/50 hover:text-ink-100 disabled:opacity-70">
    <Save size={12} className="shrink-0 text-amber/80" aria-hidden="true" />
    <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor[status.tone]}`} />
    <span className="min-w-0 truncate whitespace-nowrap" role="status" aria-live="polite" aria-atomic="true">{status.label}</span>
  </Button>
}
