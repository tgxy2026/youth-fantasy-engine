// 主题与界面缩放的全局管理
// 主题通过给 <html> 设置 data-theme，配合 index.css 中按 [data-theme] 重定义的 CSS 变量生效；
// 由于全项目颜色都走 Tailwind 的 ink/amber 调色板（已改为 CSS 变量驱动），切换主题无需改动任何组件。

export type ThemeId = 'dark' | 'eye-care' | 'midnight' | 'sepia'

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
]

const THEME_KEY = 'yfe-theme'
const ZOOM_KEY = 'yfe-ui-zoom'

export function getStoredTheme(): ThemeId {
  const v = localStorage.getItem(THEME_KEY)
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
export function getStoredZoom(): number {
  const raw = localStorage.getItem(ZOOM_KEY)
  if (raw != null) {
    const v = Number(raw)
    if (Number.isFinite(v) && v >= 80 && v <= 160) return v
  }
  // 首次运行（无已存缩放）：按窗口宽度给一个舒适默认，避免大屏上字号过小。
  // 用户之后手动调整的缩放会写入 localStorage，覆盖此默认。
  if (typeof window !== 'undefined') {
    const w = window.innerWidth
    const d = Math.min(140, Math.max(100, Math.round(100 + (w - 1280) / 40)))
    return d
  }
  return 100
}

export function applyZoom(pct: number): number {
  const z = Math.min(160, Math.max(80, Math.round(pct)))
  if (typeof document !== 'undefined') {
    document.documentElement.style.zoom = String(z / 100)
  }
  try { localStorage.setItem(ZOOM_KEY, String(z)) } catch { /* 忽略隐私模式写失败 */ }
  return z
}
