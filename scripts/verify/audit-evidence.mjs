// 3.3.3 · 审计证据合并器（**测试脚手架**，非产品代码）
//
// 作用：把 4 个契约证据生产者的最新产物，归一化成 `scripts/audit/run.mjs --evidence` 要的格式。
//
// 为什么需要它：
//   · 生产者产物是"给人看的详细记录"（cases 是对象数组：{route:'new', ok:true} …）；
//   · 审计要的是"契约覆盖清单"（cases 是 **字符串数组**：['new','edit']），
//     且 mono.rendered 的 cases 必须逐个覆盖 contracts.json 里的 8 个图表源文件。
//   两边格式不同，直接喂会被判「证据缺少必要入口覆盖 ⇒ unverified」。
//
// 前置：四个生产者各跑一次（会各自产出 artifact）：
//   node scripts/verify/preset-routes.mjs
//   node scripts/verify/mono-charts.mjs
//   node scripts/verify/draft-failure.mjs
//   node scripts/verify/card-io-roundtrip.mjs
// 用法：node scripts/verify/audit-evidence.mjs [--out .workbuddy/tmp/audit-evidence.json]
//   然后：node scripts/audit/run.mjs --evidence .workbuddy/tmp/audit-evidence.json
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import context from '../audit/context.cjs'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const args = process.argv.slice(2)
const outArg = args.indexOf('--out') >= 0 ? args[args.indexOf('--out') + 1] : '.workbuddy/tmp/audit-evidence.json'
const OUT = path.resolve(ROOT, outArg)

const contracts = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/audit/contracts.json'), 'utf8'))

/** 按 mtime 找最新产物 */
function newest(patterns) {
  let best = null
  for (const rel of patterns) {
    const abs = path.join(ROOT, rel)
    if (!fs.existsSync(abs)) continue
    const st = fs.statSync(abs)
    if (!best || st.mtimeMs > best.mtimeMs) best = { abs, mtimeMs: st.mtimeMs }
  }
  return best?.abs ?? null
}

/** 通配几种命名（有的带时间戳、有的在子目录） */
function globNewest(dir, matcher) {
  const base = path.join(ROOT, dir)
  if (!fs.existsSync(base)) return null
  const found = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (matcher(e.name)) found.push({ p, m: fs.statSync(p).mtimeMs })
    }
  }
  walk(base)
  if (!found.length) return null
  found.sort((a, b) => b.m - a.m)
  return found[0].p
}

const rel = (abs) => path.relative(ROOT, abs).replaceAll('\\', '/')

const checks = []
const skipped = []

function add(id, artifactAbs, { samples, passed, failed, cases, theme }) {
  if (!artifactAbs) { skipped.push(`${id}: 没找到产物`); return }
  const uniq = [...new Set((cases ?? []).filter(x => typeof x === 'string' && x))]
  checks.push({
    id,
    status: failed > 0 ? 'failed' : 'passed',
    artifact: rel(artifactAbs),
    samples,
    passed,
    failed,
    cases: uniq,
    ...(theme ? { theme } : {}),
  })
}

// ① preset.routes：cases 取 route（需含 new / edit）
{
  const f = globNewest('.workbuddy/tmp', (n) => /^preset-routes-evidence-\d+\.json$/.test(n))
  if (f) {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'))
    add('preset.routes', f, {
      samples: d.samples, passed: d.passed, failed: d.failed,
      cases: (d.cases ?? []).map((c) => c.route),
    })
  } else skipped.push('preset.routes: 没找到产物')
}

// ② mono.rendered：cases 必须是 8 个图表源文件（与 contracts.charts 对齐），且 theme 必须 mono
{
  const f = globNewest('.workbuddy/tmp', (n) => n === 'mono-charts-evidence.json')
  if (f) {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'))
    const files = (d.results ?? []).map((r) => r.file).filter(Boolean)
    const missing = (contracts.charts ?? []).filter((c) => !files.includes(c))
    add('mono.rendered', f, {
      samples: d.samples, passed: d.passed, failed: d.failed,
      cases: files, theme: d.theme,
    })
    if (missing.length) skipped.push(`mono.rendered: 产物里缺 ${missing.length} 个图表源（${missing[0]} …）`)
  } else skipped.push('mono.rendered: 没找到产物')
}

// ③ draft.failure：cases 取 case 名（需含 save-failure / preserve-selection / preserve-storage）
{
  const f = globNewest('.workbuddy/tmp', (n) => n === 'draft-failure-evidence.json')
  if (f) {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'))
    add('draft.failure', f, {
      samples: d.samples, passed: d.passed, failed: d.failed,
      cases: (d.cases ?? []).map((c) => c.case),
    })
  } else skipped.push('draft.failure: 没找到产物')
}

// ④ io.roundtrip：cases 取 case 名（需含 legacy-name / duplicate / roundtrip）
{
  const f = globNewest('.workbuddy/tmp', (n) => /^card-io-evidence-\d+\.json$/.test(n))
  if (f) {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'))
    add('io.roundtrip', f, {
      samples: d.samples, passed: d.passed, failed: d.failed,
      cases: (d.cases ?? []).map((c) => c.case),
    })
  } else skipped.push('io.roundtrip: 没找到产物')
}

const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceFingerprint: context.sourceFingerprint(ROOT),
  note: '由 scripts/verify/audit-evidence.mjs 从各证据生产者的最新产物归一化生成；cases 已按契约要求转成字符串数组',
  checks,
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(evidence, null, 2))

console.log(`合并 ${checks.length} 个契约 → ${rel(OUT)}`)
for (const c of checks) console.log(`  ${c.status === 'passed' ? '✓' : '✗'} ${c.id}  samples=${c.samples} passed=${c.passed} failed=${c.failed} cases=${c.cases.length}${c.theme ? ' theme=' + c.theme : ''}`)
if (skipped.length) { console.log('跳过/缺项：'); for (const s of skipped) console.log('  - ' + s) }
console.log('下一步： node scripts/audit/run.mjs --evidence ' + rel(OUT))
