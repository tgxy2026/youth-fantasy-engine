import { useEffect, useRef, type KeyboardEvent } from 'react'

/** Navigate only from a directory's selection buttons; all persistence stays with the caller. */
export function useMasterRecordNavigation(ids: readonly string[], select: (id: string, valid: () => boolean) => Promise<boolean>, isCurrent: () => boolean) {
  const pending = useRef(false), frame = useRef(0), mounted = useRef(true), latest = useRef(ids)
  latest.current = ids
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; cancelAnimationFrame(frame.current) }
  }, [])
  return (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    if (pending.current) return
    const index = latest.current.indexOf(id), target = latest.current[index + (event.key === 'ArrowUp' ? -1 : 1)]
    if (index < 0 || !target) return
    const source = event.currentTarget, list = source.closest<HTMLElement>('[data-master-scroll]')
    if (!list) return
    const valid = () => mounted.current && isCurrent() && source.isConnected && document.activeElement === source && latest.current.includes(target)
    pending.current = true
    void select(target, valid).then(ok => {
      if (!ok || !valid()) { pending.current = false; return }
      frame.current = requestAnimationFrame(() => {
        try {
          if (!valid()) return
          const button = [...list.querySelectorAll<HTMLButtonElement>('[data-master-choice]')].find(node => node.dataset.masterChoice === target)
          if (!button) return
          button.focus({ preventScroll: true })
          const bounds = list.getBoundingClientRect(), rect = button.getBoundingClientRect()
          const scale = list.offsetHeight > 0 ? bounds.height / list.offsetHeight : 1
          if (rect.top < bounds.top) list.scrollTop -= (bounds.top - rect.top) / (scale || 1)
          else if (rect.bottom > bounds.bottom) list.scrollTop += (rect.bottom - bounds.bottom) / (scale || 1)
        } finally { pending.current = false }
      })
    }).catch(() => { pending.current = false /* The selection flow reports save failures. */ })
  }
}
