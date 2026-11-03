// ============ 3.2.3 · R3（批次 D）：平台矩阵的"证据闸"语义 ============
//
// 方案 §7 的两句硬话：
//   「复用 scripts/audit/platform/policy.json，不再手写另一份平台单元总数」
//   「仅当单元全部必需子场景通过，才更新其 verified；某个子场景有证据不能代表整个单元通过」
//
// 矩阵机件（`scripts/audit/platform/run.mjs`）已经存在，但它**本身没有测试**：
// 谁都能写一份 ledger 声称 passed。这里把它的四条否定路径钉死 ——
// 少场景、缺产物、产物哈希不符、指纹过期，都不许变成 verified。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const ROOT = process.cwd()
const POLICY = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/audit/platform/policy.json'), 'utf8'))
/** 🔴 单元总数从 policy 展开，不手写 —— 手写就会与配置漂移 */
const UNITS = POLICY.runtimeCases.reduce((n: number, c: { profiles: string[] }) => n + c.profiles.length, 0)

type Row = { id: string; profile: string; status: string; reason?: string; requiredScenarios: string[] }
type Report = { status: string; sourceFingerprint: string; runtime: Row[]; diagnostics: { reason?: string }[] }

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yfe-matrix-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))
  return dir
}

/** 跑一次平台审计（独立进程；它自己只读源码、只往 root/.workbuddy/tmp 写报告） */
function runAudit(root: string, ledger?: unknown): Promise<{ code: number | null; report?: Report }> {
  let ledgerPath: string | undefined
  if (ledger) {
    ledgerPath = path.join(root, 'ledger.json')
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2))
  }
  const args = [path.join(ROOT, 'scripts/audit/platform/run.mjs'), root]
  if (ledgerPath) args.push('--evidence', ledgerPath)
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', d => { out += String(d) })
    child.stderr.on('data', d => { out += String(d) })
    child.on('close', code => {
      const dir = path.join(root, '.workbuddy/tmp/platform-audit')
      let report: Report | undefined
      if (fs.existsSync(dir)) {
        const stamps = fs.readdirSync(dir).sort()
        const last = stamps[stamps.length - 1]
        const file = path.join(dir, last, 'report.json')
        if (fs.existsSync(file)) report = JSON.parse(fs.readFileSync(file, 'utf8')) as Report
      }
      resolve({ code, report })
    })
  })
}

const cell = (r: Report | undefined, id: string, profile: string) => r?.runtime.find(x => x.id === id && x.profile === profile)
const passedCells = (r: Report | undefined) => (r?.runtime ?? []).filter(x => x.status === 'passed').length

async function main() {
  // ---------- ① 无证据：26 格全部未验证，退出码 2，绝不自称通过 ----------
  {
    const root = tempRoot()
    try {
      const { code, report } = await runAudit(root)
      ok('🔴 ① 矩阵单元数＝policy 展开数（不手写总数）', report?.runtime.length === UNITS, `${report?.runtime.length} vs ${UNITS}`)
      ok('🔴 ① 没有任何证据时 0 格 passed', passedCells(report) === 0)
      ok('① 每格都带必需子场景清单（便于将来补证）', report?.runtime.every(r => Array.isArray(r.requiredScenarios) && r.requiredScenarios.length > 0) === true)
      ok('① 缺证据时审计状态是 incomplete', report?.status === 'incomplete', report?.status)
      ok('① 退出码 2（不完整，不是失败也不是通过）', code === 2, String(code))
    } finally { fs.rmSync(root, { recursive: true }) }
  }

  const spec = POLICY.runtimeCases[0] as { id: string; profiles: string[]; scenarios: string[] }
  const profile = spec.profiles[0]
  const fpOf = async (root: string) => {
    // 先跑一次拿到指纹（无证据那次已写报告，但目录被清；这里再跑一次只为读指纹）
    const { report } = await runAudit(root)
    return report?.sourceFingerprint ?? ''
  }

  // ---------- ② 声称 passed 但证据产物不存在 ----------
  {
    const root = tempRoot()
    try {
      const fingerprint = await fpOf(root)
      const { report } = await runAudit(root, {
        sourceFingerprint: fingerprint,
        decisions: [],
        runtime: [{
          id: spec.id, profile, status: 'passed', samples: 1,
          scenarios: spec.scenarios, environment: 'fixture',
          artifact: { path: 'no-such-artifact.json', sha256: '0'.repeat(64) },
        }],
      })
      const c = cell(report, spec.id, profile)
      ok('🔴 ② 产物不存在 ⇒ 该格不是 passed（不能凭一句 passed 就绿）', c?.status !== 'passed', JSON.stringify(c))
      ok('② 给出原因（证据产物不是文件）', String(c?.reason ?? '').length > 0, String(c?.reason))
      ok('② 其余格仍未被连带点亮', passedCells(report) === 0)
    } finally { fs.rmSync(root, { recursive: true }) }
  }

  // ---------- ③ 产物哈希不符（内容被换过） ----------
  {
    const root = tempRoot()
    try {
      const fingerprint = await fpOf(root)
      const artifact = path.join(root, 'evidence.json')
      fs.writeFileSync(artifact, JSON.stringify({ note: '这是被改过的证据' }))
      const { report } = await runAudit(root, {
        sourceFingerprint: fingerprint,
        decisions: [],
        runtime: [{
          id: spec.id, profile, status: 'passed', samples: 3,
          scenarios: spec.scenarios, environment: 'fixture',
          artifact: { path: path.basename(artifact), sha256: 'f'.repeat(64) },
        }],
      })
      const c = cell(report, spec.id, profile)
      ok('🔴 ③ 哈希不符 ⇒ 不是 passed', c?.status !== 'passed', JSON.stringify(c))
      ok('③ 指明产物内容已变化', /变化/.test(String(c?.reason ?? '')), String(c?.reason))
    } finally { fs.rmSync(root, { recursive: true }) }
  }

  // ---------- ④ 少一个必需子场景 ----------
  {
    const root = tempRoot()
    try {
      const fingerprint = await fpOf(root)
      const artifact = path.join(root, 'evidence.json')
      fs.writeFileSync(artifact, '{"ok":true}')
      const sha = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex')
      const { report } = await runAudit(root, {
        sourceFingerprint: fingerprint,
        decisions: [],
        runtime: [{
          id: spec.id, profile, status: 'passed', samples: 2,
          scenarios: spec.scenarios.slice(0, -1), // 🔴 故意漏掉一个
          environment: 'fixture',
          artifact: { path: 'evidence.json', sha256: sha },
        }],
      })
      const c = cell(report, spec.id, profile)
      ok('🔴 ④ 少一个必需场景 ⇒ 整格不通过（子场景不能代表整单元）', c?.status !== 'passed', JSON.stringify(c))
      ok('④ 原因写明缺正样本或必要场景', /场景|样本/.test(String(c?.reason ?? '')), String(c?.reason))
    } finally { fs.rmSync(root, { recursive: true }) }
  }

  // ---------- ⑤ 完整合法证据：只点亮这一格 ----------
  {
    const root = tempRoot()
    try {
      const fingerprint = await fpOf(root)
      const artifact = path.join(root, 'evidence.json')
      fs.writeFileSync(artifact, '{"sha":' + JSON.stringify(fingerprint) + '}')
      const sha = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex')
      const { report } = await runAudit(root, {
        sourceFingerprint: fingerprint,
        decisions: [],
        runtime: [{
          id: spec.id, profile, status: 'passed', samples: 2,
          scenarios: spec.scenarios, environment: 'fixture · node 夹具（非真机）',
          artifact: { path: 'evidence.json', sha256: sha },
        }],
      })
      const c = cell(report, spec.id, profile)
      ok('⑤ 证据齐全 ⇒ 该格 passed', c?.status === 'passed', JSON.stringify(c))
      ok('🔴 ⑤ 只点亮 1 格，其余 25 格仍未被冒充', passedCells(report) === 1 && (report?.runtime.length ?? 0) === UNITS,
        `${passedCells(report)}/${report?.runtime.length}`)
      const env = String((c as unknown as { environment?: string } | undefined)?.environment ?? '')
      ok('⑤ 报告里记下了实测环境（不是只写个绿）', env.includes('node'), env || 'no env')
    } finally { fs.rmSync(root, { recursive: true }) }
  }

  // ---------- ⑥ 指纹过期：整份治理记录作废 ----------
  {
    const root = tempRoot()
    try {
      const artifact = path.join(root, 'evidence.json')
      fs.writeFileSync(artifact, '{"ok":true}')
      const sha = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex')
      const { report } = await runAudit(root, {
        sourceFingerprint: 'deadbeef'.repeat(8),
        decisions: [],
        runtime: [{
          id: spec.id, profile, status: 'passed', samples: 1,
          scenarios: spec.scenarios, environment: 'fixture',
          artifact: { path: 'evidence.json', sha256: sha },
        }],
      })
      ok('🔴 ⑥ 指纹不符 ⇒ 0 格 passed（旧证据不能沿用）', passedCells(report) === 0)
      ok('⑥ 诊断里写明治理记录不可用', (report?.diagnostics ?? []).some(d => /治理记录不可用/.test(String(d.reason ?? ''))),
        JSON.stringify(report?.diagnostics ?? []).slice(0, 160))
    } finally { fs.rmSync(root, { recursive: true }) }
  }

  console.log(`\n———— platformMatrix：${pass} 通过 / ${fail} 失败 ————`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
