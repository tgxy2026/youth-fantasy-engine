process.env.YFE_AUDIT_FULL ??= '1'
// UI 布局/设计一致性审查扫描器（只读）—— 补「UI 是否规范协调」这一维
// 用法：node .workbuddy/tmp/audit-ui.mjs [工作区路径]
// 只查**能确定性判定**的那半：`UI 好不好看`判不了，`UI 是不是用了同一套 token`能判。
// 另一半（两列等高、输入框被挤窄、点击真能通）归 novel-studio-ui-livecheck。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = (process.argv[2] || 'G:/AI软件/youth-fantasy-engine开发源码').replace(/\\/g, '/')
const SRC = path.join(ROOT, 'src')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}
const rel = f => path.relative(ROOT, f).replace(/\\/g, '/')
const files = walk(SRC)
const src = new Map()
for (const f of files) src.set(f, fs.readFileSync(f, 'utf8'))

/**
 * 逐字符剥离注释，保留行结构与字符串内容。
 * ⚠️ 不剥的话：注释里的「#031 定期提醒」「#012 备份策略」会被当成十六进制色瞒报成一片
 *    （实测 U2 前 12 条全是这种），而 className 住在字符串里、剥了照样能扫。
 */
function stripComments(s) {
  let out = ''
  let i = 0
  const n = s.length
  let st = 'code'
  while (i < n) {
    const c = s[i], c2 = s[i + 1]
    if (st === 'code') {
      if (c === '/' && c2 === '/') { st = 'line'; out += '  '; i += 2; continue }
      if (c === '/' && c2 === '*') { st = 'block'; out += '  '; i += 2; continue }
      if (c === "'") { st = 'sq'; out += c; i++; continue }
      if (c === '"') { st = 'dq'; out += c; i++; continue }
      if (c === '`') { st = 'tpl'; out += c; i++; continue }
      out += c; i++; continue
    }
    if (st === 'line') { if (c === '\n') { st = 'code'; out += c; i++; continue } out += ' '; i++; continue }
    if (st === 'block') { if (c === '*' && c2 === '/') { st = 'code'; out += '  '; i += 2; continue } out += (c === '\n' ? '\n' : ' '); i++; continue }
    if (c === '\\') { out += c + (c2 ?? ''); i += 2; continue }
    if ((st === 'sq' && c === "'") || (st === 'dq' && c === '"') || (st === 'tpl' && c === '`')) { st = 'code'; out += c; i++; continue }
    out += c; i++; continue
  }
  return out
}
const masked = new Map()
for (const f of files) masked.set(f, stripComments(src.get(f)))

const out = []
const P = s => out.push(s)
const escTxt = s => s.replace(/\s+/g, ' ').trim()

// 主题 token：项目用了自定义色板（bg-ink-*, bg-amber/* 等），凡是绕过这些直接用 Tailwind 默认色板的，
// 深色模式一换皮就会"某个角落突然一块白/一块黑"。
const RISKY = /(?:^|[\s"])(?:hover:|focus:|active:|dark:)*(?:bg|text|border|ring|divide|from|to|via|shadow|fill|stroke|decoration|outline|caret|accent)-(?:white|black|gray-\d{2,3}|slate-\d{2,3}|neutral-\d{2,3}|zinc-\d{2,3}|stone-\d{2,3})(?:\/[\d.]+)?(?=[\s"]|$)/g

// ── U1. 硬编码颜色（绕过主题 token）───────────────────────────────
{
  const hits = []
  for (const f of files) {
    const lines = masked.get(f).split(/\r?\n/)
    lines.forEach((l, i) => {
      for (const mm of l.matchAll(RISKY)) hits.push({ f: rel(f), i: i + 1, cls: mm[0].trim(), l: escTxt(l).slice(0, 80) })
    })
  }
  const byCls = new Map()
  for (const h of hits) {
    if (!byCls.has(h.cls)) byCls.set(h.cls, [])
    byCls.get(h.cls).push(h)
  }
  const risky = new Set(['bg-white', 'bg-black', 'text-black', 'text-white', 'bg-gray-100', 'bg-gray-50', 'border-gray-200', 'divide-gray-200'])
  P(`\n── U1. 直接使用 Tailwind 默认色板（${hits.length} 处 / ${byCls.size} 种）──`)
  P('  判读：项目自定义了 ink/amber 色板。直接写 gray-*/white/black 的，换深色皮肤时会"一块补丁"；走 token 才随主题变。')
  P('  先看这几种最容易露馅的：')
  for (const [cls, arr] of [...byCls.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (!risky.has(cls)) continue
    P(`  ▸ ${cls} ×${arr.length}   ${arr.slice(0, 2).map(x => `${x.f}:${x.i}`).join(' / ')}`)
  }
  P('  其余（按频次）：' + [...byCls.entries()].filter(([c]) => !risky.has(c)).sort((a, b) => b[1].length - a[1].length).slice(0, 10).map(([c, a]) => `${c}×${a.length}`).join('、'))
  if (!hits.length) P('  ✅ 全部走主题 token')
}

// ── U2. 硬编码十六进制色 ──────────────────────────────────────────
{
  const hits = []
  for (const f of files) {
    masked.get(f).split(/\r?\n/).forEach((l, i) => {
      // ⚠️ 只认 CSS 色值形态，避开注释里的「#031 提醒」——已剥注释，这里再加一道保险
      for (const mm of l.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        if (/^#\d{3}$/.test(mm[0])) continue
        hits.push({ f: rel(f), i: i + 1, l: escTxt(l).slice(0, 80) })
      }
    })
  }
  P(`\n── U2. 硬编码十六进制色（${hits.length} 处）──`)
  P('  判读：改主题时不会跟着变。SVG 里的大多是图谱配色，应走 `--graph-*`。')
  for (const h of (process.env.YFE_AUDIT_FULL === '1' ? hits : hits.slice(0, 12))) P(`  ▸ ${h.f}:${h.i}  ${h.l}`)
  if (!hits.length) P('  ✅ 无硬编码色值')
}

// ── U3. 任意值（Tailwind arbitrary）──────────────────────────────
// `p-[13px]` 意味着跳出了间距/字号阶梯 —— 设计失去栅格。
{
  // ⚠️ 整份项目上千处任意值，逐条打印等于没有信息。按「值」聚合才有判读价值：
  //    某个 px 字号出现几百次 ⇒ 说明**缺一条字号阶梯**；而零散的一次性值才是真的栅格外。
  const hits = []
  const tally = new Map()   // 类名 → {n, files}
  const RE = /\b(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y|w|h|min-w|min-h|max-w|max-h|text)-\[([^\]]+)\]/g
  for (const f of files) {
    masked.get(f).split(/\r?\n/).forEach((l, i) => {
      for (const mm of l.matchAll(RE)) {
        hits.push({ f: rel(f), i: i + 1, cls: mm[0], l: escTxt(l).slice(0, 70) })
        if (!tally.has(mm[0])) tally.set(mm[0], { n: 0, files: new Set() })
        const t = tally.get(mm[0]); t.n++; t.files.add(rel(f))
      }
    })
  }
  P(`\n── U3. Tailwind 任意值 ${hits.length} 处（${tally.size} 种 · 跳出栅格）──`)
  P('  判读：某个值出现几百次 ⇒ 缺少的是**一条阶梯**（应写进 tailwind.config），不是逐个改；零散的一次性值才是真例外。')
  const top = [...tally.entries()].sort((a, b) => b[1].n - a[1].n)
  for (const [cls, t] of (process.env.YFE_AUDIT_FULL === '1' ? top : top.slice(0, 14))) P(`  ▸ ${String(t.n).padStart(4)} ×  ${cls.padEnd(16)} （${t.files.size} 文件）`)
  const fonts = [...new Set(hits.map(h => h.cls).filter(c => /^text-\[(\d+)px\]$/.test(c)).map(c => c.match(/\d+/)[0]))].sort((a, b) => a - b)
  if (fonts.length) P(`  字号阶梯现状：用了 ${fonts.length} 种 px 字号（${fonts.join('/')}）—— 建议收敛到 4~5 档并写进 theme`)
  if (!hits.length) P('  ✅ 无任意值')
}

// ── U4. 重复 className（该抽组件了）──────────────────────────────
{
  const buckets = new Map()
  for (const f of files) {
    for (const mm of src.get(f).matchAll(/className="([^"]{40,})"/g)) {
      const cls = mm[1].replace(/\s+/g, ' ').trim()
      if (!buckets.has(cls)) buckets.set(cls, new Set())
      buckets.get(cls).add(rel(f))
    }
  }
  const dup = [...buckets.entries()].filter(([, s]) => s.size >= 2 && true).sort((a, b) => b[1].size - a[1].size)
  const flat = new Map()
  for (const f of files) {
    for (const mm of src.get(f).matchAll(/className="([^"]{40,})"/g)) {
      const cls = mm[1].replace(/\s+/g, ' ').trim()
      if (!flat.has(cls)) flat.set(cls, [])
      flat.get(cls).push(rel(f))
    }
  }
  const top = [...flat.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8)
  P(`\n── U4. 重复 className TOP8（同一串 ≥40 字符到处贴）──`)
  P('  判读：同一串装饰类在 N 处手写 = 改样式要改 N 次，且必然演化出细微差异。抽成组件/常量类。')
  for (const [cls, fs2] of top) {
    const uniq = [...new Set(fs2)]
    P(`  ▸ ×${fs2.length}（${uniq.length} 文件）  ${cls.slice(0, 90)}`)
  }
}

// ── U5. 可访问性 / 交互可达性 ─────────────────────────────────────
{
  const noLabel = [], noAlt = [], fakeBtn = []
  for (const f of files) {
    const s = src.get(f)
    s.split(/\r?\n/).forEach((l, i) => {
      const at = `${rel(f)}:${i + 1}`
      // 图标按钮：Button 开了 iconOnly 或有 aria-label/title 才算可读
      if (/<(?:button|Button)\b/.test(l) && /iconOnly/.test(l)) {
        if (!/aria-label|title=/.test(l) && !/aria-label|title=/.test(s.slice(s.indexOf('\n', s.indexOf(l)) + 1, s.indexOf(l) + 400))) noLabel.push(at)
      }
      if (/<img\b/.test(l) && !/alt=/.test(l) && !/alt=/.test(s.slice(s.indexOf(l), s.indexOf(l) + 300))) noAlt.push(at)
      if (/<(?:div|span)\b[^>]*onClick=/.test(l) && !/role=|tabIndex=/.test(s.slice(s.indexOf(l), s.indexOf(l) + 300))) fakeBtn.push(at)
    })
  }
  P(`\n── U5. 可访问性 / 交互可达性 ──`)
  P(`  ▸ 图标按钮缺 aria-label/title（${noLabel.length}）：朗读器读不出用途，hover 也无从知道作用`)
  for (const x of (process.env.YFE_AUDIT_FULL === '1' ? noLabel : noLabel.slice(0, 10))) P(`       ${x}`)
  P(`  ▸ <img> 缺 alt（${noAlt.length}）`)
  for (const x of (process.env.YFE_AUDIT_FULL === '1' ? noAlt : noAlt.slice(0, 8))) P(`       ${x}`)
  P(`  ▸ 可点击的 div/span 无 role/tabIndex（${fakeBtn.length}）：键盘不可达、屏幕阅读器不识别`)
  for (const x of (process.env.YFE_AUDIT_FULL === '1' ? fakeBtn : fakeBtn.slice(0, 10))) P(`       ${x}`)
  if (!noLabel.length && !noAlt.length && !fakeBtn.length) P('  ✅ 未发现明显可访问性缺口')
}

// ── U6. 超长 className（可读性 / 设计一致性）──────────────────────
{
  const long = []
  for (const f of files) {
    for (const mm of src.get(f).matchAll(/className="([^"]{40,})"/g)) {
      const cls = mm[1].replace(/\s+/g, ' ').trim()
      const n = cls.split(' ').length
      if (n >= 14) long.push({ f: rel(f), n, cls: cls.slice(0, 100), i: src.get(f).slice(0, mm.index).split('\n').length })
    }
  }
  long.sort((a, b) => b.n - a.n)
  P(`\n── U6. 超长 className TOP10（≥14 个工具类）──`)
  P('  判读：不是错误，但长到这份上通常意味着"这段视觉会被复制到别处" → 正是该抽组件的位置（与 U4 呼应）。')
  for (const x of (process.env.YFE_AUDIT_FULL === '1' ? long : long.slice(0, 10))) P(`  ▸ ${x.n} 类  ${x.f}:${x.i}  ${x.cls}`)
  if (!long.length) P('  ✅ 无超长类名')
}

console.log(out.join('\n'))
console.log('\n⚠️ U1/U3/U4 是「候选」不是「违规」：个别地方有意用默认值（如 SVG 导图、第三方容器）属正常，抽 3~5 条确认。')
const { printSupplement } = await import('../compat.mjs')
printSupplement(ROOT, 'ui')
