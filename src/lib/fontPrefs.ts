// ============ 字体偏好（2026-09-28 · 社区需求）：正文编辑器 + 界面全站 ============
//
// 模式照抄 theme.ts（主题/缩放同一族）：应用级偏好存 localStorage（跟人不跟项目），
// 生效走 root.style.setProperty 写 CSS 变量，tailwind fontFamily 栈首引用变量
// （见 tailwind.config.js —— 变量未定义时求值为默认名，与旧版渲染逐字节一致）。
//
// 🔴 盒模型红线：正文编辑器的 textarea / 测量层 / 高亮层 / ghost 层四图层共享同一个
//    .novel-textarea 类（index.css @apply font-serif），字体走类级继承自动四层一致——
//    **禁止只在 textarea 上内联 fontFamily**，否则伴写 ghost 与高亮层全部错位。

/** 正文编辑器字体变量（.novel-textarea → font-serif 栈首） */
export const FONT_EDITOR_VAR = '--font-editor'
/** 界面全站字体变量（body → font-sans 栈首） */
export const FONT_UI_VAR = '--font-ui'

export interface FontPrefs {
  /** 正文编辑器字体栈段；空串 = 跟随默认（不写变量） */
  editor: string
  /** 界面全站字体栈段；空串 = 跟随默认（不写变量） */
  ui: string
}

export const DEFAULT_FONT_PREFS: FontPrefs = { editor: '', ui: '' }

const FONT_KEY = 'yfe-font-prefs'

// ---------- 预置清单（中文写作场景常用字体；未安装的家族自动落 tailwind 栈的兜底） ----------

export interface FontPreset {
  /** 显示名（下拉里给用户看的） */
  name: string
  /** 写入 CSS 变量的字体栈段（中文显示名 + 英文注册名双保险） */
  stack: string
}

export const PRESET_FONTS: FontPreset[] = [
  { name: '思源宋体（默认正文）', stack: '"思源宋体", "Noto Serif SC", "Source Han Serif SC"' },
  { name: '思源黑体（默认界面）', stack: '"思源黑体", "Noto Sans SC", "Source Han Sans SC"' },
  { name: '宋体', stack: '"宋体", SimSun, NSimSun' },
  { name: '楷体', stack: '"楷体", "KaiTi", STKaiti' },
  { name: '仿宋', stack: '"仿宋", "FangSong", STFangsong' },
  { name: '黑体', stack: '"黑体", SimHei' },
  { name: '微软雅黑', stack: '"微软雅黑", "Microsoft YaHei"' },
  { name: '霞鹜文楷', stack: '"霞鹜文楷", "LXGW WenKai"' },
]

/**
 * 清洗用户自定义输入的字体栈（🔴 setProperty 的值可被 `;` 截断成另一条声明 —— CSS 注入面）。
 * 只保留家族名合法字符：中英文、数字、空格、逗号、引号、连字符、下划线、点。
 * @returns 清洗后的串；洗完为空返回 ''（= 无效输入，调用方按「跟随默认」处理）
 */
export function sanitizeFontStack(input: string): string {
  const s = (input ?? '').replace(/[^0-9A-Za-z\u4e00-\u9fff\u3000-\u303f，。、""''\s,.\-_'"-]/g, '')
  return s.trim()
}

/** 从字体栈段提取展示名（去引号取第一段）：'"楷体", KaiTi' → '楷体' */
export function fontStackLabel(stack: string): string {
  const first = (stack ?? '').split(',')[0]?.trim() ?? ''
  return first.replace(/^["']|["']$/g, '')
}

/** 安全读 localStorage（theme.ts 同款：隐私模式 / file:// 下直接抛 SecurityError，必须兜住） */
function safeGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

/**
 * 读已存字体偏好。脏数据逐字段收窄：非字符串 / 超长（>200）/ 含声明截断符的值一律回默认。
 */
export function getStoredFontPrefs(): FontPrefs {
  const raw = safeGet(FONT_KEY)
  if (!raw) return { ...DEFAULT_FONT_PREFS }
  try {
    const p = JSON.parse(raw) as { editor?: unknown; ui?: unknown }
    const clean = (v: unknown): string => {
      if (typeof v !== 'string' || v.length > 200) return ''
      // 🔴 含声明截断符（; { } 以及其它被剥掉的字符）时**整段回默认**，而不是留着剥剩下的残骸：
      //    'x;' 剥成 'x' 仍是一段没意义的值，而这条路径本来就是注入面 ——
      //    （48 行注释自己点名的「; 截断声明」—— 守卫声明了就得真的生效）
      const s = sanitizeFontStack(v)
      return s === v.trim() ? s : ''
    }
    return { editor: clean(p.editor), ui: clean(p.ui) }
  } catch { return { ...DEFAULT_FONT_PREFS } }
}

/**
 * 应用字体偏好：非空栈段写变量、空串移除变量（移除后 tailwind 栈的 var() 落回默认名）。
 * document 不可用（node 单测 / SSR）时静默跳过——与 theme.ts 同口径。
 */
export function applyFontPrefs(p: FontPrefs): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  for (const [v, key] of [[p.editor, FONT_EDITOR_VAR], [p.ui, FONT_UI_VAR]] as const) {
    if (v) root.style.setProperty(key, v)
    else root.style.removeProperty(key)
  }
}

/** 读已存偏好并应用（App 启动时调用，与 applyTheme(getStoredTheme()) 同点） */
export function applyStoredFontPrefs(): void {
  applyFontPrefs(getStoredFontPrefs())
}

/** 落盘偏好（「应用」按钮用）。@returns 是否写成功（隐私模式 / 配额满为 false，调用方须如实提示） */
export function storeFontPrefs(p: FontPrefs): boolean {
  try { localStorage.setItem(FONT_KEY, JSON.stringify(p)); return true } catch { return false }
}

// ---------- 系统字体枚举（路线 B：Electron 桌面版；浏览器 dev 不可用返回 null） ----------

type LocalFontsNavigator = Navigator & {
  queryLocalFonts?: () => Promise<Array<{ family: string; fullName: string; postscriptName: string }>>
}

/**
 * 枚举系统字体（按家族名去重、中文 locale 排序）。
 * · Electron 桌面版：main.cjs 已放行 local-fonts 权限 → 可用；
 * · 浏览器 / 便携版：API 不存在或被拒 → 返回 null（调用方降级到预置清单 + 自定义输入）。
 */
export async function listSystemFonts(): Promise<string[] | null> {
  if (typeof navigator === 'undefined') return null
  const nav = navigator as LocalFontsNavigator
  if (typeof nav.queryLocalFonts !== 'function') return null
  try {
    const fonts = await nav.queryLocalFonts()
    const families = [...new Set(fonts.map(f => f.family))]
    return families.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  } catch { return null }
}
