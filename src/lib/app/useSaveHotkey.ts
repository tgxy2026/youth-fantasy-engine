/** One Ctrl/Cmd+S dispatch, scoped to the active dialog and focused save region. */
import { useContext, useEffect, useId, useRef } from 'react'
import { OverlayContext, getActiveOverlayScope, type OverlayScope } from '@/lib/app/overlayScope'

interface SaveEntry { id: string; scope: OverlayScope | null; save: () => void }
const entries: SaveEntry[] = []
let lastFocused = ''
function regionAt(target: EventTarget | null) {
  return target instanceof Element ? target.closest<HTMLElement>('[data-save-scope]')?.dataset.saveScope : undefined
}
function onFocus(event: FocusEvent) {
  const id = regionAt(event.target)
  if (id) lastFocused = id
}
function onKey(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 's') return
  const scope = getActiveOverlayScope()
  const candidates = entries.filter(entry => entry.scope === scope)
  const focused = regionAt(document.activeElement)
  const target = focused ? candidates.find(entry => entry.id === focused)
    : candidates.find(entry => entry.id === lastFocused) ?? (candidates.length === 1 ? candidates[0] : undefined)
  if (!target) return
  event.preventDefault()
  if (!event.repeat) target.save()
}

/**
 * enabled follows the save button's dirty/busy state. With no eligible save,
 * preserve the browser shortcut. Multiple independent regions on one page must
 * mark their root with data-save-scope={the returned id}.
 */
export function useSaveHotkey(onSave: () => void, enabled = true): string {
  const id = useId()
  const scope = useContext(OverlayContext)
  const callback = useRef(onSave)
  useEffect(() => { callback.current = onSave }, [onSave])
  useEffect(() => {
    if (!enabled) return
    const entry: SaveEntry = { id, scope, save: () => callback.current() }
    entries.push(entry)
    if (entries.length === 1) {
      window.addEventListener('keydown', onKey)
      window.addEventListener('focusin', onFocus)
    }
    return () => {
      const index = entries.indexOf(entry)
      if (index >= 0) entries.splice(index, 1)
      if (!entries.length) {
        window.removeEventListener('keydown', onKey)
        window.removeEventListener('focusin', onFocus)
        lastFocused = ''
      }
    }
  }, [enabled, id, scope])
  return id
}
