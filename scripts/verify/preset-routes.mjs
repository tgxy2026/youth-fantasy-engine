#!/usr/bin/env node
// 六维审计契约 preset.routes 的证据生产者（3.2.3 起随仓入库）。
//
// 契约原文：「新增与编辑下拉两条预设入口都初始化必需配置」。
// 两条入口在同一份生产代码里：
//   · 新增 —— AIConfigPanel.startAddPreset(p) → providerFromPreset(p)   （整条新配置）
//   · 编辑 —— 编辑态下拉切换 → { ...editing, baseUrl, local, name, headers: headersForPresetSwitch(pre, editing.headers) }
// 这里不重写逻辑，直接 bundle 生产模块调真函数，逐预设跑两条路径。
//
// 🔴 只报真跑出来的数字：任一项不满足就 status=failed，绝不产出"看起来过了"的证据。
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

async function main() {
  const outDir = path.join(ROOT, '.workbuddy/tmp')
  await fs.mkdir(outDir, { recursive: true })
  const stamp = Date.now()
  const bundle = path.join(outDir, `preset-routes-bundle-${stamp}.mjs`)
  const artifact = path.join(outDir, `preset-routes-evidence-${stamp}.json`)

  await build({
    stdin: {
      contents: `export { providerFromPreset, headersForPresetSwitch, ONLINE_PRESETS, LOCAL_PRESETS, LOCAL_OPENAI_PRESETS, OPENCODE_GO_BASE, PRESET_AUTO_HEADER_KEYS, LOCAL_DEFAULT_TEMPERATURE, CLOUD_DEFAULT_TEMPERATURE } from '@/lib/aiCore/core';`,
      resolveDir: ROOT, loader: 'ts',
    },
    alias: { '@': path.join(ROOT, 'src') },
    bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent',
  })
  const lib = await import(pathToFileURL(bundle).href)

  const cases = []
  const fail = []
  const record = (route, preset, ok, detail) => {
    cases.push({ route, preset: preset.label, ok, ...detail })
    if (!ok) fail.push(`${route}/${preset.label}: ${detail.reason}`)
  }

  const all = [
    { group: 'online', list: lib.ONLINE_PRESETS },
    { group: 'local-ollama', list: lib.LOCAL_PRESETS.filter(p => p.type === 'ollama') },
    { group: 'local-openai', list: lib.LOCAL_OPENAI_PRESETS },
  ]
  const every = all.flatMap(g => g.list.map(p => ({ group: g.group, preset: p })))

  // ---------- 新增入口：providerFromPreset 必须给出完整可用的配置 ----------
  const seenIds = new Set()
  for (const { group, preset } of every) {
    const p = lib.providerFromPreset(preset)
    const isOllama = preset.type === 'ollama'
    const reasons = []
    if (!p.id || seenIds.has(p.id)) reasons.push('id 为空或与已有重复')
    seenIds.add(p.id)
    if (p.type !== (isOllama ? 'ollama' : 'openai')) reasons.push(`type=${p.type}`)
    if (p.baseUrl !== preset.baseUrl) reasons.push(`baseUrl=${p.baseUrl}`)
    if (p.local !== (preset.local ?? isOllama)) reasons.push(`local=${p.local}`)
    if (p.apiKey !== '' || p.model !== '') reasons.push('apiKey/model 应留空由作者填')
    if (!(typeof p.temperature === 'number' && p.temperature >= 0 && p.temperature <= 2)) reasons.push(`temperature=${p.temperature}`)
    const wantTemp = p.local ? lib.LOCAL_DEFAULT_TEMPERATURE : lib.CLOUD_DEFAULT_TEMPERATURE
    if (p.temperature !== wantTemp) reasons.push(`temperature 未按本地/云端默认（${p.temperature} != ${wantTemp}）`)
    if (/[（(]本地[）)]|[（(]联网[）)]/.test(p.name)) reasons.push(`name 残留「（本地/联网）」：${p.name}`)
    // 预设自带的请求头：只有需要它的平台才该有；其余平台必须不带（否则普通请求头会变）
    const hasSession = !!p.headers?.['x-opencode-session']
    if (preset.baseUrl === lib.OPENCODE_GO_BASE ? !hasSession : hasSession) reasons.push(`headers 与平台不匹配（hasSession=${hasSession}）`)
    record('new', preset, reasons.length === 0, { group, reason: reasons.join('；') || undefined, provider: { type: p.type, local: p.local, temperature: p.temperature, headers: Object.keys(p.headers ?? {}) } })
  }

  // ---------- 编辑入口：下拉切换预设只能改它该改的，作者手填的头一个都不许丢 ----------
  const opencode = every.find(e => e.preset.baseUrl === lib.OPENCODE_GO_BASE)?.preset
  const plain = every.find(e => e.group === 'online' && e.preset.baseUrl !== lib.OPENCODE_GO_BASE)?.preset
  const custom = { 'X-My-Gateway': 'gw-1' }
  for (const { group, preset } of every) {
    const isOpencode = preset.baseUrl === lib.OPENCODE_GO_BASE
    // 场景 A：带着作者自定义头切换（最常见：网关要求额外头）
    const next = lib.headersForPresetSwitch(preset, { ...custom })
    const reasons = []
    if (!next || next['X-My-Gateway'] !== 'gw-1') reasons.push('切换后丢失了作者自填请求头')
    const hasSession = !!next?.['x-opencode-session']
    if (isOpencode ? !hasSession : hasSession) reasons.push(`会话头与目标平台不符（hasSession=${hasSession}）`)
    record('edit', preset, reasons.length === 0, { group, reason: reasons.join('；') || undefined, headers: Object.keys(next ?? {}) })
  }
  // 场景 B：从 OpenCode Go 切走 —— 自动会话头必须被清掉（否则普通平台会收到陌生头）
  if (opencode && plain) {
    const carried = lib.headersForPresetSwitch(opencode, undefined)
    const switched = lib.headersForPresetSwitch(plain, carried)
    const reasons = []
    if (!carried?.['x-opencode-session']) reasons.push('切到 OpenCode Go 没有补上会话头')
    if (switched?.['x-opencode-session']) reasons.push('切走后仍残留会话头')
    record('edit', opencode, reasons.length === 0, { group: 'switch-away', reason: reasons.join('；') || undefined, headers: Object.keys(switched ?? {}) })
  }
  // 场景 C：手填的头大小写不同（X-Opencode-Session）也要能清掉，且清掉后若无其它头应返回 undefined
  if (opencode && plain) {
    const upper = lib.headersForPresetSwitch(plain, { 'X-Opencode-Session': 'typed-by-author' })
    const reasons = []
    if (upper && Object.keys(upper).some(k => k.toLowerCase() === 'x-opencode-session')) reasons.push('大写变体未被清除')
    if (upper !== undefined) reasons.push('清空后应返回 undefined，实际返回了空/残留对象')
    record('edit', plain, reasons.length === 0, { group: 'case-insensitive', reason: reasons.join('；') || undefined, headers: Object.keys(upper ?? {}) })
  }

  const passed = cases.filter(c => c.ok)
  const payload = {
    schemaVersion: 1, contract: 'preset.routes', at: new Date().toISOString(),
    scope: 'production providerFromPreset / headersForPresetSwitch via esbuild bundle; no network, no real keys',
    presets: every.length, samples: cases.length, passed: passed.length, failed: cases.length - passed.length,
    failures: fail, cases,
  }
  await fs.writeFile(artifact, JSON.stringify(payload, null, 2))
  console.log(`PRESET_ROUTES samples=${cases.length} passed=${passed.length} failed=${payload.failed}`)
  console.log(`artifact=${path.relative(ROOT, artifact).replaceAll('\\', '/')}`)
  if (payload.failed) { for (const f of fail) console.error('FAIL ' + f); process.exitCode = 1 }
}

main().catch(e => { console.error('PRESET_ROUTES failed: ' + (e instanceof Error ? e.stack : e)); process.exitCode = 1 })
