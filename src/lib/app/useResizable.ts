import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'
import { currentUiZoom } from '@/lib/settings/theme'

interface Opts {
  key: string
  initial: number
  initialWide?: number
  min: number
  max: number
  side?: 'left' | 'right'
}
interface DragSession { id: number; x: number; size: number; target: HTMLElement }

/** Pointer coordinates are visual pixels; persisted panel widths are layout pixels. */
export function useResizable({ key, initial, initialWide, min, max, side = 'right' }: Opts) {
  const clamp = useCallback((value: number) => Math.min(max, Math.max(min, value)), [min, max])
  const defaultSize = useCallback(() => clamp(initialWide && window.innerWidth >= 2000 ? initialWide : initial), [clamp, initial, initialWide])
  const [size, setSize] = useState(() => {
    try {
      const value = Number(localStorage.getItem(key))
      if (Number.isFinite(value) && value >= min && value <= max) return value
    } catch { /* Session-only sizing remains available when preferences cannot be read. */ }
    return defaultSize()
  })
  const sizeRef = useRef(size)
  sizeRef.current = size
  const session = useRef<DragSession | null>(null)
  const [dragging, setDragging] = useState(false)
  const finishRef = useRef<() => void>(() => {})

  useEffect(() => {
    try { localStorage.setItem(key, String(size)) } catch { /* Keep the current session width. */ }
  }, [key, size])

  useEffect(() => {
    const release = () => {
      const drag = session.current
      session.current = null
      if (!drag) return
      drag.target.removeEventListener('lostpointercapture', finish)
      try { if (drag.target.hasPointerCapture(drag.id)) drag.target.releasePointerCapture(drag.id) } catch { /* Target may already be detached. */ }
    }
    const finish = () => { release(); setDragging(false) }
    finishRef.current = finish
    const move = (event: globalThis.PointerEvent) => {
      const drag = session.current
      if (!drag || event.pointerId !== drag.id) return
      const delta = (event.clientX - drag.x) / currentUiZoom() * (side === 'right' ? 1 : -1)
      sizeRef.current = clamp(drag.size + delta)
      setSize(sizeRef.current)
    }
    const end = (event: globalThis.PointerEvent) => { if (event.pointerId === session.current?.id) finish() }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    window.addEventListener('blur', finish)
    return () => {
      release()
      finishRef.current = () => {}
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      window.removeEventListener('blur', finish)
    }
  }, [clamp, side])

  const onDragStart = useCallback((event: PointerEvent<HTMLElement>) => {
    if (!event.isPrimary || event.button !== 0) return
    event.preventDefault()
    finishRef.current()
    session.current = { id: event.pointerId, x: event.clientX, size: sizeRef.current, target: event.currentTarget }
    event.currentTarget.addEventListener('lostpointercapture', finishRef.current)
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* Global matching-pointer listeners still finish the gesture. */ }
    setDragging(true)
  }, [])
  const adjust = useCallback((delta: number) => {
    finishRef.current()
    setSize(value => clamp(value + delta))
  }, [clamp])
  const reset = useCallback(() => { finishRef.current(); setSize(defaultSize()) }, [defaultSize])
  const setWidth = useCallback((value: number) => { finishRef.current(); setSize(clamp(value)) }, [clamp])
  return { size, min, max, dragging, onDragStart, adjust, reset, setWidth }
}
