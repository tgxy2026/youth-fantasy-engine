import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

/**
 * 「在途编辑 / 切项目 / 关窗写失败」三端证据校验（3.2.6 · storage.four-profiles 最后一块）。
 *
 * 🔴 只认**本次真跑出来**的结果：指纹/构建哈希要对得上、场景清单要三个都在、
 *    每个场景要求的检查项一条都不能少、artifact 哈希要能对上 —— 少一样就不算过。
 *    脚本退出码 0 不等于证据成立（本轮踩过太多"跑过了但没测到"）。
 */
export const INFLIGHT_REQUIRED = {
  portable: [
    'inflight-edit.in-flight-during-edit', 'inflight-edit.file-valid', 'inflight-edit.ui-latest', 'inflight-edit.no-late-clobber',
    'project-switch.in-flight-during-switch', 'project-switch.write-landed', 'project-switch.other-untouched', 'project-switch.reopen-readback',
    'close-write-failure.failure-visible', 'close-write-failure.file-valid', 'close-write-failure.old-or-new', 'close-write-failure.not-empty',
    'close-write-failure.reopen-readback', 'close-write-failure.no-false-error',
    'no-pageerror', 'unchanged-inputs',
  ],
  'web-guest': [
    'inflight-edit.in-flight-during-edit', 'inflight-edit.persisted-latest', 'inflight-edit.ui-latest', 'inflight-edit.no-late-clobber',
    'project-switch.in-flight-during-switch', 'project-switch.write-landed', 'project-switch.other-untouched', 'project-switch.reopen-readback',
    'close-write-failure.failure-visible', 'close-write-failure.old-or-new', 'close-write-failure.not-empty',
    'close-write-failure.reopen-readback',
    'no-pageerror', 'unchanged-inputs',
  ],
  desktop: [
    'inflight-edit.in-flight-during-edit', 'inflight-edit.file-valid', 'inflight-edit.ui-latest', 'inflight-edit.no-late-clobber',
    'project-switch.in-flight-during-switch', 'project-switch.write-landed', 'project-switch.other-untouched', 'project-switch.reopen-readback',
    'close-write-failure.failure-visible', 'close-write-failure.blocker-still-blocked', 'close-write-failure.file-valid',
    'close-write-failure.old-or-new', 'close-write-failure.reopen-readback', 'close-write-failure.no-false-error',
    'no-pageerror', 'unchanged-inputs',
  ],
}
const SCENARIOS = ['inflight-edit', 'project-switch', 'close-write-failure']
const RUN_PREFIX = { portable: 'inflight-portable-', 'web-guest': 'inflight-guest-', desktop: 'inflight-desktop-' }
const SHOTS = ['inflight-edit.png', 'project-switch.png', 'close-write-failure.png', 'close-write-failure-reopen.png']
const within = (root, file) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }

export async function validateInflightEvidence(root, file, { profile, expectedBuildHash, expectedSourceFingerprint }) {
  const required = INFLIGHT_REQUIRED[profile]
  if (!required) throw new Error('Unknown inflight profile: ' + profile)
  const result = JSON.parse(await fs.readFile(file, 'utf8'))
  if (result.profile !== profile || result.failed !== 0 || result.error !== null) throw new Error(profile + ' inflight run did not pass')
  if (!Array.isArray(result.pageErrors) || result.pageErrors.length) throw new Error(profile + ' inflight run had page errors')
  if (result.sourceFingerprint !== expectedSourceFingerprint || result.buildManifest?.sha256 !== expectedBuildHash) throw new Error(profile + ' inflight evidence is stale')
  if (!Array.isArray(result.checks) || result.passed !== result.checks.length || new Set(result.checks.map(item => item.id)).size !== result.checks.length
    || result.checks.some(item => item.passed !== true) || required.some(id => !result.checks.some(item => item.id === id))) throw new Error(profile + ' inflight cases missing, duplicated, or failed')
  const declared = Array.isArray(result.scenarios) ? result.scenarios : []
  const missing = SCENARIOS.filter(name => !declared.includes(name))
  if (missing.length) throw new Error(profile + ' inflight scenarios missing: ' + missing.join(', '))
  const temporaryRoot = await fs.realpath(path.join(root, '.workbuddy/tmp'))
  const runRoot = await fs.realpath(result.runRoot)
  if (!within(temporaryRoot, runRoot) || !path.basename(runRoot).startsWith(RUN_PREFIX[profile])) throw new Error(profile + ' inflight run is not isolated')
  if (!Array.isArray(result.artifacts)) throw new Error(profile + ' inflight artifacts missing')
  for (const name of SHOTS) {
    const expected = path.join(runRoot, name)
    if (result.artifacts.filter(item => path.resolve(root, item.path) === expected).length !== 1) throw new Error(profile + ' inflight artifact missing or duplicated: ' + name)
  }
  for (const artifact of result.artifacts) {
    const actual = await fs.realpath(path.resolve(root, artifact.path))
    if (!within(runRoot, actual)) throw new Error(profile + ' inflight artifact escapes run directory')
    if (createHash('sha256').update(await fs.readFile(actual)).digest('hex') !== artifact.sha256) throw new Error(profile + ' inflight artifact hash mismatch')
  }
  return { assertions: result.checks.length, result }
}
