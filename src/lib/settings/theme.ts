// 主题与界面缩放的全局管理
// 主题通过给 <html> 设置 data-theme，配合 index.css 中按 [data-theme] 重定义的 CSS 变量生效；
// 由于全项目颜色都走 Tailwind 的 ink/amber 调色板（已改为 CSS 变量驱动），切换主题无需改动任何组件。

import { deriveCustomTheme, ALL_THEME_VAR_KEYS, INK_VAR_KEYS, GRAPH_NEUTRAL_KEYS, GRAPH_ACCENT_KEYS, type ThemeBase, type CustomThemeVars } from '@/lib/settings/customTheme'

// 门面显式再导出（勿 export *）：弹窗等消费方统一从本模块取主题相关类型
// （CustomThemeParams / ThemeId 本文件已声明并导出，此处只补 CustomThemeVars）
export type { CustomThemeVars }

export type ThemeId =
  | 'dark'
  | 'eye-care'
  | 'midnight'
  | 'sepia'
  | 'dusk-violet'
  | 'porcelain'
  | 'pine-ink'
  | 'peach-note'
  | 'custom'

export interface ThemeDef {
  id: ThemeId
  name: string
  desc: string
  /** 切换按钮上的小色块预览 */
  swatch: string
}

export const THEMES: ThemeDef[] = [
  { id: 'dark', name: '暗夜', desc: '深色', swatch: '#121218' },
  { id: 'eye-care', name: '护眼', desc: '浅绿·默认·护眼', swatch: '#cfe3c4' },
  { id: 'midnight', name: '午夜蓝', desc: '冷蓝·深色', swatch: '#1a2740' },
  { id: 'sepia', name: '羊皮卷', desc: '暖棕·浅色', swatch: '#e3d4b8' },
  { id: 'dusk-violet', name: '暮山紫', desc: '紫罗兰·深色', swatch: '#100d1a' },
  { id: 'porcelain', name: '青花', desc: '青白瓷·浅色', swatch: '#e4ecf4' },
  { id: 'pine-ink', name: '松烟墨', desc: '墨绿松烟·深色', swatch: '#0a1212' },
  { id: 'peach-note', name: '桃笺', desc: '暖粉胭脂·浅色', swatch: '#faecee' },
  { id: 'custom', name: '自定义', desc: '母版派生 · 可调色', swatch: 'conic-gradient(#e88, #ec8, #8c8, #8cc, #88c, #c8c, #e88)' },
]

/** 深浅基调（决定 color-scheme 与 graph 色是否参与派生）——与 index.css 各块的 color-scheme 声明保持一致 */
const DARK_THEMES = new Set<string>(['dark', 'midnight', 'dusk-violet', 'pine-ink'])

const THEME_KEY = 'yfe-theme'
const ZOOM_KEY = 'yfe-ui-zoom'
/** 用户是否手动调过缩放：'1' = 尊重存储值；否则按窗口宽度自动适配（2026-09-15） */
const ZOOM_MANUAL_KEY = 'yfe-ui-zoom-manual'

/**
 * 安全读取 localStorage。
 * 便携版是双击打开的 file:// 单文件，某些浏览器/隐私模式下 localStorage 被禁用会直接抛
 * SecurityError —— 读取发生在首帧（App 挂载时），一抛就是整屏白屏，故必须兜住。
 * 写入侧同理（见 applyTheme / applyZoom 的 try-catch）。
 */
function safeGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

// ============ 自定义主题（2.5.0 · C1：母版 + 强调色 + 色相偏移，三参数派生）============

export interface CustomThemeParams {
  baseId: Exclude<ThemeId, 'custom'>
  /** 用户强调色（'#rrggbb'）；空串 = 不换强调色（用母版 amber 参与色相旋转） */
  accent: string
  hueShift: number
}

const CUSTOM_KEY = 'yfe-custom-theme'

export function getStoredCustomTheme(): CustomThemeParams | null {
  const raw = safeGet(CUSTOM_KEY)
  if (!raw) return null
  try {
    // 🔴 断言放宽为 unknown 再手动收窄：脏 localStorage 可能存任何东西（包括 baseId:'custom'、
    //    数字、对象）。若直接断言 Partial<CustomThemeParams>，baseId 类型不含 'custom'，
    //    防御比较会被 TS 判 TS2367 拦下——但那道运行时防御恰恰是必须的。
    const p = JSON.parse(raw) as { baseId?: unknown; accent?: unknown; hueShift?: unknown }
    if (!p || typeof p.baseId !== 'string' || p.baseId === 'custom') return null
    if (!THEMES.some(t => t.id === p.baseId)) return null
    return {
      baseId: p.baseId as CustomThemeParams['baseId'],
      accent: typeof p.accent === 'string' ? p.accent : '',
      hueShift: Number.isFinite(p.hueShift) ? Math.max(-180, Math.min(180, Number(p.hueShift))) : 0,
    }
  } catch { return null }
}

/**
 * 清掉所有内联主题变量。🔴 离开 custom 时必须逐个清 —— 内联 style 优先级高于任何选择器，
 * 残留一条就会悄悄覆盖内置主题的那一档。清单与写入同用 `ALL_THEME_VAR_KEYS`（写什么删什么）。
 */
function clearCustomInlineVars(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  for (const key of ALL_THEME_VAR_KEYS) root.style.removeProperty(key)
  root.style.colorScheme = ''
}

/**
 * 应用自定义主题：切到母版 → 读母版变量 → 派生 → 内联写入 → 存参数。
 * 🔴 **存参数不存派生值**：以后改进派生算法，所有用户的自定义主题自动升级。
 * 🔴 读母版前必须先清内联变量并切 data-theme，否则 getComputedStyle 读到的是 custom 自己的值；
 *    浅色母版的 --graph-* 是 var() 引用（且只在浅色覆盖段里定义），不读 —— ink 变了引用自动跟随。
 * 🔴 本函数不写 THEME_KEY：只负责「算 + 生效 + 存参数」；把 yfe-theme 切到 'custom' 归 applyTheme 管
 *    （弹窗实时预览时调用本函数，确认选用才走 applyTheme('custom') 落盘）。
 * 返回派生结果（弹窗展示「强调色被守卫微调」提示用）；document 不可用时返回 null。
 */
export function applyCustomTheme(params: CustomThemeParams): CustomThemeVars | null {
  if (typeof document === 'undefined') return null
  const root = document.documentElement
  clearCustomInlineVars()
  root.dataset.theme = params.baseId
  const cs = getComputedStyle(root)
  const read = (keys: readonly string[]) => {
    const out: Record<string, string> = {}
    for (const k of keys) {
      const v = cs.getPropertyValue(k).trim()
      if (v && !v.includes('var(')) out[k] = v
    }
    return out
  }
  const isDark = DARK_THEMES.has(params.baseId)
  const base: ThemeBase = {
    vars: {
      ...read(INK_VAR_KEYS),
      ...(isDark ? read(GRAPH_NEUTRAL_KEYS) : {}),
      ...(isDark ? read(GRAPH_ACCENT_KEYS) : {}),
    },
    colorScheme: isDark ? 'dark' : 'light',
  }
  const derived = deriveCustomTheme(base, { accent: params.accent, hueShift: params.hueShift })
  for (const [k, v] of Object.entries(derived.vars)) root.style.setProperty(k, v)
  root.style.colorScheme = derived.colorScheme
  root.dataset.theme = 'custom'
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(params)) } catch { /* 忽略隐私模式写失败 */ }
  return derived
}

export function getStoredTheme(): ThemeId {
  const v = safeGet(THEME_KEY)
  return THEMES.some(t => t.id === v) ? (v as ThemeId) : 'eye-care'
}

export function applyTheme(id: ThemeId): ThemeId {
  if (id === 'custom') {
    const params = getStoredCustomTheme()
    if (params) {
      applyCustomTheme(params)
      try { localStorage.setItem(THEME_KEY, 'custom') } catch { /* 忽略隐私模式写失败 */ }
      return 'custom'
    }
    id = 'eye-care' // 无参数兜底（存储被清 / 首次异常）：回默认主题而不是黑屏
  }
  clearCustomInlineVars()
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = id
  }
  try { localStorage.setItem(THEME_KEY, id) } catch { /* 忽略隐私模式写失败 */ }
  return id as ThemeId
}

/** 界面缩放范围：80% ~ 160% */

/** 按窗口宽度算一个舒适值：窗口越宽界面同比放大（100% ~ 140%） */
export function autoZoom(): number {
  if (typeof window === 'undefined') return 100
  const w = window.innerWidth
  return Math.min(140, Math.max(100, Math.round(100 + (w - 1280) / 40)))
}

/** 是否处于「跟随窗口」的自动模式（用户没手动调过缩放） */
export function isZoomAuto(): boolean {
  return safeGet(ZOOM_MANUAL_KEY) !== '1'
}

/**
 * 界面缩放取值：**手动调过就用存储值，否则按窗口宽度自动适配**。
 *
 * 🔴 旧实现是「存储里有值就永远用它」—— 大屏作者首次运行明明自动算出了 132%，
 * 可只要手动碰过一次（哪怕只为临时看清某处调到 110%），这个值就被永久钉死：
 * 之后换更大屏 / 全屏，字号偏小且再也不会自适应。故补 manual 标记区分两种情况。
 */
export function getStoredZoom(): number {
  if (isZoomAuto()) return autoZoom()
  const raw = safeGet(ZOOM_KEY)
  if (raw != null) {
    const v = Number(raw)
    if (Number.isFinite(v) && v >= 80 && v <= 160) return v
  }
  return autoZoom()
}

/**
 * 应用缩放。`opts.manual === true` 表示这是用户手动调整（此后不再自动适配），
 * `false` 表示切回「跟随窗口」。不传则只改值、不动模式（启动时用）。
 */
export function applyZoom(pct: number, opts?: { manual?: boolean }): number {
  const z = Math.min(160, Math.max(80, Math.round(pct)))
  if (typeof document !== 'undefined') {
    const root = document.documentElement
    root.style.zoom = String(z / 100)
    // 🔴 系数必须同步写给 CSS：index.css 的 .h-screen / .min-h-screen 用它把 vh 折回来 ——
    //    少了这一步，100vh 不跟着缩放走，主容器比窗口高、被 overflow-hidden 裁掉。
    root.style.setProperty('--ui-zoom', String(z / 100))
  }
  try {
    localStorage.setItem(ZOOM_KEY, String(z))
    if (opts?.manual !== undefined) localStorage.setItem(ZOOM_MANUAL_KEY, opts.manual ? '1' : '0')
  } catch { /* 忽略隐私模式写失败 */ }
  // 通知界面同步显示：缩放被自动重算时，侧栏那个数字也得跟着变
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('yfe:zoom-changed', { detail: z }))
  }
  return z
}
/**
 * 把 CSS 长度里的 vh / vw **折回界面缩放**。
 *
 * 为什么必须折：`<html>` 上的 `zoom` **不缩放 vh/vw** —— 2560 宽屏（zoom 132%）下
 * `max-height: 85vh` 的元素视觉高度是 112vh，比视口还高；若同时锁了 body 滚动，
 * 弹窗的标题栏或页脚按钮就会落到视口外，用户点不到。同 index.css 里 `.h-screen` 的处理。
 *
 * 用法：`style={{ maxHeight: foldVh(maxHeight) }}`。非 vh/vw 的写法原样返回。
 */
export function foldVh(v?: string): string | undefined {
  if (!v) return v
  return v
    .replace(/(\d+(?:\.\d+)?)vh/g, 'calc($1vh / var(--ui-zoom, 1))')
    .replace(/(\d+(?:\.\d+)?)vw/g, 'calc($1vw / var(--ui-zoom, 1))')
}

/**
 * 把 `getBoundingClientRect()` 量到的**视觉像素**折算成**可直接写进 style 的像素**（3.0.2 立）。
 *
 * 为什么必须折：`<html>` 上的 `zoom` 会**二次放大**内联 `left / top / width` ——
 * 量出来的 `rect.right` 已经是缩放后的坐标（zoom 1.08 时放大 8%），直接写 `style.left`
 * 会被浏览器**再乘一次 zoom**，弹窗整体偏移 8%，窄窗口下就往右跑出屏幕被遮挡。
 * 故写 style 前一律除以 `--ui-zoom`；`foldVh` 折的是 CSS 长度，本函数折的是 JS 数值。
 *
 * 用法：`setPos({ left: foldPx(b.right - w), top: foldPx(b.bottom + 6), w: foldPx(w) })`，
 * 且**比较时也要用同一口径**（左右都 foldPx 后再比，别拿折叠值与原始值混算）。
 *
 * @param zoom 可选：**一次定位里要折多个值**时，先 `currentUiZoom()` 读一次再逐个传入 ——
 *   避免每个值都跑一次 `getComputedStyle`（那是一次样式解析，批量折算时不值当）。
 *   不传则自己读（单值场景更省事）。
 */
export function foldPx(px: number, zoom?: number): number {
  if (typeof document === 'undefined') return px
  const z = zoom ?? parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom'))
  return Number.isFinite(z) && z > 0 ? px / z : px
}

/** 当前界面缩放系数（1 = 100%）。读 CSS 变量，避免与 localStorage 不同步。 */
export function currentUiZoom(): number {
  if (typeof document === 'undefined') return 1
  const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom'))
  return Number.isFinite(z) && z > 0 ? z : 1
}

/**
 * 内容区「恰好一屏」的**锁定高度**（与 `contentMinH` 同源，但用 `height` 而非 `minHeight`）。
 *
 * 2026-10-05：主从双栏页签（左列表 + 右详情）需要**锁高**才能让两栏各自 `overflow-y-auto`
 * 独立滚动；只给 `minHeight` 时子元素无滚动上限，左栏条目一多就撑高整页、右栏被迫跟着滚。
 * `minHeight` ⇒ `height` 的区别是本函数存在的**唯一理由**，两者参数口径保持一致。
 *
 * 🔴 布局前提：调用方必须给**容器补 `overflow-hidden`**，并把 `flex-1 min-h-0` 链传下去，
 *    否则子元素仍会溢出（`flex` 子项默认 `min-height:auto`）。
 */
export function contentHeight(deductPx: number): string {
  return `calc(${foldVh('100vh')} - ${deductPx}px)`
}

/** 卡片型页签（角色卡）页头 + 工具条的高度，供 contentHeight 使用 */
export const CARD_SHEET_CHROME_PX = 180
/** 大纲型页签（细纲卡）页头 + 工具条的高度 */
export const OUTLINE_SHEET_CHROME_PX = 200
