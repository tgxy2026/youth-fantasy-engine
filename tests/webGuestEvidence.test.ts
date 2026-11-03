import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { GUEST_CASE_IDS, validateGuestEvidence, type GuestRuntimeResult } from '../scripts/verify/web-guest-evidence.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yfe-guest-evidence-'))
const runRoot = path.join(root, '.workbuddy/tmp/web-guest-save-fixture')
const file = path.join(root, 'result.json')
const expected = { expectedBuildHash: 'build-fixture', expectedSourceFingerprint: 'source-fixture' }
const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex')
let passed = 0
async function rejects(name: string, value: GuestRuntimeResult) {
  await fs.writeFile(file, JSON.stringify(value))
  await assert.rejects(() => validateGuestEvidence(root, file, expected))
  passed++; console.log('PASS ' + name)
}
try {
  await fs.mkdir(runRoot, { recursive: true })
  const artifacts = []
  for (const name of ['quota-failure.png', 'abort-failure.png', 'restart-readback.png', 'chapter-readback.json', 'server.log']) {
    await fs.writeFile(path.join(runRoot, name), 'fixture-' + name)
    artifacts.push({ path: path.relative(root, path.join(runRoot, name)), sha256: hash('fixture-' + name) })
  }
  const good: GuestRuntimeResult = { profile: 'web-guest', runRoot, sourceFingerprint: expected.expectedSourceFingerprint,
    buildManifest: { sha256: expected.expectedBuildHash }, passed: GUEST_CASE_IDS.length, failed: 0, error: null,
    pageErrors: [], checks: GUEST_CASE_IDS.map(id => ({ id, passed: true })), artifacts }
  await fs.writeFile(file, JSON.stringify(good))
  assert.equal((await validateGuestEvidence(root, file, expected)).assertions, GUEST_CASE_IDS.length)
  passed++; console.log('PASS 当前指纹、构建、场景与产物一致才接收')
  await rejects('旧源码证据不能重用', { ...good, sourceFingerprint: 'stale' })
  await rejects('旧构建不能冒充本次构建', { ...good, buildManifest: { sha256: 'stale' } })
  await rejects('少场景即使退出零也不能过', { ...good, checks: good.checks.slice(1), passed: good.passed - 1 })
  await rejects('重复场景不能凑数量', { ...good, checks: [...good.checks.slice(1), good.checks[1]] })
  await rejects('单场景失败不接受', { ...good, checks: good.checks.map((item, index) => index ? item : { ...item, passed: false }) })
  await rejects('未捕获页面异常不接受', { ...good, pageErrors: ['unhandled error'] })
  await rejects('错误状态不接受', { ...good, error: 'runtime interrupted', failed: 1 })
  await rejects('无截图与存储快照不接受', { ...good, artifacts: [] })
  await fs.writeFile(path.join(runRoot, 'server.log'), 'changed')
  await rejects('产物内容被改动不接受', good)
  await fs.writeFile(path.join(runRoot, 'server.log'), 'fixture-server.log')
  await fs.unlink(path.join(runRoot, 'quota-failure.png'))
  await rejects('产物缺失不接受', good)
  await fs.writeFile(path.join(runRoot, 'quota-failure.png'), 'fixture-quota-failure.png')
  await fs.writeFile(path.join(root, 'outside.txt'), 'outside')
  await rejects('产物不得指向隔离目录之外', { ...good, artifacts: [...artifacts, { path: 'outside.txt', sha256: hash('outside') }] })
  await rejects('测试资料不得使用非隔离路径', { ...good, runRoot: root })
  console.log('webGuestEvidence: ' + passed + ' passed')
} finally {
  const target = await fs.realpath(root)
  if (path.dirname(target) !== await fs.realpath(os.tmpdir()) || !path.basename(target).startsWith('yfe-guest-evidence-')) throw new Error('Refusing unsafe fixture cleanup')
  await fs.rm(target, { recursive: true })
}
