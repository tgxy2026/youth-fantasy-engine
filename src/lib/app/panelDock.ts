/**
 * 颉文姬面板的停靠 / 浮动几何（3.6.1 · B 方案）
 *
 * 【为什么要纯函数】面板位置涉及四种容易写错的边界：窗口缩放、界面缩放、窄窗口、拖到屏幕外。
 * 把「默认停靠矩形 / 浮动矩形夹取 / 松手吸附 / 坏偏好归一」都放在这里，组件只读结果，
 * 测试可以逐条钉住，不必靠手动拖。
 *
 * 🔴 默认状态必须与改动前**逐像素一致**：贴边 12px、顶部 56px（工具栏下方）、距底 40px、宽 360px。
 *    这也是"开关默认关闭"的含义 —— 关闭时走 `dockedRect`，不引入任何新几何。
 * 🔴 浮动只在够宽的窗口里生效（见 `effectiveMode`）：窄窗口把面板浮在正文上会直接挡住正文，
 *    所以窄时强制回落停靠，但**不清掉**用户的浮动偏好 —— 窗口变宽后自动恢复。
 */

export type PanelMode = 'docked' | 'floating'
export type PanelSide = 'left' | 'right'

export interface PanelRect {
  left: number
  top: number
  width: number
  height: number
}

export interface PanelViewport {
  width: number
  height: number
}

export interface PanelPrefs {
  mode: PanelMode
  /** 停靠边；浮动时也记着上次吸附到哪一侧，复位与拖回都据此 */
  side: PanelSide
  /** 浮动宽度（停靠宽度固定为 DEFAULT_WIDTH，与改动前一致） */
  width: number
  /** 浮动时的矩形；从未浮动过为 null */
  rect: PanelRect | null
}

/**
 * 把**屏幕像素**折算成**可写进 style 的像素**（3.6.1 修：右侧吸附只露半边）。
 *
 * 🔴 为什么需要：`<html>` 上有 `zoom: var(--ui-zoom)`，内联 `left/top/width/height`
 *    会被浏览器**再乘一次 zoom**。直接写 `window.innerWidth - width` 这类屏幕坐标，
 *    在 zoom≠1 时整体右移、尺寸放大 —— 表现就是"吸附右侧只剩半边、上下长度也不对"。
 *    项目里已有同一口径的 `foldPx`（`lib/settings/theme`），这里独立一份是为了让本模块
 *    保持纯函数、可在 node 里测（`foldPx` 依赖 document）。
 */
export function toLocalPx(screenPx: number, zoom: number): number {
  return Number.isFinite(zoom) && zoom > 0 ? screenPx / zoom : screenPx
}

/** 视口在「style 像素」空间里的尺寸（与 toLocalPx 同一口径） */
export function localViewport(viewport: PanelViewport, zoom: number): PanelViewport {
  return { width: toLocalPx(viewport.width, zoom), height: toLocalPx(viewport.height, zoom) }
}

/** 距屏幕边（与改动前 right-3 一致） */
export const PANEL_EDGE = 12
/** 顶部起点（与改动前 top-14 一致：工具栏下方） */
export const PANEL_TOP = 56
/** 距底部（与改动前 bottom-10 一致） */
export const PANEL_BOTTOM = 40
/** 默认宽度（改动前 w-[360px]） */
export const PANEL_DEFAULT_WIDTH = 360
export const PANEL_MIN_WIDTH = 300
export const PANEL_MAX_WIDTH = 560
export const PANEL_MIN_HEIGHT = 320
/** 低于这个宽度不提供浮动（正文会被完全挡住） */
export const PANEL_FLOAT_MIN_VIEWPORT = 1180

export const DEFAULT_PANEL_PREFS: PanelPrefs = {
  mode: 'docked',
  side: 'right',
  width: PANEL_DEFAULT_WIDTH,
  rect: null,
}

const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

/** 停靠矩形：贴边 + 从工具栏下方到距底（与改动前一致） */
export function dockedRect(prefs: Pick<PanelPrefs, 'side'>, viewport: PanelViewport): PanelRect {
  const width = Math.min(PANEL_DEFAULT_WIDTH, Math.max(0, viewport.width - PANEL_EDGE * 2))
  const left = prefs.side === 'left' ? PANEL_EDGE : Math.max(PANEL_EDGE, viewport.width - width - PANEL_EDGE)
  const top = PANEL_TOP
  const height = Math.max(PANEL_MIN_HEIGHT, viewport.height - PANEL_TOP - PANEL_BOTTOM)
  return { left, top, width, height }
}

/**
 * 把浮动矩形夹回可视区：
 *   · 宽度/高度先按上下限收敛，且不超过「视口 - 两边留白」；
 *   · 左上角保证整块面板可见（不是只保证标题栏可见 —— 否则底部的输入框会被切掉）。
 */
export function clampFloatingRect(rect: PanelRect, viewport: PanelViewport): PanelRect {
  const maxWidth = Math.max(PANEL_MIN_WIDTH, viewport.width - PANEL_EDGE * 2)
  const width = clamp(rect.width, PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, maxWidth))
  const maxHeight = Math.max(PANEL_MIN_HEIGHT, viewport.height - PANEL_EDGE * 2)
  const height = clamp(rect.height, PANEL_MIN_HEIGHT, maxHeight)
  const left = clamp(rect.left, PANEL_EDGE, Math.max(PANEL_EDGE, viewport.width - width - PANEL_EDGE))
  const top = clamp(rect.top, PANEL_EDGE, Math.max(PANEL_EDGE, viewport.height - height - PANEL_EDGE))
  return { left, top, width, height }
}

/** 松手后吸附到哪一侧：看面板中心在视口中线的左还是右（平局算右侧，与默认值一致） */
export function snapSide(rect: Pick<PanelRect, 'left' | 'width'>, viewport: PanelViewport): PanelSide {
  const center = rect.left + rect.width / 2
  return center < viewport.width / 2 ? 'left' : 'right'
}

/** 吸附后该侧的左边距（面板保持当前宽度，只贴边） */
export function snappedLeft(side: PanelSide, width: number, viewport: PanelViewport): number {
  return side === 'left' ? PANEL_EDGE : Math.max(PANEL_EDGE, viewport.width - width - PANEL_EDGE)
}

/**
 * 实际生效的模式：窄窗口一律按停靠处理（但不改写用户偏好，窗口变宽会自动恢复浮动）。
 */
export function effectiveMode(
  prefs: Pick<PanelPrefs, 'mode'>,
  viewport: PanelViewport,
  minViewport = PANEL_FLOAT_MIN_VIEWPORT,
): PanelMode {
  if (prefs.mode !== 'floating') return 'docked'
  return viewport.width >= minViewport ? 'floating' : 'docked'
}

/** 切换到浮动时的初始矩形：沿用当前停靠位置（不跳），宽度用记忆值 */
export function initialFloatingRect(
  current: PanelRect,
  prefs: Pick<PanelPrefs, 'width'>,
  viewport: PanelViewport,
): PanelRect {
  const width = isNum(prefs.width) ? prefs.width : current.width
  // 以当前停靠的边为准决定向左还是向右展开，避免切换瞬间面板整体横移
  const keepRight = current.left + current.width / 2 >= viewport.width / 2
  const left = keepRight ? Math.max(PANEL_EDGE, current.left + current.width - width) : current.left
  return clampFloatingRect({ left, top: current.top, width, height: current.height }, viewport)
}

/**
 * 归一化持久化偏好（读 localStorage 后一律过这里）。
 * 🔴 坏值不能抛也不能当成合法值：手工改过、旧版本残留、字段缺失都退回默认 ——
 *    否则面板会出现在屏幕外，作者只会觉得"AI 面板不见了"。
 */
export function normalizePanelPrefs(raw: unknown): PanelPrefs {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PANEL_PREFS }
  const source = raw as Record<string, unknown>
  const mode: PanelMode = source.mode === 'floating' ? 'floating' : 'docked'
  const side: PanelSide = source.side === 'left' ? 'left' : 'right'
  // 非数字或非正数 = 坏值（手改过 / 旧版本残留）→ 回默认；正数越界才收敛到上下限
  const width = isNum(source.width) && source.width > 0
    ? clamp(source.width, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH)
    : PANEL_DEFAULT_WIDTH
  let rect: PanelRect | null = null
  const rawRect = source.rect as Record<string, unknown> | null | undefined
  if (rawRect && typeof rawRect === 'object'
    && isNum(rawRect.left) && isNum(rawRect.top) && isNum(rawRect.width) && isNum(rawRect.height)) {
    rect = { left: rawRect.left, top: rawRect.top, width: rawRect.width, height: rawRect.height }
  }
  // floating 却没有可用矩形 ⇒ 退回停靠，不留一个"漂在 (0,0)"的面板
  if (mode === 'floating' && !rect) return { ...DEFAULT_PANEL_PREFS, side, width }
  return { mode, side, width, rect }
}

/** 序列化（写回 localStorage 前统一走这里，避免把浮点噪声与临时字段写进去） */
export function serializePanelPrefs(prefs: PanelPrefs): string {
  const rect = prefs.rect
  return JSON.stringify({
    mode: prefs.mode,
    side: prefs.side,
    width: Math.round(prefs.width),
    ...(rect ? {
      rect: {
        left: Math.round(rect.left), top: Math.round(rect.top),
        width: Math.round(rect.width), height: Math.round(rect.height),
      },
    } : {}),
  })
}
