// 审计登记项校验 · 纯逻辑层（3.4.1）。
//
// 🔴 刻意不依赖 typescript / AST：tests/build-test.mjs 用 esbuild bundle 成 ESM，
//    一旦把 CommonJS 的 typescript 打进来就会报 "Dynamic require of fs is not supported"。
//    校验规则本身是纯数据比对，放在这里既好测，也不会把整包 TypeScript 拖进单测。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** scan.mjs / source.mjs 里写死的依赖：不在任何配置里，改路径时最容易漏改 */
export const HARDCODED_FILES = ['src/lib/db/core.ts', 'server/index.mjs', 'scripts/portable-server.mjs']

/** 收集两份配置里所有登记路径（label 用于报错时定位到具体字段） */
export function registeredPaths(contracts, policy) {
  const rows = []
  const push = (label, file) => { if (typeof file === 'string' && file) rows.push({ label, file }) }
  for (const [name, file] of Object.entries(policy.flagSources ?? {})) push(`policy.flagSources.${name}`, file)
  for (const key of ['bridgeAdapters', 'rawFlagAdapters', 'httpStoreAdapters']) {
    for (const [i, file] of (policy[key] ?? []).entries()) push(`policy.${key}[${i}]`, file)
  }
  for (const [i, file] of (policy.agentAuditPaths ?? []).entries()) push(`policy.agentAuditPaths[${i}]`, file)
  for (const [i, s] of (policy.sidecars ?? []).entries()) push(`policy.sidecars[${i}].file`, s?.file)
  for (const [i, file] of (contracts.charts ?? []).entries()) push(`contracts.charts[${i}]`, file)
  for (const [i, x] of (contracts.nonChartMono ?? []).entries()) push(`contracts.nonChartMono[${i}].file`, x?.file)
  for (const file of HARDCODED_FILES) push('hardcoded', file)
  return rows
}

/**
 * 纯校验层：不碰磁盘，配置与 exists 由调用方注入 ⇒ 可用构造数据验证「坏配置真能被拦住」。
 * @param {object} o contracts/policy 为配置对象；exists(file) 判断相对路径是否存在；
 *                   srcFileCount 为独立数出的真实 ts/tsx 文件数；staticFiles 为 scanAst 报告的文件数
 */
export function validateRegistry({ contracts, policy, exists, srcFileCount, staticFiles }) {
  const checks = [], issues = []
  const check = (name, ok, detail) => {
    checks.push({ name, status: ok ? 'passed' : 'failed', detail })
    if (!ok) issues.push(`${name}：${detail}`)
  }

  const rows = registeredPaths(contracts, policy)
  const missing = rows.filter(r => !exists(r.file))
  check('登记路径全部存在', rows.length > 0 && missing.length === 0,
    missing.length ? `缺失 ${missing.map(m => `${m.label}=${m.file}`).join(', ')}` : `${rows.length} 项`)

  const charts = contracts.charts ?? []
  const duplicates = [...new Set(charts.filter((f, i) => charts.indexOf(f) !== i))]
  const nonChart = (contracts.nonChartMono ?? []).map(x => x.file)
  const crossed = charts.filter(f => nonChart.includes(f))
  check('图表清单健康', charts.length > 0 && !duplicates.length && !crossed.length,
    `charts=${charts.length}` + (duplicates.length ? ` 重复=${duplicates.join(',')}` : '')
      + (crossed.length ? ` 与 nonChartMono 交叉=${crossed.join(',')}` : ''))

  const ids = (contracts.required ?? []).map(r => r.id)
  check('必要契约 id 唯一且非空', ids.length > 0 && new Set(ids).size === ids.length && ids.every(Boolean),
    `${ids.length} 个契约`)

  // Agent 覆盖不能因登记项被整体删掉而静默退回旧版六契约。
  if (policy.schemaVersion === 1) {
    const agentPaths = policy.agentAuditPaths ?? []
    const requiredPaths = ['src/lib/aiCore/chat.ts', 'scripts/mcp/yfe-readonly.mjs', 'tests/mcpReadonlyBridge.test.ts', 'scripts/verify/agent-contract.mjs', 'scripts/audit/agent-contracts.mjs', 'src/lib/aiCore/backend/bridgeConfig.ts', 'src/components/settings/AgentBridgeSetup.tsx', 'tests/agentBridgeConfig.test.ts']
    const ok = ['agent.readonly', 'agent.bridge-config'].every(id => ids.includes(id)) && requiredPaths.every(file => agentPaths.includes(file)) && new Set(agentPaths).size === agentPaths.length
    check('Agent 契约与路径登记完整', ok, `contracts=${ids.length}, paths=${agentPaths.length}`)
  }

  // 🔴 核心防失明：AST 扫描的文件数必须等于独立 walk 出的真实数量，且不能为 0。
  check('静态扫描覆盖与源码一致', Number.isInteger(staticFiles) && staticFiles > 0 && staticFiles === srcFileCount,
    `AST 扫描 ${staticFiles} / 实际 ${srcFileCount} 个 ts/tsx 文件`)

  return { ok: issues.length === 0, checks, issues }
}

/** 独立数一遍 src 下的 ts/tsx，刻意不复用 ast.mjs 内部的 walk（同源实现会一起错） */
export function countSourceFiles(dir) {
  let n = 0
  if (!fs.existsSync(dir)) return 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) n += countSourceFiles(p)
    else if (/\.(ts|tsx)$/.test(e.name)) n++
  }
  return n
}

/** 审计工具自身指纹：工具规则变了，旧报告就能被区分开（不碰 sourceFingerprint，证据链不变） */
export function toolFingerprint(root) {
  const dir = path.join(root, 'scripts/audit'), files = []
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else files.push(p)
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  const h = crypto.createHash('sha256')
  for (const file of files.sort()) {
    h.update(path.relative(root, file).replaceAll('\\', '/'))
    h.update('\0'); h.update(fs.readFileSync(file)); h.update('\0')
  }
  return h.digest('hex')
}

/**
 * 审计工具「输出给用户的命令提示」是否指向不存在的脚本（3.4.1 第二轮）。
 *
 * 背景：`compat.mjs` 曾提示 `node .workbuddy/tmp/audit-platform.mjs --matrix`，
 * 但 tmp 不入库、本机也没恢复该入口 ⇒ 用户照抄必然失败，而扫描器自己毫无察觉。
 * 只查**真正会输出的行**，跳过注释：legacy 文件头的「用法：node .workbuddy/tmp/audit-*.mjs」
 * 是兼容入口说明，README 已交代需先跑 install-entrypoints.mjs，不算失效提示。
 */
export function staleToolHints(root) {
  const dir = path.join(root, 'scripts/audit'), hits = []
  const scanFile = file => {
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      const t = line.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
      const m = /node\s+(\.workbuddy\/(?:tmp|tools)\/[\w.-]+\.(?:mjs|cjs|js))/.exec(line)
      if (m && !fs.existsSync(path.join(root, m[1]))) {
        hits.push({ file: path.relative(root, file).replaceAll('\\', '/'), line: i + 1, target: m[1] })
      }
    })
  }
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(mjs|cjs|js)$/.test(e.name)) scanFile(p)
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return hits
}
