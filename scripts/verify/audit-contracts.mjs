import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { runProcess } from './process.mjs'
import { captureInputs, hashPaths } from './evidence.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const within = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel) }
const ids = ['preset.routes', 'io.roundtrip', 'draft.failure', 'mono.rendered']
const legacy = ['scan', 'dead', 'graph', 'arch', 'content', 'prompt', 'ui', 'func', 'sec', 'coverage', 'label-consistency']
const success = item => item?.ok === true && item.exitCode === 0 && !item.signal && !item.timedOut && !item.aborted && !item.error && !item.outputLimit && item.cleanupComplete !== false
const sameIds = (rows, expected, field = 'id') => Array.isArray(rows) && rows.length === expected.length && new Set(rows.map(row => row[field])).size === rows.length && expected.every(id => rows.some(row => row[field] === id))

export async function validateAuditBundle(root, directory, expected) {
  const dir = await fs.realpath(directory), temp = await fs.realpath(path.join(root, '.workbuddy/tmp'))
  if (!within(temp, dir) || dir === temp) throw new Error('Audit bundle is not isolated')
  const result = JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8'))
  const contractsBytes = await fs.readFile(path.join(root, 'scripts/audit/contracts.json'))
  const contracts = JSON.parse(contractsBytes)
  if (result.kind !== 'audit-contracts' || result.status !== 'passed' || result.inputHash !== expected.inputHash || result.sourceFingerprint !== expected.sourceFingerprint || result.contractsHash !== hash(contractsBytes)) throw new Error('Audit bundle failed or is stale')
  if (!sameIds(result.processes, ['producer', 'audit']) || !result.processes.every(success)) throw new Error('Audit processes did not complete normally')
  if (!Array.isArray(result.artifacts) || !result.artifacts.length) throw new Error('Audit artifacts missing')
  const files = new Set()
  for (const artifact of result.artifacts) {
    const file = await fs.realpath(path.resolve(root, artifact.path))
    if (!within(dir, file) || files.has(file) || hash(await fs.readFile(file)) !== artifact.sha256) throw new Error('Audit artifact changed, duplicated, or escaped')
    files.add(file)
  }
  for (const name of ['report.json', 'evidence.json', 'producer-evidence.json', 'producer.log', 'audit.log', 'draft.failure.png', 'mono.rendered.png', ...ids.map(id => id + '.json'), ...ids.map(id => id + '.log'), ...legacy.map(name => 'legacy-' + name + '.log')]) {
    if (!files.has(path.join(dir, name))) throw new Error('Audit mandatory artifact missing: ' + name)
  }
  const report = JSON.parse(await fs.readFile(path.join(dir, 'report.json'), 'utf8'))
  const evidence = JSON.parse(await fs.readFile(path.join(dir, 'evidence.json'), 'utf8'))
  if (report.status !== 'complete' || report.sourceFingerprint !== expected.sourceFingerprint || !sameIds(report.contracts, contracts.required.map(row => row.id)) || report.contracts.some(row => row.status !== 'passed') || !Array.isArray(report.diagnostics) || report.diagnostics.length) throw new Error('Audit is not complete')
  if (!sameIds(report.legacy, legacy, 'name') || report.legacy.some(row => row.status !== 'executed' || row.code !== 0)) throw new Error('Legacy audit is incomplete')
  if (!Array.isArray(report.static?.findings) || report.static.findings.some(row => row.disposition !== 'dismissed' || typeof row.reviewReason !== 'string' || row.reviewReason.trim().length < 10)) throw new Error('Unreviewed or confirmed audit findings')
  if (evidence.sourceFingerprint !== expected.sourceFingerprint || evidence.inputHash !== expected.inputHash || evidence.dirty || !sameIds(evidence.checks, ids) || !sameIds(evidence.runs, ids) || !evidence.runs.every(success)) throw new Error('Producer evidence incomplete')
  const cases = { 'preset.routes': ['new', 'edit'], 'io.roundtrip': ['legacy-name', 'duplicate', 'roundtrip'], 'draft.failure': ['save-failure', 'preserve-selection', 'preserve-storage'], 'mono.rendered': contracts.charts }
  for (const id of ids) {
    const check = evidence.checks.find(row => row.id === id)
    if (check.status !== 'passed' || path.resolve(root, check.artifact) !== path.join(dir, id + '.json')) throw new Error('Producer artifact not bound to bundle')
    const raw = JSON.parse(await fs.readFile(path.join(dir, id + '.json'), 'utf8'))
    const rows = id === 'mono.rendered' ? raw.results : raw.cases
    if (raw.contract !== id || !Number.isInteger(raw.samples) || raw.samples < 1 || raw.samples !== check.samples || raw.failed !== 0 || raw.passed !== raw.samples || !Array.isArray(rows) || rows.length !== raw.samples || rows.some(row => row.ok !== true) || (raw.pageErrors && raw.pageErrors.length)) throw new Error('Raw producer result did not pass')
    const observed = rows.map(row => id === 'mono.rendered' ? row.file : id === 'preset.routes' ? row.route : row.case)
    if (cases[id].some(name => !observed.includes(name)) || !Array.isArray(check.cases) || cases[id].some(name => !check.cases.includes(name))) throw new Error('Actual producer case coverage missing')
    if (id === 'mono.rendered' && (raw.theme !== 'mono' || check.theme !== 'mono' || rows.some(row => !(row.painted > 0) || row.unknownCount !== 0 || !Array.isArray(row.violations) || row.violations.length))) throw new Error('Mono real painted evidence incomplete')
  }
  return report.contracts.length
}

async function main() {
  const context = createRequire(import.meta.url)(path.join(ROOT, 'scripts/audit/context.cjs'))
  const index = process.argv.indexOf('--out-dir')
  if (index < 0 || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error('--out-dir is required')
  const dir = path.resolve(process.argv[index + 1])
  await fs.mkdir(path.join(ROOT, '.workbuddy/tmp'), { recursive: true })
  const temp = await fs.realpath(path.join(ROOT, '.workbuddy/tmp'))
  if (!within(temp, dir) || dir === temp) throw new Error('Output must be under workspace tmp')
  await fs.mkdir(dir) // Refuse to overwrite evidence from a previous run.
  const inputHash = (await captureInputs(ROOT)).combined, sourceFingerprint = context.sourceFingerprint(ROOT)
  const result = { kind: 'audit-contracts', status: 'failed', inputHash, sourceFingerprint, contractsHash: hash(await fs.readFile(path.join(ROOT, 'scripts/audit/contracts.json'))), processes: [] }
  try {
    const producer = await runProcess(process.execPath, ['scripts/verify/contracts-evidence.mjs', '--out-dir', dir], { cwd: ROOT, timeoutMs: 1000000 })
    await fs.writeFile(path.join(dir, 'producer.log'), producer.out)
    result.processes.push({ id: 'producer', ...producer, stdout: undefined, stderr: undefined, out: undefined })
    if (!producer.ok) throw new Error('Audit producer process failed')
    const evidence = JSON.parse(await fs.readFile(path.join(dir, 'producer-evidence.json'), 'utf8'))
    for (const check of evidence.checks) {
      if (!ids.includes(check.id)) throw new Error('Unknown producer')
      const original = await fs.realpath(path.resolve(ROOT, check.artifact))
      if (!within(temp, original)) throw new Error('Producer artifact outside temporary workspace')
      const copy = path.join(dir, check.id + '.json')
      await fs.copyFile(original, copy)
      if (['draft.failure', 'mono.rendered'].includes(check.id)) await fs.copyFile(path.join(path.dirname(original), check.id === 'draft.failure' ? 'draft-failure.png' : 'mono-charts.png'), path.join(dir, check.id + '.png'))
      check.artifact = path.relative(ROOT, copy)
    }
    const evidenceFile = path.join(dir, 'evidence.json')
    await fs.writeFile(evidenceFile, JSON.stringify(evidence, null, 2))
    const audit = await runProcess(process.execPath, ['scripts/audit/run.mjs', '--probes', '--evidence', evidenceFile], { cwd: ROOT, timeoutMs: 720000 })
    await fs.writeFile(path.join(dir, 'audit.log'), audit.out)
    result.processes.push({ id: 'audit', ...audit, stdout: undefined, stderr: undefined, out: undefined })
    const reportPath = /^Report: (.+\.md)\s*$/m.exec(audit.stdout)?.[1]?.trim()
    if (!audit.ok || !reportPath) throw new Error('Audit process failed or incomplete')
    const report = JSON.parse(await fs.readFile(reportPath.replace(/\.md$/, '.json'), 'utf8'))
    for (const entry of report.legacy) await fs.copyFile(path.resolve(ROOT, entry.log), path.join(dir, 'legacy-' + entry.name + '.log'))
    await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2))
    if ((await captureInputs(ROOT)).combined !== inputHash) throw new Error('Audit inputs changed while running')
    result.status = 'passed'
    result.artifacts = (await hashPaths(ROOT, [path.relative(ROOT, dir)])).entries
    await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2))
    const count = await validateAuditBundle(ROOT, dir, { inputHash, sourceFingerprint })
    console.log('AUDIT_CONTRACTS passed=' + count + ' bundle=' + dir)
  } catch (error) {
    result.status = 'failed'; result.error = String(error)
    await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2))
    throw error
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1 })
