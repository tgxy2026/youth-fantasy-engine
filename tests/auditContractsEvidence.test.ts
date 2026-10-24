import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { validateAuditBundle } from '../scripts/verify/audit-contracts.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yfe-audit-bundle-'))
const dir = path.join(root, '.workbuddy/tmp/bundle')
const expected = { inputHash: 'current-tools', sourceFingerprint: 'current-source' }
const ids = ['preset.routes', 'io.roundtrip', 'draft.failure', 'mono.rendered']
const legacy = ['scan', 'dead', 'graph', 'arch', 'content', 'prompt', 'ui', 'func', 'sec', 'coverage', 'label-consistency']
const cases: Record<string, string[]> = { 'preset.routes': ['new', 'edit'], 'io.roundtrip': ['legacy-name', 'duplicate', 'roundtrip'], 'draft.failure': ['save-failure', 'preserve-selection', 'preserve-storage'], 'mono.rendered': ['chart-a', 'chart-b'] }
const contracts = { required: ['headers.case', 'headers.syntax', ...ids].map(id => ({ id })), charts: cases['mono.rendered'] }
const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex')
const processOK = { ok: true, exitCode: 0, signal: null, timedOut: false, aborted: false, outputLimit: false, error: null, cleanupComplete: true }
let passed = 0
try {
  await fs.mkdir(dir, { recursive: true }); await fs.mkdir(path.join(root, 'scripts/audit'), { recursive: true })
  const contractFile = path.join(root, 'scripts/audit/contracts.json')
  await fs.writeFile(contractFile, JSON.stringify(contracts))
  const raw: Record<string, unknown> = {
    'report.json': { status: 'complete', sourceFingerprint: expected.sourceFingerprint, contracts: contracts.required.map(row => ({ ...row, status: 'passed' })), diagnostics: [], static: { findings: [] }, legacy: legacy.map(name => ({ name, status: 'executed', code: 0 })) },
    'evidence.json': { ...expected, sourceFingerprint: expected.sourceFingerprint, checks: ids.map(id => ({ id, status: 'passed', samples: cases[id].length, cases: cases[id], artifact: path.relative(root, path.join(dir, id + '.json')), ...(id === 'mono.rendered' ? { theme: 'mono' } : {}) })), runs: ids.map(id => ({ id, ...processOK })) },
  }
  for (const id of ids) raw[id + '.json'] = { contract: id, samples: cases[id].length, passed: cases[id].length, failed: 0, ...(id === 'mono.rendered' ? { theme: 'mono', results: cases[id].map(file => ({ file, ok: true, painted: 4, violations: [], unknownCount: 0 })), pageErrors: [] } : { cases: cases[id].map(name => ({ ok: true, ...(id === 'preset.routes' ? { route: name } : { case: name }) })) }) }
  const strings = ['producer-evidence.json', 'producer.log', 'audit.log', 'draft.failure.png', 'mono.rendered.png', ...ids.map(id => id + '.log'), ...legacy.map(name => 'legacy-' + name + '.log')]
  for (const [name, value] of Object.entries(raw)) await fs.writeFile(path.join(dir, name), JSON.stringify(value))
  for (const name of strings) await fs.writeFile(path.join(dir, name), '{}')
  const base = { kind: 'audit-contracts', status: 'passed', ...expected, contractsHash: hash(await fs.readFile(contractFile)), processes: ['producer', 'audit'].map(id => ({ id, ...processOK })) }
  async function seal(extra = {}) {
    const artifacts = []
    for (const name of await fs.readdir(dir)) if (name !== 'result.json') artifacts.push({ path: path.relative(root, path.join(dir, name)), sha256: hash(await fs.readFile(path.join(dir, name))) })
    await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ ...base, artifacts, ...extra }))
  }
  await seal()
  assert.equal(await validateAuditBundle(root, dir, expected), 6); passed++; console.log('PASS 本轮完整契约与原始产物可接收')
  async function reject(name: string, action: () => Promise<void>, reset: () => Promise<void>) {
    await action(); await assert.rejects(() => validateAuditBundle(root, dir, expected)); passed++; console.log('PASS ' + name); await reset()
  }
  for (const extra of [
    { status: 'failed' }, { sourceFingerprint: 'old' }, { inputHash: 'old' }, { contractsHash: 'old' },
    { processes: [{ id: 'producer', ...processOK }, { id: 'audit', ...processOK, signal: 'SIGTERM' }] },
  ]) await reject('失败/旧指纹/旧契约/信号退出不能通过', () => seal(extra), () => seal())
  async function mutate(name: string, value: unknown) {
    await fs.writeFile(path.join(dir, name), JSON.stringify(value)); await seal()
  }
  for (const [name, value, label] of [
    ['report.json', { ...(raw['report.json'] as object), status: 'incomplete' }, '审计不完整不接收'],
    ['report.json', { ...(raw['report.json'] as object), contracts: contracts.required.slice(1).map(row => ({ ...row, status: 'passed' })) }, '少一个必要契约不能通过'],
    ['report.json', { ...(raw['report.json'] as object), diagnostics: [{ status: 'blocked' }] }, '诊断受阻不能通过'],
    ['report.json', { ...(raw['report.json'] as object), legacy: [] }, '漏旧扫描器不能通过'],
    ['report.json', { ...(raw['report.json'] as object), static: { findings: [{ disposition: 'unreviewed' }] } }, '未复核候选不能通过'],
    ['evidence.json', { ...(raw['evidence.json'] as object), checks: [] }, '缺运行证据不能通过'],
    ['mono.rendered.json', { contract: 'mono.rendered', samples: 1, passed: 1, failed: 0, theme: 'mono', results: [{ file: 'chart-a', ok: true, painted: 4, violations: [], unknownCount: 0 }] }, '声明覆盖全部但实际少图表不能通过'],
    ['mono.rendered.json', { contract: 'mono.rendered', samples: 2, passed: 2, failed: 0, theme: 'mono', results: cases['mono.rendered'].map(file => ({ file, ok: true, painted: 0, violations: [], unknownCount: 0 })) }, '无绘制样本不能通过'],
    ['preset.routes.json', { contract: 'preset.routes', samples: 2, passed: 2, failed: 0, cases: [{ route: 'new', ok: true }, { route: 'new', ok: true }] }, '只有新增入口不能冒充新增和编辑'],
  ] as const) await reject(label, () => mutate(name, value), () => mutate(name, raw[name]))
  await reject('哈希被改动不得接收', () => fs.writeFile(path.join(dir, 'audit.log'), 'tampered'), async () => { await fs.writeFile(path.join(dir, 'audit.log'), '{}'); await seal() })
  await reject('遗漏产物不能通过', () => fs.unlink(path.join(dir, 'audit.log')), async () => { await fs.writeFile(path.join(dir, 'audit.log'), '{}'); await seal() })
  const result = JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8'))
  await reject('重复产物不能通过', () => seal({ artifacts: [...result.artifacts, result.artifacts[0]] }), () => seal())
  await fs.writeFile(path.join(root, 'outside.log'), 'outside')
  await reject('越界产物不能通过', () => seal({ artifacts: [...result.artifacts, { path: 'outside.log', sha256: hash('outside') }] }), () => seal())
  console.log('auditContractsEvidence: ' + passed + ' passed')
} finally {
  const target = await fs.realpath(root)
  if (path.dirname(target) !== await fs.realpath(os.tmpdir()) || !path.basename(target).startsWith('yfe-audit-bundle-')) throw new Error('Unsafe fixture cleanup')
  await fs.rm(target, { recursive: true })
}
