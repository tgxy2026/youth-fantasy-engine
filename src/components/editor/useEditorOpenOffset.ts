import { useEffect, useRef, type RefObject } from 'react'
import { contentRevision } from '@/lib/editor/editorViewMath'
import { workspaceViews } from '@/lib/settings/workspaceViewState'
import { showToast } from '@/components/dialogs/dialogs'

const STABLE_FRAMES = 45
export interface EditorOpenOffsetArgs {
  enabled: boolean
  activeId: string | null
  openChapterId: string | null
  offset: number | null
  matchLength?: number | null
  taRef: RefObject<HTMLTextAreaElement>
  requestId?: number
  expectedRevision?: string
  content: string | null
}

/** Own one activation for a fresh request; manually returning to that chapter may restore its view. */
export function createPositionOwnership() {
  let active: string | null = null, key: string | null = null, consumed: string | null = null, owns = false
  return (chapter: string | null, request: string | null): boolean => {
    if (active !== chapter || key !== request) {
      active = chapter; key = request
      owns = request != null && request !== consumed
      if (owns) consumed = request
    }
    return owns
  }
}

/** Pure fallback; measuredTop includes soft wrapping when supplied by the DOM mirror below. */
export function scrollTopForOffset(value: string, start: number, lineHeight: number, clientHeight: number, scrollHeight: number, measuredTop?: number): number {
  const safeStart = Math.max(0, Math.min(value.length, Math.trunc(Number.isFinite(start) ? start : 0)))
  let lines = 0
  for (let i = 0; i < safeStart; i++) if (value.charCodeAt(i) === 10) lines++
  const height = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 24
  const top = measuredTop != null && Number.isFinite(measuredTop) ? measuredTop : lines * height
  return Math.max(0, Math.min(Math.max(0, scrollHeight - clientHeight), Math.round(top - clientHeight / 3)))
}

/** A short-lived, invisible mirror measures the caret using the actual font, padding and wrapping. */
function caretTop(ta: HTMLTextAreaElement, offset: number): number {
  const mirror = ta.ownerDocument.createElement('div'), marker = ta.ownerDocument.createElement('span')
  const style = getComputedStyle(ta)
  for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'textIndent', 'textTransform', 'tabSize', 'direction', 'wordBreak', 'overflowWrap'] as const) mirror.style[property] = style[property]
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', left: '0', top: '0',
    width: ta.clientWidth + 'px', boxSizing: 'border-box', whiteSpace: 'pre-wrap', border: '0' })
  mirror.setAttribute('aria-hidden', 'true')
  mirror.append(ta.ownerDocument.createTextNode(ta.value.slice(0, offset)))
  marker.textContent = ta.value.slice(offset, offset + 1) || '\u200b'
  mirror.append(marker); ta.ownerDocument.body.append(mirror)
  try { return marker.offsetTop } finally { mirror.remove() }
}

export function useEditorOpenOffset({ enabled, activeId, openChapterId, offset, matchLength, taRef, requestId, expectedRevision, content }: EditorOpenOffsetArgs): boolean {
  const attempted = useRef(''), epoch = useRef(0), ownership = useRef(createPositionOwnership())
  const requestKey = offset != null && activeId === openChapterId
    ? JSON.stringify([requestId ?? 0, openChapterId, offset, matchLength ?? 0, expectedRevision ?? '']) : null
  const ownsPosition = ownership.current(activeId, requestKey)
  useEffect(() => {
    if (!enabled) return
    const cancel = () => { epoch.current++ }
    const events = ['input', 'compositionstart', 'keydown', 'pointerdown', 'wheel'] as const
    for (const name of events) document.addEventListener(name, cancel, { capture: true, passive: true })
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', cancel)
    const off = workspaceViews.subscribeInvalidation(cancel)
    return () => {
      for (const name of events) document.removeEventListener(name, cancel, { capture: true })
      window.removeEventListener('blur', cancel); document.removeEventListener('visibilitychange', cancel); off()
    }
  }, [enabled])

  useEffect(() => {
    const token = ++epoch.current
    if (!enabled || !ownsPosition || !activeId || openChapterId !== activeId || requestKey == null || offset == null || content == null) return
    if (attempted.current === requestKey) return
    attempted.current = requestKey // An interrupted request is consumed too: saving must not resurrect it.
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > content.length) return
    const ta = taRef.current
    if (!ta) return
    let disposed = false
    const generation = workspaceViews.generation()
    const cancelled = () => disposed || epoch.current !== token || workspaceViews.generation() !== generation || document.hidden || !ta.isConnected
    void (async () => {
      let fontsReady = !document.fonts || document.fonts.status === 'loaded'
      void document.fonts?.ready.then(() => { fontsReady = true }).catch(() => {})
      let previous = '', stable = 0
      for (let frame = 0; frame < STABLE_FRAMES; frame++) {
        if (cancelled()) return
        const geometry = [ta.clientWidth, ta.clientHeight, ta.scrollHeight].join(':')
        const ready = fontsReady && ta.value === content && ta.clientHeight > 0
        stable = ready && geometry === previous ? stable + 1 : 0
        previous = geometry
        if (stable >= 2) break
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      }
      if (cancelled() || stable < 2 || ta.value !== content || document.querySelector('[role="dialog"]')) return
      if (expectedRevision && contentRevision(ta.value) !== expectedRevision) {
        showToast('章节内容已更新，已打开章节；请重新检索定位', 'info'); return
      }
      const length = Number.isSafeInteger(matchLength) && (matchLength ?? 0) > 0 ? matchLength! : 0
      const end = Math.min(content.length, offset + length)
      const top = caretTop(ta, offset)
      ta.setSelectionRange(offset, end, 'forward')
      ta.scrollTop = scrollTopForOffset(content, offset, Number.parseFloat(getComputedStyle(ta).lineHeight), ta.clientHeight, ta.scrollHeight, top)
      const focused = document.activeElement
      if (document.hasFocus() && (!focused || focused === document.body || focused === ta)) ta.focus({ preventScroll: true })
    })().catch(() => { /* Optional positioning must never change the chapter content or saving outcome. */ })
    return () => { disposed = true }
  }, [enabled, ownsPosition, activeId, openChapterId, requestKey, offset, matchLength, expectedRevision, content, taRef])
  return ownsPosition
}
