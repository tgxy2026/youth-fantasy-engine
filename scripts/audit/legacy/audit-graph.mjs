process.env.YFE_AUDIT_FULL ??= '1'
// 模块依赖图分析：循环依赖 / 扇入扇出 / 分层违规
import fs from 'node:fs'
import path from 'node:path'

const ROOT = (process.argv[2] || 'G:/AI软件/youth-fantasy-engine开发源码').replace(/\\/g, '/')
const SRC = path.join(ROOT, 'src')

/**
 * 剥离注释（`//` 行注释 + 块注释，含 JSX 的 `{/* *\/}`），保留行结构。
 * 🔴 不剥注释会**凭空造出假的循环依赖**：本项目 Modal.tsx 的注释里就写着示例
 * `import { Z } from './Modal'`（2026-09-17 实测），被当成自环上报过。
 * 字符串/模板串保留内容（动态 import('…') 的路径就在字符串里）。
 */
function stripComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  let st = 'code' // code | line | block | sq | dq | tpl
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

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

const files = walk(SRC).map(f => path.resolve(f))
const set = new Set(files)
const rel = f => path.relative(ROOT, f).replace(/\\/g, '/')

// 解析 import：支持相对路径 + `@/` 别名；同时记录「这条边是不是纯类型边」
// 🔴 为什么要记：`import type` 编译后即消失，运行时不产生依赖边。只按语法边找环，会把
//    「为共用声明而互相 type 引用」的正当写法报成环（本项目已有一例：aiTasks ↔ flow/fieldMap）。
//    闸（tests/importCycles.test.ts 的 stripTypeOnlyImports）擦类型边；这里**不擦、只标注**，
//    既能看到全量图，又不会被假环吓到。
// 🔴🔴 2026-10-14 修「工具失明」：本脚本原先**只认相对路径**（`./x` / `../x`）。3.0 G3 重组后
//    `src/` 全面改用 `@/` 别名（tsconfig `paths: {"@/*": ["src/*"]}`、vite alias 同源），
//    于是解析不到任何边 ⇒ **整张依赖图变空**，表现为「扇入/扇出全是 0」「循环依赖 0 组」
//    这两句话看着像"很干净"，其实是**假阴性**。真闸 tests/importCycles.test.ts 有自己的
//    `@/` 自检，早就覆盖了这条；本脚本与它口径必须一致，否则报告会自相矛盾。
const ALIAS_ROOT = path.resolve(ROOT, 'src') // 与 tsconfig 的 `@/* → src/*` 保持一致
const importsOf = new Map()
const edgeTypeOnly = new Map() // 'from|to' → true 表示该边为纯类型边
for (const f of files) {
  const t = stripComments(fs.readFileSync(f, 'utf8')) // 🔴 先剥注释，否则注释里的示例 import 会造出假边/假环
  const deps = new Map() // dep → 'value' | 'type'（同一条边既有值又有类型时取 'value'）
  const dir = path.dirname(f)
  const mark = (spec, isType) => {
    const base = spec.startsWith('@/')
      ? path.resolve(ALIAS_ROOT, spec.slice(2))
      : path.resolve(dir, spec)
    for (const cand of [base, base + '.ts', base + '.tsx', path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
      if (set.has(cand)) {
        deps.set(cand, !isType || deps.get(cand) === 'value' ? 'value' : 'type')
        break
      }
    }
  }
  // ① `... from './x'` / `from '@/x'`（含跨行 import）—— 需回溯判整条语句是否 type-only
  const fromRe = /from\s*['"](\.\.?\/[^'"]+|@\/[^'"]+)['"]/g
  let m
  while ((m = fromRe.exec(t))) {
    const back = t.slice(Math.max(0, m.index - 300), m.index)
    const im = back.lastIndexOf('import')
    let isType = false
    if (im >= 0) {
      const seg = back.slice(im)
      if (/^import\s+type\b/.test(seg)) isType = true
      else {
        const br = seg.match(/^import\s*\{([^}]*)\}\s*$/)
        if (br) {
          const specs = br[1].split(',').map(s => s.trim()).filter(Boolean)
          if (specs.length > 0 && specs.every(s => /^type\s+/.test(s))) isType = true
        }
      }
    }
    mark(m[1], isType)
  }
  // ② 动态 import('./x') / import('@/x') —— 一定是运行时边
  const dynRe = /import\s*\(\s*['"](\.\.?\/[^'"]+|@\/[^'"]+)['"]/g
  while ((m = dynRe.exec(t))) mark(m[1], false)
  // ③ 副作用 import './x' / import '@/x' —— 运行时边
  const sideRe = /\bimport\s*['"](\.\.?\/[^'"]+|@\/[^'"]+)['"]/g
  while ((m = sideRe.exec(t))) mark(m[1], false)
  importsOf.set(f, [...deps.keys()])
  for (const [k, v] of deps) edgeTypeOnly.set(f + '|' + k, v === 'type')
}

const out = []

// 循环依赖：DFS 找简单环（去重）
const cycles = []
const seenCycle = new Set()
{
  const stack = []
  const inStack = new Set()
  const visited = new Set()
  const dfs = (n) => {
    visited.add(n); inStack.add(n); stack.push(n)
    for (const d of importsOf.get(n) ?? []) {
      if (inStack.has(d)) {
        const i = stack.indexOf(d)
        const cyc = stack.slice(i)
        const key = [...cyc].sort().join('|')
        if (!seenCycle.has(key)) { seenCycle.add(key); cycles.push(cyc) }
      } else if (!visited.has(d)) dfs(d)
    }
    stack.pop(); inStack.delete(n)
  }
  for (const f of files) if (!visited.has(f)) dfs(f)
}

out.push(`# 模块依赖分析\n`)
out.push(`## 1. 🔴 循环依赖（${cycles.length} 组）\n`)
out.push('  判读：这里统计的是**语法边**（含 type-only）。`import type` 编译后即消失、运行时不产生依赖，')
out.push('  所以环上只要有一条 type-only 边，编译后环就断开 → 运行时不成立（闸 tests/importCycles.test.ts 会擦掉类型边再看）。')
out.push('  这里不擦只标注，便于看到全量图；真正要在意的是**全是运行时边**的环。')
if (!cycles.length) out.push('（无）')
for (const c of cycles) {
  const tEdges = []
  for (let i = 0; i < c.length; i++) {
    const a = c[i], b = c[(i + 1) % c.length]
    if (edgeTypeOnly.get(a + '|' + b)) tEdges.push(`${rel(a)} → ${rel(b)}`)
  }
  out.push(`- ${c.map(rel).join(' → ')} → ${rel(c[0])}`)
  if (tEdges.length) {
    out.push(`    ↳ type-only 边：${tEdges.join('、')}`)
    out.push('    ↳ ✅ 环上存在 type-only 边 → 编译后该边消失、环断开，**运行时不成立**（闸已按类型豁免），无需处理')
  } else {
    out.push('    ↳ 🔴 全是运行时边 → **真环**，必须处理')
  }
}
out.push('')

// 扇入（被多少个文件 import）
const fanIn = new Map(files.map(f => [f, 0]))
for (const [f, deps] of importsOf) for (const d of deps) fanIn.set(d, (fanIn.get(d) ?? 0) + 1)

out.push(`## 2. 扇入最高的 25 个模块（被依赖最多 = 变更风险最高）\n`)
out.push(`| 被引用次数 | 文件 |`)
out.push(`|---|---|`)
for (const [f, n] of (process.env.YFE_AUDIT_FULL === '1' ? [...fanIn.entries()].sort((a, b) => b[1] - a[1]) : [...fanIn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25))) {
  if (n > 0) out.push(`| ${n} | ${rel(f)} |`)
}
out.push('')

// 扇出
out.push(`## 3. 扇出最高的 20 个模块（依赖最多 = 最耦合）\n`)
out.push(`| 依赖数 | 文件 |`)
out.push(`|---|---|`)
for (const [f, deps] of (process.env.YFE_AUDIT_FULL === '1' ? [...importsOf.entries()].sort((a, b) => b[1].length - a[1].length) : [...importsOf.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 20))) {
  out.push(`| ${deps.length} | ${rel(f)} |`)
}
out.push('')

// 孤立模块（ts/tsx，扇入 0 且不是入口）
out.push(`## 4. 扇入 0 的模块（没人 import；入口文件除外）\n`)
const entryLike = /(^|\/)(main|App|vite-env\.d)\.tsx?$|\.d\.ts$/
const orphans = [...fanIn.entries()].filter(([f, n]) => n === 0 && !entryLike.test(rel(f)))
if (!orphans.length) out.push('（无）')
for (const [f] of orphans) out.push(`- ${rel(f)}`)
out.push('')

// 分层违规：非 UI 层不该 import components
out.push(`## 5. 分层违规检查\n`)
// ⚠️ 这是「非 UI 层」白名单，新增平级数据/资源目录时**必须同步登记**（2026-09-19 加 src/data/）。
//    漏登记不会报错 —— 只会让新目录的分层违规**静默漏检**。
const NO_UI_DIRS = ['src/lib/', 'src/data/']
const violations = []
for (const [f, deps] of importsOf) {
  const fr = rel(f)
  for (const d of deps) {
    const dr = rel(d)
    if (NO_UI_DIRS.some(p => fr.startsWith(p)) && dr.startsWith('src/components/')) violations.push(`${fr} → ${dr}`)
  }
}
out.push(`- 非 UI 层（${NO_UI_DIRS.join(' / ')}）反向依赖 components/：${violations.length ? '' : '（无）'}`)
for (const v of violations) out.push(`  - ${v}`)
out.push('')

const text = out.join('\n')
fs.writeFileSync(path.join(ROOT, '.workbuddy/tmp/dep-graph-report.md'), text, 'utf8')
console.log(text)
