import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { DESKTOP_CASE_IDS, DESKTOP_ARTIFACTS, validateDesktopEvidence } from '../scripts/verify/desktop-evidence.mjs'
import type { GuestRuntimeResult } from '../scripts/verify/web-guest-evidence.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yfe-desktop-evidence-'))
const runRoot = path.join(root, '.workbuddy/tmp/desktop-save-fixture'), file = path.join(root, 'result.json')
const expected = { expectedBuildHash: 'build-fixture', expectedSourceFingerprint: 'source-fixture' }
const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex')
let passed = 0
async function rejects(name: string, value: GuestRuntimeResult) {
  await fs.writeFile(file, JSON.stringify(value))
  await assert.rejects(() => validateDesktopEvidence(root, file, expected))
  passed++; console.log('PASS ' + name)
}
try {
  await fs.mkdir(runRoot, { recursive: true })
  const artifacts = []
  const semanticFixtures: Record<string, unknown> = {
    'save-barriers.json': ['install-blocker', 'remove-blocker'].map(phase => ({ phase, paused: true, active: 0, at: 1, mutatedAt: 2 })),
    'chapter-readback.json': { content: 'saved draft' },
    'ipc-before-restart.json': [{ channel: 'store:save', result: { ok: true }, body: 'saved draft', diskAtReturn: { body: 'saved draft' } }],
    'filesystem-before-restart.json': [{ name: 'rename', error: 'EPERM' }, { name: 'rename', ok: true }],
  }
  for (const name of DESKTOP_ARTIFACTS) {
    const bytes = name in semanticFixtures ? JSON.stringify(semanticFixtures[name]) : 'fixture-' + name
    await fs.writeFile(path.join(runRoot, name), bytes)
    artifacts.push({ path: path.relative(root, path.join(runRoot, name)), sha256: hash(bytes) })
  }
  const good: GuestRuntimeResult = { profile: 'desktop', runRoot, sourceFingerprint: expected.expectedSourceFingerprint,
    buildManifest: { sha256: expected.expectedBuildHash }, passed: DESKTOP_CASE_IDS.length, failed: 0, error: null,
    pageErrors: [], checks: DESKTOP_CASE_IDS.map(id => ({ id, passed: true })), artifacts }
  await fs.writeFile(file, JSON.stringify(good))
  assert.equal((await validateDesktopEvidence(root, file, expected)).assertions, DESKTOP_CASE_IDS.length)
  passed++; console.log('PASS 当前构建与完整证据接收')
  await rejects('其他配置不能冒充桌面', { ...good, profile: 'web-guest' })
  await rejects('源码过期', { ...good, sourceFingerprint: 'stale' })
  await rejects('构建过期', { ...good, buildManifest: { sha256: 'stale' } })
  await rejects('缺少故障导出场景', { ...good, checks: good.checks.filter(item => item.id !== 'failure-export'), passed: good.passed - 1 })
  await rejects('重复场景不能凑数', { ...good, checks: [...good.checks.slice(1), good.checks[1]] })
  await rejects('失败场景', { ...good, checks: good.checks.map((item, index) => index ? item : { ...item, passed: false }) })
  await rejects('页面异常', { ...good, pageErrors: ['unhandled'] })
  await rejects('错误状态', { ...good, error: 'interrupted', failed: 1 })
  await rejects('导出文件不得缺失', { ...good, artifacts: artifacts.filter(item => !item.path.endsWith('failure-export.json')) })
  await rejects('产物不得重复', { ...good, artifacts: [...artifacts, artifacts[0]] })
  await fs.writeFile(path.join(runRoot, 'electron.log'), 'changed')
  await rejects('哈希不符', good)
  await fs.writeFile(path.join(runRoot, 'electron.log'), 'fixture-electron.log')
  await fs.unlink(path.join(runRoot, 'write-failure.png'))
  await rejects('截图文件缺失', good)
  await fs.writeFile(path.join(runRoot, 'write-failure.png'), 'fixture-write-failure.png')
  await fs.writeFile(path.join(root, 'outside.txt'), 'outside')
  await rejects('越界产物', { ...good, artifacts: [...artifacts, { path: 'outside.txt', sha256: hash('outside') }] })
  await rejects('非隔离资料区', { ...good, runRoot: root })
  for (const [name, value, label] of [
    ['save-barriers.json', [{ phase: 'install-blocker', paused: true, active: 1, at: 1, mutatedAt: 2 }, { phase: 'remove-blocker', paused: true, active: 0, at: 3, mutatedAt: 4 }], '有写入在途时不得撤挡板'],
    ['ipc-before-restart.json', [{ channel: 'store:save', result: { ok: true }, body: 'saved draft', diskAtReturn: { body: 'saved draft' } }, { channel: 'store:save', result: { ok: true }, body: 'saved draft', diskAtReturn: { error: 'ENOENT' } }], '一次成功不能掩盖另一次IPC成功但磁盘无文件'],
    ['filesystem-before-restart.json', [{ name: 'rename', ok: true }], '没有真实rename失败不能通过'],
  ] as const) {
    const bytes = JSON.stringify(value)
    await fs.writeFile(path.join(runRoot, name), bytes)
    await rejects(label, { ...good, artifacts: artifacts.map(item => item.path === path.relative(root, path.join(runRoot, name)) ? { ...item, sha256: hash(bytes) } : item) })
    await fs.writeFile(path.join(runRoot, name), JSON.stringify(semanticFixtures[name]))
  }
  console.log('desktopEvidence: ' + passed + ' passed')
} finally {
  const target = await fs.realpath(root)
  if (path.dirname(target) !== await fs.realpath(os.tmpdir()) || !path.basename(target).startsWith('yfe-desktop-evidence-')) throw new Error('Refusing unsafe fixture cleanup')
  await fs.rm(target, { recursive: true })
}
