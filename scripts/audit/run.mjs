import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { scanAst } from './ast.mjs'
import { auditHeaders } from './probes.mjs'
import context from './context.cjs'
import { auditSelfCheck } from './self-check.mjs'
import { AGENT_AUDIT } from './agent-contracts.mjs'
import { captureInputs } from '../verify/evidence.mjs'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const args = process.argv.slice(2)
if (args.includes('--platform')) {
  process.argv.splice(process.argv.indexOf('--platform'), 1)
  await import('./platform/run.mjs')
} else {
if (args.includes('--help')) {
  console.log('node scripts/audit/run.mjs [--probes] [--no-legacy] [--evidence file.json]\nSpecialised: node scripts/audit/run.mjs --platform [--matrix] [--base ref] [--evidence ledger.json]\nExit 0: complete evidence; 1: confirmed failure; 2: incomplete/blocked/review candidates. No product writes or publishing.')
  process.exit(0)
}
const allowed = new Set(['--probes', '--no-legacy', '--evidence'])
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i])) throw new Error(`Unknown audit option: ${args[i]}`)
  if (args[i] === '--evidence') { if (!args[++i]) throw new Error('--evidence requires a JSON path') }
}
const contracts = JSON.parse(fs.readFileSync(new URL('./contracts.json', import.meta.url), 'utf8'))
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const out = path.join(root, '.workbuddy/tmp/audit', stamp)
fs.mkdirSync(out, { recursive: true })
const fingerprint = () => context.sourceFingerprint(root)
const sourceFingerprint = fingerprint()
const inputHash = (await captureInputs(root)).combined
const staticResult = scanAst(root, contracts)
// 🔴 3.4.1：开场自检登记项与扫描覆盖度，防止「搬文件后扫 0 个文件仍报 0 候选」的假绿灯。
//    复用上面算好的 staticResult，避免重复解析全部 ts/tsx。schemaVersion 保持 1：只增字段、不改契约语义。
const selfCheck = auditSelfCheck(root, { staticResult })
const report = { schemaVersion: 1, scope: 'audit-contracts-v1; excludes packaged desktop, real API and dual-device acceptance', generatedAt: new Date().toISOString(), appVersion: selfCheck.appVersion, toolFingerprint: selfCheck.toolFingerprint, sourceFingerprint, static: staticResult, selfCheck: { ok: selfCheck.ok, checks: selfCheck.checks, issues: selfCheck.issues }, legacy: [], observations: [], diagnostics: [], contracts: [] }
/**
 * 3.6.0 · 审计补盲（2026-11-17）：死导出不再是「只写进 log 的候选」。
 *
 * 旧行为：`legacy/audit-dead.mjs` 把几十条零引用导出打进 log，`report.static.findings`
 * 永远是 0 —— 报告绿着，候选躺着没人看。现在结构化后：
 *   · `deadExports.openItems` 逐条列进 report.md（可执行清单）；
 *   · 已复核项（scripts/audit/dead-reviews.json，按**符号**匹配，不怕行号漂移）不再计入欠账；
 *   · 欠账条数由 debt-budget.json 卡住，**只准降不准升**（超了自检就失败）。
 * 🔴 为什么不直接把它们塞进 findings：会一次性给 22 条历史欠账套上「必须 dismissed/confirmed」
 *    的门槛，升级工具反而把老版本判成不合格。预算机制既能看见、又能防恶化、还不误伤。
 */
report.static.deadExports = selfCheck.deadExports
/**
 * 结构约束（2026-11-18）：反向依赖 / 未登记门面 —— 判据客观、预期长期为 0。
 * 它们按「硬线」处理（不是欠账预算）：出现即自检失败，报告不可能 complete。
 */
report.static.structure = selfCheck.structure
/**
 * 审计策略化第三轮（2026-11-19）：两条新硬线，各自对应一次"专项才发现的细节"。
 *   staleCache —— 缓存缩放/窗口尺寸却不订阅变更（面板缩放 bug 的形态）
 *   duplicateImpls —— 同名导出且函数体相同（stableHash 双份的形态）
 */
report.static.staleCache = selfCheck.staleCache
report.static.duplicateImpls = selfCheck.duplicateImpls
/**
 * 未接线模块（2026-11-18）：整个模块没有任何生产代码 import。
 * 死导出按符号统计，这类形状在报告里看不见（实测 changeEvents / modeAuthority 都是），
 * 现在单列一段：按台账状态分组，gap 单独标出（能力缺口，删了等于扔方案）。
 */
report.static.unwired = selfCheck.unwired
/**
 * 零覆盖台账（2026-11-18）：能补测的已补，其余留下风险与触发条件。
 * 报告里单列，是为了让「这批文件没测试」这件事每次都看得见，而不是埋在覆盖率日志里。
 */
report.static.coverage = selfCheck.coverage
if (!selfCheck.ok) report.diagnostics.push({ status: 'blocked', reason: `审计工具自检失败：${selfCheck.issues.join('; ')}` })
const legacyNames = ['scan', 'dead', 'graph', 'arch', 'content', 'prompt', 'ui', 'func', 'sec', 'coverage', 'label-consistency']
function runLegacy(name) {
  return new Promise(resolve => {
    const log = path.join(out, `legacy-${name}.log`)
    const stream = fs.createWriteStream(log)
    let done = false, timedOut = false
    const child = spawn(process.execPath, [path.join(root, `scripts/audit/legacy/audit-${name}.mjs`), root], { cwd: root, env: { ...process.env, YFE_AUDIT_FULL: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false })
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 60_000)
    const finish = (code, error) => {
      if (done) return
      done = true; clearTimeout(timer)
      stream.end(() => resolve({ name, status: error || timedOut || code !== 0 ? 'blocked' : 'executed', code, reason: error?.message ?? (timedOut ? '60s timeout' : undefined), log: path.relative(root, log).replaceAll('\\', '/') }))
    }
    child.once('error', error => finish(null, error))
    child.once('close', code => finish(code))
  })
}
if (!args.includes('--no-legacy')) for (const name of legacyNames) {
  console.log(`Audit scanner: ${name}`)
  report.legacy.push(await runLegacy(name))
}
if (args.includes('--probes')) {
  try { report.observations = await auditHeaders(root, out) }
  catch (e) { report.diagnostics.push({ status: 'blocked', reason: `Offline probe: ${e.message}` }) }
}
let evidence = null
const index = args.indexOf('--evidence')
if (index >= 0) {
  try {
    evidence = JSON.parse(fs.readFileSync(path.resolve(args[index + 1]), 'utf8'))
    if (evidence.sourceFingerprint !== sourceFingerprint) throw new Error('Evidence fingerprint differs from current source (including uncommitted edits)')
    if (evidence.dirty || evidence.inputHash !== inputHash) throw new Error('Evidence inputs changed or producer marked dirty')
    if (!Array.isArray(evidence.checks)) throw new Error('Evidence checks must be an array')
    if (evidence.reviews !== undefined && !Array.isArray(evidence.reviews)) throw new Error('Evidence reviews must be an array')
    const ids = evidence.checks.map(c => c.id)
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate evidence contract ids')
    for (const c of evidence.checks) if (!contracts.required.some(r => r.id === c.id)) throw new Error(`Unknown evidence id: ${c.id}`)
  } catch (e) { evidence = null; report.diagnostics.push({ status: 'blocked', reason: `Evidence: ${e.message}` }) }
}
for (const required of contracts.required) {
  const observations = report.observations.filter(o => o.id === required.id)
  const provided = evidence?.checks.find(c => c.id === required.id)
  let status = 'unverified', reason = '尚未提供运行路径与结果证据'
  if (['headers.case', 'headers.syntax'].includes(required.id) && observations.length) {
    status = observations.every(o => o.status === 'passed') ? 'passed' : 'failed'
    reason = '当前生产函数的离线边界审计；不代表真实服务可用'
  }
  if (provided) {
    const artifact = typeof provided.artifact === 'string' && fs.existsSync(path.resolve(root, provided.artifact)) && fs.statSync(path.resolve(root, provided.artifact)).isFile()
    const sample = Number.isInteger(provided.samples) && provided.samples > 0
    const expectedCases = { 'preset.routes': ['new', 'edit'], 'mono.rendered': contracts.charts, 'draft.failure': ['save-failure', 'preserve-selection', 'preserve-storage'], 'io.roundtrip': ['legacy-name', 'duplicate', 'roundtrip'], ...Object.fromEntries(Object.entries(AGENT_AUDIT).map(([id, spec]) => [id, Object.keys(spec.cases)])) }[required.id] ?? []
    const cases = Array.isArray(provided.cases) && expectedCases.every(c => provided.cases.includes(c))
    if (provided.status === 'failed') { status = 'failed'; reason = '运行证据报告失败' }
    else if (provided.status === 'blocked') { status = 'blocked'; reason = provided.reason ?? '执行受阻' }
    else if (provided.status === 'passed' && artifact && sample && cases && (required.id !== 'mono.rendered' || provided.theme === 'mono')) {
      // Local failing probes cannot be overwritten by a supplied green report.
      if (status !== 'failed') { status = 'passed'; reason = '证据前提、路径覆盖及当前源码指纹已核对；仍需人工核实产物内容' }
    } else if (status !== 'failed') { status = 'unverified'; reason = '证据缺少有效样本、产物、主题或必要入口覆盖，不能报绿' }
  }
  report.contracts.push({ ...required, status, reason })
}
for (const finding of report.static.findings) {
  const review = evidence?.reviews?.find(r => r.file === finding.file && r.line === finding.line && r.rule === finding.rule)
  finding.disposition = review && ['dismissed', 'confirmed'].includes(review.status) && typeof review.reason === 'string' && review.reason.trim().length >= 10 ? review.status : 'unreviewed'
  if (finding.disposition !== 'unreviewed') finding.reviewReason = review.reason
}
if (fingerprint() !== sourceFingerprint || (await captureInputs(root)).combined !== inputHash) report.diagnostics.push({ status: 'blocked', reason: 'Audit inputs changed during audit; results are stale. Rerun after edits settle.' })
const failures = report.contracts.filter(c => c.status === 'failed')
report.status = failures.length || report.static.findings.some(f => f.disposition === 'confirmed') ? 'failed' : report.contracts.every(c => c.status === 'passed') && report.static.findings.every(f => f.disposition === 'dismissed') && !report.diagnostics.length && report.legacy.every(c => c.status === 'executed') ? 'complete' : 'incomplete'
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
const unregisteredMono = report.static.inventory.filter(x => x.mono && !x.registered)
const md = ['# 审计结果', '', `状态：**${report.status}**。静态扫描完成不等于功能验收通过。`, '', `源码指纹：\`${sourceFingerprint}\``, '', '## 本次扫描', '', `- 软件版本：\`v${report.appVersion}\`　|　审计工具指纹：\`${report.toolFingerprint.slice(0, 16)}\``, `- 静态扫描：\`${report.static.files}\` 个 ts/tsx 文件、\`${report.static.findings.length}\` 个候选；图表 / mono 清单 \`${report.static.inventory.length}\` 项（未登记 \`${unregisteredMono.length}\` 项）`, `- 工具自检：**${selfCheck.ok ? 'passed' : 'failed'}**（${selfCheck.checks.length} 项）；自检失败会阻止报告判为 complete`, ...(selfCheck.ok ? [] : ['', ...selfCheck.issues.map(issue => `- ⚠️ ${issue}`)]), '', '## 必要运行证据', '', ...report.contracts.map(c => `- **${c.status}** ${c.id}：${c.reason}`), '', '## 静态缺陷候选（须人工确认）', '', ...report.static.findings.map(f => `- ${f.file}:${f.line} [${f.rule}/${f.confidence}/${f.disposition}] ${f.message}${f.reviewReason ? '；复核：' + f.reviewReason : ''}`), '', '## 结构约束（预期长期为 0）', '',
  `- 反向依赖 \`${report.static.structure.reverseImports}\` 处；未登记门面 \`${report.static.structure.undeclaredFacades}\` 个；扫描 \`${report.static.structure.files}\` 个源码文件`,
  ...(report.static.structure.items.length
    ? ['', ...report.static.structure.items.map(i => `- ${i.file}:${i.line} [${i.rule}] ${i.message}`)]
    : ['', '两条规则均为 0。']),
    '', '## 新增硬线：尺寸缓存订阅 / 重复实现（2026-11-19）', '',
  `- 尺寸缓存：扫描 \`${report.static.staleCache.files}\` 个文件，命中 \`${report.static.staleCache.items.length}\` 处（缓存了缩放/窗口尺寸却没有任何 resize / yfe:zoom-changed 订阅）`,
  `- 重复实现：扫描 \`${report.static.duplicateImpls.files}\` 个文件，命中 \`${report.static.duplicateImpls.items.length}\` 处（同名导出 + 函数体逐字符相同，且函数体 ≥120 字符）`,
  ...(report.static.staleCache.items.length || report.static.duplicateImpls.items.length
    ? ['', ...[...report.static.staleCache.items, ...report.static.duplicateImpls.items].map(i => `- ${i.file}:${i.line} [${i.rule}] ${i.message}`)]
    : ['', '两条规则均为 0。']),
    '', '## 零覆盖台账（安全 / 数据 / 算法类，无测试但已记风险）', '',
  `- 登记 \`${report.static.coverage.entries.length}\` 个文件；按风险：${['data', 'sync', 'agent', 'ui', 'display'].map(r => `${r} \`${report.static.coverage.entries.filter(e => e.risk === r).length}\``).join(' · ')}；按状态：整体未测 \`${report.static.coverage.entries.filter(e => (e.status ?? 'open') === 'open').length}\` · 部分已测（其余靠真机） \`${report.static.coverage.entries.filter(e => e.status === 'partial').length}\``,
  `- 台账在 \`scripts/audit/coverage-ledger.json\`：每条写清\`why\`（为什么现在不补）与\`trigger\`（什么情况下必须补）；标 \`partial\` 的还必须写 \`remaining\`（剩余哪部分）与 \`coveredBy\`（哪个测试文件覆盖的，自检会核对该文件存在）`,
  ...(report.static.coverage.entries.length
    ? ['', ...report.static.coverage.entries.map(e => `- ${e.file} ［${e.risk} · ${e.status ?? 'open'}］${e.why}；**触发**：${e.trigger}${e.status === 'partial' ? `；**已测**：\`${e.coveredBy}\`；**剩余**：${e.remaining}` : ''}`)]
    : ['', '台账为空。']),
  '', '## 未接线模块（整模块没有生产 import）', '',
  `- 扫描 \`${report.static.unwired.files}\` 个 .ts/.tsx（不含 .d.ts）；已接线 \`${report.static.unwired.wired}\`；**未接线 \`${report.static.unwired.unwired}\`**（其中仅测试引用的 \`${report.static.unwired.testOnly}\` 个）`,
  `- 台账 \`${report.static.unwired.entries.length}\` 条：能力缺口 \`${report.static.unwired.entries.filter(e => e.status === 'gap').length}\` · 已判定保留 \`${report.static.unwired.entries.filter(e => e.status === 'retained').length}\` · 度量夹具 \`${report.static.unwired.entries.filter(e => e.status === 'harness').length}\``,
  ...(report.static.unwired.items.length
    ? ['', '清单（状态与理由见 `scripts/audit/unwired-ledger.json`）：', ...report.static.unwired.items.map(i => {
        const e = report.static.unwired.entries.find(x => x.file === i.file)
        return `- ${i.file} ［${e?.status ?? '未登记'}］测试引用 ${i.testImporters} 处 — ${e?.reason ?? i.message}`
      })]
    : ['', '没有未接线模块。']),
'', '## 死导出欠账（结构化清单）', '',
  `- 导出总数 \`${report.static.deadExports.exports}\`；零引用 \`${report.static.deadExports.dead}\`（已复核 \`${report.static.deadExports.reviewed}\` / **未复核 \`${report.static.deadExports.open}\`**）`,
  `- 仅测试引用 \`${report.static.deadExports.testOnly}\`（不计入欠账：单测覆盖是常态）；仅被**门面再导出** \`${report.static.deadExports.facadeOnly}\`（删除会打断对外 API，须同时改门面）`,
  ...(report.static.deadExports.openItems.length
    ? ['', '未复核清单（逐条给结论后可移入 `scripts/audit/dead-reviews.json`，或直接删除）：', ...report.static.deadExports.openItems.map(i => `- ${i.file}:${i.line} \`${i.symbol}\`（${i.kind}）`)]
    : ['', '未复核清单为空。']),
  '', '## 执行说明', '', ...report.diagnostics.map(d => `- ${d.status}: ${d.reason}`), ...report.legacy.map(l => `- ${l.name}: ${l.status}；原始日志 ${l.log}`), '', '旧扫描器以完整候选模式执行，原始日志不丢弃；此报告不会把旧脚本的退出0直接解释成产品通过。']
fs.writeFileSync(path.join(out, 'report.md'), md.join('\n'))
console.log(`Audit ${report.status}: ${report.static.findings.length} candidates; ${failures.length} failing contracts.\nScanned ${report.static.files} ts/tsx files; tool self-check ${selfCheck.ok ? 'passed' : 'FAILED'}; app v${report.appVersion}; tool ${report.toolFingerprint.slice(0, 12)}.\nReport: ${path.join(out, 'report.md')}`)
process.exitCode = report.status === 'failed' ? 1 : report.status === 'incomplete' ? 2 : 0
}
