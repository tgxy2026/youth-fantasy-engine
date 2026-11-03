// npm test / historical run-all entry: asynchronous, same A/B/C/D manifest as PS/Bash.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTestPlan } from '../scripts/verify/test-plan.mjs'
import { runProcess } from '../scripts/verify/process.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function runTests({ root = ROOT, batches = ['all'], reportPath, signal } = {}) {
  if (reportPath && !reportPath.endsWith('.json')) throw new Error('Test report path must end with .json')
  const plan = readTestPlan(root, batches)
  const startedAt = new Date().toISOString()
  const results = []
  for (const job of plan.jobs) {
    if (signal?.aborted) {
      results.push({ id: job.id, batch: job.batch, status: 'not-run', reason: 'cancelled' })
      continue
    }
    const result = await runProcess(process.execPath, [path.join(root, 'tests', job.file), ...job.args], {
      cwd: root, env: { ...process.env, YFE_TEST_QUIET: '1' }, timeoutMs: 180000, signal,
    })
    results.push({ id: job.id, batch: job.batch, status: result.ok ? 'passed' : 'failed', ...result })
    console.log((result.ok ? 'PASS' : 'FAIL') + ' [' + job.batch + '] ' + job.id + ' (' + result.durationMs + 'ms)')
    if (!result.ok) console.log(result.error ?? (result.out.slice(-5000) || 'exit=' + result.exitCode + ' signal=' + result.signal + ' timeout=' + result.timedOut))
  }
  const passed = results.filter(item => item.status === 'passed').length
  const failed = results.filter(item => item.status === 'failed').length
  const notRun = results.filter(item => item.status === 'not-run').length
  const report = { schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(), actualEntries: plan.actualEntries,
    planned: plan.jobs.length, passed, failed, notRun, batchIds: plan.batchIds, results,
    ok: passed === plan.jobs.length && failed === 0 && notRun === 0 && plan.jobs.length > 0 }
  if (reportPath) {
    const target = path.resolve(reportPath)
    if (!target.endsWith('.json')) throw new Error('Test report path must end with .json')
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target + '.part', JSON.stringify(report, null, 2))
    await fs.rename(target + '.part', target)
  }
  console.log('TEST_RESULTS_JSON ' + JSON.stringify({ planned: report.planned, passed, failed, notRun, actualEntries: plan.actualEntries, ok: report.ok }))
  return report
}

async function main() {
  const args = process.argv.slice(2), batches = []
  let reportPath, list = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--report') {
      reportPath = args[++i]
      if (!reportPath || reportPath.startsWith('--') || !reportPath.endsWith('.json')) throw new Error('--report requires a .json path')
    } else if (args[i] === '--list') list = true
    else if (/^(all|[A-D])$/.test(args[i])) batches.push(args[i])
    else throw new Error('Unknown argument ' + args[i])
  }
  if (list) { console.log(JSON.stringify(readTestPlan(ROOT, batches), null, 2)); return }
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.on('SIGINT', abort); process.on('SIGTERM', abort)
  try { process.exitCode = (await runTests({ batches, reportPath, signal: controller.signal })).ok ? 0 : 1 }
  finally { process.off('SIGINT', abort); process.off('SIGTERM', abort) }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1 })
}
