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
import { THEMES } from '../src/lib/settings/theme'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n—— themeContrast 用例开始 ——')

const CSS = path.join(process.cwd(), 'src', 'index.css')
const css = fs.readFileSync(CSS, 'utf8')
/**
 * 🔴 剥注释版：主题块解析**必须**用它 —— 两个原因：
 *   ① dark 块内的注释写着 `style={{ fill: … }}`，连续 `}}` 会让 `[^}]*` 提前截断（graph 键全丢）；
 *   ② 主题块前的注释（如「护眼：浅绿柔光…」）会混进选择器匹配，按「选择器恰为单个
 *      [data-theme='x']」判定时全部落马（2026-10-15 mono 接入时实测：9 个主题只解析出 1 个）。
 * 与 tests/customTheme.test.ts 的 cssClean 同一口径。
 */
const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, '')

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
  // （用剥注释版：dark 块内注释含 `style={{ … }}`，原始文本会把块体截断在注释里）
  const root = cssNoComment.match(/:root,\s*\[data-theme='dark'\]\s*\{([^}]*)\}/)
  /**
   * 🔴 必须按「选择器 + 块」成对取，而不是只找 `[data-theme='x'] {`：
   *    文末那段「浅色主题 · 图谱界面色覆盖」用的是**多选择器并列**
   *    （`[data-theme='eye-care'], [data-theme='sepia'], …`），
   *    只按后者匹配会把它误当成最后一个主题（peach-note）重复解析一遍，
   *    于是那个主题报出一堆"变量缺失"的假失败。故：选择器里出现 ≥2 次的块一律跳过。
   * 🔴 2026-10-15（3.1 · P0-D 纯黑白）：判定进一步收紧为「选择器**恰为**单个
   *    [data-theme='x']」—— mono 的回收段有几十条 `[data-theme='mono'] [class*=…]` /
   *    `[data-theme='mono'] .badge-*` 作用域规则，按旧口径（出现 1 次即收）会被
   *    误判成又一个「mono 主题块」：变量全缺 → 对比度假失败，主题数还会虚增。
   *    只有变量定义块本身（选择器仅一个属性选择器）才是主题。
   */
  const blocks = [...cssNoComment.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .map(m => ({ sel: m[1], body: m[2] }))
    .filter(b => (b.sel.match(/data-theme/g) ?? []).length === 1)
    .map(b => ({ sel: b.sel.trim(), body: b.body }))
    .filter(b => /^\[data-theme='[a-z-]+'\]$/.test(b.sel))
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

ok('解析到全部主题（9 个：八彩色 + 纯黑白）', themes.length === 9, `实到 ${themes.length}：${themes.map(t => t.id).join(',')}`)

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
 * 🔴 2026-10-15（mono）：改**非严格**单调（>= / <=）—— 纯黑白主题的 50→600
 *    七档同为 #000000 是设计使然（不靠灰阶传递层级），严格比较会误报；
 *    非严格仍抓得到真正的「刻度反转」。
 */
for (const t of themes) {
  const seq = ['ink-50', 'ink-100', 'ink-200', 'ink-300', 'ink-400', 'ink-500', 'ink-600']
    .map(k => t.vars[k]).filter(Boolean) as number[][]
  if (seq.length < 7) { ok(`主题「${t.id}」灰阶完整`, false, '缺刻度'); continue }
  const ls = seq.map(c => lum(c[0], c[1], c[2]))
  const up = ls.every((v, i) => i === 0 || v >= ls[i - 1])
  const down = ls.every((v, i) => i === 0 || v <= ls[i - 1])
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
// （cssNoComment 已在文件头统一剥注释，此处直接复用）
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

// ---------- 纯黑白主题（mono）专项闸（3.1 · P0-D · 2026-10-15）----------
//
// 为什么单立一段：mono 的验收口径不是「对比度够」而是「严格二值」——
// 全部取值只允许 #FFFFFF 与 #000000，且左下角主题栏顺序、派生链排除、
// 半透明/固定色回收规则都在验收清单上。这些一旦被后续改色破坏，对比度闸
// （黑白 21:1 恒过）根本发现不了，故在这里钉死。
{
  // ① 变量块严格二值：ink 12 档 + amber 家族 + 三状态色只允许两值
  //    ⚠️ 用 matchAll 再挑含 --ink-950 的那块：文末图谱色覆盖组的末选择器也是
  //       `[data-theme='mono'] {`，只取第一个会随源文件顺序漂移。
  const monoBlocks = [...cssNoComment.matchAll(/\[data-theme='mono'\]\s*\{([^}]*)\}/g)]
  const monoBlock = monoBlocks.find(m => m[1].includes('--ink-950'))
  ok('mono：index.css 存在 [data-theme=\'mono\'] 变量块', !!monoBlock)
  if (monoBlock) {
    const body = monoBlock[1]
    const vals = [...body.matchAll(/--(ink-\d+|amber|amber-soft|danger|success|info):\s*([^;]+);/g)]
      .map(m => ({ k: m[1], v: m[2].trim() }))
    ok('mono：17 个颜色变量全部声明（ink 12 + amber 2 + 状态 3）', vals.length === 17, `实到 ${vals.length}`)
    const offValue = vals.filter(v => v.v !== '255 255 255' && v.v !== '0 0 0')
    ok('mono：所有取值严格为 #FFFFFF(255 255 255) 或 #000000(0 0 0)',
      offValue.length === 0, offValue.map(v => `${v.k}=${v.v}`).join(', '))
    // 面（950~800）必须白、字与边（700~50）必须黑 —— 收反了就是「黑底白字的暗色主题」
    const surfaces = ['ink-950', 'ink-900', 'ink-850', 'ink-800']
      .map(k => vals.find(v => v.k === k)?.v)
    const inks = ['ink-700', 'ink-600', 'ink-500', 'ink-400', 'ink-300', 'ink-200', 'ink-100', 'ink-50']
      .map(k => vals.find(v => v.k === k)?.v)
    ok('mono：面（ink-950~800）= #FFFFFF', surfaces.every(v => v === '255 255 255'), surfaces.join(' | '))
    ok('mono：字与描边（ink-700~50）= #000000', inks.every(v => v === '0 0 0'), inks.join(' | '))
    ok('mono：color-scheme 为 light（白色界面配浅色表单控件）', /color-scheme:\s*light/.test(body))
  }

  // ② 主题栏顺序：八个彩色预制 → 纯黑白 → 彩色自定义按钮（custom 恒最末）
  const ids = THEMES.map(t => t.id)
  ok('THEMES：共 10 项（8 彩色预制 + mono + custom）', ids.length === 10, ids.join(','))
  ok('THEMES：mono 位于 peach-note 之后、custom 之前（左下角主题栏顺序）',
    ids[ids.length - 2] === 'mono' && ids[ids.length - 1] === 'custom' && ids.includes('peach-note'),
    ids.join(','))
  const monoDef = THEMES.find(t => t.id === 'mono')
  ok('THEMES：mono 名称为「纯黑白」', monoDef?.name === '纯黑白')

  // ③ 派生链排除：mono 不做自定义主题母版（严格黑白预设保持独立）
  const dialogSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'settings', 'CustomThemeDialog.tsx'), 'utf8')
  ok('CustomThemeDialog：母版列表排除 mono（不进色相派生链）',
    /t\.id !== 'custom' && t\.id !== 'mono'/.test(dialogSrc))
  ok('CustomThemeDialog：当前主题为 mono 时母版回退 eye-care',
    /cur === 'custom' \|\| cur === 'mono' \? 'eye-care'/.test(dialogSrc))
  const themeSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'settings', 'theme.ts'), 'utf8')
  ok('theme.ts：getStoredCustomTheme 拒绝 baseId=mono 的脏参数',
    /p\.baseId === 'custom' \|\| p\.baseId === 'mono'/.test(themeSrc))

  // ④ 回收规则在位（防呆：删了任何一类，黑白下就会出现灰/彩色界面元素）
  const reclamations: [string, RegExp][] = [
    ['半透明底色 → 纯白', /\[data-theme='mono'\] \[class\*='bg-amber\/'\]/],
    ['固定调色板实底 → 纯黑', /\[data-theme='mono'\] \[class\*='bg-red-'/],
    ['悬停实底 ink-700/600 → 纯白', /\[data-theme='mono'\] \[class\*='hover:bg-ink-700'\]/],
    ['描边 → 纯黑', /\[data-theme='mono'\] \[class\*='border-amber'\]/],
    ['文字 → 纯黑', /\[data-theme='mono'\] \[class\*='text-amber'\]/],
    ['光环 → 纯黑（--tw-ring-color）', /\[data-theme='mono'\] \[class\*='ring-amber'\]/],
    ['阴影撤掉（--tw-shadow，排除 drop-shadow）', /\[data-theme='mono'\] \[class\*='shadow-'\]:not\(\[class\*='drop-shadow'\]\)/],
    ['自定义类逃逸口：聚焦纯黑（input:focus）', /\[data-theme='mono'\] input:focus/],
    ['自定义类逃逸口：field-example 纯黑', /\[data-theme='mono'\] \.field-example/],
    ['自定义类逃逸口：card-hover 黑边无投影', /\[data-theme='mono'\] \.card-hover:hover/],
    ['选中态双线补偿（排除 hover: 变体）', /\[data-theme='mono'\] \[class\*='border-amber\/'\]:not\(\[class\*='hover:border-amber'\]\)/],
    ['悬停态内嵌轮廓', /\[data-theme='mono'\] \[class\*='hover:bg-'\]:hover/],
    ['正文选择黑底白字', /\[data-theme='mono'\] ::selection/],
    ['引用名高亮黑底白字', /\[data-theme='mono'\] \.ref-mark/],
    ['ghost 建议虚下划线', /\[data-theme='mono'\] \.ai-ghost/],
    ['占位符纯黑不透明', /\[data-theme='mono'\] input::placeholder/],
    ['状态徽章白底黑字', /\[data-theme='mono'\] \.badge-green/],
    ['写锁横幅白底黑字', /\[data-theme='mono'\] \.bg-red-700\\\/97/],
  ]
  for (const [name, re] of reclamations) {
    ok(`mono 回收规则在位：${name}`, re.test(cssNoComment))
  }

  // ⑤ mono 并入浅色图谱色覆盖组（图谱自动继承纯黑白）
  ok('mono 并入浅色主题图谱色覆盖选择器组',
    /\[data-theme='peach-note'\],\s*\[data-theme='mono'\]\s*\{/.test(cssNoComment))
}

console.log(`\nthemeContrast: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
