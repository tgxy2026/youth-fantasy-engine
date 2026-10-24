import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const DESKTOP_CASE_IDS = [
  'initial-flags', 'isolated-paths', 'fixture-readback', 'failure-visible', 'failure-preserves-draft',
  'accepted-vs-persisted', 'dirty-retry', 'failure-export', 'export-preserves-failure', 'retry-readback',
  'recovery-barrier', 'recovery-visible', 'backend-selection', 'restart-readback',
  // 端到端往返：真实导出 → 改库落盘 → 真实导入 → 重启回读
  'roundtrip-export', 'roundtrip-changed', 'roundtrip-import-readback', 'roundtrip-restart-readback',
  'no-pageerror', 'unchanged-inputs',
]
export const DESKTOP_ARTIFACTS = ['write-failure.png', 'failure-export.png', 'restart-readback.png',
  'roundtrip-import.png', 'failure-export.json', 'roundtrip-export.json', 'chapter-readback.json',
  'ipc-before-restart.json', 'filesystem-before-restart.json', 'save-barriers.json', 'electron.log']
const within = (root, file) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }

export async function validateDesktopEvidence(root, file, { expectedBuildHash, expectedSourceFingerprint }) {
  const result = JSON.parse(await fs.readFile(file, 'utf8'))
  if (result.profile !== 'desktop' || result.failed !== 0 || result.error !== null || !Array.isArray(result.pageErrors) || result.pageErrors.length) throw new Error('Desktop runtime did not pass')
  if (result.sourceFingerprint !== expectedSourceFingerprint || result.buildManifest?.sha256 !== expectedBuildHash) throw new Error('Desktop source or build evidence is stale')
  if (!Array.isArray(result.checks) || result.passed !== result.checks.length || new Set(result.checks.map(item => item.id)).size !== result.checks.length || result.checks.some(item => item.passed !== true) || DESKTOP_CASE_IDS.some(id => !result.checks.some(item => item.id === id))) throw new Error('Desktop cases missing, duplicated, or failed')
  const temporaryRoot = await fs.realpath(path.join(root, '.workbuddy/tmp'))
  const runRoot = await fs.realpath(result.runRoot)
  if (!within(temporaryRoot, runRoot) || !path.basename(runRoot).startsWith('desktop-save-')) throw new Error('Desktop data is not isolated')
  if (!Array.isArray(result.artifacts)) throw new Error('Desktop artifacts missing')
  for (const name of DESKTOP_ARTIFACTS) {
    if (result.artifacts.filter(item => path.resolve(root, item.path) === path.join(runRoot, name)).length !== 1) throw new Error('Desktop artifact missing or duplicated: ' + name)
  }
  for (const artifact of result.artifacts) {
    const actual = await fs.realpath(path.resolve(root, artifact.path))
    if (!within(runRoot, actual)) throw new Error('Desktop artifact escapes run directory')
    if (createHash('sha256').update(await fs.readFile(actual)).digest('hex') !== artifact.sha256) throw new Error('Desktop artifact hash mismatch')
  }
  const barriers = JSON.parse(await fs.readFile(path.join(runRoot, 'save-barriers.json'), 'utf8'))
  if (!Array.isArray(barriers) || barriers.length !== 2 || barriers[0].phase !== 'install-blocker' || barriers[1].phase !== 'remove-blocker' || barriers.some(item => item.paused !== true || item.active !== 0 || !Number.isFinite(item.at) || !Number.isFinite(item.mutatedAt) || item.mutatedAt < item.at)) throw new Error('Desktop blocker changed while save was active')
  const chapter = JSON.parse(await fs.readFile(path.join(runRoot, 'chapter-readback.json'), 'utf8'))
  const calls = JSON.parse(await fs.readFile(path.join(runRoot, 'ipc-before-restart.json'), 'utf8'))
  const successfulSaves = Array.isArray(calls) ? calls.filter(item => item.channel === 'store:save' && item.result?.ok === true) : []
  if (typeof chapter.content !== 'string' || !successfulSaves.some(item => item.body === chapter.content) || successfulSaves.some(item => typeof item.body !== 'string' || item.diskAtReturn?.body !== item.body)) throw new Error('Desktop successful IPC lacks matching disk readback')
  const filesystem = JSON.parse(await fs.readFile(path.join(runRoot, 'filesystem-before-restart.json'), 'utf8'))
  if (!Array.isArray(filesystem) || !filesystem.some(item => item.name === 'rename' && item.ok === true) || !filesystem.some(item => item.name === 'rename' && typeof item.error === 'string')) throw new Error('Desktop real rename failure/recovery trace missing')
  return { assertions: result.checks.length, result }
}
