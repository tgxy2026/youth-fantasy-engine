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

/**
 * 死导出「欠账预算」校验（2026-11-17 审计补盲）。
 *
 * 🔴 为什么是预算而不是硬阻塞：历史欠账（当前 22 条未复核）不该让升级后的审计把
 *    一个本来能发版的版本判成失败；但**欠账只允许减少**——一旦新增死代码让实际条数
 *    超过预算，自检立刻失败、审计不可能 complete。这样既显性化历史问题，又防止恶化。
 * 🔴 预算只能下调：校验时若 actual 明显低于 budget 也提示（要求同步收紧），避免预算
 *    长期虚高、失去约束力。
 */
export function validateDebtBudget({ budget, actual, reviewed, tolerance = 0 }) {
  const checks = [], issues = []
  const check = (name, ok, detail) => {
    checks.push({ name, status: ok ? 'passed' : 'failed', detail })
    if (!ok) issues.push(`${name}：${detail}`)
  }
  const cap = Number(budget?.deadExports)
  const open = Number(actual)
  check('死导出欠账不超预算',
    Number.isInteger(cap) && cap >= 0 && Number.isInteger(open) && open <= cap,
    `未复核 ${open} 条 / 预算 ${cap} 条${open > cap ? '（新增死代码必须处理或先复核，禁止直接调高预算）' : ''}`)
  // 预算明显高于实际（留了很多余量）说明该收紧，否则预算形同虚设
  check('死导出预算未虚高', Number.isInteger(cap) && Number.isInteger(open) && open >= cap - tolerance,
    `未复核 ${open} / 预算 ${cap}（差 ${Number.isInteger(cap) ? cap - open : '?'}；清掉欠账后请同步下调 budget）`)
  check('死导出复核条数已计入',
    Number.isInteger(reviewed) && reviewed >= 0 && reviewed + open > 0,
    `已复核 ${reviewed} 条`)
  return { ok: issues.length === 0, checks, issues }
}

/**
 * 扫描器清单一致性（2026-11-17 补）。
 *
 * 🔴 病灶：`run.mjs` 的 legacyNames 是**手写数组**，而 `legacy/audit-*.mjs` 是目录里的真实文件。
 *    两边靠人记——新增一支扫描器忘了登记 ⇒ 永远不跑（报告里看不到它，也不会报错）；
 *    删了一支却留着登记 ⇒ 每次审计都 spawn 一个不存在的文件，runLegacy 判 blocked，
 *    报告永远 incomplete 却查不出原因。两种都是「静默失明」，必须在自检里挡。
 */
export function validateScannerRegistry({ dirNames, runNames }) {
  const checks = [], issues = []
  const check = (name, ok, detail) => {
    checks.push({ name, status: ok ? 'passed' : 'failed', detail })
    if (!ok) issues.push(`${name}：${detail}`)
  }
  const dir = [...dirNames].sort()
  const run = [...runNames].sort()
  const missingInRun = dir.filter(n => !run.includes(n))
  const missingInDir = run.filter(n => !dir.includes(n))
  check('扫描器清单与目录一致',
    dir.length > 0 && missingInRun.length === 0 && missingInDir.length === 0,
    missingInRun.length || missingInDir.length
      ? `目录多出 ${missingInRun.join(',') || '无'}；清单多出 ${missingInDir.join(',') || '无'}`
      : `${dir.length} 支扫描器`)
  return { ok: issues.length === 0, checks, issues }
}

/**
 * 结构约束预算（2026-11-18）。
 *
 * 🔴 与死导出的差别：死导出允许有历史欠账（预算 22），而结构约束是**预期长期为 0** 的硬线
 *    （反向依赖、未登记门面）。为 0 的东西不需要预算余量：一旦出现就该失败，
 *    所以这里的语义是「实际 > 预算（默认 0）即失败」，不做"虚高提醒"。
 */
export function validateStructureBudget({ budget, counts }) {
  const checks = [], issues = []
  const rules = Object.keys(counts ?? {})
  if (!rules.length) {
    checks.push({ name: '结构约束有检查项', status: 'failed', detail: '结构扫描没有产出任何规则计数' })
    issues.push('结构约束有检查项：结构扫描没有产出任何规则计数')
    return { ok: false, checks, issues }
  }
  const limits = budget?.structure ?? {}
  const over = []
  for (const rule of rules) {
    const cap = Number(limits[rule] ?? 0)
    const actual = Number(counts[rule] ?? 0)
    if (!Number.isInteger(actual) || actual > cap) over.push(`${rule} 实际 ${actual} / 上限 ${cap}`)
  }
  const passed = over.length === 0
  checks.push({
    name: '结构约束不超预算',
    status: passed ? 'passed' : 'failed',
    detail: passed ? `${rules.length} 条规则均为 0（预期长期为 0）` : over.join('；'),
  })
  if (!passed) issues.push(`结构约束不超预算：${over.join('；')}`)
  return { ok: passed, checks, issues }
}
