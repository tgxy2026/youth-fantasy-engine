#!/usr/bin/env node
// 审计工具自检（3.4.1）—— 专治「搬文件 / 改目录后扫描器静默失明」。
//
// 背景：审计规则里有大量**写死的登记路径**（contracts.json 的 charts、policy.json 的
// flagSources / sidecars，以及 scan.mjs / source.mjs 里写死的文件名）。文件一旦被搬走或改名，
// 扫描器不会报错，只会「什么都扫不到」⇒ 0 findings ⇒ 看起来像绿灯。历史上吃过这个亏。
// 本模块在每次审计开场核对登记项与真实源码，失败即 block，绝不允许报 complete。
//
// 分层：纯数据校验在 registry-check.mjs（零 typescript 依赖，单测可直接 import）；
//       本文件负责组装真实配置、AST 侧的白名单符号核对与命令行入口。
// 纪律：只读源码与配置，不执行业务代码、不联网、不写用户数据、不改 sourceFingerprint 语义。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanAst } from './ast.mjs'
import { parse, initializer } from './platform/source.mjs'
import {
  validateRegistry, countSourceFiles, toolFingerprint, staleToolHints,
  validateDebtBudget, validateScannerRegistry,
} from './registry-check.mjs'
import { scanDeadExports, staleDeadReviews, validateDeadReviews } from './dead-exports.mjs'

export { validateRegistry, toolFingerprint }

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** 组装层：读真实配置 → 复用已算好的 scanAst 结果 → 追加 sidecar 符号核对 */
export function auditSelfCheck(root = DEFAULT_ROOT, options = {}) {
  const readJson = rel => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))
  const contracts = options.contracts ?? readJson('scripts/audit/contracts.json')
  const policy = options.policy ?? readJson('scripts/audit/platform/policy.json')
  const pkg = options.pkg ?? readJson('package.json')
  const staticResult = options.staticResult ?? scanAst(root, contracts)
  const result = validateRegistry({
    contracts, policy,
    exists: file => fs.existsSync(path.join(root, file)),
    srcFileCount: options.srcFileCount ?? countSourceFiles(path.join(root, 'src')),
    staticFiles: staticResult.files,
  })

  // 白名单常量被改名后，platform 扫描只会少一项而不会报错 ⇒ 这里显式核对符号仍可解析。
  if (!options.skipSymbols) for (const [i, entry] of (policy.sidecars ?? []).entries()) {
    const file = path.join(root, entry.file)
    let found = false
    if (fs.existsSync(file)) found = !!initializer(parse(entry.file, fs.readFileSync(file, 'utf8')), entry.symbol)
    result.checks.push({ name: `sidecar 符号 ${entry.symbol}`, status: found ? 'passed' : 'failed', detail: entry.file })
    if (!found) result.issues.push(`sidecar[${i}] ${entry.file} 中找不到 ${entry.symbol} 的变量声明`)
  }

  /**
   * 3.6.0 · 审计补盲（2026-11-17）：三件以前**没人守**的事。
   *
   * ① 扫描器清单一致性：`run.mjs` 的 legacyNames 是手写数组，新增/删除扫描器时两边会漂。
   * ② 死导出复核清单：格式与「是否还指向真实导出」——符号改名后旧复核会静默失效。
   * ③ 死导出欠账预算：历史欠账可以留，但**只能减少不能变多**（新增死代码立刻挡）。
   */
  const runSrc = fs.existsSync(path.join(root, 'scripts/audit/run.mjs'))
    ? fs.readFileSync(path.join(root, 'scripts/audit/run.mjs'), 'utf8') : ''
  const listed = /const legacyNames = \[([^\]]*)\]/.exec(runSrc)
  const runNames = listed ? [...listed[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : []
  const legacyDir = path.join(root, 'scripts/audit/legacy')
  const dirNames = fs.existsSync(legacyDir)
    ? fs.readdirSync(legacyDir).filter(n => /^audit-.+\.mjs$/.test(n)).map(n => n.replace(/^audit-/, '').replace(/\.mjs$/, ''))
    : []
  const scanners = validateScannerRegistry({ dirNames, runNames })
  result.checks.push(...scanners.checks)
  result.issues.push(...scanners.issues)

  const readJsonFile = rel => {
    try { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')) } catch { return null }
  }
  const deadReviews = options.deadReviews ?? readJsonFile('scripts/audit/dead-reviews.json')?.entries ?? null
  const reviewShape = validateDeadReviews(deadReviews ?? [])
  result.checks.push({
    name: '死导出复核清单有效',
    status: deadReviews && reviewShape.ok ? 'passed' : 'failed',
    detail: deadReviews ? (reviewShape.ok ? `${deadReviews.length} 条` : reviewShape.issues.join('; ')) : 'scripts/audit/dead-reviews.json 缺失或不可解析',
  })
  if (!deadReviews || !reviewShape.ok) {
    result.issues.push(`死导出复核清单无效：${deadReviews ? reviewShape.issues.join('; ') : '文件缺失或不可解析'}`)
  }
  if (deadReviews) {
    const stale = staleDeadReviews(deadReviews, root)
    result.checks.push({
      name: '死导出复核未失效',
      status: stale.length ? 'failed' : 'passed',
      detail: stale.length ? stale.map(x => `${x.file}:${x.symbol}（${x.why}）`).join(', ') : `${deadReviews.length} 条均指向现存导出`,
    })
    if (stale.length) result.issues.push(`死导出复核有 ${stale.length} 条已失效（符号被删/改名）：${stale.map(x => x.symbol).join(', ')}`)
  }

  const deadScan = options.deadScan ?? scanDeadExports(root)
  const reviewedKeys = new Set((deadReviews ?? []).map(e => `${e.file}:${e.symbol}`))
  const deadFindings = deadScan.findings.filter(f => f.rule === 'dead.export')
  const openDead = deadFindings.filter(f => !reviewedKeys.has(`${f.file}:${f.symbol}`))
  const budget = options.budget ?? readJsonFile('scripts/audit/debt-budget.json')
  const debt = validateDebtBudget({
    budget, actual: openDead.length, reviewed: deadFindings.length - openDead.length,
  })
  result.checks.push(...debt.checks)
  result.issues.push(...debt.issues)

  // 3.4.1 第二轮：工具输出给用户的命令提示不能指向不存在的脚本（tmp 不入库）。
  const stale = options.staleHints ?? staleToolHints(root)
  result.checks.push({
    name: '工具提示路径有效',
    status: stale.length ? 'failed' : 'passed',
    detail: stale.length ? stale.map(h => `${h.file}:${h.line} → ${h.target}`).join(', ') : '0 处失效提示',
  })
  if (stale.length) result.issues.push(`审计工具输出了 ${stale.length} 处失效脚本路径提示：${stale.map(h => h.target).join(', ')}`)

  result.ok = result.issues.length === 0

  return {
    ...result,
    appVersion: pkg.version ?? 'unknown',
    toolFingerprint: options.toolFingerprint ?? toolFingerprint(root),
    files: staticResult.files,
    inventory: staticResult.inventory,
    deadExports: {
      ...deadScan.stats,
      reviewed: deadFindings.length - openDead.length,
      open: openDead.length,
      openItems: openDead.map(f => ({ file: f.file, line: f.line, symbol: f.symbol, kind: f.kind, rule: f.rule })),
    },
  }
}

// 独立入口：node scripts/audit/self-check.mjs（被 import 时不触发）
const invoked = process.argv[1] ? path.resolve(process.argv[1]).replaceAll('\\', '/').toLowerCase() : ''
const selfPath = fileURLToPath(import.meta.url).replaceAll('\\', '/').toLowerCase()
if (invoked && invoked === selfPath) {
  const r = auditSelfCheck()
  for (const c of r.checks) console.log(`[${c.status}] ${c.name}${c.detail ? ' — ' + c.detail : ''}`)
  console.log(`\nSelf-check ${r.ok ? 'PASSED' : 'FAILED'}: ${r.checks.length} checks; app v${r.appVersion}; tool ${r.toolFingerprint.slice(0, 12)}; ${r.files} scanned files`)
  process.exitCode = r.ok ? 0 : 1
}
