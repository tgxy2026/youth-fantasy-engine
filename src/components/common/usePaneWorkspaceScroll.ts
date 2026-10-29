import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { getCurrentProjectId } from '@/lib/db'
import { currentWorkspaceScope, registerWorkspaceCapture } from '@/lib/settings/workspaceRuntime'
import { workspaceViews, type DetailView, type ListView, type ViewAnchor, type ViewScroll } from '@/lib/settings/workspaceViewState'
import { anchorScrollTop, createScrollTargetRequests, firstVisibleAnchor, ratioScrollTop, viewportScale } from '@/lib/settings/workspaceScrollMath'
import { scrollRatio } from '@/lib/editor/editorViewMath'

interface Args {
  pageId: string; detailPageId?: string; ownerKey: string; generation: number; ready: boolean; query: string
  selectedId: string | null; objectId: string | null; targetId: string | null; requestId?: number
  listRef: RefObject<HTMLDivElement>; detailRef: RefObject<HTMLDivElement>; isCurrent: () => boolean
}
const nodes = (el: HTMLElement, attribute: string) => [...el.querySelectorAll<HTMLElement>(`[${attribute}]`)]
const find = (el: HTMLElement, attribute: string, id: string) => nodes(el, attribute).find(node => node.getAttribute(attribute) === id)
function anchor(el: HTMLElement, attribute: string): ViewAnchor | undefined {
  const viewport = el.getBoundingClientRect()
  const scale = viewportScale(viewport.height, el.offsetHeight)
  return firstVisibleAnchor(nodes(el, attribute).map(node => {
    const box = node.getBoundingClientRect()
    return { id: node.getAttribute(attribute) ?? '', top: box.top / scale, bottom: box.bottom / scale }
  }), viewport.top / scale, viewport.bottom / scale)
}
function scroll(el: HTMLElement): ViewScroll {
  const outer = el.closest('main')
  return { top: el.scrollTop, ratio: scrollRatio(el.scrollTop, el.scrollHeight - el.clientHeight),
    outerTop: outer?.scrollTop ?? 0, outerRatio: outer ? scrollRatio(outer.scrollTop, outer.scrollHeight - outer.clientHeight) : 0 }
}
async function stable(el: HTMLElement, cancelled: () => boolean, extraReady = () => true) {
  let previous = '', frames = 0
  for (let i = 0; i < 65; i++) {
    if (cancelled() || !el.isConnected) return false
    const size = [el.clientHeight, el.clientWidth, el.scrollHeight].join(':')
    if (document.fonts.status !== 'loading' && el.clientHeight > 0 && extraReady() && size === previous) frames++
    else frames = 0
    if (frames >= 2) return true
    previous = size
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  }
  return false
}
function restore(el: HTMLElement, saved: { scroll: ViewScroll; anchor?: ViewAnchor }, attribute: string) {
  const row = saved.anchor ? find(el, attribute, saved.anchor.id) : undefined
  if (!saved.anchor) { el.scrollTop = ratioScrollTop(saved.scroll.ratio, el.scrollHeight - el.clientHeight); return }
  // rects include CSS zoom; scrollTop is in layout pixels. A second correction removes rounding drift.
  for (let pass = 0; pass < 2; pass++) {
    const viewport = el.getBoundingClientRect(), scale = viewportScale(viewport.height, el.offsetHeight)
    el.scrollTop = anchorScrollTop(el.scrollTop, row ? row.getBoundingClientRect().top / scale : null,
      viewport.top / scale, saved.anchor.offset, el.scrollHeight - el.clientHeight)
  }
}

/** One page capture owns both panes. Only IDs and geometry enter session memory, never fields.
 * Capture the old detail before switching records; restore against the actually rendered draft ID.
 */
export function usePaneWorkspaceScroll(args: Args): () => void {
  const live = useRef(args); live.current = args
  const epochs = useRef({ list: 0, detail: 0 })
  const allowed = useRef({ list: false, detail: null as string | null })
  const pending = useRef({ list: false, detail: false })
  const requests = useRef(createScrollTargetRequests())
  const target = requests.current(args.ownerKey, args.requestId, args.targetId)
  const capture = useCallback(() => {
    const v = live.current
    if (!v.ready || !v.isCurrent() || v.generation !== workspaceViews.generation()) return
    const pid = getCurrentProjectId(), list = v.listRef.current, detail = v.detailRef.current
    const listScope = currentWorkspaceScope(pid, 'list:' + v.pageId), detailScope = currentWorkspaceScope(pid, v.detailPageId ?? 'outline:' + v.pageId)
    if (list && listScope && allowed.current.list && !pending.current.list) {
      const value: ListView = { version: 1, kind: 'list', objectId: 'list-state', selectedId: v.selectedId,
        query: v.query.slice(0, 200), scroll: scroll(list), anchor: anchor(list, 'data-workspace-record') }
      workspaceViews.put(listScope, value, v.generation)
    }
    if (detail && detailScope && v.objectId && allowed.current.detail === v.objectId && !pending.current.detail) {
      const previous = workspaceViews.get(detailScope, v.objectId)
      const value: DetailView = { version: 1, kind: 'detail', objectId: v.objectId, groups: [],
        scroll: scroll(detail), anchor: anchor(detail, 'data-workspace-field'),
        ...(previous?.kind === 'detail' && previous.showEmpty !== undefined ? { showEmpty: previous.showEmpty } : {}) }
      workspaceViews.put(detailScope, value, v.generation)
    }
  }, [])
  useEffect(() => registerWorkspaceCapture(capture), [capture])
  useEffect(() => {
    let frame = 0
    const onScroll = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(capture) }
    const cancel = (event: Event) => {
      const v = live.current, node = event.target instanceof Node ? event.target : null
      if (v.listRef.current?.contains(node)) allowed.current.list = true
      if (v.detailRef.current?.contains(node)) allowed.current.detail = v.objectId
      epochs.current.list++; epochs.current.detail++; target.consumed = true
      pending.current.list = false; pending.current.detail = false
    }
    const list = args.listRef.current, detail = args.detailRef.current
    list?.addEventListener('scroll', onScroll, { passive: true }); detail?.addEventListener('scroll', onScroll, { passive: true })
    for (const name of ['pointerdown', 'wheel', 'keydown', 'input', 'compositionstart', 'visibilitychange']) document.addEventListener(name, cancel, true)
    window.addEventListener('blur', cancel)
    return () => {
      cancelAnimationFrame(frame)
      list?.removeEventListener('scroll', onScroll); detail?.removeEventListener('scroll', onScroll)
      for (const name of ['pointerdown', 'wheel', 'keydown', 'input', 'compositionstart', 'visibilitychange']) document.removeEventListener(name, cancel, true)
      window.removeEventListener('blur', cancel)
    }
  }, [args.ready, args.ownerKey, args.objectId, args.listRef, args.detailRef, capture, target])

  // Child AutoTextarea passive effects measure their content before this parent restoration.
  useEffect(() => {
    const clock = epochs.current, state = pending.current
    const v = live.current, el = v.listRef.current, mine = ++clock.list, generation = v.generation
    allowed.current.list = false
    if (!v.ready || !el || !v.isCurrent()) return
    const scope = currentWorkspaceScope(getCurrentProjectId(), 'list:' + v.pageId)
    const saved = scope ? workspaceViews.get(scope, 'list-state') : null
    const usable = saved?.kind === 'list' && saved.query === v.query ? saved : null
    const explicit = !target.consumed ? target.id : null
    if (!usable && !explicit) { el.scrollTop = 0; allowed.current.list = true; return }
    pending.current.list = true
    const cancelled = () => mine !== epochs.current.list || generation !== workspaceViews.generation() || !live.current.isCurrent()
    void (async () => {
      if (!await stable(el, cancelled, () => !explicit || !!find(el, 'data-workspace-record', explicit))) return
      if (cancelled()) return
      if (explicit) {
        const row = find(el, 'data-workspace-record', explicit)!
        restore(el, { scroll: { top: 0, ratio: 0, outerTop: 0, outerRatio: 0 }, anchor: { id: row.getAttribute('data-workspace-record')!, offset: 0 } }, 'data-workspace-record')
        target.consumed = true
      } else if (usable) restore(el, usable, 'data-workspace-record')
      const outer = el.closest('main')
      if (outer && usable && !explicit) outer.scrollTop = ratioScrollTop(usable.scroll.outerRatio, outer.scrollHeight - outer.clientHeight)
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      if (!cancelled()) allowed.current.list = true
    })().catch(() => { /* Optional view restoration must not affect editing or saving. */ })
      .finally(() => { if (mine === epochs.current.list) { pending.current.list = false; target.consumed = true } })
    return () => { if (mine === clock.list) { clock.list++; state.list = false } }
  }, [args.ready, args.ownerKey, args.query, target])

  useEffect(() => {
    const clock = epochs.current, state = pending.current
    const v = live.current, el = v.detailRef.current, id = v.objectId, mine = ++clock.detail, generation = v.generation
    allowed.current.detail = null
    if (!v.ready || !el || !id || !v.isCurrent()) return
    const scope = currentWorkspaceScope(getCurrentProjectId(), v.detailPageId ?? 'outline:' + v.pageId)
    const saved = scope ? workspaceViews.get(scope, id) : null
    if (saved?.kind !== 'detail') { el.scrollTop = 0; allowed.current.detail = id; return }
    pending.current.detail = true
    const cancelled = () => mine !== epochs.current.detail || generation !== workspaceViews.generation() || !live.current.isCurrent() || live.current.objectId !== id
    void (async () => {
      if (!await stable(el, cancelled) || cancelled()) return
      restore(el, saved, 'data-workspace-field')
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      if (!cancelled()) allowed.current.detail = id
    })().catch(() => { /* Optional view restoration must not affect editing or saving. */ })
      .finally(() => { if (mine === epochs.current.detail) pending.current.detail = false })
    return () => { if (mine === clock.detail) { clock.detail++; state.detail = false } }
  }, [args.ready, args.ownerKey, args.objectId])
  return capture
}
