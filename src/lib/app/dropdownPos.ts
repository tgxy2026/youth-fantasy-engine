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
 *    与 `window.innerWidth/Height` 同坐标系（这也正是项目红线里"量尺寸用 offsetHeight"的
 *    例外情形 —— 那是量元素自身尺寸，这是量视口位置）。
 *
 * 🔴🔴 2026-10-13 六维审计补修（**与 HelpPopover 同根因的漏修**）：
 *    上面那句原先写的是「界面缩放下依然正确」——**错了**。`<html style="zoom:X">` 下：
 *      · `getBoundingClientRect()` 与 `window.innerWidth/Height` 返回的都是**视觉像素**（已乘 zoom）；
 *      · 而写回 `style.left/top/minWidth/maxHeight` 的值会被浏览器**再乘一次 zoom**；
 *      · 本文件的 `gap / margin / estH / minWidth / minHeight / clampRight` 是**逻辑像素**常量。
 *    三者混算的结果：zoom 1.08 时下拉整体右移 ~8%、翻转判断偏、maxHeight 偏小。
 *    这正是 2026-10-13 修 HelpPopover 时的同一个病 —— 当时只修了那一个组件，本文件漏了。
 *    ⇒ 现在把**输入统一折成逻辑像素**（`foldPx`），全程在逻辑坐标系里算，输出直接写 style。
 *    窄窗口测不出（1200px 以下 autoZoom = 100%），必须宽屏验。
 */
import { foldPx, currentUiZoom } from '@/lib/settings/theme'

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
  // 🔴 折算见文件头「2026-10-13 六维审计补修」：一次定位只读一次 zoom，再逐个折算。
  const z = currentUiZoom()
  const left0 = foldPx(r.left, z)
  const top0 = foldPx(r.top, z)
  const bottom0 = foldPx(r.bottom, z)
  const width0 = foldPx(r.width, z)
  const vw = foldPx(window.innerWidth, z)
  const vh = foldPx(window.innerHeight, z)
  // 以下全部在**逻辑像素**坐标系里算（常量与量得的坐标同口径）
  const spaceBelow = vh - bottom0
  const spaceAbove = top0
  const flip = spaceBelow < flipBelow && spaceAbove > spaceBelow
  const avail = flip ? spaceAbove - margin : spaceBelow - margin
  const rawLeft = clampRight ? Math.min(left0, vw - clampRight) : left0
  const pos: DropdownPos = {
    left: Math.max(margin, Math.round(rawLeft)),
    top: Math.round(flip ? top0 - gap : bottom0 + gap),
    minWidth: Math.max(minWidth, Math.round(width0)),
    flip,
  }
  if (estH != null) pos.maxHeight = Math.min(Math.max(minHeight, avail), estH)
  return pos
}
