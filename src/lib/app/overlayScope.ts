import { createContext, useContext, useEffect, useRef, type RefObject } from 'react'
import { Z } from './zLayer'

export interface OverlayScope {
  panel: RefObject<HTMLDivElement>
  ancestors: RefObject<HTMLDivElement>[]
  layer: number
}
export const OverlayContext = createContext<OverlayScope | null>(null)

interface DialogEntry {
  scope: OverlayScope
  panel: HTMLDivElement
  previous: Element | null
  close: () => void
  canClose: () => boolean
}
interface PopupEntry {
  scope: OverlayScope | null
  close: () => void
  trigger: RefObject<HTMLElement>
}
const dialogs: DialogEntry[] = []
const popups: PopupEntry[] = []
const isolated = new Map<HTMLElement, { inert: boolean; ariaHidden: string | null }>()
let bodyObserver: MutationObserver | null = null
let pagePopupHost: HTMLDivElement | null = null
let rootReturn: Element | null = null
const topDialog = () => dialogs[dialogs.length - 1]
export const getActiveOverlayScope = () => topDialog()?.scope ?? null
/** Covered popups must not react to pointer events inside a newer dialog. */
export const isOverlayObscured = (trigger: HTMLElement | null) => {
  const top = topDialog()
  return !!top && !top.panel.contains(trigger)
}
const focus = (element: Element | null) => {
  if (element instanceof HTMLElement && element.isConnected) element.focus({ preventScroll: true })
}

function onKey(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing) return
  const top = topDialog()
  if (event.key === 'Escape') {
    const popup = [...popups].reverse().find(entry => entry.scope === (top?.scope ?? null))
    if (!popup && !top) return
    event.preventDefault()
    event.stopPropagation()
    if (popup) {
      popup.close()
      focus(popup.trigger.current)
    } else if (top.canClose()) top.close()
    return
  }
  if (event.key !== 'Tab' || !top) return
  const items = [...top.panel.querySelectorAll<HTMLElement>(
    'a[href],button,input,select,textarea,[tabindex]',
  )].filter(el => el.tabIndex >= 0 && !el.matches(':disabled') && !el.closest('[inert],[aria-hidden="true"]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (!first) {
    event.preventDefault()
    focus(top.panel)
  } else if (!top.panel.contains(active) || active === top.panel) {
    event.preventDefault()
    focus(event.shiftKey ? last : first)
  } else if (event.shiftKey && active === first) {
    event.preventDefault()
    focus(last)
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    focus(first)
  }
}

function syncListener() {
  // Bubble phase lets an input consume Escape to cancel its own inline edit first.
  document.removeEventListener('keydown', onKey)
  if (dialogs.length || popups.length) document.addEventListener('keydown', onKey)
}

function syncBackground() {
  const overlay = topDialog()?.panel.parentElement
  const targets = new Set(overlay ? [...document.body.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el !== overlay) : [])
  for (const [element, previous] of isolated) {
    if (targets.has(element)) continue
    element.inert = previous.inert
    if (previous.ariaHidden === null) element.removeAttribute('aria-hidden')
    else element.setAttribute('aria-hidden', previous.ariaHidden)
    isolated.delete(element)
  }
  for (const element of targets) {
    if (!isolated.has(element)) isolated.set(element, { inert: element.inert, ariaHidden: element.getAttribute('aria-hidden') })
    element.inert = true
    element.setAttribute('aria-hidden', 'true')
  }
  if (overlay && !bodyObserver) {
    bodyObserver = new MutationObserver(syncBackground)
    bodyObserver.observe(document.body, { childList: true })
  } else if (!overlay) {
    bodyObserver?.disconnect()
    bodyObserver = null
  }
}

function getPagePopupHost() {
  if (!pagePopupHost?.isConnected) {
    pagePopupHost = document.createElement('div')
    pagePopupHost.dataset.uiPopupRoot = ''
    // A page dropdown can outrank page chrome without outranking a new modal.
    pagePopupHost.style.position = 'relative'
    pagePopupHost.style.zIndex = String(Z.modal - 1)
    document.body.appendChild(pagePopupHost)
  }
  return pagePopupHost
}

export function registerDialog(scope: OverlayScope, close: () => void, canClose: () => boolean) {
  const panel = scope.panel.current
  if (!panel) return () => {}
  if (!dialogs.length) rootReturn = document.activeElement
  const entry: DialogEntry = { scope, panel, previous: document.activeElement, close, canClose }
  // React runs child effects first when nested dialogs mount in the same commit.
  const childIndex = dialogs.findIndex(candidate => candidate.scope.ancestors.includes(scope.panel))
  if (childIndex < 0) dialogs.push(entry)
  else dialogs.splice(childIndex, 0, entry)
  dialogs.sort((a, b) => a.scope.layer - b.scope.layer)
  syncListener()
  syncBackground()
  const frame = requestAnimationFrame(() => { if (topDialog() === entry) focus(panel) })
  return () => {
    cancelAnimationFrame(frame)
    const wasTop = topDialog() === entry
    const index = dialogs.indexOf(entry)
    if (index >= 0) dialogs.splice(index, 1)
    syncListener()
    syncBackground()
    if (!wasTop) return
    const next = topDialog()
    if (next) focus(entry.previous?.isConnected && next.panel.contains(entry.previous) ? entry.previous : next.panel)
    else {
      focus(entry.previous?.isConnected ? entry.previous : rootReturn)
      rootReturn = null
    }
  }
}

/** Portals stay outside the scrolling body, but inside their owning dialog's focus and z-order. */
export function usePopupLayer(open: boolean, close: () => void, trigger: RefObject<HTMLElement>) {
  const scope = useContext(OverlayContext)
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!open) return
    const entry: PopupEntry = { scope, trigger, close: () => closeRef.current() }
    popups.push(entry)
    syncListener()
    return () => {
      const index = popups.indexOf(entry)
      if (index >= 0) popups.splice(index, 1)
      syncListener()
    }
  }, [open, scope, trigger])
  return () => scope?.panel.current ?? getPagePopupHost()
}
