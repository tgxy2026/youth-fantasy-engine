// ============ 主题对比度闸（2.4.4 · 社区反馈）============
//
// 为什么必须有这一道：社区反馈「个别主题下文字跟背景太接近，看不清」。
// 这类问题**不会报错**、开发者在自己惯用的那个主题下也永远看不见 ——
// 调色板是 CSS 变量，改一个值就静默影响八个主题。上次人工修完，下次照样能退回去。
//
// 判据（按 WCAG 相对亮度公式算对比度，见下方 `contrast`）：
//   · 正文档位（ink-50 / 100 / 200 / 300）与次级说明（ink-400）　≥ 4.5
//   · 弱提示（ink-500，用于"共 N 行"这类补充信息）　　　　　　　≥ 3.2
//   · 极弱元素（ink-600，主要用于描边与占位符的"—"）　　　　　　≥ 2.2
//   · 强调色 amber / amber-soft（标签、高亮、按钮描边）　　　　　≥ 4.5 / 3.4
// 参照面取 **ink-900（主面板）与 ink-950（页面底）** —— 文字绝大多数落在这两层上。
//
// 🔴 阈值不是拍脑袋：ink-500 / ink-600 在界面上承担的是"弱化的补充说明"，
//    强行拉到 4.5 会让整个灰阶塌成一片、失去层次（也就不叫设计系统了）。
//    它们的不达标项必须是**有意为之**且写清理由，改阈值时请同步改这里的注释。
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n—— themeContrast 用例开始 ——')

const CSS = path.join(process.cwd(), 'src', 'index.css')
const css = fs.readFileSync(CSS, 'utf8')

const lum = (r: number, g: number, b: number) => {
  const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const contrast = (a: number[], b: number[]) => {
  const la = lum(a[0], a[1], a[2]), lb = lum(b[0], b[1], b[2])
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

interface Theme { id: string; vars: Record<string, number[]> }
const themes: Theme[] = []
{
  // `:root` 与 [data-theme='dark'] 写在同一条选择器里，匹配时要把两者都涵盖
  const root = css.match(/:root,\s*\[data-theme='dark'\]\s*\{([^}]*)\}/)
  /**
   * 🔴 必须按「选择器 + 块」成对取，而不是只找 `[data-theme='x'] {`：
   *    文末那段「浅色主题 · 图谱界面色覆盖」用的是**多选择器并列**
   *    （`[data-theme='eye-care'], [data-theme='sepia'], …`），
   *    只按后者匹配会把它误当成最后一个主题（peach-note）重复解析一遍，
   *    于是那个主题报出一堆"变量缺失"的假失败。故：选择器里出现 ≥2 次的块一律跳过。
   */
  const blocks = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .map(m => ({ sel: m[1], body: m[2] }))
    .filter(b => (b.sel.match(/data-theme/g) ?? []).length === 1)
    .map(b => ({ id: (b.sel.match(/data-theme='([a-z-]+)'/) ?? [])[1], body: b.body }))
    .filter(b => !!b.id)
  const push = (id: string, body: string) => {
    const vars: Record<string, number[]> = {}
    for (const m of body.matchAll(/--(ink-\d+|amber|amber-soft):\s*([^;]+);/g)) {
      const v = m[2].trim()
      if (v.startsWith('var')) continue // 浅色主题的图谱色是引用，不参与文字对比度判定
      vars[m[1]] = v.split(/\s+/).map(Number)
    }
    themes.push({ id, vars })
  }
  if (root) push('dark', root[1])
  for (const b of blocks) if (b.id !== 'dark') push(b.id, b.body)
}

ok('解析到全部主题（8 个）', themes.length === 8, `实到 ${themes.length}：${themes.map(t => t.id).join(',')}`)

/** 判定表：token → 阈值（只判 ink-900 / ink-950 两种最常见的落地面） */
const RULES: { token: string; min: number; bg: string[] }[] = [
  { token: 'ink-50', min: 4.5, bg: ['ink-900', 'ink-950'] },
  { token: 'ink-100', min: 4.5, bg: ['ink-900', 'ink-950'] },
  { token: 'ink-200', min: 4.5, bg: ['ink-900', 'ink-950'] },
  { token: 'ink-300', min: 4.5, bg: ['ink-900', 'ink-950'] },
  { token: 'ink-400', min: 4.5, bg: ['ink-900', 'ink-950'] },
  { token: 'ink-500', min: 3.2, bg: ['ink-900'] },
  { token: 'ink-600', min: 2.2, bg: ['ink-900'] },
  { token: 'amber', min: 4.5, bg: ['ink-900', 'ink-950'] },
  { token: 'amber-soft', min: 3.4, bg: ['ink-900'] },
]

for (const t of themes) {
  const bad: string[] = []
  for (const r of RULES) {
    const col = t.vars[r.token]
    if (!col) { bad.push(`${r.token} 缺失`); continue }
    for (const bg of r.bg) {
      const b = t.vars[bg]
      if (!b) continue
      const c = contrast(col, b)
      if (c < r.min) bad.push(`${r.token} on ${bg} = ${c.toFixed(2)} < ${r.min}`)
    }
  }
  ok(`主题「${t.id}」对比度全部达标`, bad.length === 0, bad.join(' ｜ '))
}

/**
 * 灰阶**单调性**：浅色主题里 ink 刻度是反的（950 最浅、50 最深），
 * 这条只判「文字用的这几档（50→600）亮度必须单调递增或递减」——
 * 若某次手动调色把 ink-500 调得比 ink-400 还浅，层次就乱了（且对比度闸查不出来）。
 */
for (const t of themes) {
  const seq = ['ink-50', 'ink-100', 'ink-200', 'ink-300', 'ink-400', 'ink-500', 'ink-600']
    .map(k => t.vars[k]).filter(Boolean) as number[][]
  if (seq.length < 7) { ok(`主题「${t.id}」灰阶完整`, false, '缺刻度'); continue }
  const ls = seq.map(c => lum(c[0], c[1], c[2]))
  const up = ls.every((v, i) => i === 0 || v > ls[i - 1])
  const down = ls.every((v, i) => i === 0 || v < ls[i - 1])
  ok(`主题「${t.id}」灰阶单调（50→600）`, up || down, ls.map(v => v.toFixed(3)).join(' '))
}

// ---------- 边框（描边 / 分隔线）对比度（2026-10-10 · 社区反馈）----------
//
// 为什么补这一道：上面的 RULES 只判**文字**，边框一条都没测 —— 而边框出问题**不会报错**，
// 在作者惯用的那个主题下也未必看得见。实测（修复前）浅色主题里 ink-800 与 ink-900 几乎同色
// （对比度 ≈1.0），于是所有「拿 ink-800 当边框」的元素（当时 134 处）在护眼 / 羊皮卷 / 青花 /
// 桃笺四个浅色主题下**完全看不见**，本项目 ink-700 才是描边主色（约 740 处）。
// 🔴 判据：ink-700 相对三种常见落地面 —— ink-900（主面板）/ ink-850（抬升面板）/ ink-800（嵌套面）。
//    ink-800 一档的下限刻意更松：该面本身已由「面与面的边界」承载一层分离，描边只需补强。
const BORDER_RULES: { min: number; bg: string }[] = [
  { min: 1.45, bg: 'ink-900' },
  { min: 1.35, bg: 'ink-850' },
  { min: 1.20, bg: 'ink-800' },
]
for (const t of themes) {
  const bad: string[] = []
  const col = t.vars['ink-700']
  if (!col) bad.push('ink-700 缺失')
  else for (const r of BORDER_RULES) {
    const bg = t.vars[r.bg]
    if (!bg) continue
    const c = contrast(col, bg)
    if (c < r.min) bad.push(`ink-700 on ${r.bg} = ${c.toFixed(2)} < ${r.min}`)
  }
  ok(`主题「${t.id}」边框对比度达标`, bad.length === 0, bad.join(' ｜ '))
}

// ---------- 源码闸：禁止把「面」当描边色用 ----------
//
// 🔴 ink-800 / ink-850 的职责是**面**（输入框底 / 卡片底），不是描边色。对比度闸只能约束
//    「变量取值」，管不住「类名怎么用」—— 故这里直接扫源码，防止下一个人顺手写回去。
//    范围只限 .ts / .tsx（index.css 的注释里为讲清缘由会提到该串，不该被误伤）。
function walkSrc(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkSrc(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}
{
  const offenders: string[] = []
  for (const f of walkSrc(path.join(process.cwd(), 'src'))) {
    const src = fs.readFileSync(f, 'utf8')
    if (src.includes('border-ink-800') || src.includes('divide-ink-800')) {
      offenders.push(path.relative(process.cwd(), f).replace(/\\/g, '/'))
    }
  }
  ok('源码里没有把 ink-800 当边框 / 分隔色（统一用 ink-700）', offenders.length === 0, offenders.join(', '))
}

// ---------- CSS 分层闸：输入类默认样式必须在 @layer 内（2026-10-10 · 全局修正）----------
//
// 为什么要有这一道：Tailwind v4 的工具类都在 `@layer utilities`，而**未分层样式优先于任何命名层** ——
// 于是 index.css 里那条不套层的 `input, textarea, select { … px-3 py-1.5 … }` 会把组件传的
// px-* / py-* / rounded-* / bg-* / border-* 全部压掉。真机实测的后果（改前）：
//   · 侧栏缩放框 48px 宽只剩 22px 可用，「132」被裁成「1」；
//   · 编辑器正文 textarea 的 `px-6 md:px-8 pt-6` 失效 ⇒ 正文与高亮/ghost 叠层错位 20px × 18px。
// 判据：默认样式留在 `@layer base`；未分层处**不再允许**出现 input/textarea/select 的默认样式
//       （只保留聚焦态与占位符 —— 那两条是设计系统刻意统一给的，本就不该被各页面覆盖）。
const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, '')
{
  const baseBlock = cssNoComment.match(/@layer\s+base\s*\{([^}]*)\}/)
  ok('输入类默认样式已放进 @layer base',
    !!baseBlock && /(^|\s)input,\s*textarea,\s*select\s*\{?/.test(baseBlock[1]),
    baseBlock ? baseBlock[1].trim().slice(0, 70) : '未找到 @layer base 块')
  // 去掉 base 块后，源里不该再有未分层的 `input/textarea/select …{`
  // （`input:focus` / `textarea::placeholder` 因为紧跟冒号，不会被这条匹配到）
  const rest = cssNoComment.replace(/@layer\s+base\s*\{[^}]*\}/, '')
  const hit = rest.match(/\n\s*(input|textarea|select)\s*[,{]/)
  ok('未分层处不再有输入类默认样式（只留聚焦态 / 占位符）', !hit, hit ? `命中：${hit[0].trim()}` : '')
}

// ---------- 实心按钮（solid danger / success / info）的白字对比度（2026-10-03 · 方案 ②）----------
//
// 这三种 solid 的底色是**固定 500/600/700 级色**（不随主题变），字色统一 `text-white`。
// 因此只有当底色足够深才达 WCAG AA（正文级 ≥ 4.5）—— 这正是「三变体统一深底白字」的判据。
// 🔴 反面：`text-ink-950` 看上去是「深字」，但 ink 是**主题变量** —— 浅色主题下它是浅色
//    （如 230 240 224），会变成「浅字 + 亮底」（success 原样仅约 2.1），跨主题翻车。
// 本闸同时钉「类名」与「对比度」：只钉对比度会被"换个色名"绕过，只钉类名则算不出深浅。
const TW_PALETTE: Record<string, Record<number, string>> = {
  red: { 500: '#ef4444', 600: '#dc2626', 700: '#b91c1c', 800: '#991b1b' },
  emerald: { 500: '#10b981', 600: '#059669', 700: '#047857', 800: '#065f46' },
  sky: { 500: '#0ea5e9', 600: '#0284c7', 700: '#0369a1', 800: '#075985' },
}
const hexRgb = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
const WHITE = [255, 255, 255]
const buttonSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'common', 'Button.tsx'), 'utf8')
const SOLID_VARIANTS: { variant: string; cls: string; color: string; shade: number }[] = [
  { variant: 'danger', cls: "'bg-red-600 text-white border border-red-600 hover:bg-red-700", color: 'red', shade: 600 },
  { variant: 'success', cls: "'bg-emerald-700 text-white border border-emerald-700 hover:bg-emerald-800", color: 'emerald', shade: 700 },
  { variant: 'info', cls: "'bg-sky-700 text-white border border-sky-700 hover:bg-sky-800", color: 'sky', shade: 700 },
]
for (const v of SOLID_VARIANTS) {
  ok(`solid ${v.variant}：底色类名与字色被钉死（${v.color}-${v.shade} + text-white）`, buttonSrc.includes(v.cls))
  const c = contrast(hexRgb(TW_PALETTE[v.color][v.shade]), WHITE)
  ok(`solid ${v.variant}：白字对比度 ≥ 4.5（实测 ${c.toFixed(2)}）`, c >= 4.5)
}

console.log(`\nthemeContrast: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
