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
import { validateRegistry, countSourceFiles, toolFingerprint } from './registry-check.mjs'

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
  result.ok = result.issues.length === 0

  return {
    ...result,
    appVersion: pkg.version ?? 'unknown',
    toolFingerprint: options.toolFingerprint ?? toolFingerprint(root),
    files: staticResult.files,
    inventory: staticResult.inventory,
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
