import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

// 3.2.3 · R4：web-cloud（真实本地服务 + 临时账号）取证校验。
// 只认「本次构建 + 本次源码 + 全套场景 + 隔离目录 + 产物哈希」；
// 账号必须是探针自建的临时账号（前缀 probe-）——生产账号哪怕跑通了也不算证据。
export const WEB_CLOUD_CASE_IDS = [
  'page-renders-account', 'initial-flags', 'boot-store', 'write-readback', 'data-scoped-to-account',
  'backend-selection', 'restart-readback-write', 'restart-readback',
  'two-accounts', 'same-browser-account-switch', 'switch-back-restores-own-data',
  'expired-session', 'stale-write-did-not-land', 'guest-never-writes-server', 'guest-to-account',
  'guest-local-data-intact',
  // write-failure：配额 413 与服务端写盘 500 —— 三个必需子场景必须各自有检查项
  'write-failure-seed', 'write-failure-fixture', 'quota-rejected-visible', 'quota-preserves-draft',
  'quota-not-persisted', 'server-error-visible', 'failure-preserves-draft', 'accepted-vs-persisted',
  'retry-readback', 'recovery-visible',
  // 端到端往返：浏览器真实下载 → 改库落盘 → 真实选文件导入 → 回读
  'roundtrip-export', 'roundtrip-changed', 'roundtrip-import-readback',
  // roundtrip 四子场景（3.2.6）：侧车内联/拆回、密钥剥离、格式版本闸、损坏文件
  'sidecars.seeded', 'sidecars.inlined-on-export', 'sidecars.restored-after-import',
  'secret-stripping.secret-present-before', 'secret-stripping.absent-after-export',
  'schema-version.reject-newer', 'schema-version.data-unchanged',
  'restore-failure.corrupt-rejected', 'restore-failure.data-unchanged',
  'two-tabs-conditional-write', 'stale-save-rejected', 'conflict-keeps-draft', 'conflict-preserves-server',
  'conflict-export', 'conflict-stops-retry', 'conflict-leave-blocked',
  'no-pageerror', 'unchanged-inputs',
]
export const WEB_CLOUD_ARTIFACTS = ['server.log', 'conflict-export.json', 'conflict.png']
const within = (root, file) => {
  const relative = path.relative(root, file)
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

export async function validateWebCloudEvidence(root, file, { expectedBuildHash, expectedSourceFingerprint }) {
  const result = JSON.parse(await fs.readFile(file, 'utf8'))
  if (result.profile !== 'web-cloud' || result.failed !== 0 || result.error !== null
    || !Array.isArray(result.pageErrors) || result.pageErrors.length) throw new Error('Web-cloud runtime did not pass')
  if (result.sourceFingerprint !== expectedSourceFingerprint || result.buildManifest?.sha256 !== expectedBuildHash) {
    throw new Error('Web-cloud source or build evidence is stale')
  }
  if (!Array.isArray(result.checks) || result.passed !== result.checks.length
    || new Set(result.checks.map(item => item.id)).size !== result.checks.length
    || result.checks.some(item => item.passed !== true)
    || WEB_CLOUD_CASE_IDS.some(id => !result.checks.some(item => item.id === id))) {
    throw new Error('Web-cloud cases missing, duplicated, or failed')
  }
  // 临时账号：探针自建、带 probe- 前缀；生产账号一律不认
  if (typeof result.scope !== 'string' || !/throwaway accounts/.test(result.scope)) {
    throw new Error('Web-cloud evidence does not declare throwaway accounts')
  }
  const temporaryRoot = await fs.realpath(path.join(root, '.workbuddy/tmp'))
  const runRoot = await fs.realpath(result.runRoot)
  if (!within(temporaryRoot, runRoot) || !path.basename(runRoot).startsWith('web-cloud-save-')) throw new Error('Web-cloud data is not isolated')
  // 隔离数据目录必须落在本次临时目录里（否则可能写到了真实数据根）
  const dataDir = path.join(runRoot, 'server-data')
  await fs.access(dataDir)
  if (!Array.isArray(result.artifacts)) throw new Error('Web-cloud artifacts missing')
  for (const name of WEB_CLOUD_ARTIFACTS) {
    if (result.artifacts.filter(item => path.resolve(root, item.path) === path.join(runRoot, name)).length !== 1) {
      throw new Error('Web-cloud artifact missing or duplicated: ' + name)
    }
  }
  for (const artifact of result.artifacts) {
    const actual = await fs.realpath(path.resolve(root, artifact.path))
    if (!within(runRoot, actual)) throw new Error('Web-cloud artifact escapes run directory')
    if (createHash('sha256').update(await fs.readFile(actual)).digest('hex') !== artifact.sha256) {
      throw new Error('Web-cloud artifact hash mismatch')
    }
  }
  return { assertions: result.checks.length, result }
}
