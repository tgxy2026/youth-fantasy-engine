// Stage A foundation. Unimplemented business contracts deliberately prevent full-local green.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProcess } from './process.mjs'
import { readTestPlan } from './test-plan.mjs'
import { captureInputs, hashPaths, scopeVerdict, writeReports } from './evidence.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PLAN = JSON.parse(await fs.readFile(new URL('./reliability.contracts.json', import.meta.url), 'utf8'))

export async function verify({ root = ROOT, stage = 'local', signal } = {}) {
  if (!['local', 'foundation'].includes(stage)) throw new Error('stage must be local or foundation')
  const realRoot = await fs.realpath(root)
  const parent = path.join(realRoot, '.workbuddy', 'tmp')
  await fs.mkdir(parent, { recursive: true })
  const realParent = await fs.realpath(parent)
  if (path.relative(realRoot, realParent).startsWith('..')) throw new Error('Temporary directory escapes workspace')
  const runRoot = await fs.mkdtemp(path.join(realParent, 'reliability-'))
  const contracts = PLAN.contracts
  const results = []
  const startedAt = new Date().toISOString()
  const inputs = await captureInputs(realRoot)
  const pkg = JSON.parse(await fs.readFile(path.join(realRoot, 'package.json'), 'utf8'))
  const git = await runProcess('git', ['rev-parse', 'HEAD'], { cwd: realRoot, timeoutMs: 15000, signal })
  const dirty = await runProcess('git', ['diff', '--no-ext-diff', '--binary', 'HEAD'], { cwd: realRoot, timeoutMs: 15000, signal })
  // Fingerprints include untracked source/tooling too; Git diff alone cannot identify this workspace.
  const report = { schemaVersion: 1, runRoot, stage, profile: 'local', startedAt, version: pkg.version,
    plannedVersion: '3.2.3', head: git.ok ? git.stdout.trim() : null, gitAvailable: git.ok,
    environment: { node: process.version, platform: process.platform, arch: process.arch }, inputs, results }
  await fs.writeFile(path.join(runRoot, 'working-tree.diff'), dirty.out)
  const record = (id, status, assertions, reason, evidencePaths = []) => {
    results.push({ id, profile: 'local', status, assertions, reason, inputHash: inputs.combined, evidencePaths })
    console.log(status.toUpperCase() + ' ' + id + (reason ? ': ' + reason : ''))
  }
  async function command(id, args, timeoutMs, inspect = () => 1) {
    const result = await runProcess(process.execPath, args, { cwd: realRoot, timeoutMs, signal,
      env: { ...process.env, YFE_TEST_QUIET: '1' } })
    const log = id + '.log'
    await fs.writeFile(path.join(runRoot, log), result.out)
    await fs.writeFile(path.join(runRoot, id + '.process.json'), JSON.stringify({ ...result, stdout: undefined, stderr: undefined, out: undefined }, null, 2))
    if (!result.ok) { record(id, 'failed', 0, result.error ?? ('exit=' + result.exitCode + ' signal=' + result.signal + ' timeout=' + result.timedOut), [log, id + '.process.json']); return false }
    try {
      const assertions = await inspect(result)
      if (!Number.isInteger(assertions) || assertions < 1) throw new Error('No verified samples')
      const extra = id === 'source.tests' ? ['tests.json'] : id === 'source.build' ? ['build-manifest.json'] : []
      record(id, 'passed', assertions, '', [log, id + '.process.json', ...extra]); return true
    } catch (error) { record(id, 'failed', 0, String(error), [log, id + '.process.json']); return false }
  }
  let ready = true
  try {
    if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node 20+ required')
    const plan = readTestPlan(realRoot)
    for (const file of ['typescript/bin/tsc', 'eslint/bin/eslint.js', 'vite/bin/vite.js', 'esbuild/package.json']) await fs.access(path.join(realRoot, 'node_modules', file))
    for (const item of contracts) if (item.platformCaseIds) {
      const policy = JSON.parse(await fs.readFile(path.join(realRoot, 'scripts/audit/platform/policy.json'), 'utf8'))
      for (const id of item.platformCaseIds) if (!policy.runtimeCases.some(entry => entry.id === id)) throw new Error('Unknown platform contract ' + id)
    }
    await fs.writeFile(path.join(runRoot, 'preflight.json'), JSON.stringify({ actualTestEntries: plan.actualEntries, jobs: plan.jobs.length, node: process.version }, null, 2))
    record('tooling.preflight', 'passed', 1, '', ['preflight.json'])
  } catch (error) { ready = false; record('tooling.preflight', 'failed', 0, String(error)) }
  const steps = [
    ['source.typecheck', ['node_modules/typescript/bin/tsc', '--noEmit'], 120000],
    ['source.lint', ['node_modules/eslint/bin/eslint.js', 'src', 'tests', '--max-warnings', '0'], 120000],
    ['source.tests', ['tests/run-all.mjs', '--report', path.join(runRoot, 'tests.json')], 900000, async () => {
      const testReport = JSON.parse(await fs.readFile(path.join(runRoot, 'tests.json'), 'utf8'))
      const expected = readTestPlan(realRoot).jobs.map(job => job.id).sort()
      const actual = testReport.results.map(item => item.id).sort()
      if (!testReport.ok || testReport.planned !== expected.length || testReport.passed !== expected.length || testReport.failed !== 0 || testReport.notRun !== 0 || JSON.stringify(expected) !== JSON.stringify(actual) || testReport.results.some(item => item.status !== 'passed' || !item.ok)) throw new Error('Incomplete test execution')
      return expected.length
    }],
    ['source.build', ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(runRoot, 'build')], 180000, async () => {
      await fs.access(path.join(runRoot, 'build/index.html'))
      report.build = await hashPaths(path.join(runRoot, 'build'), ['.'])
      await fs.writeFile(path.join(runRoot, 'build-manifest.json'), JSON.stringify(report.build, null, 2))
      return report.build.count
    }],
    ['source.release-check', ['scripts/release-check.mjs', '--source-only', '--dist', path.join(runRoot, 'build'), '--json'], 180000, result => {
      const check = JSON.parse(result.stdout)
      if (check.stage !== 'source' || check.fail !== 0 || !['PASS', 'PASS_WITH_WARNINGS'].includes(check.verdict)) throw new Error('Invalid source check result')
      return check.rows.filter(row => row.level === 'OK').length
    }],
    // 3.2.3 · R1：校对协议要有**当次**的定向证据（全量里也跑，但这里要能单独追责）。
    ['proofread.protocol', ['tests/build-test.mjs', 'proofreadProtocol'], 180000, result => {
      const summary = /proofreadProtocol 用例结束：(\d+) 通过 \/ (\d+) 失败/.exec(result.out)
      if (!summary) throw new Error('Protocol suite printed no summary')
      if (Number(summary[2]) !== 0) throw new Error('Protocol suite has failing assertions')
      return Number(summary[1])
    }],
    // 3.2.3 · R2：候选应用的**真实进程终止**与重启核对（不是内存异常冒充崩溃）。
    ['revision.recovery', ['tests/build-test.mjs', 'candidateCrash'], 300000, result => {
      const summary = /candidateCrash：(\d+) 通过 \/ (\d+) 失败/.exec(result.out)
      if (!summary) throw new Error('Crash suite printed no summary')
      if (Number(summary[2]) !== 0) throw new Error('Crash suite has failing assertions')
      return Number(summary[1])
    }],
  ]
  try {
    for (const [id, args, timeoutMs, inspect] of steps) {
      if (!ready || signal?.aborted) { record(id, 'not-run', 0, 'Prerequisite failed or run cancelled'); continue }
      ready = await command(id, args, timeoutMs, inspect)
    }
  } finally {
    for (const contract of contracts) if (!results.some(result => result.id === contract.id)) record(contract.id,
      stage === 'foundation' ? 'not-run' : 'blocked', 0, contract.pending ?? 'Not implemented in stage A')
    const after = await captureInputs(realRoot)
    if (after.combined !== inputs.combined) {
      for (const result of results) if (result.status === 'passed') { result.status = 'blocked'; result.reason = 'Inputs changed during execution; evidence stale' }
    }
    const evidenceFiles = []
    for (const result of results) if (result.status === 'passed') for (const file of result.evidencePaths) {
      try { await fs.access(path.join(runRoot, file)); evidenceFiles.push(file) } catch { result.status = 'failed'; result.reason = 'Missing evidence ' + file }
    }
    if (evidenceFiles.length) report.artifacts = await hashPaths(runRoot, evidenceFiles)
    report.finishedAt = new Date().toISOString()
    report.verdict = scopeVerdict(contracts, results, stage)
    report.localVerdict = scopeVerdict(contracts, results)
    await writeReports(runRoot, report)
  }
  console.log('RELIABILITY_REPORT ' + JSON.stringify({ runRoot, stage, exitCode: report.verdict.code, localExitCode: report.localVerdict.code }))
  return report
}

async function main() {
  const args = process.argv.slice(2)
  let stage = 'local', profile = 'local', list = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--stage' || args[i] === '--profile') {
      const option = args[i], value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(option + ' requires a value')
      if (option === '--stage') stage = value; else profile = value
    }
    else if (args[i] === '--list') list = true
    else if (args[i] === '--help') { console.log('reliability.mjs --profile local [--stage foundation] [--list]\nPackaged/extended execution is not implemented; no packaging or deployment is performed.'); return }
    else throw new Error('Unknown argument ' + args[i])
  }
  if (profile !== 'local') { console.error('BLOCKED: packaged/extended adapters are not implemented'); process.exitCode = 2; return }
  if (!['local', 'foundation'].includes(stage)) throw new Error('stage must be local or foundation')
  if (list) { console.log(JSON.stringify(PLAN, null, 2)); return }
  const controller = new AbortController(), abort = () => controller.abort()
  process.on('SIGINT', abort); process.on('SIGTERM', abort)
  try { process.exitCode = (await verify({ stage, signal: controller.signal })).verdict.code }
  finally { process.off('SIGINT', abort); process.off('SIGTERM', abort) }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1 })
}
