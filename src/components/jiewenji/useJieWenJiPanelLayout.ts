/**
 * 颉文姬面板的停靠 / 浮动交互（3.6.1 · B 方案）
 *
 * 【默认必须是改动前的样子】开关关闭时走原样式的 `absolute right-3 top-14 bottom-10 w-[360px]`，
 *   **不用内联几何** —— 改动前是怎么定位的，现在还怎么定位，避免"只是加了个开关，位置却挪了两像素"。
 * 【浮动时用 fixed + 视口坐标】切换那一刻读一次 `getBoundingClientRect()` 作为初始矩形，
 *   所以无论原来相对谁定位，切过去都不会跳；之后拖动只做视口坐标加减与夹取。
 *
 * 🔴 拖动只认标题栏，且跳过按钮/输入框（`data-no-drag` 也跳过）：
 *    否则"想点收起，结果把面板拖走了"。
 * 🔴 松手吸附到最近一侧，但保留纵向位置 —— 吸附是为了"换到另一边"，不是为了跳回默认高度。
 * 🔴 窄窗口（< 1180）一律按停靠渲染，但**不改写**偏好：窗口拉宽后自动恢复浮动。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { readStringPref, writeStringPref } from '@/lib/settings/uiPrefs'
import {
  DEFAULT_PANEL_PREFS, PANEL_FLOAT_MIN_VIEWPORT, clampFloatingRect, dockedRect, effectiveMode,
  initialFloatingRect, normalizePanelPrefs, serializePanelPrefs, snapSide, snappedLeft,
  type PanelPrefs, type PanelRect, type PanelViewport,
} from '@/lib/app/panelDock'

const PREF_KEY = 'jiewenji-panel'

function readPrefs(): PanelPrefs {
  try {
    const raw = readStringPref(PREF_KEY)
    return raw ? normalizePanelPrefs(JSON.parse(raw)) : { ...DEFAULT_PANEL_PREFS }
  } catch {
    // 读不到 / 解析失败一律回默认：面板位置坏掉不该让 AI 面板打不开
    return { ...DEFAULT_PANEL_PREFS }
  }
}

function viewportOf(): PanelViewport {
  if (typeof window === 'undefined') return { width: 1440, height: 900 }
  return { width: window.innerWidth, height: window.innerHeight }
}

export interface JieWenJiPanelLayout {
  prefs: PanelPrefs
  /** 实际生效的模式（窄窗口会把 floating 降级成 docked） */
  mode: 'docked' | 'floating'
  /** 当前窗口是否够宽到可以浮动 */
  canFloat: boolean
  /** 停靠模式的 className（与改动前逐字一致，仅左右可切） */
  dockedClass: string
  /** 浮动模式的内联几何；停靠时为 null */
  floatingStyle: React.CSSProperties | null
  dragging: boolean
  panelRef: React.RefObject<HTMLDivElement>
  toggleMode: () => void
  switchSide: () => void
  reset: () => void
  headerProps: {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void
    onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void
    onDoubleClick: (e: React.MouseEvent<HTMLDivElement>) => void
  }
  resizeHandleProps: {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void
  }
}

/** 拖动起点快照 */
interface DragState { pointerId: number; startX: number; startY: number; origin: PanelRect }
/** 拉宽起点快照 */
interface ResizeState { pointerId: number; startX: number; origin: PanelRect }

const INTERACTIVE = 'button, a, input, textarea, select, [role="button"], [data-no-drag]'

export function useJieWenJiPanelLayout(): JieWenJiPanelLayout {
  const panelRef = useRef<HTMLDivElement>(null)
  const [prefs, setPrefs] = useState<PanelPrefs>(readPrefs)
  const [viewport, setViewport] = useState<PanelViewport>(viewportOf)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<DragState | null>(null)
  const resizeRef = useRef<ResizeState | null>(null)

  // 窗口尺寸变化：只更新视口，几何在渲染时重新夹取（偏好本身不动）
  useEffect(() => {
    const onResize = () => setViewport(viewportOf())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 偏好持久化：写失败只影响"下次记住"，不影响本次会话
  useEffect(() => { writeStringPref(PREF_KEY, serializePanelPrefs(prefs)) }, [prefs])

  const mode = effectiveMode(prefs, viewport)
  const canFloat = viewport.width >= PANEL_FLOAT_MIN_VIEWPORT

  const floatingRect = useMemo<PanelRect | null>(() => {
    if (mode !== 'floating') return null
    const base = prefs.rect ?? initialFloatingRect(dockedRect(prefs, viewport), prefs, viewport)
    return clampFloatingRect(base, viewport)
  }, [mode, prefs, viewport])

  const dockedClass = prefs.side === 'left'
    ? 'absolute left-3 top-14 bottom-10 w-[360px]'
    : 'absolute right-3 top-14 bottom-10 w-[360px]'

  const floatingStyle = floatingRect
    ? {
        left: `${floatingRect.left}px`,
        top: `${floatingRect.top}px`,
        width: `${floatingRect.width}px`,
        height: `${floatingRect.height}px`,
      }
    : null

  /** 当前面板在视口里的真实矩形（切换模式与拖动的统一起点） */
  const currentRect = useCallback((): PanelRect => {
    const el = panelRef.current
    if (el) {
      const box = el.getBoundingClientRect()
      if (box.width > 0 && box.height > 0) {
        return { left: box.left, top: box.top, width: box.width, height: box.height }
      }
    }
    return floatingRect ?? dockedRect(prefs, viewport)
  }, [floatingRect, prefs, viewport])

  const toggleMode = useCallback(() => {
    setPrefs(previous => {
      const nextMode = effectiveMode(previous, viewport) === 'floating' ? 'docked' : 'floating'
      if (nextMode === 'docked') return { ...previous, mode: 'docked' }
      const rect = clampFloatingRect(initialFloatingRect(currentRect(), previous, viewport), viewport)
      return { ...previous, mode: 'floating', width: rect.width, rect }
    })
  }, [currentRect, viewport])

  const switchSide = useCallback(() => {
    setPrefs(previous => {
      const side = previous.side === 'left' ? 'right' : 'left'
      const rect = previous.rect
      // 浮动时换边＝立刻吸附到另一侧（纵向位置保留）
      if (effectiveMode(previous, viewport) === 'floating' && rect) {
        const moved = clampFloatingRect({ ...rect, left: snappedLeft(side, rect.width, viewport) }, viewport)
        return { ...previous, side, rect: moved }
      }
      return { ...previous, side }
    })
  }, [viewport])

  const reset = useCallback(() => { setPrefs({ ...DEFAULT_PANEL_PREFS }) }, [])

  // ---------- 拖动（只认标题栏） ----------
  const onHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (mode !== 'floating') return
    const target = e.target as HTMLElement
    if (target.closest(INTERACTIVE)) return
    e.preventDefault()
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, origin: currentRect() }
    setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onHeaderPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const next = clampFloatingRect({
      ...drag.origin,
      left: drag.origin.left + (e.clientX - drag.startX),
      top: drag.origin.top + (e.clientY - drag.startY),
    }, viewport)
    setPrefs(previous => ({ ...previous, rect: next }))
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    dragRef.current = null
    setDragging(false)
    // 松手吸附：横向贴边，纵向留在原处（吸附是为了换边，不是跳回默认高度）
    setPrefs(previous => {
      const rect = previous.rect
      if (!rect) return previous
      const clamped = clampFloatingRect(rect, viewport)
      const side = snapSide(clamped, viewport)
      return { ...previous, side, rect: clampFloatingRect({ ...clamped, left: snappedLeft(side, clamped.width, viewport) }, viewport) }
    })
  }

  // ---------- 拉宽（右下角把手） ----------
  const onResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (mode !== 'floating') return
    e.preventDefault()
    e.stopPropagation()
    resizeRef.current = { pointerId: e.pointerId, startX: e.clientX, origin: currentRect() }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current
    if (!resize || resize.pointerId !== e.pointerId) return
    const next = clampFloatingRect({
      ...resize.origin,
      width: resize.origin.width + (e.clientX - resize.startX),
    }, viewport)
    setPrefs(previous => ({ ...previous, width: next.width, rect: next }))
  }

  const endResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current
    if (!resize || resize.pointerId !== e.pointerId) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    resizeRef.current = null
  }

  return {
    prefs, mode, canFloat, dockedClass, floatingStyle, dragging, panelRef,
    toggleMode, switchSide, reset,
    headerProps: {
      onPointerDown: onHeaderPointerDown,
      onPointerMove: onHeaderPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      // 双击复位只认标题栏空白处：双击「收起/开关」这类按钮时不该顺带把位置也重置了
      onDoubleClick: e => {
        if ((e.target as HTMLElement).closest(INTERACTIVE)) return
        if (mode === 'floating') reset()
      },
    },
    resizeHandleProps: {
      onPointerDown: onResizePointerDown,
      onPointerMove: onResizePointerMove,
      onPointerUp: endResize,
    },
  }
}
