import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const GUEST_CASE_IDS = [
  'initial-flags', 'fixture-readback', 'quota.failure-visible', 'quota.failure-preserves-draft',
  'quota.accepted-vs-persisted', 'quota.retry-readback', 'abort.failure-visible',
  'abort.failure-preserves-draft', 'abort.accepted-vs-persisted', 'abort.retry-readback',
  'backend-selection', 'restart-readback', 'no-pageerror', 'unchanged-inputs',
]
const within = (root, file) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }

// Only consume a freshly executed production-renderer result, not an exit-code-only claim.
export async function validateGuestEvidence(root, file, { expectedBuildHash, expectedSourceFingerprint }) {
  const result = JSON.parse(await fs.readFile(file, 'utf8'))
  if (result.profile !== 'web-guest' || result.failed !== 0 || result.error !== null || !Array.isArray(result.pageErrors) || result.pageErrors.length) throw new Error('Guest runtime did not pass')
  if (result.sourceFingerprint !== expectedSourceFingerprint || result.buildManifest?.sha256 !== expectedBuildHash) throw new Error('Guest source or build evidence is stale')
  if (!Array.isArray(result.checks) || result.passed !== result.checks.length || new Set(result.checks.map(item => item.id)).size !== result.checks.length || result.checks.some(item => item.passed !== true) || GUEST_CASE_IDS.some(id => !result.checks.some(item => item.id === id))) throw new Error('Guest cases missing, duplicated, or failed')
  const temporaryRoot = await fs.realpath(path.join(root, '.workbuddy/tmp'))
  const runRoot = await fs.realpath(result.runRoot)
  if (!within(temporaryRoot, runRoot) || !path.basename(runRoot).startsWith('web-guest-save-')) throw new Error('Guest profile is not isolated')
  if (!Array.isArray(result.artifacts)) throw new Error('Guest artifacts missing')
  for (const name of ['quota-failure.png', 'abort-failure.png', 'restart-readback.png', 'chapter-readback.json', 'server.log']) {
    const expected = path.join(runRoot, name)
    const entries = result.artifacts.filter(item => path.resolve(root, item.path) === expected)
    if (entries.length !== 1) throw new Error('Guest artifact missing or duplicated: ' + name)
  }
  for (const artifact of result.artifacts) {
    const actual = await fs.realpath(path.resolve(root, artifact.path))
    if (!within(runRoot, actual)) throw new Error('Guest artifact escapes run directory')
    if (createHash('sha256').update(await fs.readFile(actual)).digest('hex') !== artifact.sha256) throw new Error('Guest artifact hash mismatch')
  }
  return { assertions: result.checks.length, result }
}
