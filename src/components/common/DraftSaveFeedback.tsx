import type { ManualDraftSaveState } from '@/lib/editor/manualDraftSave'
import { Button } from './Button'

/** Page submission is distinct from the backend's final write/sync receipt. */
export default function DraftSaveFeedback({ state, dirty, onRetry }: {
  state: ManualDraftSaveState; dirty: boolean; onRetry: () => void
}) {
  if (state.error) return <div role="alert" data-draft-save-feedback="error"
    className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-12 text-danger">
    <span>{state.error}</span>
    <Button variant="secondary" onClick={onRetry} disabled={state.saving}>重试保存</Button>
  </div>
  if (!state.saving && !dirty && !state.submitted) return null
  return <p role="status" aria-live="polite" data-draft-save-feedback={state.saving ? 'submitting' : dirty ? 'pending' : 'submitted'}
    className="mt-2 text-12 text-ink-400">
    {state.saving ? '正在提交本次修改…' : dirty ? '还有修改待保存。' : '本页修改已提交；最终写入状态请查看存储区。'}
  </p>
}
