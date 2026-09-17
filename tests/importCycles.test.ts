// ============ 静态闸：禁止 src/ 内出现循环依赖 ============
//
// 为什么要单独立一道闸：**TS 与测试都不报**循环依赖 —— 只有当环里的求值顺序恰好让一个
// `const` 在被赋值前被读到，才会在**浏览器**里以 TDZ 形式炸掉：
//     ReferenceError: Cannot access 'DESKTOP' before initialization
//
// 2026-09-18 实测踩过一次：给 `desktop.ts` 加了一行 `import { isDesktopCloudEnabled }
// from './desktopCloudSync'`，凑出 `desktop → desktopCloudSync → env → desktop` 的环
// （`env.ts` 反过来 `import { DESKTOP } from './desktop'`）。
// 当时 **tsc 0 error + 47 个测试入口全绿**，实机脚本一跑就崩在模块求值期。
// 这类问题只能靠静态分析锁死 —— 所以这道闸不查逻辑，只查依赖图。
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 找 src 根目录：优先 cwd/src，其次 cwd/../src（构建产物可能落在 tests/ 下） */
function findSrc(): string | null {
  for (const c of [path.join(process.cwd(), 'src'), path.join(process.cwd(), '..', 'src')]) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c
  }
  return null
}

const SRC = findSrc()

/**
 * 剥离注释（`//` 行注释 + 块注释），保留行结构。
 * 🔴 不剥注释会**凭空造出假的循环依赖**：本项目 Modal.tsx 的注释里就写着示例
 * `import { Z } from './Modal'`（2026-09-17 实测被当成自环上报过）。
 */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  let st: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code'
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

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

console.log('—— importCycles：src/ 循环依赖静态闸 ——')

if (!SRC) {
  ok('找到 src 目录', false, 'cwd=' + process.cwd())
} else {
  const files = walk(SRC).map(f => path.resolve(f))
  const set = new Set(files)
  const rel = (f: string) => path.relative(path.dirname(SRC), f).replace(/\\/g, '/')

  const importsOf = new Map<string, string[]>()
  for (const f of files) {
    const t = stripComments(fs.readFileSync(f, 'utf8'))
    const deps = new Set<string>()
    // 兼容跨行 import：只认 `from '...'` 与动态 `import('...')`，且只认相对路径
    const re = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(t))) {
      const base = path.resolve(path.dirname(f), m[1])
      for (const cand of [base, base + '.ts', base + '.tsx', path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
        if (set.has(cand)) { deps.add(cand); break }
      }
    }
    importsOf.set(f, [...deps])
  }

  ok('扫描到源文件', files.length > 100, String(files.length))

  // DFS 找环（去重）
  const cycles: string[][] = []
  const seenCycle = new Set<string>()
  {
    const stack: string[] = []
    const inStack = new Set<string>()
    const visited = new Set<string>()
    const dfs = (n: string) => {
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

  ok('🔴 src/ 内无循环依赖（有环 = 浏览器里可能 TDZ 崩，见本文件顶部说明）',
    cycles.length === 0,
    cycles.map(c => c.map(rel).join(' → ') + ' → ' + rel(c[0])).join('  ｜  '))

  // 顺带锁住那条最隐蔽的方向：lib 不得反向依赖 components（分层红线）
  const layering: string[] = []
  for (const [f, deps] of importsOf) {
    const fr = rel(f)
    for (const d of deps) {
      const dr = rel(d)
      if (fr.startsWith('src/lib/') && dr.startsWith('src/components/')) layering.push(`${fr} → ${dr}`)
    }
  }
  ok('lib/ 不反向依赖 components/', layering.length === 0, layering.slice(0, 3).join(' ｜ '))
}

console.log(`\nimportCycles: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
