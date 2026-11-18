import type { ManualDraftSaveState } from '@/lib/editor/manualDraftSave'
import { draftSaveFeedbackOf } from '@/lib/editor/draftSaveFeedback'
import { Button } from './Button'

/** Page submission is distinct from the backend's final write/sync receipt. */
export default function DraftSaveFeedback({ state, dirty, onRetry }: {
  state: ManualDraftSaveState; dirty: boolean; onRetry: () => void
}) {
  // 四态与优先级在 `draftSaveFeedback`（有单测）：错误 > 正在提交 > 还有修改 > 已提交 > 不显示
  const feedback = draftSaveFeedbackOf({ error: state.error, saving: state.saving, submitted: state.submitted, dirty })
  if (feedback.kind === 'hidden') return null
  if (feedback.kind === 'error') return <div role="alert" data-draft-save-feedback="error"
    className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-12 text-danger">
    <span>{feedback.text}</span>
    <Button variant="secondary" onClick={onRetry} disabled={state.saving}>重试保存</Button>
  </div>
  return <p role="status" aria-live="polite" data-draft-save-feedback={feedback.kind}
    className="mt-2 text-12 text-ink-400">
    {feedback.text}
  </p>
}
