import type { ViewAnchor } from './workspaceViewState'

export function viewportScale(rectHeight: number, layoutHeight: number): number {
  const scale = rectHeight / layoutHeight
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}

export function firstVisibleAnchor(rows: readonly { id: string; top: number; bottom: number }[], top: number, bottom: number): ViewAnchor | undefined {
  const row = rows.find(row => row.id.trim().length > 0 && row.id.length <= 256 && !/[\u0000-\u001f\u007f]/.test(row.id) && Number.isFinite(row.top)
    && Number.isFinite(row.bottom) && row.bottom > top && row.top < bottom)
  return row ? { id: row.id, offset: row.top - top } : undefined
}
export function anchorScrollTop(current: number, targetTop: number | null, viewportTop: number, offset: number, max: number): number {
  if (targetTop === null) return 0 // The original object is gone; never invent or resurrect it.
  const value = current + targetTop - viewportTop - offset
  return Number.isFinite(value) && Number.isFinite(max) ? Math.max(0, Math.min(Math.max(0, max), value)) : 0
}
export function ratioScrollTop(ratio: number, max: number): number {
  return Number.isFinite(ratio) && Number.isFinite(max) ? Math.max(0, Math.min(1, ratio)) * Math.max(0, max) : 0
}
/** A consumed/cleared prop cannot revive a request; fresh generations and legacy focus cycles can. */
export function createScrollTargetRequests() {
  let owner = '', request: number | undefined, lastFocus: string | null = null, serial = 0
  let target = { key: 0, id: null as string | null, consumed: true }
  return (nextOwner: string, nextRequest: number | undefined, focus: string | null) => {
    if (owner !== nextOwner || request !== nextRequest || (focus !== null && focus !== lastFocus)) {
      target = { key: ++serial, id: focus, consumed: focus === null }
    }
    owner = nextOwner; request = nextRequest; lastFocus = focus
    return target
  }
}
