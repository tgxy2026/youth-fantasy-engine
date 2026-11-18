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
  validateDebtBudget, validateScannerRegistry, validateStructureBudget,
  validateCoverageLedger,
} from './registry-check.mjs'
import { scanDeadExports, staleDeadReviews, validateDeadReviews, walkCode } from './dead-exports.mjs'
import { DECLARED_FACADES, scanStructure, validateFacadeRegistry } from './structure-checks.mjs'
import { PROVIDERS, scanStaleCache, validateProviders } from './stale-cache.mjs'
import { scanDuplicateImpls } from './duplicate-impl.mjs'
import { ENTRY_FILES, reconcileUnwiredLedger, scanUnwiredModules, validateUnwiredLedger } from './unwired-modules.mjs'

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
  /**
   * 结构约束（2026-11-18）：反向依赖与未登记门面，**预期长期为 0**。
   * 这两条判据客观、不含启发式，所以出现即失败，不留预算余量。
   * 门面名单本身也要自洽——登记了却不存在，名单就变成谎言。
   */
  const structure = options.structure ?? scanStructure(root)
  const facadeCheck = validateFacadeRegistry(DECLARED_FACADES, f => fs.existsSync(path.join(root, f)))
  result.checks.push({
    name: '门面名单自洽',
    status: facadeCheck.ok ? 'passed' : 'failed',
    detail: facadeCheck.ok ? `${DECLARED_FACADES.length} 个已声明门面均在位` : facadeCheck.issues.join('; '),
  })
  result.issues.push(...facadeCheck.issues)
  /**
   * 未接线模块（2026-11-18）：整个模块没有任何生产代码 import。
   *
   * 为什么必须单独一条：死导出按**符号**统计，`test` 桶只报数不列清单，于是
   * 「实现完整、单测齐全、产品一次都没用」的模块在报告里完全看不见（实测：changeEvents 235 行、
   * modeAuthority 51 行都是这种形状，只有读 graph 扇入表才能用眼睛捞）。
   * 三条检查分别拦：台账写得敷衍 / 新增未接线没定性质 / 台账过期变成谎言。
   */
  const unwiredLedgerFile = readJsonFile('scripts/audit/unwired-ledger.json')
  const unwiredEntries = options.unwiredLedger ?? unwiredLedgerFile?.entries ?? null
  const unwiredCheck = validateUnwiredLedger(unwiredEntries ?? [], f => fs.existsSync(path.join(root, f)))
  result.checks.push({
    name: '未接线台账有效',
    status: unwiredEntries && unwiredCheck.ok ? 'passed' : 'failed',
    detail: unwiredEntries
      ? (unwiredCheck.ok ? `${unwiredEntries.length} 条（状态与理由齐全）` : unwiredCheck.issues.join('; '))
      : 'scripts/audit/unwired-ledger.json 缺失或不可解析',
  })
  if (!unwiredEntries || !unwiredCheck.ok) {
    result.issues.push(`未接线台账无效：${unwiredEntries ? unwiredCheck.issues.join('; ') : '文件缺失或不可解析'}`)
  }

  const unwired = options.unwired ?? scanUnwiredModules(root)
  if (unwiredEntries) {
    const recon = reconcileUnwiredLedger(unwired.findings, unwiredEntries)
    result.checks.push({
      name: '未接线模块已登记',
      status: recon.unregistered.length ? 'failed' : 'passed',
      detail: recon.unregistered.length
        ? recon.unregistered.map(f => `${f}（新增未接线，请在 unwired-ledger.json 定性质：gap / retained / harness）`).join(', ')
        : `${unwired.findings.length} 个未接线模块全部已登记`,
    })
    if (recon.unregistered.length) {
      result.issues.push(`未接线模块有 ${recon.unregistered.length} 个未登记：${recon.unregistered.join(', ')}`)
    }
    result.checks.push({
      name: '未接线台账未失效',
      status: recon.stale.length ? 'failed' : 'passed',
      detail: recon.stale.length
        ? recon.stale.map(f => `${f}（已接线或已删，登记该清了）`).join(', ')
        : `${unwiredEntries.length} 条均仍为未接线`,
    })
    if (recon.stale.length) {
      result.issues.push(`未接线台账有 ${recon.stale.length} 条已失效：${recon.stale.join(', ')}`)
    }
  }

  /**
   * 零覆盖台账（2026-11-18）：覆盖率报告里「零测试提及」且属安全/数据/算法类的文件，
   * 能低成本补测的已补，其余必须留下**风险 + 触发条件**，不能只是"没测"。
   * 失效检查：某文件后来被测试提到了，就该移出台账（否则台账会变成过时的借口）。
   */
  const covLedger = options.coverageLedger ?? readJsonFile('scripts/audit/coverage-ledger.json')
  const covEntries = covLedger?.entries ?? null
  if (covEntries) {
    const mentioned = new Set()
    const names = new Set(covEntries.map(e => String(e.file).split('/').pop().replace(/\.tsx?$/, '')))
    /**
     * 🔴 必须按**词边界**匹配：`WriteLockBanner` 是 `DesktopWriteLockBanner` 的子串，
     *    用 includes 会把「桌面版横幅已有测试」误当成「这个横幅已有测试」，从而把台账项误判失效。
     */
    const nameRes = [...names].map(n => [n, new RegExp(`(?<![A-Za-z0-9_$])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_$])`)])
    for (const f of walkCode(path.join(root, 'tests'))) {
      let text = ''
      try { text = fs.readFileSync(f, 'utf8') } catch { continue }
      for (const [n, re] of nameRes) if (!mentioned.has(n) && re.test(text)) mentioned.add(n)
    }
    const cov = validateCoverageLedger(covEntries, {
      exists: f => fs.existsSync(path.join(root, f)),
      riskLevels: covLedger.riskLevels,
      mentioned,
    })
    result.checks.push(...cov.checks)
    result.issues.push(...cov.issues)
  } else {
    result.checks.push({
      name: '零覆盖台账有效',
      status: 'failed',
      detail: 'scripts/audit/coverage-ledger.json 缺失或不可解析',
    })
    result.issues.push('零覆盖台账无效：文件缺失或不可解析')
  }

  /**
   * 审计策略化第三轮（2026-11-19）：把两次"专项才发现的细节"沉淀成规则。
   *   ① stale.cache —— 把缩放/窗口尺寸缓存进 useState 却没有任何变更订阅（3.6.1 面板缩放 bug 的形态）
   *   ② dup.impl    —— 同名导出且函数体逐字符相同（3.6.1 stableHash 双份的形态）
   * 两条都不含相似度打分，命中即可判定，所以按硬线处理（出现即失败，不给预算余量）。
   */
  const staleCache = options.staleCache ?? scanStaleCache(root)
  const providerCheck = validateProviders(root)
  result.checks.push({
    name: '缩放/尺寸豁免名单自洽',
    status: providerCheck.ok ? 'passed' : 'failed',
    detail: providerCheck.ok ? `${PROVIDERS.length} 个提供者文件均在位` : providerCheck.issues.join('; '),
  })
  result.issues.push(...providerCheck.issues)
  result.checks.push({
    name: '全局尺寸缓存已订阅变更',
    status: staleCache.findings.length ? 'failed' : 'passed',
    detail: staleCache.findings.length
      ? staleCache.findings.map(f => `${f.file}:${f.line}`).join(', ')
      : `扫描 ${staleCache.files} 个源码文件，未发现「缓存了缩放/窗口尺寸却不订阅」的写法`,
  })
  if (staleCache.findings.length) {
    result.issues.push(`有 ${staleCache.findings.length} 处缓存了缩放/窗口尺寸却没有订阅变更：${staleCache.findings.map(f => `${f.file}:${f.line}`).join(', ')}`)
  }

  const duplicateImpls = options.duplicateImpls ?? scanDuplicateImpls(root)
  result.checks.push({
    name: '无重复实现（同名 + 函数体相同）',
    status: duplicateImpls.findings.length ? 'failed' : 'passed',
    detail: duplicateImpls.findings.length
      ? duplicateImpls.findings.map(f => `${f.file}:${f.line}`).join(', ')
      : `扫描 ${duplicateImpls.files} 个源码文件，未发现同名同体的重复实现`,
  })
  if (duplicateImpls.findings.length) {
    result.issues.push(`有 ${duplicateImpls.findings.length} 处重复实现：${duplicateImpls.findings.map(f => `${f.file}:${f.line}`).join(', ')}`)
  }

  const structBudget = validateStructureBudget({
    budget,
    counts: { 'arch.reverse-import': structure.stats.reverseImports, 'arch.facade-undeclared': structure.stats.undeclaredFacades },
  })
  result.checks.push(...structBudget.checks)
  result.issues.push(...structBudget.issues)
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
    structure: { ...structure.stats, items: structure.findings.map(f => ({ rule: f.rule, file: f.file, line: f.line, message: f.message })) },
    staleCache: {
      files: staleCache.files,
      items: staleCache.findings.map(f => ({ rule: f.rule, file: f.file, line: f.line, message: f.message })),
    },
    duplicateImpls: {
      files: duplicateImpls.files,
      items: duplicateImpls.findings.map(f => ({ rule: f.rule, file: f.file, line: f.line, message: f.message })),
    },
    coverage: {
      entries: (covEntries ?? []).map(e => ({
        file: e.file, risk: e.risk, why: e.why, trigger: e.trigger,
        // 3.6.1：partial = 可测部分已抽出来测掉，剩余靠真机（必须带举证）
        status: e.status ?? 'open', remaining: e.remaining ?? '', coveredBy: e.coveredBy ?? '',
      })),
    },
    unwired: {
      ...unwired.stats,
      entries: (unwiredEntries ?? []).map(e => ({ file: e.file, status: e.status, reason: e.reason })),
      items: unwired.findings.map(f => ({ file: f.file, testImporters: f.testImporters, message: f.message })),
      entryFiles: ENTRY_FILES,
    },
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
