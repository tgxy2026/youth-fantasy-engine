import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/common/Button'
import { copyText } from '@/components/dialogs/dialogs'

const issueKeys = new WeakMap<object, number>()
let nextIssueKey = 0
/** A result object keeps its own feedback when neighbouring results are removed. */
export function proofIssueKey(issue: object): number {
  const existing = issueKeys.get(issue)
  if (existing !== undefined) return existing
  const key = ++nextIssueKey
  issueKeys.set(issue, key)
  return key
}

/** Keep the exact text selectable when the browser denies both clipboard methods. */
export function CopyProofText({ text, replacement }: { text: string; replacement: boolean }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'manual'>('idle')
  const sequence = useRef(0)
  useEffect(() => {
    const currentSequence = sequence
    currentSequence.current++
    setStatus('idle')
    return () => { currentSequence.current++ }
  }, [text])

  const copy = async () => {
    const request = ++sequence.current
    const ok = await copyText(text, '已复制', { silent: true })
    if (request !== sequence.current) return
    setStatus(ok ? 'copied' : 'manual')
  }
  return <div className="inline-block max-w-full">
    <Button variant="bare" onClick={() => void copy()} disabled={!text.trim()}
      className="px-2 py-1 bg-ink-700 text-ink-200 border border-ink-600 rounded text-11 hover:bg-ink-600 transition-colors"
      title="复制文本，不修改正文">
      {status === 'copied' ? '已复制' : replacement ? '复制替换文本' : '复制建议'}
    </Button>
    {status === 'manual' && <div className="mt-1 text-11 text-amber" role="status">
      复制失败，请选中下方文字后手动复制。
      <textarea aria-label="待手动复制的文本" readOnly value={text} onFocus={event => event.currentTarget.select()}
        className="block mt-1 w-full min-w-48 rounded border border-ink-600 bg-ink-800 p-2 text-ink-100" rows={3} />
    </div>}
  </div>
}
