// 主题与界面缩放的全局管理
// 主题通过给 <html> 设置 data-theme，配合 index.css 中按 [data-theme] 重定义的 CSS 变量生效；
// 由于全项目颜色都走 Tailwind 的 ink/amber 调色板（已改为 CSS 变量驱动），切换主题无需改动任何组件。

export type ThemeId =
  | 'dark'
  | 'eye-care'
  | 'midnight'
  | 'sepia'
  | 'dusk-violet'
  | 'porcelain'
  | 'pine-ink'
  | 'peach-note'

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
]

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

export function getStoredTheme(): ThemeId {
  const v = safeGet(THEME_KEY)
  return THEMES.some(t => t.id === v) ? (v as ThemeId) : 'eye-care'
}

export function applyTheme(id: ThemeId): ThemeId {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = id
  }
  try { localStorage.setItem(THEME_KEY, id) } catch { /* 忽略隐私模式写失败 */ }
  return id
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
 *    可只要手动碰过一次（哪怕只为临时看清某处调到 110%），这个值就被永久钉死：
 *    之后换更大屏 / 全屏，字号偏小且再也不会自适应。故补 manual 标记区分两种情况。
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
 * 内容区「至少撑满一屏」的最小高度：`100vh（折过 zoom） − 减去的高度`。
 *
 * 2026-09-22 六维审计 P2：原先 CharacterSheet / OutlineSheet 各自内联
 * `calc(${foldVh('100vh')} - 180px)` 与 `- 200px` —— 两个魔数**与页头高度强耦合**、
 * 又散在两处，页头一改就静默失效（而且没人知道那 180/200 是从哪来的）。
 * 集中到这里 + 具名常量，改一处即可、也有地方写清来源。
 *
 * @param deductPx 页头 / 工具条等占据的高度（px）
 */
export function contentMinH(deductPx: number): string {
  return `calc(${foldVh('100vh')} - ${deductPx}px)`
}

/** 卡片型页签（角色卡）页头 + 工具条的高度，供 contentMinH 使用 */
export const CARD_SHEET_CHROME_PX = 180
/** 大纲型页签（细纲卡）页头 + 工具条的高度 */
export const OUTLINE_SHEET_CHROME_PX = 200
