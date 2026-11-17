// 结构类结构化检查（2026-11-18 · 审计策略化第二轮）
//
// 上一轮把「死导出」从日志搬进了报告。这一轮补两件**判据客观、误报极低**的结构约束：
//   ① `arch.reverse-import` —— 非 UI 层反向依赖 UI 层（分层被打破，后面会连锁烂）；
//   ② `arch.facade-undeclared` —— 只做再导出却没登记的门面文件（该删的没删 / 该登记的没登记）。
//
// 🔴 为什么挑这两条：它们**不含启发式**（不靠"看起来像"），命中即可判定，所以能直接进报告、
//    并且可以按「预期长期为 0」来卡预算——一旦出现就说明有人引入了新的分层破坏。
//    相比之下「近似重复模块」「重复 className」这类靠相似度的规则仍留在旧脚本日志里，
//    它们必须人工抽样，硬塞进报告只会制造噪音。
//
// 🔴 与旧脚本的关系：`legacy/audit-arch.mjs` 的 A1/A2/A3 是**人读的排查报告**（含判读建议）；
//    本文件只做「可量化验收」的那两条。两者判据如果哪天不一致，以本文件为准并在旧脚本注明。

import fs from 'node:fs'
import path from 'node:path'
import { walkCode } from './dead-exports.mjs'
import { stripComments } from './source-text.mjs'

/**
 * 已声明门面（整文件只做再导出的入口）。
 *
 * 🔴 登记纪律：**必须写清为什么它是门面**。门面是设计（对外契约稳定、调用方零改动），
 *    不是债；但没登记的门面会被人当"冗余转发层"删掉，一删就是 69 个调用方一起炸。
 * 🔴 白名单里的文件**若不存在**，自检必须失败（防删了文件忘清名单，名单变成谎言）。
 */
export const DECLARED_FACADES = [
  {
    file: 'src/lib/db.ts',
    reason: '2026-09-19 D2 存储层门面：实体在 src/lib/db/ 的 10 个域模块，此文件只做再导出，69 个调用方零改动',
  },
  {
    file: 'src/lib/ai/aiTasks.ts',
    reason: '3.0 G3 门面：实体在 src/lib/aiTasks/，此文件负责对外契约与 PROMPT_ORDER 注册',
  },
]

/** 非 UI 层：这些目录里的代码不该认识界面 */
export const NON_UI_DIRS = ['src/lib/', 'src/data/']

/**
 * 抽出一段源码里的 import 说明（去掉注释后按行扫）。
 * 🔴 不能用 AST 的理由：这些规则只看「谁 import 了谁」，正则足够且更快；
 *    但**必须剥注释**——注释里举例的 `import ... from '@/components/x'` 会变成假命中（历史踩过）。
 */
function importLines(text) {
  const out = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    // 多行 import（`import {\n  a,\n} from '...'`）：命中带 from 的那一行即可，仍能定位到文件
    const m = /^\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/.exec(lines[i])
      ?? /^\s*import\s*['"]([^'"]+)['"]/.exec(lines[i])
    if (m) out.push({ spec: m[1], line: i + 1 })
  }
  return out
}

/** 把 import 说明解析成「是否指向 src/components」——支持别名 @/ 与相对路径 */
function pointsToUi(file, spec) {
  if (spec.startsWith('@/components/')) return true
  if (spec.startsWith('@/App')) return true
  if (!spec.startsWith('.')) return false
  // 相对路径：按定义文件所在目录解析，看是否落进 src/components
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec))
  return resolved.startsWith('src/components/') || resolved === 'src/App' || resolved.startsWith('src/App.')
}

/**
 * 扫描结构约束。
 *
 * @param root 仓库根
 * @param opts.files 注入文件列表（单测用，相对仓库根的 posix 路径）
 * @param opts.readFile 注入读取函数（单测用）
 */
export function scanStructure(root, opts = {}) {
  const readFile = opts.readFile ?? (f => fs.readFileSync(f, 'utf8'))
  /** @type {{ rel: string, abs: string }[]} */
  const files = opts.files
    ? opts.files.map(p => ({ rel: p, abs: path.join(root, p) }))
    : walkCode(path.join(root, 'src')).map(f => ({ rel: path.relative(root, f).replaceAll('\\', '/'), abs: f }))

  /** @type {import('./structure-checks.d.mts').StructureFinding[]} */
  const findings = []
  const facadeSet = new Set(DECLARED_FACADES.map(f => f.file))
  let reverseImports = 0
  let undeclaredFacades = 0

  for (const { rel, abs } of files) {
    if (!rel.startsWith('src/')) continue
    const text = stripComments(readFile(abs))
    const lines = text.split(/\r?\n/)

    // ① 反向依赖：非 UI 层 import UI 层
    if (NON_UI_DIRS.some(d => rel.startsWith(d))) {
      for (const imp of importLines(text)) {
        if (!pointsToUi(rel, imp.spec)) continue
        reverseImports++
        findings.push({
          rule: 'arch.reverse-import', confidence: 'review', file: rel, line: imp.line,
          message: `非 UI 层引用界面层：\`${rel}\` → \`${imp.spec}\`；`
            + '把界面依赖下沉成参数/回调，或把共用逻辑提到 lib（否则 lib 会反向长成半个 UI）',
        })
      }
    }

    // ② 未登记门面：几乎整文件都是再导出
    const nonEmpty = lines.filter(l => l.trim()).length
    if (nonEmpty > 0 && nonEmpty <= 40 && !facadeSet.has(rel)) {
      const forwarded = lines.filter(l => /^\s*export\s+(?:\*|\{[^}]*\})\s+from\s*['"]/.test(l)).length
      if (forwarded / nonEmpty >= 0.6) {
        undeclaredFacades++
        findings.push({
          rule: 'arch.facade-undeclared', confidence: 'review', file: rel, line: 1,
          message: `整文件 ${forwarded}/${nonEmpty} 行是再导出但未登记为门面：`
            + '确认是否该删（直接用实体模块）或登记进 DECLARED_FACADES 并写明理由',
        })
      }
    }
  }

  return {
    findings,
    stats: { files: files.filter(f => f.rel.startsWith('src/')).length, reverseImports, undeclaredFacades },
  }
}

/**
 * 门面名单自洽校验（纯逻辑）：登记了但文件不存在 ⇒ 名单变成谎言。
 * 与死导出复核同一个道理：**白名单自己也会失效**，必须有人检查它还指向真实文件。
 */
export function validateFacadeRegistry(facades, exists) {
  /** @type {string[]} */
  const issues = []
  for (const f of facades ?? []) {
    if (typeof f.file !== 'string' || !f.file.startsWith('src/')) issues.push(`门面登记路径非法：${f.file}`)
    if (typeof f.reason !== 'string' || f.reason.trim().length < 10) issues.push(`门面 ${f.file} 缺理由（至少 10 字，写清为什么它是设计而非债）`)
    if (!exists(f.file)) issues.push(`门面登记了但文件不存在：${f.file}`)
  }
  return { ok: issues.length === 0, issues }
}
