import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/** A local overlay keeps global navigation reachable while its covered card wall is inert. */
export function useAtlasDetailFocus(overlay: boolean, selectedId: string | null,
  listRef: RefObject<HTMLDivElement>, detailRef: RefObject<HTMLDivElement>) {
  const frame = useRef(0)
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const ownedFocus = list.contains(document.activeElement)
    list.inert = overlay && !!selectedId
    if (list.inert && ownedFocus) {
      const aside = detailRef.current?.closest('aside')
      ;(aside?.querySelector<HTMLElement>('[data-atlas-nav]') ?? aside?.querySelector<HTMLElement>('[data-atlas-close]'))?.focus({ preventScroll: true })
    }
    return () => { list.inert = false }
  }, [overlay, selectedId, listRef, detailRef])
  return useCallback((id: string) => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const list = listRef.current
      if (!list?.isConnected || list.inert) return
      const card = [...list.querySelectorAll<HTMLButtonElement>('[data-workspace-record]')].find(node => node.dataset.workspaceRecord === id)
      ;(card ?? list).focus({ preventScroll: true })
      card?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  }, [listRef])
}
