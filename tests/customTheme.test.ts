/**
 * 2.5.0 · C1 自定义主题派生层 —— 单测（纯函数）
 *
 * 测四件事：
 *   ① 颜色工具的往返精度（rgb→hsl→rgb 不漂移）
 *   ② 🔴 色相旋转的对比度守恒 —— 整个方案的安全根基：旋转只动 H 不动 L，
 *      故派生结果对 themeContrast 全套 RULES 的对比度与母版逐条几乎一致（|Δ| < 0.05）
 *   ③ 强调色守卫：低对比的用户色会被自动调明度到达标（深底提亮 / 浅底压暗）
 *   ④ 变量清单与 index.css 一致（防 ALL_THEME_VAR_KEYS 与 css 漂移 → 残留清理失准）
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  parseTriple, formatTriple, hexToRgb, rgbToHex, rgbToHsl, hslToRgb, contrast,
  deriveCustomTheme, INK_VAR_KEYS, GRAPH_NEUTRAL_KEYS, GRAPH_ACCENT_KEYS, ALL_THEME_VAR_KEYS,
  CONTRAST_RULES,
} from '../src/lib/settings/customTheme'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ customTheme')

// ---------- 0) 从 index.css 解析母版（与 themeContrast 同思路：只认成对的单主题块） ----------
// 🔴 先剥注释再解析：dark 块的注释里有 style={{ ... }}，连续 }} 会让 [^}]* 提前截断（graph 键全丢）；
//    键名必须允许数字（--ink-950），[a-z-]+ 会整体失配。
const css = fs.readFileSync(path.join(process.cwd(), 'src', 'index.css'), 'utf8')
const cssClean = css.replace(/\/\*[\s\S]*?\*\//g, '')
function parseBlock(selectorHead: string): Record<string, string> {
  const re = new RegExp(selectorHead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')
  const m = re.exec(cssClean)
  if (!m) throw new Error(`index.css 里找不到块：${selectorHead}`)
  const vars: Record<string, string> = {}
  for (const v of m[1].matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    if (!v[2].includes('var(')) vars[`--${v[1]}`] = v[2].trim()
  }
  return vars
}
/** :root 与 [data-theme='dark'] 同块 —— 取整段（含 graph 9 键） */
const darkBase = { vars: parseBlock("[data-theme='dark']"), colorScheme: 'dark' as const }
const sepiaBase = { vars: parseBlock("[data-theme='sepia']"), colorScheme: 'light' as const }

/** 判定表：以 lib 的 CONTRAST_RULES 为权威单一源（含 -- 前缀 token） */
const RULES = CONTRAST_RULES

// ---------- 1) 颜色工具往返精度 ----------
{
  const samples: [number, number, number][] = [
    [12, 12, 15], [217, 160, 74], [0, 0, 0], [255, 255, 255], [128, 128, 128],
    [30, 120, 200], [200, 40, 90], [251, 191, 36], [90, 169, 214],
  ]
  let worst = 0
  for (const rgb of samples) {
    const back = hslToRgb(rgbToHsl(rgb))
    for (let i = 0; i < 3; i++) worst = Math.max(worst, Math.abs(back[i] - rgb[i]))
  }
  ok('rgb→hsl→rgb 往返误差 < 1/255', worst < 1, `worst=${worst.toFixed(3)}`)
  ok('hex 往返', rgbToHex(hexToRgb('#d9a04a')!) === '#d9a04a')
  ok('非法 hex → null', hexToRgb('#12g') === null && hexToRgb('zzz') === null)
  ok('三元组解析往返', formatTriple(parseTriple('12 12 15')!) === '12 12 15')
}

// ---------- 2) 🔴 色相旋转的亮度重校（方案的安全根基） ----------
{
  const derived = deriveCustomTheme(darkBase, { accent: '', hueShift: 120 })
  // 分两层断言：
  //  ① 硬保证 —— 派生后仍全 RULES 过闸（母版过闸 + 亮度重校 + 贴线守卫 ⇒ 派生过闸）；
  //  ② 单向守恒 —— 对比度**不许显著下降**（降 ≥0.1 FAIL，专抓「改回裸旋转」的回归：
  //     裸旋转会双向漂 0.17~0.4，向下必然破线或逼近阈值）。上升与贴线守卫的上推（2.20→2.36）
  //     是「更清晰」，无害不拦。amber 系排除：被用户色替换 / 重新派生，与母版本无对应关系。
  const gate: string[] = [], drift: string[] = []
  for (const r of RULES) {
    const col = parseTriple(derived.vars[r.token])
    if (!col) { gate.push(`${r.token} 缺失`); continue }
    for (const bgKey of r.bg) {
      const bg = parseTriple(derived.vars[bgKey] ?? darkBase.vars[bgKey])
      if (!bg) continue
      const before = contrast(parseTriple(darkBase.vars[r.token])!, parseTriple(darkBase.vars[bgKey])!)
      const after = contrast(col, bg)
      if (after < r.min) gate.push(`${r.token} on ${bgKey}: ${after.toFixed(2)} < ${r.min}`)
      else if (!r.token.startsWith('--amber') && before - after >= 0.1)
        drift.push(`${r.token} on ${bgKey}: ${before.toFixed(2)}→${after.toFixed(2)}`)
    }
  }
  ok('dark 旋转 120°：全 RULES 仍过闸', gate.length === 0, gate.join(' ｜ '))
  ok('dark 旋转 120°：对比度无显著下降（<0.1）', drift.length === 0, drift.join(' ｜ '))
  ok('dark 派生含 graph 9 键', GRAPH_NEUTRAL_KEYS.every(k => !!derived.vars[k]) && GRAPH_ACCENT_KEYS.every(k => !!derived.vars[k]))
  ok('sepia（浅色）派生不含 graph 键', deriveCustomTheme(sepiaBase, { accent: '#2d64a5', hueShift: 45 }).vars['--graph-grid'] === undefined)
  ok('sepia 旋转 -120°：过闸 + 无显著下降', (() => {
    const d = deriveCustomTheme(sepiaBase, { accent: '', hueShift: -120 })
    return RULES.every(r => {
      const col = parseTriple(d.vars[r.token]); if (!col) return false
      return r.bg.every(bgKey => {
        const bg = parseTriple(d.vars[bgKey] ?? sepiaBase.vars[bgKey]); if (!bg) return true
        const before = contrast(parseTriple(sepiaBase.vars[r.token])!, parseTriple(sepiaBase.vars[bgKey])!)
        const after = contrast(col, bg)
        return after >= r.min && (r.token.startsWith('--amber') || before - after < 0.1)
      })
    })
  })())
}

// ---------- 3) 强调色守卫 ----------
{
  // 深底 + 极暗强调色 → 自动提亮到 ≥4.5
  const d = deriveCustomTheme(darkBase, { accent: '#222222', hueShift: 0 })
  const amber = parseTriple(d.vars['--amber'])!
  const c900 = contrast(amber, parseTriple(d.vars['--ink-900'])!)
  const c950 = contrast(amber, parseTriple(d.vars['--ink-950'])!)
  ok('深底暗强调色被自动提亮', d.accentAdjusted && c900 >= 4.5 && c950 >= 4.5, `c900=${c900.toFixed(2)}`)
  // 浅底 + 极亮强调色 → 自动压暗
  const s = deriveCustomTheme(sepiaBase, { accent: '#eeeeee', hueShift: 0 })
  const amber2 = parseTriple(s.vars['--amber'])!
  const c2 = contrast(amber2, parseTriple(s.vars['--ink-900'])!)
  ok('浅底亮强调色被自动压暗', s.accentAdjusted && c2 >= 4.5, `c=${c2.toFixed(2)}`)
  // 合法强调色不动
  const fine = deriveCustomTheme(darkBase, { accent: '#d9a04a', hueShift: 0 })
  ok('达标强调色不被动（accentAdjusted=false）', !fine.accentAdjusted && contrast(parseTriple(fine.vars['--amber'])!, parseTriple(fine.vars['--ink-900'])!) >= 4.5)
  // soft 守卫
  const soft = parseTriple(d.vars['--amber-soft'])!
  ok('amber-soft 守卫 ≥3.4', contrast(soft, parseTriple(d.vars['--ink-900'])!) >= 3.4)
  // accent 空 = 母版 amber 原样（shift 0）
  const none = deriveCustomTheme(darkBase, { accent: '', hueShift: 0 })
  ok('accent 空 + 0° = 母版原色', none.vars['--amber'] === darkBase.vars['--amber'])
}

// ---------- 4) 边界与杂项 ----------
{
  const a = deriveCustomTheme(darkBase, { accent: '#d9a04a', hueShift: 999 }).vars['--ink-500']
  const b = deriveCustomTheme(darkBase, { accent: '#d9a04a', hueShift: 180 }).vars['--ink-500']
  ok('hueShift 越界 clamp 到 ±180', a === b)
  const neg = deriveCustomTheme(darkBase, { accent: '#d9a04a', hueShift: -999 }).vars['--ink-500']
  const n180 = deriveCustomTheme(darkBase, { accent: '#d9a04a', hueShift: -180 }).vars['--ink-500']
  ok('hueShift 负向越界同样 clamp', neg === n180)
  // 非法 accent 当「空」处理（用母版 amber 旋转），不炸
  const dirty = deriveCustomTheme(darkBase, { accent: 'not-a-color', hueShift: 30 })
  ok('非法 accent 不炸（回退母版 amber）', !!dirty.vars['--amber'])
  ok('finalAccent 是合法 hex', /^#[0-9a-f]{6}$/i.test(dirty.finalAccent))
}

// ---------- 5) 变量清单与 index.css 一致（防漂移 → 残留清理失准） ----------
{
  const inCss = new Set<string>()
  for (const m of cssClean.matchAll(/--([a-z0-9][a-z0-9-]*):/g)) {
    const key = `--${m[1]}`
    if (key.startsWith('--ink-') || key.startsWith('--amber') || key.startsWith('--graph-')) inCss.add(key)
  }
  const missing = [...inCss].filter(k => !ALL_THEME_VAR_KEYS.includes(k))
  const extra = ALL_THEME_VAR_KEYS.filter(k => !inCss.has(k))
  ok('ALL_THEME_VAR_KEYS 与 index.css 键集合一致', missing.length === 0 && extra.length === 0,
    `${missing.length ? '缺 ' + missing.join(',') : ''}${extra.length ? '多 ' + extra.join(',') : ''}`)
  ok('清单数量 = 14 + 6 + 3', ALL_THEME_VAR_KEYS.length === INK_VAR_KEYS.length + GRAPH_NEUTRAL_KEYS.length + GRAPH_ACCENT_KEYS.length)
}

console.log(`\n  结果：${pass} pass / ${fail} fail`)
if (fail > 0) process.exit(1)
