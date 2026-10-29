import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { getCurrentProjectId } from '@/lib/db'
import { candidateApplyContext } from '@/lib/ai/candidateContext'
import { currentWorkspaceScope, registerWorkspaceCapture } from '@/lib/settings/workspaceRuntime'
import { workspaceViews, type TableView } from '@/lib/settings/workspaceViewState'
import { anchorScrollTop, firstVisibleAnchor, ratioScrollTop, viewportScale } from '@/lib/settings/workspaceScrollMath'
import { scrollRatio } from '@/lib/editor/editorViewMath'
import { useListWorkspaceView } from '@/components/common/useListWorkspaceView'

interface Args {
  tabId: string; ready: boolean; ids: readonly string[]; filters: Record<string, string>
  scrollRef: RefObject<HTMLDivElement>; revealId: (id: string) => void; focusRowId?: string | null
  pinRestore: (id: string | null) => void
}
const filterKey = (value: Record<string, string>) => JSON.stringify(Object.entries(value).filter(([, v]) => v).sort(([a], [b]) => a.localeCompare(b)))
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
const rowNodes = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('tbody [data-workspace-record]')]
const columnNodes = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('thead [data-workspace-column]')]

/** Owns only table geometry. It never reads/writes a cell or rebuilds an editor to restore a view. */
export function useTableWorkspaceScroll(args: Args) {
  const projectId = getCurrentProjectId(), pageId = 'table-scroll:' + args.tabId
  const owner = useListWorkspaceView(projectId, pageId, 'none'), context = candidateApplyContext()
  const ownerKey = owner.ownerKey + context, query = filterKey(args.filters)
  const live = useRef({ ...args, projectId, pageId, owner, context }); live.current = { ...args, projectId, pageId, owner, context }
  const epoch = useRef({ value: 0 }), writable = useRef(false), pending = useRef(false)
  const previous = useRef({ ownerKey, generation: owner.generation, ready: false, focusRowId: args.focusRowId })
  const current = () => {
    const v = live.current
    return v.ready && v.owner.isCurrent() && v.context === candidateApplyContext() && v.owner.generation === workspaceViews.generation()
  }
  const capture = useCallback(() => {
    const v = live.current, el = v.scrollRef.current
    if (!el || !writable.current || pending.current || !v.ready || !v.owner.isCurrent()
      || v.context !== candidateApplyContext() || v.owner.generation !== workspaceViews.generation()) return
    const scope = currentWorkspaceScope(v.projectId, v.pageId)
    if (!scope) return
    const box = el.getBoundingClientRect(), scale = viewportScale(box.height, el.offsetHeight)
    const header = el.querySelector('thead tr')?.getBoundingClientRect(), outer = el.closest('main')
    const top = header?.bottom ?? box.top
    const anchor = firstVisibleAnchor(rowNodes(el).map(row => { const r = row.getBoundingClientRect()
      return { id: row.dataset.workspaceRecord ?? '', top: r.top / scale, bottom: r.bottom / scale } }), top / scale, box.bottom / scale)
    const column = firstVisibleAnchor(columnNodes(el).map(node => { const r = node.getBoundingClientRect()
      return { id: node.dataset.workspaceColumn ?? '', top: r.left / scale, bottom: r.right / scale } }), box.left / scale, box.right / scale)
    const value: TableView = { version: 1, kind: 'table', objectId: 'viewport', filters: v.filters, anchor,
      scroll: { top: el.scrollTop, ratio: scrollRatio(el.scrollTop, el.scrollHeight - el.clientHeight), outerTop: outer?.scrollTop ?? 0,
        outerRatio: outer ? scrollRatio(outer.scrollTop, outer.scrollHeight - outer.clientHeight) : 0 },
      horizontal: { left: el.scrollLeft, ratio: scrollRatio(el.scrollLeft, el.scrollWidth - el.clientWidth), anchor: column } }
    workspaceViews.put(scope, value, v.owner.generation)
  }, [])
  useEffect(() => args.ready ? registerWorkspaceCapture(capture) : undefined, [args.ready, capture])
  useEffect(() => {
    const el = args.scrollRef.current
    if (!args.ready || !el) return
    let raf = 0
    const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(capture) }
    const cancel = () => { epoch.current.value++; pending.current = false; delete el.dataset.workspaceRestoring; live.current.pinRestore(null); writable.current = true }
    const loseFocus = () => { epoch.current.value++; pending.current = false; delete el.dataset.workspaceRestoring; live.current.pinRestore(null) }
    el.addEventListener('scroll', onScroll, { passive: true })
    for (const event of ['pointerdown', 'wheel', 'keydown', 'input', 'compositionstart']) el.addEventListener(event, cancel, true)
    window.addEventListener('blur', loseFocus); document.addEventListener('visibilitychange', loseFocus)
    return () => {
      cancelAnimationFrame(raf); el.removeEventListener('scroll', onScroll)
      for (const event of ['pointerdown', 'wheel', 'keydown', 'input', 'compositionstart']) el.removeEventListener(event, cancel, true)
      window.removeEventListener('blur', loseFocus); document.removeEventListener('visibilitychange', loseFocus)
    }
  }, [args.ready, args.scrollRef, capture])
  useEffect(() => {
    const clock = epoch.current, el = args.scrollRef.current, mine = ++clock.value, prior = previous.current
    previous.current = { ownerKey, generation: owner.generation, ready: args.ready, focusRowId: args.focusRowId }
    writable.current = false; pending.current = false
    if (!args.ready || !el || !current()) return
    // An optional invalidation does not unmount a virtualized live input or revive the old snapshot.
    if (prior.ready && prior.ownerKey === ownerKey && prior.generation !== owner.generation) return
    const scope = currentWorkspaceScope(projectId, pageId), record = scope ? workspaceViews.get(scope, 'viewport') : null
    const saved = record?.kind === 'table' ? record : null
    if (args.focusRowId || (prior.ready && prior.ownerKey === ownerKey && prior.focusRowId)) {
      el.scrollLeft = 0; writable.current = true; return
    }
    if (!saved) { el.scrollTop = 0; el.scrollLeft = 0; writable.current = true; return }
    const sameFilter = filterKey(saved.filters) === query
    const cancelled = () => mine !== clock.value || !current() || !el.isConnected
    pending.current = true
    el.dataset.workspaceRestoring = 'true'
    void (async () => {
      const target = sameFilter && saved.anchor && live.current.ids.includes(saved.anchor.id) ? saved.anchor : null
      live.current.pinRestore(target?.id ?? null)
      if (target) live.current.revealId(target.id)
      else el.scrollTop = 0
      let last = '', stable = 0
      for (let n = 0; n < 90; n++) {
        await frame(); if (cancelled()) return
        const row = target ? rowNodes(el).find(node => node.dataset.workspaceRecord === target.id) : null
        if (target && !row) { if (n % 4 === 0) live.current.revealId(target.id); continue }
        const box = el.getBoundingClientRect(), scale = viewportScale(box.height, el.offsetHeight)
        const header = el.querySelector('thead tr')?.getBoundingClientRect()
        if (target && row) el.scrollTop = anchorScrollTop(el.scrollTop, row.getBoundingClientRect().top / scale,
          (header?.bottom ?? box.top) / scale, target.offset, el.scrollHeight - el.clientHeight)
        const column = saved.horizontal.anchor
        const node = column ? columnNodes(el).find(node => node.dataset.workspaceColumn === column.id) : null
        el.scrollLeft = column ? anchorScrollTop(el.scrollLeft, node ? node.getBoundingClientRect().left / scale : null,
          box.left / scale, column.offset, el.scrollWidth - el.clientWidth) : ratioScrollTop(saved.horizontal.ratio, el.scrollWidth - el.clientWidth)
        const size = [el.clientHeight, el.clientWidth, el.scrollHeight, el.scrollTop, el.scrollLeft].join(':')
        stable = document.fonts.status !== 'loading' && size === last ? stable + 1 : 0; last = size
        if (stable >= 2) break
      }
      if (cancelled()) return
      const outer = el.closest('main')
      if (outer) outer.scrollTop = ratioScrollTop(saved.scroll.outerRatio, outer.scrollHeight - outer.clientHeight)
      pending.current = false; writable.current = true
    })().catch(() => { if (!cancelled()) { pending.current = false; writable.current = true } })
      .finally(() => { if (mine === clock.value) { delete el.dataset.workspaceRestoring; live.current.pinRestore(null) } })
    return () => { clock.value++; pending.current = false; delete el.dataset.workspaceRestoring; live.current.pinRestore(null) }
    // IDs and widths can change while measuring; read them live without restarting on cell edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.ready, args.focusRowId, ownerKey, owner.generation, query, projectId, pageId])
}
