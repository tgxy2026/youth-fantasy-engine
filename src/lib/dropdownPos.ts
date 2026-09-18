/**
 * 锚定浮层的定位几何（2026-09-19 六维审计抽出）
 *
 * 此前这段「下方不够就上翻 + 算可用高度 + 夹住左边」的算法在 5 个下拉组件里各写一遍
 * （CalendarSelect / CalendarPicker / CharacterSelect / CustomSelect / TableRefSelect），
 * 参数还各自漂移（估算高度 256/264/288、翻转阈值 200/220/240/248、留白 8/12）。
 * 复制粘贴的必然结局就是"改一处漏四处"，所以把**纯几何**收成一处：
 * 组件只负责"什么时候重算"，这里负责"算成什么"。
 *
 * ⚠️ 这里只能用 `getBoundingClientRect()`：算的是**视口坐标**（浮层是 fixed 定位），
 *    与 `window.innerHeight` 同坐标系；界面缩放下依然正确（这也正是项目红线里
 *    "量尺寸用 offsetHeight" 的例外情形 —— 那是量元素自身尺寸，这是量视口位置）。
 */
export interface DropdownPos {
  left: number
  top: number
  minWidth: number
  /** 未提供 estH 时无此字段（浮层靠自身 max-h-* 类限高） */
  maxHeight?: number
  flip: boolean
}

export interface DropdownPosOptions {
  /** 浮层估算高度；传 null 表示不产出 maxHeight（由 CSS 类限高） */
  estH?: number | null
  /** 下方剩余空间小于该值时才考虑上翻 */
  flipBelow?: number
  /** 与触发键的间距 */
  gap?: number
  /** 距视口边缘的留白 */
  margin?: number
  /** 浮层最小宽度 */
  minWidth?: number
  /** 浮层最小高度 */
  minHeight?: number
  /** 左边缘上限：`Math.min(left, window.innerWidth - clampRight)`，用于避免贴右边溢出 */
  clampRight?: number
}

export function computeDropdownPos(r: DOMRect, opts: DropdownPosOptions = {}): DropdownPos {
  const {
    estH = 256, flipBelow = 200, gap = 4, margin = 8,
    minWidth = 160, minHeight = 160, clampRight,
  } = opts
  const spaceBelow = window.innerHeight - r.bottom
  const spaceAbove = r.top
  const flip = spaceBelow < flipBelow && spaceAbove > spaceBelow
  const avail = flip ? spaceAbove - margin : spaceBelow - margin
  const rawLeft = clampRight ? Math.min(r.left, window.innerWidth - clampRight) : r.left
  const pos: DropdownPos = {
    left: Math.max(margin, Math.round(rawLeft)),
    top: Math.round(flip ? r.top - gap : r.bottom + gap),
    minWidth: Math.max(minWidth, Math.round(r.width)),
    flip,
  }
  if (estH != null) pos.maxHeight = Math.min(Math.max(minHeight, avail), estH)
  return pos
}
