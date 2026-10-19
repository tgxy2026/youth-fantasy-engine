import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { scanAst } from './ast.mjs'
import { auditHeaders } from './probes.mjs'
import context from './context.cjs'

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
const report = { schemaVersion: 1, scope: 'audit-contracts-v1; excludes packaged desktop, real API and dual-device acceptance', generatedAt: new Date().toISOString(), sourceFingerprint, static: scanAst(root, contracts), legacy: [], observations: [], diagnostics: [], contracts: [] }
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
    const expectedCases = { 'preset.routes': ['new', 'edit'], 'mono.rendered': contracts.charts, 'draft.failure': ['save-failure', 'preserve-selection', 'preserve-storage'], 'io.roundtrip': ['legacy-name', 'duplicate', 'roundtrip'] }[required.id] ?? []
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
if (fingerprint() !== sourceFingerprint) report.diagnostics.push({ status: 'blocked', reason: 'Source changed during audit; results are stale. Rerun after edits settle.' })
const failures = report.contracts.filter(c => c.status === 'failed')
report.status = failures.length || report.static.findings.some(f => f.disposition === 'confirmed') ? 'failed' : report.contracts.every(c => c.status === 'passed') && report.static.findings.every(f => f.disposition === 'dismissed') && !report.diagnostics.length && report.legacy.every(c => c.status === 'executed') ? 'complete' : 'incomplete'
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
const md = ['# 审计结果', '', `状态：**${report.status}**。静态扫描完成不等于功能验收通过。`, '', `源码指纹：\`${sourceFingerprint}\``, '', '## 必要运行证据', '', ...report.contracts.map(c => `- **${c.status}** ${c.id}：${c.reason}`), '', '## 静态缺陷候选（须人工确认）', '', ...report.static.findings.map(f => `- ${f.file}:${f.line} [${f.rule}/${f.confidence}/${f.disposition}] ${f.message}${f.reviewReason ? '；复核：' + f.reviewReason : ''}`), '', '## 执行说明', '', ...report.diagnostics.map(d => `- ${d.status}: ${d.reason}`), ...report.legacy.map(l => `- ${l.name}: ${l.status}；原始日志 ${l.log}`), '', '旧扫描器以完整候选模式执行，原始日志不丢弃；此报告不会把旧脚本的退出0直接解释成产品通过。']
fs.writeFileSync(path.join(out, 'report.md'), md.join('\n'))
console.log(`Audit ${report.status}: ${report.static.findings.length} candidates; ${failures.length} failing contracts.\nReport: ${path.join(out, 'report.md')}`)
process.exitCode = report.status === 'failed' ? 1 : report.status === 'incomplete' ? 2 : 0
}
