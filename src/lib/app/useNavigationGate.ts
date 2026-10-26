import { useEffect, useRef, useState } from 'react'
import { createNavigationGate, type NavigationGateOptions } from './navigation'

export function useNavigationGate<T>(options: NavigationGateOptions<T>) {
  const live = useRef(options)
  live.current = options
  const [gate] = useState(() => createNavigationGate<T>({
    context: () => live.current.context(), busy: options.busy,
    capture: () => live.current.capture(), validate: intent => live.current.validate(intent),
    dirty: () => live.current.dirty(), flush: () => live.current.flush(),
    commit: intent => live.current.commit(intent), invalid: intent => live.current.invalid(intent),
    failed: (intent, scope, error) => live.current.failed(intent, scope, error),
  }))
  useEffect(() => () => gate.invalidate(), [gate])
  return gate
}
