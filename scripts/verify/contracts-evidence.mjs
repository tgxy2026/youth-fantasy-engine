#!/usr/bin/env node
// 六维审计 evidence 汇总器（3.2.3 起随仓入库）。
//
// 背景：`run.mjs --evidence <json>` 只认「有产物 + samples>0 + cases 齐全 + 指纹一致」的证据，
// 而产出证据的四个 verify 脚本历史上没入库（只剩 json/log）。本文件把已入库的生产者串起来，
// 一条命令产出可交给 run.mjs 的 evidence.json。
//
// 🔴 纪律：
//   · 每个生产者都必须**真跑**；failed>0 或非 0 退出 ⇒ evidence 里如实标 failed，不丢弃、不改写。
//   · 指纹取当前工作树（含未提交改动）；writer 与 reader 之间若源码变了，run.mjs 会自己判失效。
//   · 四个生产者均已入库；少项、异常退出或输入变化不能占位充数。
import fs from 'node:fs/promises'
import path from 'node:path'
import { runProcess } from './process.mjs'
import { captureInputs } from './evidence.mjs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const require = createRequire(import.meta.url)
const { sourceFingerprint } = require('../audit/context.cjs')
/** 契约定义（cases 的真源）：mono.rendered 的 cases 就是这里的 charts 列表 */
const CONTRACTS = require('../audit/contracts.json')

/** 已实现的生产者；`summary` 用于解析各自打印的汇总行 */
const PRODUCERS = [
  {
    id: 'preset.routes', script: 'scripts/verify/preset-routes.mjs', cases: ['new', 'edit'],
    summary: /PRESET_ROUTES samples=(\d+) passed=(\d+) failed=(\d+)/, label: 'PRESET_ROUTES',
  },
  {
    id: 'io.roundtrip', script: 'scripts/verify/card-io-roundtrip.mjs', cases: ['legacy-name', 'duplicate', 'roundtrip'],
    summary: /CARD_IO samples=(\d+) passed=(\d+) failed=(\d+)/, label: 'CARD_IO',
  },
  {
    // 需要 vite dev server + Edge（约 40 秒）：真实浏览器里注入一次 IDB 写失败，验切换守卫
    id: 'draft.failure', script: 'scripts/verify/draft-failure.mjs', cases: ['save-failure', 'preserve-selection', 'preserve-storage'],
    summary: /DRAFT_FAILURE samples=(\d+) passed=(\d+) failed=(\d+)/, label: 'DRAFT_FAILURE',
  },
  {
    // 需要 vite dev server + Edge（约 45 秒）：8 个图表在 mono 主题下的真实绘制采样
    id: 'mono.rendered', script: 'scripts/verify/mono-charts.mjs', cases: CONTRACTS.charts, theme: 'mono',
    summary: /MONO_CHARTS samples=(\d+) passed=(\d+) failed=(\d+)/, label: 'MONO_CHARTS',
  },
]

async function main() {
  const only = process.argv.includes('--only')
    ? String(process.argv[process.argv.indexOf('--only') + 1] ?? '')
    : ''
  const fingerprint = sourceFingerprint(ROOT)
  const inputs = await captureInputs(ROOT)
  const dirAt = process.argv.indexOf('--out-dir')
  if (dirAt >= 0 && (!process.argv[dirAt + 1] || process.argv[dirAt + 1].startsWith('--'))) throw new Error('--out-dir requires a value')
  await fs.mkdir(path.join(ROOT, '.workbuddy/tmp'), { recursive: true })
  const temp = await fs.realpath(path.join(ROOT, '.workbuddy/tmp'))
  const outDir = dirAt >= 0 ? path.resolve(process.argv[dirAt + 1]) : await fs.mkdtemp(path.join(temp, 'contracts-evidence-'))
  if (!outDir.startsWith(temp + path.sep)) throw new Error('Evidence output must be inside workspace tmp')
  await fs.mkdir(outDir, { recursive: true })
  const checks = []
  const runs = []
  let dirty = false

  for (const producer of PRODUCERS) {
    if (only && !producer.id.includes(only)) continue
    console.log('Producer ' + producer.id)
    const result = await runProcess(process.execPath, [producer.script], { cwd: ROOT, timeoutMs: 240000 })
    await fs.writeFile(path.join(outDir, producer.id + '.log'), result.out)
    const summary = producer.summary.exec(result.out)
    const artifactLine = /^artifact=(.+)$/m.exec(result.out)?.[1]?.trim() ?? ''
    if (!summary) {
      // 没有汇总行 = 生产者自己没跑成，如实标 failed（run.mjs 会据此判红）
      dirty = true
      checks.push({ id: producer.id, status: 'failed', samples: 0, cases: producer.cases, artifact: '', reason: `${producer.label} 未打印汇总行（exit=${result.code}）` })
      runs.push({ id: producer.id, ...result, stdout: undefined, stderr: undefined, out: undefined })
      continue
    }
    const samples = Number(summary[1])
    const failed = Number(summary[3])
    const status = failed === 0 && result.ok && samples > 0 && Number(summary[2]) === samples ? 'passed' : 'failed'
    if (status === 'failed') dirty = true
    checks.push({ id: producer.id, status, samples, cases: producer.cases, artifact: artifactLine, ...(producer.theme ? { theme: producer.theme } : {}) })
    runs.push({ id: producer.id, ...result, stdout: undefined, stderr: undefined, out: undefined, samples, failed })
  }

  if (!checks.length || (await captureInputs(ROOT)).combined !== inputs.combined) dirty = true
  const file = path.join(outDir, 'producer-evidence.json')
  await fs.writeFile(file, JSON.stringify({ sourceFingerprint: fingerprint, inputHash: inputs.combined, checks, runs, at: new Date().toISOString(), dirty }, null, 2))
  for (const c of checks) console.log(`${c.status === 'passed' ? 'PASS' : 'FAIL'} ${c.id} samples=${c.samples} artifact=${c.artifact || '-'}`)
  console.log(`EVIDENCE ${path.relative(ROOT, file).replaceAll('\\', '/')}`)
  console.log(`fingerprint=${fingerprint.slice(0, 12)} checks=${checks.length} dirty=${dirty}`)
  if (dirty) process.exitCode = 1
}

main().catch((e) => { console.error('EVIDENCE failed: ' + (e instanceof Error ? e.stack : e)); process.exitCode = 1 })
