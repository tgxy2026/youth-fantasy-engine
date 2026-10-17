import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

/** Offline audit of real production functions. No API keys, network or project database. */
export async function auditHeaders(root, out) {
  const bundle = path.join(out, 'production-headers.mjs')
  await build({ stdin: { contents: `export * from '@/lib/aiCore/headers'; export {providerFromPreset,ONLINE_PRESETS} from '@/lib/aiCore/core';`, resolveDir: root, loader: 'ts' }, alias: { '@': path.join(root, 'src') }, bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' })
  const lib = await import(pathToFileURL(bundle).href)
  const observations = []
  const record = (id, scenario, condition) => observations.push({ id, scenario, status: condition ? 'passed' : 'failed' })
  const base = { Authorization: 'Bearer original', 'Content-Type': 'application/json' }
  for (const name of ['Authorization', 'authorization', 'AUTHORIZATION']) {
    record('headers.case', name, new Headers(lib.mergeHeaders(base, { [name]: 'Bearer replacement' })).get('authorization') === 'Bearer replacement')
  }
  record('headers.case', 'absent preserves defaults', JSON.stringify(lib.mergeHeaders(base)) === JSON.stringify(base))
  for (const [scenario, raw] of [['invalid name', { 'bad name': 'x' }], ['embedded LF', { 'x-check': 'a\nb' }], ['embedded NUL', { 'x-check': 'a\0b' }], ['non-ByteString value', { 'x-check': '中文值' }]]) {
    const result = lib.sanitizeCustomHeaders(raw)
    let sendable = true
    try { new Headers(result.allowed) } catch { sendable = false }
    record('headers.syntax', scenario, result.rejected.length > 0 && Object.keys(result.allowed).length === 0 && sendable)
  }
  const preset = lib.ONLINE_PRESETS.find(x => x.label === 'OpenCode Go')
  record('preset.routes', 'new configuration only (editor route remains unverified)', !!preset && !!lib.providerFromPreset(preset).headers?.['x-opencode-session'])
  return observations
}
