import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

const digest = data => createHash('sha256').update(data).digest('hex')
const normalized = value => value.split(path.sep).join('/')

export async function hashPaths(root, paths) {
  const files = []
  async function walk(relative) {
    const full = path.resolve(root, relative)
    const stat = await fs.lstat(full)
    if (stat.isSymbolicLink()) throw new Error('Fingerprint input must not be a symlink: ' + relative)
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(full)).sort()) {
        // Generated test bundles are not source inputs.
        if (name === 'node_modules' || name === '.git' || (normalized(relative).startsWith('tests') && name.startsWith('.') && /\.(mjs|map)$/.test(name))) continue
        await walk(path.join(relative, name))
      }
    } else if (stat.isFile()) files.push(normalized(relative))
  }
  for (const relative of paths) {
    if (path.isAbsolute(relative) || path.relative(root, path.resolve(root, relative)).startsWith('..')) throw new Error('Fingerprint input escapes root')
    await walk(relative)
  }
  const entries = []
  for (const file of [...new Set(files)].sort()) entries.push({ path: file, sha256: digest(await fs.readFile(path.join(root, file))) })
  if (!entries.length) throw new Error('Empty fingerprint input')
  return { sha256: digest(JSON.stringify(entries)), count: entries.length, entries }
}

export async function captureInputs(root) {
  const source = await hashPaths(root, ['src', 'electron'])
  const platform = await hashPaths(root, ['src', 'electron', 'server', 'build', 'package.json', 'package-lock.json', 'vite.config.ts', 'electron-builder.yml'])
  const tools = await hashPaths(root, ['scripts', 'tests', 'tsconfig.json', 'eslint.config.js', 'postcss.config.js'])
  return { source, platform, tools, combined: digest(JSON.stringify([source.sha256, platform.sha256, tools.sha256])) }
}

export function scopeVerdict(contracts, results, stage = 'local') {
  if (!contracts.length || new Set(contracts.map(item => item.id)).size !== contracts.length || contracts.some(item => !item.id || !item.stage || !Number.isInteger(item.minAssertions) || item.minAssertions < 1)) return { code: 1, reason: 'invalid, empty or duplicate contract plan' }
  if (new Set(results.map(item => item.id)).size !== results.length || results.some(item => !contracts.some(c => c.id === item.id))) return { code: 1, reason: 'duplicate or unknown result' }
  const required = contracts.filter(item => stage === 'local' || item.stage === stage)
  if (!required.length) return { code: 1, reason: 'empty required scope' }
  let incomplete = false
  for (const contract of required) {
    const result = results.find(item => item.id === contract.id)
    if (!result) { incomplete = true; continue }
    if (result.status === 'failed') return { code: 1, reason: contract.id + ' failed' }
    if (['blocked', 'not-run'].includes(result.status)) { incomplete = true; continue }
    if (result.status !== 'passed' || !Number.isInteger(result.assertions) || result.assertions < contract.minAssertions) return { code: 1, reason: contract.id + ' invalid evidence or zero assertions' }
  }
  return { code: incomplete ? 2 : 0, reason: incomplete ? 'required evidence incomplete' : 'selected scope passed' }
}

const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])
export async function writeReports(runRoot, report) {
  await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2))
  const lines = ['# Reliability verification', '', 'Scope: ' + report.stage, 'Selected exit code: ' + report.verdict.code,
    'Full local exit code: ' + report.localVerdict.code, 'Input hash: ' + report.inputs.combined,
    '', 'Foundation evidence is not full product or release acceptance.', '', '| Contract | Status | Assertions | Detail |', '|---|---|---|---|']
  for (const item of report.results) lines.push('| ' + item.id + ' | ' + item.status + ' | ' + item.assertions + ' | ' + String(item.reason ?? '').replace(/[|\r\n]/g, ' ') + ' |')
  await fs.writeFile(path.join(runRoot, 'report.md'), lines.join('\n') + '\n')
  const cases = report.results.map(item => '<testcase name="' + xml(item.id) + '">' + (item.status === 'failed'
    ? '<failure message="' + xml(item.reason) + '"/>' : item.status === 'passed' ? '' : '<skipped message="' + xml(item.reason) + '"/>') + '</testcase>')
  await fs.writeFile(path.join(runRoot, 'junit.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="reliability" tests="' + report.results.length + '" failures="' + report.results.filter(r => r.status === 'failed').length + '" skipped="' + report.results.filter(r => ['blocked', 'not-run'].includes(r.status)).length + '">' + cases.join('') + '</testsuite>\n')
  await fs.writeFile(path.join(runRoot, 'coverage-ledger.json'), JSON.stringify({ schemaVersion: 1, stage: report.stage,
    inputHash: report.inputs.combined, complete: report.localVerdict.code === 0,
    planned: report.results.length, counts: Object.fromEntries(['passed', 'failed', 'blocked', 'not-run'].map(status => [status, report.results.filter(item => item.status === status).length])) }, null, 2))
}
