process.env.YFE_AUDIT_FULL ??= '1'
// 结构审查扫描器（只读）—— 补「架构合理性 / 冗余设计 / 低效实现」这一维
// 用法：node .workbuddy/tmp/audit-arch.mjs [工作区路径]
// ⚠️ 全部输出都是**候选清单**，不是违规清单。file-level Jaccard 与重复块都会有误报，须人工抽样。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = (process.argv[2] || 'G:/AI软件/youth-fantasy-engine开发源码').replace(/\\/g, '/')
const SRC = path.join(ROOT, 'src')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}
const rel = f => path.relative(ROOT, f).replace(/\\/g, '/')
const count = (s, re) => [...s.matchAll(re)].length   // ⚠️ 别用 String.match 计数：有捕获组时长度=1+组数

/**
 * 逐字符剥离注释，保留行结构与字符串内容。
 * 不剥的话：注释里举例的 import / JSX / 正则会全部变成假命中。
 */
function stripComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  let st = 'code'
  while (i < n) {
    const c = src[i], c2 = src[i + 1]
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

const files = walk(SRC)
const raw = new Map()
const masked = new Map()
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8')
  raw.set(f, src)
  masked.set(f, stripComments(src))
}
const normLine = l => l.replace(/\s+/g, ' ').trim()

const out = []
const P = s => out.push(s)
const hasCJK = s => /[\u4e00-\u9fa5]/.test(s)

// ── A1. 重复代码块（跨文件 ≥6 行归一化后逐行相同）──────────────────
// 这是「复制粘贴式冗余」最强的信号 —— 两个文件共享一段 ≥6 行的代码，
// 几乎总是应当抽成共享函数/组件，而不是各自维护一份。
{
  const W = 6
  const blocks = new Map() // 窗口文本 → Map(file → 起始行)
  for (const f of files) {
    const ls = masked.get(f).split(/\r?\n/).map(normLine)
    for (let i = 0; i + W <= ls.length; i++) {
      const win = ls.slice(i, i + W)
      if (win.some(l => l.length < 8)) continue                       // 短行/符号行不构成有意义重复
      if (win.every(l => /^[{}\[\]()<>,;]+$/.test(l))) continue
      const key = win.join('\n')
      if (!blocks.has(key)) blocks.set(key, new Map())
      blocks.get(key).set(f, i)
    }
  }
  // 同一「文件集合」的相邻窗口属同一段 —— 按起始行连续性把滑动窗口合并成块
  const bySet = new Map()
  for (const [key, fm] of blocks) {
    if (fm.size < 2) continue
    const setKey = [...fm.keys()].sort().join('|')
    if (!bySet.has(setKey)) bySet.set(setKey, [])
    bySet.get(setKey).push({ min: Math.min(...fm.values()), fm })
  }
  const groups = []
  for (const arr of bySet.values()) {
    arr.sort((a, b) => a.min - b.min)
    let cur = null
    for (const w of arr) {
      if (cur && w.min === cur.min + cur.len) { cur.len++; continue }
      if (cur) groups.push(cur)
      cur = { min: w.min, len: 1, fm: w.fm }
    }
    if (cur) groups.push(cur)
  }
  groups.sort((a, b) => (b.len - a.len) || (b.fm.size - a.fm.size))
  P(`\n── A1. 重复代码块（≥${W} 行跨文件雷同 · 合并后 ${groups.length} 块）──`)
  P('  判读：两个文件共享一段 N 行雷同代码 = 复制粘贴冗余。先看最长的几块，抽掉能同时减体积、消漂移。')
  for (const g of (process.env.YFE_AUDIT_FULL === '1' ? groups : groups.slice(0, 10))) {
    const [file, off] = [...g.fm.entries()][0]
    const ls = masked.get(file).split(/\r?\n/).map(normLine)
    const size = g.len + W - 1
    P(`  ▸ ${size} 行 × ${g.fm.size} 个文件 · ${[...g.fm.entries()].slice(0, 3).map(([f, i]) => `${rel(f)}:${i + 1}`).join(' / ')}`)
    P(`      ${ls[off].slice(0, 100)}`)
  }
  if (!groups.length) P('  ✅ 无跨文件重复块')
}

// ── A2. 近似重复模块（同目录内文本重合度高）────────────────────────
// 只在「同一目录」内两两比对 + 「basename 前缀相同」的跨目录对，避免 O(n²) 误报洪水。
{
  const sets = new Map()
  for (const f of files) {
    const s = new Set()
    for (const l of masked.get(f).split(/\r?\n/)) {
      const n = normLine(l)
      if (n.length >= 16) s.add(n)
    }
    sets.set(f, s)
  }
  const pairs = []
  const byDir = new Map()
  for (const f of files) {
    const d = path.dirname(f)
    if (!byDir.has(d)) byDir.set(d, [])
    byDir.get(d).push(f)
  }
  const consider = (a, b) => {
    const sa = sets.get(a), sb = sets.get(b)
    if (!sa.size || !sb.size) return
    let inter = 0
    for (const l of sa) if (sb.has(l)) inter++
    const j = inter / (sa.size + sb.size - inter)
    if (j >= 0.3) pairs.push([j, rel(a), rel(b), inter])
  }
  for (const [, arr] of byDir) for (let i = 0; i < arr.length; i++) for (let k = i + 1; k < arr.length; k++) consider(arr[i], arr[k])
  const base = f => path.basename(f, path.extname(f))
  for (let i = 0; i < files.length; i++) for (let k = i + 1; k < files.length; k++) {
    const a = base(files[i]), b = base(files[k])
    if (a.length >= 6 && b.length >= 6 && (a.startsWith(b.slice(0, 6)) || b.startsWith(a.slice(0, 6)))) consider(files[i], files[k])
  }
  pairs.sort((x, y) => y[0] - x[0])
  P(`\n── A2. 近似重复模块（重合度 ≥30% · ${pairs.length} 对）──`)
  P('  判读：>50% 多半该合并或抽公共底座；30~50% 常见于同族 UI（同目录 alumnus），看是不是"抄改版"。')
  for (const [j, a, b, inter] of (process.env.YFE_AUDIT_FULL === '1' ? pairs : pairs.slice(0, 15))) P(`  ▸ ${(j * 100).toFixed(0)}% (${inter} 行同) ${a}  ⟷  ${b}`)
  if (!pairs.length) P('  ✅ 无高重合模块')
}

// ── A3. 冗余转发层（整文件只做 re-export）─────────────────────────
// ⚠️ 候选不是违规：有意留的兼容口子（如 tavern 的 engine → provider）要留下。
// 处置思路见 SKILL §「删掉便捷 re-export 比改调用方彻底」。
//
// 🏛 有意为之的「门面」白名单（改动前先读该文件头部注释，别当转发层删掉）：
//   2026-09-19 结构优化 D2 —— src/lib/db.ts 从 1,613 行巨石改为**存储层门面**
//   （10 个 src/lib/db/* 子模块 + 再导出，69 个调用方零改动、对外契约逐名比对无差异）。
//   索引型入口天生 re-export 占比 100%，它出现在 A3 是**设计**，不是债。
// 已声明的门面（原巨石按域拆进同级目录后，只剩「再导出」的入口文件）：
//   src/lib/db.ts      —— 2026-09-19 D2：存储层（实体在 ./db/，10 个域模块）
//   src/lib/ai/aiTasks.ts —— 门面（3.0 G3 移入 lib/ai/；实体仍在 ./aiTasks/）
// 🔴 新增门面必须登记在这里，否则 A3 会把它当成「待清理的冗余转发层」误报。
// ⚠️ 判「文件是否存在」禁用 Glob 塞绝对路径（返空→误判）；用 test -f / Read。
const INTENTIONAL_FACADES = ['src/lib/db.ts', 'src/lib/ai/aiTasks.ts']
{
  const fwdOf = (f) => {
    const ls = masked.get(f).split(/\r?\n/).map(normLine).filter(Boolean)
    const fwd = ls.filter(l => /^export .* from ['"]/.test(l) || /^export \{[^}]*\} from ['"]/.test(l)).length
    return [fwd, ls.length]
  }
  const real = []
  for (const f of files) {
    if (INTENTIONAL_FACADES.includes(rel(f))) continue // 已声明门面单独列，不让下面的启发式过滤掉
    const ls = masked.get(f).split(/\r?\n/).map(normLine).filter(Boolean)
    if (ls.length > 40 || ls.length === 0) continue
    const fwd = ls.filter(l => /^export .* from ['"]/.test(l) || /^export \{[^}]*\} from ['"]/.test(l)).length
    if (fwd / ls.length >= 0.6) real.push([rel(f), fwd, ls.length])
  }
  // 🏛 已声明门面：**无条件**列出，不参与「占比 ≥60%」筛选。
  // ⚠️ 2026-09-19 实测：门面除再导出外还可能带编排逻辑（aiTasks.ts 的 PROMPT_ORDER 注册 + 112 行），
  //    转发占比不到 60%，且 `ls.length > 40` 会把它直接跳过 → 启发式**静默漏报**。
  //    所以门面靠白名单认，不靠启发式认；白名单里有但文件不在 → 报警（防删了文件忘清白名单）。
  const facades = INTENTIONAL_FACADES.map(name => {
    const f = files.find(x => rel(x) === name)
    return f ? [name, ...fwdOf(f), true] : [name, 0, 0, false]
  })
  P(`\n── A3. 冗余转发层（re-export 占 ≥60% · 待清理 ${real.length} 个 · 已声明门面 ${facades.filter(x => x[3]).length} 个）──`)
  P('  判读：删掉 re-export 一行，tsc 会把**真实调用方全部报出来**（清单比人工查全）。')
  for (const [f, a, b] of real) P(`  ▸ ${f}  （${a}/${b} 行是转发）`)
  for (const [f, a, b, ok] of facades)
    P(ok
      ? `  🏛 ${f}  （${a}/${b} 行是转发）— 已声明门面，勿删（见脚本内 INTENTIONAL_FACADES 注释）`
      : `  ⚠️ ${f} — 白名单里登记了，但**文件不存在**，请清理白名单`)
  if (!real.length && !facades.some(x => x[3])) P('  ✅ 无纯转发层')
  else if (!real.length) P('  ✅ 无待清理的转发层（仅门面）')
}

// ── A4. 巨型文件 / 巨型组件 ───────────────────────────────────────
{
  const big = files.map(f => [rel(f), raw.get(f).split(/\r?\n/).length])
    .sort((a, b) => b[1] - a[1])
  P(`\n── A4. 巨型文件 TOP12（>600 行的 .tsx 建议拆）──`)
  for (const [f, n] of (process.env.YFE_AUDIT_FULL === '1' ? big : big.slice(0, 12))) P(`  ▸ ${n} 行  ${f}${n > 600 && /\.tsx$/.test(f) ? '   ⚠️ 拆分候选' : ''}`)

  const comps = []
  for (const f of files.filter(f => /\.tsx$/.test(f))) {
    const ls = masked.get(f).split(/\r?\n/)
    let cur = null
    for (let i = 0; i < ls.length; i++) {
      const m = ls[i].match(/^(?:export\s+)?(?:default\s+)?(?:const|function)\s+([A-Z]\w*)/)
      if (m) { if (cur && cur.n > 200) comps.push(cur); cur = { f: rel(f), name: m[1], at: i + 1, n: 0 } }
      else if (cur) cur.n++
    }
    if (cur && cur.n > 200) comps.push(cur)
  }
  comps.sort((a, b) => b.n - a.n)
  P(`\n── A4b. 巨型组件 TOP12（>200 行）──`)
  P('  判读：体量大不一定是错，但 >200 行常伴随「多处 return」→ 数据源/JSX/逻辑三层没分。')
  for (const c of (process.env.YFE_AUDIT_FULL === '1' ? comps : comps.slice(0, 12))) P(`  ▸ ${c.n} 行  ${c.name}  ${c.f}:${c.at}`)
  if (!comps.length) P('  ✅ 无超 200 行组件')
}

// ── A5. React 低效 / 危险模式 ─────────────────────────────────────
{
  const tsx = files.filter(f => /\.tsx$/.test(f))
  const rep = []

  // A5-1：列表渲染可能缺 key
  // ⚠️ v1 用「后 500 字符里有 < 就算渲染」→ `.map(c => c.id)` 这类纯取值被大量误报（抽 2 中 2）。
  // v2：先做括号配平取出**整个回调**，只有「箭头后直接返回 JSX」才算渲染列表。
  const balanced = (s, open) => { let d = 0; for (let i = open; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (!d) return i } } return -1 }
  const returnsJSX = cb => /=>\s*(?:\(\s*)?(?:\{[\s\S]{0,40}?(?:return)?\s*)?(?<![A-Za-z0-9_$])<[A-Za-z]/.test(cb)
  //                                                                    ↑ TS 泛型 `Record<string,…>` 不能被当成 JSX 开标签（实测误报源）
  const noKey = []
  for (const f of tsx) {
    const m = masked.get(f)
    for (const mm of m.matchAll(/\.map\(/g)) {
      const open = mm.index + 4
      const close = balanced(m, open)
      if (close < 0) continue
      const cb = m.slice(open, close + 1)
      if (!returnsJSX(cb)) continue
      if (/key=/.test(cb)) continue
      const ln = m.slice(0, mm.index).split('\n').length
      noKey.push(`${rel(f)}:${ln}`)
    }
  }
  rep.push([`列表渲染疑似缺 key（${noKey.length}）`, noKey.slice(0, 12), '缺 key 会让 React 整列表重挂载：输入框失焦、动画重播、滚动跳位。'])

  // A5-2：render body 里的排序/过滤未 memo
  // 只报「链式 ≥2 段」且「结果真的进 JSX」的 —— 单段 map 到局部小数组不值得 memo。
  const heavy = []
  for (const f of tsx) {
    const m = masked.get(f)
    const ls = m.split(/\r?\n/)
    for (let i = 0; i < ls.length; i++) {
      const mt = ls[i].match(/^\s*const (\w+) = [\w.[\]]+(\.[a-z]+\([^)]*\))\./)
      if (!mt) continue
      const chain = (ls[i].match(/\.[a-zA-Z]+\(/g) || []).length
      if (chain < 2) continue
      if (!new RegExp(`\\{${mt[1]}[.,}]|\\{${mt[1]}\\s`).test(m)) continue   // 结果没被渲染使用
      const prev = ls.slice(Math.max(0, i - 3), i).join('\n')
      if (/useMemo/.test(prev) || /useMemo/.test(ls[i])) continue
      heavy.push(`${rel(f)}:${i + 1}  const ${mt[1]} = …（${chain} 段链）`)
    }
  }
  rep.push([`渲染期重算：filter/sort/map 未包 useMemo（${heavy.length}）`, heavy.slice(0, 12), '每次渲染重排全表；行数上万时明显卡顿。'])

  // A5-3：useEffect 内 setState 且该 state 出现在依赖里 → 循环风险
  const loops = []
  for (const f of files) {
    const m = masked.get(f)
    for (const mm of m.matchAll(/useEffect\(/g)) {
      let d = 0, i = mm.index + 'useEffect'.length, started = false, end = i
      for (; i < m.length; i++) {
        if (m[i] === '(') { d++; started = true }
        else if (m[i] === ')') { d--; if (started && d === 0) { end = i; break } }
      }
      const body = m.slice(mm.index, end)
      const dep = body.match(/\[([^\]]*)\]\s*,?\s*$/)
      if (!dep) continue
      const deps = dep[1].split(',').map(s => s.trim()).filter(Boolean)
      const sets = [...body.matchAll(/set([A-Z]\w*)\(/g)].map(x => x[1])
      const clash = sets.filter(s => deps.some(d => new RegExp(`\\b${s}\\b`).test(d)))
      if (clash.length) loops.push(`${rel(f)}:${m.slice(0, mm.index).split('\n').length} → set${clash[0]} 在依赖里`)
    }
  }
  rep.push([`useEffect 自 feeding（${loops.length}）`, loops.slice(0, 12), 'set 的值又在依赖里 → 渲染→effect→setState→渲染。必须确认有终止条件。'])

  // A5-4：危险 API
  const danger = []
  for (const f of files) {
    const ls = masked.get(f).split(/\r?\n/)
    ls.forEach((l, i) => { if (/dangerouslySetInnerHTML/.test(l)) danger.push(`${rel(f)}:${i + 1}`) })
  }
  rep.push([`dangerouslySetInnerHTML（${danger.length}）`, danger.slice(0, 8), '作者正文/AI 产出直接进 DOM → XSS 面。确认前置 escape 或走纯文本渲染。'])

  // A5-5：catch 吞异常（静默失败）
  const swallow = []
  for (const f of files) {
    const m = masked.get(f)
    for (const mm of m.matchAll(/catch\s*\(([^)]*)\)\s*\{/g)) {
      const after = m.slice(mm.index + mm[0].length, mm.index + mm[0].length + 260)
      const bodyEnd = after.indexOf('}')
      const body = bodyEnd >= 0 ? after.slice(0, bodyEnd) : after
      if (!/\S/.test(body) || /^(?:\s*(console\.(warn|log|debug)|void|\/\*)[\s\S]*)$/.test(body)) {
        swallow.push(`${rel(f)}:${m.slice(0, mm.index).split('\n').length}`)
      }
    }
  }
  rep.push([`空 catch / 只 log 的 catch（${swallow.length}）`, swallow.slice(0, 12), '最有价值的一类：错误被吃掉 → 用户看到"没反应"，日志里也找不到。'])

  P(`\n── A5. React 低效与危险模式 ──`)
  for (const [title, list, why] of rep) {
    P(`  ▸ ${title}`)
    P(`     为什么值得查：${why}`)
    for (const x of list) P(`       · ${x}`)
    if (!list.length) P('       ✅ 无命中')
  }
}

console.log(out.join('\n'))
console.log('\n⚠️ 本脚本全部是候选清单：每一类都必须抽 3~5 条回源码确认再写进报告（验尸率教训：看着像的不一定是真的）。')
