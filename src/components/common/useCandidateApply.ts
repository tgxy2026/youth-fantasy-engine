import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { candidateApplyContext } from '@/lib/ai/candidateContext'
import { createCandidateApplyGuard, type CandidateSubmit } from '@/lib/ai/candidateApply'

export { candidateApplyContext } from '@/lib/ai/candidateContext'
export function useCandidateApply(submit: CandidateSubmit, onClose: () => void) {
  const live = useRef({ submit, onClose }); live.current = { submit, onClose }
  const context = useRef(candidateApplyContext())
  const lifetime = useRef({ mounted: false, generation: 0 })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const gate = useRef<ReturnType<typeof createCandidateApplyGuard> | null>(null)
  if (!gate.current) gate.current = createCandidateApplyGuard({
    owner: () => lifetime.current.mounted && context.current === candidateApplyContext() ? `${context.current}:${lifetime.current.generation}` : null,
    pending: setPending,
    accepted: () => { setError(null); live.current.onClose() },
    rejected: () => setError('本次采用未完成，候选内容仍保留在这里。请查看页面与存储提示，处理后重试。'),
    stale: owner => {
      if (!lifetime.current.mounted || owner !== `${context.current}:${lifetime.current.generation}`) return
      setPending(false); setStale(true)
      setError('当前上下文已改变，采用结果需要到原目标核对。此处不再重复提交，请关闭窗口后检查。')
    },
  })
  useLayoutEffect(() => {
    const current = lifetime.current
    current.mounted = true; current.generation++
    return () => { current.mounted = false; current.generation++ }
  }, [])
  const apply = useCallback((values: Record<string, string>) => {
    const handler = live.current.submit
    const snapshot = { ...values }
    return gate.current!.run(() => { setError(null); return handler(snapshot) })
  }, [])
  const requestClose = useCallback(() => { if (!gate.current!.isBusy()) live.current.onClose() }, [])
  const reset = useCallback(() => {
    if (stale || context.current !== candidateApplyContext() || !gate.current!.reset()) return false
    setError(null)
    return true
  }, [stale])
  return { apply, pending, error, reset, requestClose, blocked: stale || context.current !== candidateApplyContext(), isPending: () => gate.current!.isBusy() }
}
