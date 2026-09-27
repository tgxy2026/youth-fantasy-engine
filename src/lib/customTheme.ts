/**
 * 自定义主题派生层（2.5.0 · C1）—— **纯函数，零 DOM 依赖**。
 *
 * 三参数派生（主人哥哥 2026-09-25 拍板）：母版主题 + 强调色 + 色相偏移，
 * 其余颜色全部由算法从母版派生 —— 不让用户直调 14 个变量（门槛高、易出对比度灾难）。
 *
 * 🔴 核心设计（为什么派生是安全的）：WCAG 对比度只取决于**相对亮度**——派生时旋转色相
 *    后**把每档的 WCAG 亮度二分校回母版原值**（⚠️ 只转 HSL 的 H 并不守恒：HSL 的 L 是几何
 *    明度，与 WCAG 感知亮度不等价，实测 120° 会让 ink-400 对比度漂 ±0.4、贴线档会破闸——
 *    单测「旋转守恒」专防改回裸旋转）。故 ink 系对比度自动保持母版水平；
 *    运行时唯一要守卫的是用户自选强调色（amber ≥4.5 / amber-soft ≥3.4，阈值与闸一致）。
 *
 * 🔴 分层：本模块只管「给母版变量 + 参数 → 出派生变量」；
 *    读母版（getComputedStyle）、写内联变量、清理与持久化在 `lib/theme.ts`。
 *
 * 🔴 变量值格式：index.css 里是裸三元组字符串（如 "12 12 15"），本模块沿用该格式，
 *    不做 hex 转换（graph 浅色主题是 var() 引用，**跳过不派生**——ink 变了引用自动跟随）。
 */

/** 14 个核心变量：ink 12 档 + 强调色 2 档（顺序与 index.css 一致） */
export const INK_VAR_KEYS = [
  '--ink-950', '--ink-900', '--ink-850', '--ink-800', '--ink-700', '--ink-600',
  '--ink-500', '--ink-400', '--ink-300', '--ink-200', '--ink-100', '--ink-50',
  '--amber', '--amber-soft',
] as const

/** 图谱中性色 6 个：**仅深色母版**需要派生（浅色母版是 var() 引用，自动跟随 ink） */
export const GRAPH_NEUTRAL_KEYS = [
  '--graph-grid', '--graph-node', '--graph-node-text',
  '--graph-label', '--graph-edge-label', '--graph-halo',
] as const

/** 图谱强调色 3 个：跟随用户强调色（深色母版才写；浅色母版引用 --amber 自动跟） */
export const GRAPH_ACCENT_KEYS = [
  '--graph-accent', '--graph-accent-strong', '--graph-accent-text',
] as const

/** 全集 —— theme.ts 应用与清理必须同用这一份清单（写什么删什么，防残留） */
export const ALL_THEME_VAR_KEYS: string[] = [...INK_VAR_KEYS, ...GRAPH_NEUTRAL_KEYS, ...GRAPH_ACCENT_KEYS]

/** 对比度阈值（与 tests/themeContrast 的 RULES 同源，改这里要同步那边） */
const ACCENT_MIN = 4.5
const ACCENT_SOFT_MIN = 3.4

/**
 * 贴线守卫表（运行时用；与 tests/themeContrast 的 RULES 同源，token 带 `--` 前缀）。
 * 母版个别档本就贴线（dark 的 ink-600 = 2.20 vs 阈值 2.2），重校 + 取整噪声 0.01 就能破线 ——
 * 派生末尾按这张表逐档检查，破线就把该档亮度拉回「阈值 ×1.05」以上。
 */
export const CONTRAST_RULES: { token: string; min: number; bg: string[] }[] = [
  { token: '--ink-50', min: 4.5, bg: ['--ink-900', '--ink-950'] },
  { token: '--ink-100', min: 4.5, bg: ['--ink-900', '--ink-950'] },
  { token: '--ink-200', min: 4.5, bg: ['--ink-900', '--ink-950'] },
  { token: '--ink-300', min: 4.5, bg: ['--ink-900', '--ink-950'] },
  { token: '--ink-400', min: 4.5, bg: ['--ink-900', '--ink-950'] },
  { token: '--ink-500', min: 3.2, bg: ['--ink-900'] },
  { token: '--ink-600', min: 2.2, bg: ['--ink-900'] },
  { token: '--amber', min: ACCENT_MIN, bg: ['--ink-900', '--ink-950'] },
  { token: '--amber-soft', min: ACCENT_SOFT_MIN, bg: ['--ink-900'] },
]

interface CustomThemeInput {
  /** 用户自选强调色（'#rrggbb'）；**空串 = 不换强调色**（用母版 amber 参与色相旋转） */
  accent: string
  /** 色相偏移（度），−180 ~ 180 */
  hueShift: number
}

export interface ThemeBase {
  /** 母版变量（变量名 → "R G B" 三元组字符串）；graph 键可缺（浅色母版） */
  vars: Record<string, string>
  colorScheme: 'dark' | 'light'
}

export interface CustomThemeVars {
  /** 派生结果（变量名 → "R G B"）；浅色母版不含 --graph-* 键 */
  vars: Record<string, string>
  colorScheme: 'dark' | 'light'
  /** 守卫是否动过用户的强调色明度（UI 提示「已自动调整以保证可读」） */
  accentAdjusted: boolean
  /** 最终强调色的 hex（UI 色块显示用） */
  finalAccent: string
}

// ============ 颜色工具（RGB ↔ HSL ↔ hex，标准公式） ============

type RGB = [number, number, number]
type HSL = [number, number, number] // h: 0~360, s/l: 0~100

export function parseTriple(s: string): RGB | null {
  const m = s.trim().split(/\s+/).map(Number)
  if (m.length !== 3 || m.some(n => !Number.isFinite(n))) return null
  return [m[0], m[1], m[2]]
}

export const formatTriple = (c: RGB) => `${Math.round(c[0])} ${Math.round(c[1])} ${Math.round(c[2])}`

export function hexToRgb(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export const rgbToHex = ([r, g, b]: RGB) =>
  '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')

export function rgbToHsl([r, g, b]: RGB): HSL {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l * 100]
  const d = max - min
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === rn) h = ((gn - bn) / d) % 6
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  h = (h * 60 + 360) % 360
  return [h, s * 100, l * 100]
}

export function hslToRgb([h, s, l]: HSL): RGB {
  const sn = s / 100, ln = l / 100
  const c = (1 - Math.abs(2 * ln - 1)) * sn
  const hp = ((h % 360) + 360) % 360 / 60
  const x = c * (1 - Math.abs(hp % 2 - 1))
  let [r, g, b] = [0, 0, 0]
  if (hp < 1) [r, g, b] = [c, x, 0]
  else if (hp < 2) [r, g, b] = [x, c, 0]
  else if (hp < 3) [r, g, b] = [0, c, x]
  else if (hp < 4) [r, g, b] = [0, x, c]
  else if (hp < 5) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const m = ln - c / 2
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}

/** WCAG 相对亮度与对比度（与 tests/themeContrast 同公式） */
function lum([r, g, b]: RGB): number {
  const f = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

export function contrast(a: RGB, b: RGB): number {
  const la = lum(a), lb = lum(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * 色相旋转 + WCAG 亮度重校。
 *
 * 🔴 为什么不能只转 HSL 的 H：HSL 的 L 是 (max+min)/2 的几何明度，**不等于** WCAG
 *    相对亮度（gamma 展开后的 0.2126R+0.7152G+0.0722B 感知加权）——实测旋转 120° 会让
 *    ink-400 的对比度从 4.51 漂到 4.91（不同方向还会往下漂，贴线的档位会破闸）。
 *    做法：先 HSL 旋转，再等比缩放 RGB 把 WCAG 亮度二分校回原值（等比缩放不动色相与
 *    饱和度结构，只动明度；两端 clamp 由二分的单调性兜底）。
 */
function shiftHue(c: RGB, deg: number): RGB {
  const y0 = lum(c)
  const [h, s, l] = rgbToHsl(c)
  const rotated = hslToRgb([((h + deg) % 360 + 360) % 360, s, l])
  const clamp255 = (v: RGB) => v.map(x => Math.max(0, Math.min(255, x))) as RGB
  if (Math.abs(lum(rotated) - y0) < 1e-6) return rotated
  let lo = 0, hi = 3
  for (let i = 0; i < 24; i++) {
    const k = (lo + hi) / 2
    const y = lum(clamp255(rotated.map(v => v * k) as RGB))
    if (y < y0) lo = k; else hi = k
  }
  return clamp255(rotated.map(v => v * ((lo + hi) / 2)) as RGB)
}

// ============ 派生主流程 ============

/** 母版三元组 → 旋转后的三元组；母版缺该键/值不合法 → 返回 null（调用方跳过） */
function rotateVar(base: Record<string, string>, key: string, deg: number): string | null {
  const raw = base[key]
  if (!raw || raw.includes('var(')) return null // 浅色母版的 graph 引用不参与
  const rgb = parseTriple(raw)
  if (!rgb) return null
  return formatTriple(shiftHue(rgb, deg))
}

/**
 * 调整强调色明度直到对两个背景（ink-900 / ink-950）全部达标。
 * 方向按「离哪个背景远往哪边推」：深色底 → 提亮，浅色底 → 压暗；
 * 达标立即返回；推到头仍不达标就返回推到的极值（尽力而为，UI 有 accentAdjusted 提示）。
 */
function guardAccent(rgb: RGB, backgrounds: RGB[], min: number): { rgb: RGB; adjusted: boolean } {
  const pass = (c: RGB) => backgrounds.every(bg => contrast(c, bg) >= min)
  if (pass(rgb)) return { rgb, adjusted: false }
  const [h, s, l] = rgbToHsl(rgb)
  const darkBg = lum(backgrounds[0]) < 0.35 // 背景偏暗 → 往亮推
  const dir = darkBg ? +1 : -1
  let cur = rgb
  for (let step = 1; step <= 40; step++) {
    const nl = Math.max(0, Math.min(100, l + dir * step * 2))
    cur = hslToRgb([h, s, nl])
    if (pass(cur)) return { rgb: cur, adjusted: true }
    if (nl === 0 || nl === 100) break
  }
  return { rgb: cur, adjusted: true }
}

/**
 * 派生自定义主题。
 * · ink 12 档：统一色相旋转（明度/饱和度不动 → 对比度守恒）；
 * · amber：用户色（或空 = 母版 amber 一起旋转），守卫不过自动调明度；
 * · amber-soft：amber 提亮淡化（S×0.92、L×1.15），守卫同上；
 * · 深色母版才派生 graph 9 个：中性 6 个旋转、强调 3 个跟随 amber 家族。
 */
export function deriveCustomTheme(base: ThemeBase, input: CustomThemeInput): CustomThemeVars {
  const deg = Math.max(-180, Math.min(180, input.hueShift || 0))
  const vars: Record<string, string> = {}

  // ① ink 12 档 + （accent 为空时）amber 一起旋转
  for (const key of INK_VAR_KEYS) {
    const rotated = rotateVar(base.vars, key, deg)
    if (rotated) vars[key] = rotated
  }

  // ② 强调色：用户色优先，空 = 母版 amber 已在 ① 里旋转过
  const ink900 = parseTriple(vars['--ink-900'] ?? base.vars['--ink-900'] ?? '0 0 0')!
  const ink950 = parseTriple(vars['--ink-950'] ?? base.vars['--ink-950'] ?? '0 0 0')!
  const bgs = [ink900, ink950]
  let accentAdjusted = false
  let amber: RGB
  if (input.accent) {
    const parsed = hexToRgb(input.accent)
    amber = parsed ?? parseTriple(vars['--amber'] ?? '217 160 74')!
    const g = guardAccent(amber, bgs, ACCENT_MIN)
    amber = g.rgb
    accentAdjusted = g.adjusted
  } else {
    amber = parseTriple(vars['--amber'])!
  }
  vars['--amber'] = formatTriple(amber)

  // ②' U-3 · 2.6.0：状态语义色三件套——自定义主题也要带，否则掉回 :root 暗色值、浅色自定义主题下对比度失效。
  //    不随强调色旋转（语义色有自己的识别度），只按母版明暗取 index.css 同款基准值。
  const STATUS_TRIPLETS: Record<'dark' | 'light', Record<string, string>> = {
    dark: { '--danger': '252 165 165', '--success': '110 231 183', '--info': '125 211 252' },
    light: { '--danger': '185 28 28', '--success': '21 128 61', '--info': '7 89 133' },
  }
  Object.assign(vars, STATUS_TRIPLETS[base.colorScheme])

  // ③ amber-soft：提亮淡化，再守卫（soft 阈值更低；不达标沿反方向压也行，简化为同 guard）
  const [ah, as, al] = rgbToHsl(amber)
  let soft = hslToRgb([ah, Math.min(100, as * 0.92), Math.min(96, al * 1.15)])
  const gs = guardAccent(soft, bgs, ACCENT_SOFT_MIN)
  soft = gs.rgb
  if (gs.adjusted) accentAdjusted = true
  vars['--amber-soft'] = formatTriple(soft)

  // ④ 深色母版的 graph 色：中性 6 个旋转、强调 3 个跟随 amber 家族
  if (base.colorScheme === 'dark') {
    for (const key of GRAPH_NEUTRAL_KEYS) {
      const rotated = rotateVar(base.vars, key, deg)
      if (rotated) vars[key] = rotated
    }
    if (vars['--amber']) {
      const a = parseTriple(vars['--amber'])!
      const [gh, gss, gl] = rgbToHsl(a)
      const hover = hslToRgb([gh, gss, Math.min(92, gl * 1.08)])
      vars['--graph-accent'] = formatTriple(hover)
      vars['--graph-accent-strong'] = formatTriple(a)
      vars['--graph-accent-text'] = vars['--amber-soft']
    }
  }

  // ⑤ 贴线守卫（兜底网）：母版个别档本就贴线（dark 的 ink-600 = 2.20 vs 阈值 2.2），
  //    亮度重校 + 取整噪声 0.01 就能破线 → 逐档检查，破线把该档亮度拉回「阈值 ×1.05」以上。
  for (const rule of CONTRAST_RULES) {
    const col = parseTriple(vars[rule.token])
    if (!col) continue
    const bgs = rule.bg
      .map(k => parseTriple(vars[k] ?? base.vars[k] ?? ''))
      .filter((x): x is RGB => !!x)
    if (bgs.length === 0 || bgs.every(bg => contrast(col, bg) >= rule.min)) continue
    const [h, s, l] = rgbToHsl(col)
    const dir = lum(col) >= lum(bgs[0]) ? 1 : -1 // 沿远离背景的方向推
    for (let step = 1; step <= 30; step++) {
      const cand = hslToRgb([h, s, Math.max(0, Math.min(100, l + dir * step))])
      if (bgs.every(bg => contrast(cand, bg) >= rule.min * 1.05)) { vars[rule.token] = formatTriple(cand); break }
    }
  }

  return { vars, colorScheme: base.colorScheme, accentAdjusted, finalAccent: rgbToHex(amber) }
}
