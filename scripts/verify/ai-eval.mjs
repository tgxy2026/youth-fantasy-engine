#!/usr/bin/env node
/**
 * AI 输出质量评估（3.6.2 · W5）
 *
 * 【它判什么、不判什么】
 *   判：**守不守约** —— 输出是不是可解析的 JSON、有没有越出给定范围、
 *       信息不足时有没有承认不确定、格式有没有守约。
 *   不判：文笔好坏。那件事无法自动判定，硬判只会得到噪声（而且会让"通过"变得没有意义）。
 *
 * 【两种模式】
 *   node scripts/verify/ai-eval.mjs
 *     → 离线：用夹具里**录制好的响应**跑断言。不需要模型、不需要网络，可进回归。
 *
 *   node scripts/verify/ai-eval.mjs --live --model dongfangshuo:27b-128k
 *     → 真跑：请求本机 Ollama 重新生成，再跑同一套断言。**不进 CI**（慢、依赖本机模型）。
 *       加 `--save` 会把新响应写回夹具（换模型后想留一份对照时用）。
 *
 * 🔴 为什么夹具必须存"真实录制的响应"而不是编一段：
 *   编的响应一定守约（因为就是照着断言写的），跑出来全绿 —— 那是在测自己，不是在测模型。
 *   没有录制时本脚本如实输出 `SKIP（未录制）`，不把"没测"算成"通过"。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runScenarioChecks } from './ai-eval-checks.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const FIXTURE = path.join(ROOT, 'tests/fixtures/ai-eval/scenarios.json')

const arg = (name, def = '') => {
  const i = process.argv.indexOf(name)
  if (i < 0) return def
  const v = process.argv[i + 1]
  if (!v || v.startsWith('--')) throw new Error(name + ' 需要值')
  return v
}
const LIVE = process.argv.includes('--live')
const SAVE = process.argv.includes('--save')
const ONLY = arg('--only', '')
const MODEL = arg('--model', process.env.YFE_EVAL_MODEL || '')
const BASE = (arg('--base', process.env.OLLAMA_BASE || 'http://127.0.0.1:11434')).replace(/\/+$/, '')

/* ---------------- 真跑 ---------------- */

async function callOllama(scenario, model) {
  const body = {
    model,
    messages: [
      { role: 'system', content: scenario.system },
      { role: 'user', content: scenario.user },
    ],
    stream: false,
    options: { temperature: 0.2 },
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 180_000)
  try {
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    return String(json?.message?.content ?? '')
  } finally {
    clearTimeout(timer)
  }
}

/* ---------------- 主流程 ---------------- */

async function main() {
  if (!fs.existsSync(FIXTURE)) {
    console.error(`FAIL 找不到夹具：${path.relative(ROOT, FIXTURE)}`)
    process.exit(1)
  }
  const doc = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  const all = Array.isArray(doc.scenarios) ? doc.scenarios : []
  const picked = ONLY ? all.filter(s => s.id === ONLY) : all
  if (!picked.length) {
    console.error(`FAIL 没有匹配的场景：${ONLY || '(全部)'}`)
    process.exit(1)
  }

  if (LIVE && !MODEL) {
    console.error('FAIL --live 需要 --model（例如 --model dongfangshuo:27b-128k）')
    process.exit(1)
  }

  console.log(`AI 质量评估 · ${LIVE ? `真跑 ${MODEL} @ ${BASE}` : '离线（用录制响应）'}`)
  console.log('场景'.padEnd(22) + '结果'.padEnd(8) + '说明')
  console.log('-'.repeat(78))

  let pass = 0, fail = 0, skip = 0
  const failures = []

  for (const s of picked) {
    let text = ''
    let status = 'recorded'

    if (LIVE) {
      process.stdout.write(`  生成中：${s.id} …`)
      try {
        text = await callOllama(s, MODEL)
        status = 'live'
        process.stdout.write(' 完成\n')
        if (SAVE) {
          s.recorded = { status: 'recorded', model: MODEL, at: new Date().toISOString(), response: text }
        }
      } catch (e) {
        process.stdout.write(' 失败\n')
        console.log(s.id.padEnd(22) + 'FAIL'.padEnd(8) + `请求失败：${e.message}`)
        fail++
        failures.push({ id: s.id, reason: `请求失败：${e.message}` })
        continue
      }
    } else {
      const rec = s.recorded ?? {}
      if (!rec.response || rec.status === 'unrecorded') {
        console.log(s.id.padEnd(22) + 'SKIP'.padEnd(8) + '未录制响应（--live --model 可录制）')
        skip++
        continue
      }
      text = rec.response
    }

    const { results, failed: bad } = runScenarioChecks(s.checks, text)
    if (bad.length === 0) {
      console.log(s.id.padEnd(22) + 'PASS'.padEnd(8) + `${results.length} 项断言全过`)
      pass++
    } else {
      console.log(s.id.padEnd(22) + 'FAIL'.padEnd(8) + bad.map(b => b.detail).join('；'))
      fail++
      failures.push({ id: s.id, reason: bad.map(b => `[${b.check.kind}] ${b.detail}`).join('；') })
    }
    // 逐项明细（只在失败时展开，避免刷屏）
    if (bad.length) {
      for (const b of bad) console.log(`    ✗ ${b.check.kind}${b.check.why ? `（${b.check.why}）` : ''}：${b.detail}`)
    }
    if (status === 'live' && !SAVE) console.log('    （未写回夹具；要留档请加 --save）')
  }

  if (SAVE && LIVE) {
    fs.writeFileSync(FIXTURE, JSON.stringify(doc, null, 2) + '\n')
    console.log(`\n已写回夹具：${path.relative(ROOT, FIXTURE)}`)
  }

  console.log('-'.repeat(78))
  console.log(`AI_EVAL passed=${pass} failed=${fail} skipped=${skip}`)
  if (failures.length) {
    console.log('\n失败明细：')
    for (const f of failures) console.log(`  - ${f.id}：${f.reason}`)
  }
  if (skip > 0 && pass === 0 && fail === 0) {
    console.log('\n⚠️ 全部未录制：这次运行**没有验证任何东西**。用 --live --model <模型> --save 录一份。')
  }
  // 未录制的场景不算失败，但「一条都没跑」要让人看见（见上面的警告）
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => {
  console.error('AI_EVAL 运行异常：', e)
  process.exit(1)
})
