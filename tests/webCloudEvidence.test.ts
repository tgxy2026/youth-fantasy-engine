// 3.2.3 · R4：web-cloud 证据闸 —— 只认「本次构建 + 本次源码 + 全套场景 + 临时账号 + 隔离目录」
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { WEB_CLOUD_CASE_IDS, WEB_CLOUD_ARTIFACTS, validateWebCloudEvidence, type WebCloudRuntimeResult } from '../scripts/verify/web-cloud-evidence.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yfe-cloud-evidence-'))
const runRoot = path.join(root, '.workbuddy/tmp/web-cloud-save-fixture')
const file = path.join(root, 'result.json')
const expected = { expectedBuildHash: 'build-fixture', expectedSourceFingerprint: 'source-fixture' }
const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex')
const SCOPE = 'fixture; throwaway accounts; isolated data dir'
let passed = 0
async function rejects(name: string, value: WebCloudRuntimeResult) {
  await fs.writeFile(file, JSON.stringify(value))
  await assert.rejects(() => validateWebCloudEvidence(root, file, expected))
  passed++
  console.log('PASS ' + name)
}
try {
  await fs.mkdir(path.join(runRoot, 'server-data'), { recursive: true })
  const artifacts = []
  for (const name of WEB_CLOUD_ARTIFACTS) {
    const full = path.join(runRoot, name)
    await fs.writeFile(full, 'fixture-' + name)
    artifacts.push({ path: path.relative(root, full), sha256: hash('fixture-' + name) })
  }
  const good: WebCloudRuntimeResult = {
    schemaVersion: 1, profile: 'web-cloud', scope: SCOPE, runRoot,
    sourceFingerprint: expected.expectedSourceFingerprint, build: 'build', buildManifest: { sha256: expected.expectedBuildHash },
    at: new Date().toISOString(), passed: WEB_CLOUD_CASE_IDS.length, failed: 0,
    checks: WEB_CLOUD_CASE_IDS.map(id => ({ id, passed: true })), artifacts, pageErrors: [], error: null,
  }
  await fs.writeFile(file, JSON.stringify(good))
  assert.equal((await validateWebCloudEvidence(root, file, expected)).assertions, WEB_CLOUD_CASE_IDS.length)
  passed++
  console.log('PASS 当前构建与完整证据接收')
  await rejects('其他配置不能冒充云端', { ...good, profile: 'web-guest' })
  await rejects('源码过期', { ...good, sourceFingerprint: 'stale' })
  await rejects('构建过期', { ...good, buildManifest: { sha256: 'stale' } })
  await rejects('缺少账号隔离场景', { ...good, checks: good.checks.filter(item => item.id !== 'two-accounts'), passed: good.passed - 1 })
  await rejects('缺少过期会话场景', { ...good, checks: good.checks.filter(item => item.id !== 'expired-session'), passed: good.passed - 1 })
  await rejects('重复场景不能凑数', { ...good, checks: [...good.checks.slice(1), good.checks[1]] })
  await rejects('有失败场景', { ...good, checks: good.checks.map((item, index) => index ? item : { ...item, passed: false }) })
  await rejects('页面异常', { ...good, pageErrors: ['unhandled'] })
  await rejects('错误状态', { ...good, error: 'interrupted', failed: 1 })
  await rejects('未声明临时账号', { ...good, scope: 'production accounts' })
  await rejects('产物缺失', { ...good, artifacts: [] })
  await rejects('产物重复', { ...good, artifacts: [...artifacts, artifacts[0]] })
  await fs.writeFile(path.join(runRoot, 'server.log'), 'changed')
  await rejects('哈希不符', good)
  await fs.writeFile(path.join(runRoot, 'server.log'), 'fixture-server.log')
  await fs.writeFile(path.join(root, 'outside.txt'), 'outside')
  await rejects('越界产物', { ...good, artifacts: [...artifacts, { path: 'outside.txt', sha256: hash('outside') }] })
  await rejects('非隔离资料区', { ...good, runRoot: root })
  const otherPrefix = path.join(root, '.workbuddy/tmp/guest-save-fixture')
  await fs.mkdir(path.join(otherPrefix, 'server-data'), { recursive: true })
  await rejects('目录前缀不符', { ...good, runRoot: otherPrefix })
  console.log('webCloudEvidence: ' + passed + ' passed')
} finally {
  const target = await fs.realpath(root)
  if (path.dirname(target) !== await fs.realpath(os.tmpdir()) || !path.basename(target).startsWith('yfe-cloud-evidence-')) throw new Error('Refusing unsafe fixture cleanup')
  await fs.rm(target, { recursive: true })
}
