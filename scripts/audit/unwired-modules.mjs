// 未接线模块扫描 · 结构化版（2026-11-18）
//
// 【要解决的问题】
// 死导出扫描（`dead-exports.mjs`）按**符号**统计，三个桶里 `test` 只是「只报数不列清单」。
// 于是「整个模块实现完整、单测齐全，但产品代码一次都没 import」这种形状**在报告里完全看不见**：
// 符号全都落在 test 桶里，统计平滑得像健康代码。
//
// 实测代价：2026-11-18 全量审计里，`revision/changeEvents`（235 行 · 有证据的后续影响提示）与
// `agentHost/modeAuthority`（模式切换持久化）**产品侧零 import**，只有单测在用 —— 而两者的
// 方案文档都写着「已完成」。报告是绿的，功能是不存在的。这类问题只能靠读 `graph` 的「扇入 0」
// 表用眼睛捞，捞不捞得到全看当天心情。
//
// 【判据】
// 一个 `src/**/*.ts(x)` 文件，若**没有任何生产代码 import 它**（自身除外、入口除外），
// 就是「未接线」。`export … from` 也算依赖（它确实需要目标存在才能编译）。
// 再补一个信息位：它被多少个 `tests/**` 文件 import —— 用来区分
// 「完全没人用」与「只为测试而活」。
//
// 【为什么不是自动删】
// 未接线有两种性质完全不同的东西：
//   · 能力缺口（gap）：按方案实现了，但入口没做 / 被别的机制取代 —— 删了等于扔掉方案；
//   · 度量夹具（harness）：评测集、基准脚本，本来就不该被产品 import。
// 所以本文件的输出是**候选 + 台账核对**：每条必须进 `unwired-ledger.json` 写明性质与理由，
// 否则自检失败（与死导出的 `dead-reviews.json` 同一套纪律）。

import fs from 'node:fs'
import path from 'node:path'
import { stripComments } from './source-text.mjs'
import { walkCode } from './dead-exports.mjs'

/**
 * 入口文件：没有 importers 是正常的（`index.html` 指向它）。
 * 🔴 新增入口必须登记，否则它会被当成「未接线」误报；反之删了入口忘了清名单，也会被台账失效检查抓出来。
 */
export const ENTRY_FILES = ['src/main.tsx', 'src/App.tsx']

/** 允许出现的台账状态（每种含义不同，报告里分别计数） */
export const LEDGER_STATUSES = ['gap', 'retained', 'harness', 'entry']

const toPosix = p => p.replaceAll('\\', '/')

/**
 * 解析一个 import 说明符到仓库内相对路径。
 *
 * 支持三种写法：`@/x`（项目别名，指向 `src/`）、`./x` / `../x`（相对），其余（第三方包）返回 null。
 * 目录入口按 TS 的解析顺序补 `index.ts(x)` —— 少了这一步，`@/lib/db`（实体是 `src/lib/db/index.ts`）
 * 之类的引用会被漏掉，把一整个目录误判成未接线。
 *
 * @param {string} fromRel 引用方（仓库相对路径，posix 风格）
 * @param {string} spec import 说明符
 * @param {(rel: string) => boolean} exists 判断仓库内某路径是否存在
 * @returns {string | null} 目标文件（仓库相对路径）或 null
 */
export function resolveImport(fromRel, spec, exists) {
  let base
  if (spec.startsWith('@/')) base = 'src/' + spec.slice(2)
  else if (spec.startsWith('./') || spec.startsWith('../')) {
    base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec))
  } else return null
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
  for (const c of candidates) if (exists(c)) return c
  return null
}

/**
 * 抽出一个文件里的全部模块说明符：静态 import / 再导出 / 动态 import() / require()。
 *
 * 🔴 先用 `stripComments` 剥注释：注释里写的 `from './x'`（示例、说明）不该算依赖。
 * 🔴 不用 `stripReexport`：再导出**是**依赖（目标不存在就编译不过），这里必须计入。
 */
export function importSpecifiers(text) {
  const out = []
  const src = stripComments(text)
  for (const m of src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
  for (const m of src.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
  return out
}

/**
 * 扫描未接线模块。
 *
 * @param {string} root 仓库根
 * @param {{ files?: string[], testFiles?: string[], readFile?: (f: string) => string }} [opts]
 *        `files` / `testFiles` 供单测注入（绝对路径）
 */
export function scanUnwiredModules(root, opts = {}) {
  const readFile = opts.readFile ?? (f => fs.readFileSync(path.join(root, f), 'utf8'))
  const rel = abs => toPosix(path.relative(root, abs))

  const files = (opts.files ?? walkCode(path.join(root, 'src')))
    .map(f => (path.isAbsolute(f) ? rel(f) : toPosix(f)))
    .filter(f => /\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f))
  const fileSet = new Set(files)
  /**
   * 🔴 解析目标必须落在**文件集合**里，不能用 `fs.existsSync`：
   *    后者对目录也返回 true，于是 `@/lib/ai` 会先命中目录 `src/lib/ai/`（门面 `ai.ts` 的兄弟目录），
   *    被当成"目标不存在"跳过 —— 实测会把 `lib/ai.ts` / `lib/db.ts` / `lib/help/index.ts`
   *    这三个门面误报成未接线。
   */
  const exists = rel => fileSet.has(rel)

  /** target -> 引用它的生产文件集合 */
  const importers = new Map()
  for (const f of files) {
    const text = readFile(f)
    for (const spec of importSpecifiers(text)) {
      const target = resolveImport(f, spec, exists)
      if (!target || !fileSet.has(target) || target === f) continue
      if (!importers.has(target)) importers.set(target, new Set())
      importers.get(target).add(f)
    }
  }

  // 测试侧引用（只为区分「完全没人用」与「只为测试而活」；不参与判定）
  const testFiles = (opts.testFiles ?? walkCode(path.join(root, 'tests')))
    .map(f => (path.isAbsolute(f) ? rel(f) : toPosix(f)))
    .filter(f => /\.(ts|tsx|mjs)$/.test(f))
  const testImporters = new Map()
  for (const f of testFiles) {
    let text
    try { text = readFile(f) } catch { continue }
    for (const spec of importSpecifiers(text)) {
      // 测试里的 `../src/lib/x` / `@/lib/x` 都要能解到 src 下
      let target = null
      if (spec.startsWith('../src/') || spec.startsWith('./src/')) {
        target = resolveImport('src/_probe.ts', './' + spec.slice(spec.indexOf('src/') + 4), exists)
      }
      if (!target) target = resolveImport('src/_probe.ts', spec, exists)
      if (!target || !fileSet.has(target)) continue
      if (!testImporters.has(target)) testImporters.set(target, new Set())
      testImporters.get(target).add(f)
    }
  }

  const findings = []
  let wired = 0
  for (const f of files) {
    const prod = importers.get(f)?.size ?? 0
    if (prod > 0) { wired++; continue }
    if (ENTRY_FILES.includes(f)) continue
    const t = testImporters.get(f)?.size ?? 0
    findings.push({
      rule: 'wired.missing',
      confidence: 'review',
      file: f,
      line: 1,
      testImporters: t,
      message: t > 0
        ? `模块没有生产代码 import（只有 ${t} 个测试文件在用）：实现完整但没接入口，或是度量夹具`
        : '模块没有任何 import（生产与测试都没有）：要么是准备中的新模块，要么是可以删的遗留',
    })
  }
  findings.sort((a, b) => a.file.localeCompare(b.file))

  return {
    findings,
    stats: {
      files: files.length,
      wired,
      unwired: findings.length,
      testOnly: findings.filter(f => f.testImporters > 0).length,
    },
  }
}

/**
 * 台账校验：每条必须指向真实文件、状态合法、理由写够长度。
 *
 * 🔴 理由长度门槛与 `dead-reviews.json` 一致（≥20 字）：这个台账的全部价值就是
 *    「下次别再重新想一遍」，一句话敷衍等于没写。
 */
export function validateUnwiredLedger(entries, exists) {
  const issues = []
  if (!Array.isArray(entries)) return { ok: false, issues: ['台账 entries 不是数组'] }
  const seen = new Set()
  for (const e of entries) {
    if (!e || typeof e !== 'object') { issues.push('存在非对象条目'); continue }
    if (typeof e.file !== 'string' || !e.file.startsWith('src/')) {
      issues.push(`file 非法：${JSON.stringify(e.file)}`)
      continue
    }
    if (seen.has(e.file)) issues.push(`重复登记：${e.file}`)
    seen.add(e.file)
    if (!LEDGER_STATUSES.includes(e.status)) {
      issues.push(`${e.file} 的 status「${String(e.status)}」不在 ${LEDGER_STATUSES.join('/')} 内`)
    }
    if (typeof e.reason !== 'string' || e.reason.trim().length < 20) {
      issues.push(`${e.file} 的理由太短（<20 字），等于没写`)
    }
    if (exists && !exists(e.file)) issues.push(`${e.file} 已不存在（登记未清理）`)
  }
  return { ok: issues.length === 0, issues }
}

/**
 * 台账与实测对账：返回 { unregistered, stale }。
 *   · unregistered —— 实测未接线但没登记（新增缺口，必须当场定性质）
 *   · stale        —— 登记了但现在已被接线/文件已删（台账过期，会慢慢变成谎言）
 */
export function reconcileUnwiredLedger(findings, entries) {
  const listed = new Set((entries ?? []).map(e => e.file))
  const found = new Set(findings.map(f => f.file))
  const unregistered = [...found].filter(f => !listed.has(f)).sort()
  const stale = [...listed].filter(f => !found.has(f) && !ENTRY_FILES.includes(f)).sort()
  return { unregistered, stale }
}
