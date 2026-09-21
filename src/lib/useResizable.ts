import { useCallback, useEffect, useRef, useState } from 'react'

interface Opts {
  /** localStorage 存储键，记住用户调整后的宽度 */
  key: string
  initial: number
  /** 大屏（宽 >= WIDE_THRESHOLD）下的默认初始宽度；用于 4K/2K 等高分屏下给出更合理的默认窗格大小 */
  initialWide?: number
  min: number
  max: number
  /** 拖拽边：'right' = 向右拖增大，'left' = 向左拖增大 */
  side?: 'left' | 'right'
}

/** 屏宽达到该值视为「大屏」，使用 initialWide 作为默认初始宽度 */
const WIDE_THRESHOLD = 2000

/**
 * 可拖拽调整宽度的面板（侧边栏 / 章节树 / 设定检索）。
 * 宽度持久化到 localStorage，且在 <html> 设置了 zoom 时自动把视觉位移换算回布局像素，避免缩放后拖拽错位。
 * 首次使用（无存储值）时，若处于大屏则采用 initialWide，让高分屏下的窗格默认更宽、不至于字小挤成一团。
 */
export function useResizable({ key, initial, initialWide, min, max, side = 'right' }: Opts) {
  const [size, setSize] = useState<number>(() => {
    const v = Number(localStorage.getItem(key))
    if (Number.isFinite(v) && v >= min && v <= max) return v
    const base =
      initialWide && typeof window !== 'undefined' && window.innerWidth >= WIDE_THRESHOLD
        ? initialWide
        : initial
    return Math.min(max, Math.max(min, base))
  })

  useEffect(() => {
    try { localStorage.setItem(key, String(size)) } catch { /* 忽略 */ }
  }, [key, size])

  const [dragging, setDragging] = useState(false)
  const startX = useRef(0)
  const startSize = useRef(size)

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    startX.current = e.clientX
    startSize.current = size
    setDragging(true)
  }, [size])

  // 拖拽期间挂载全局监听；松开或组件卸载时统一清理，避免泄漏悬挂的 mousemove/mouseup
  useEffect(() => {
    if (!dragging) return
    const onMove = (ev: MouseEvent) => {
      const z = Number(document.documentElement.style.zoom) || 1
      const dx = (ev.clientX - startX.current) / z
      const delta = side === 'right' ? dx : -dx
      setSize(Math.min(max, Math.max(min, startSize.current + delta)))
    }
    const onUp = () => setDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging, min, max, side])

  return { size, onDragStart }
}
