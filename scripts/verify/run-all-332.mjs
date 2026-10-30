// 3.3.2 · 服务端自检统一入口
//
// 【为什么需要它】3.3.2 的服务端/协议自检长在 `scripts/verify/*`（要真起 HTTP 服务、
// 真写临时目录），与 `tests/` 里的纯函数单测不是一类东西，不能混进 `run-batches.sh`
// （那批是 `npm test` 的入口，跑在 jsdom/纯 node 环境，秒级）。
//
// 但"十个脚本逐个手敲"必然漏跑。这个入口把它们串起来，一次给结论：
//   node scripts/verify/run-all-332.mjs          # 全跑
//   node scripts/verify/run-all-332.mjs project  # 只跑名字含 project 的
//
// 🔴 **不算通过就不算过**：任何脚本非零退出即整体失败，不会因为"其他都过了"而变绿。
// 🔴 每个脚本独立进程跑：它们会改 `process.env`（临时数据目录）、起真实 HTTP 端口，
//    同进程跑会互相污染。
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const filter = process.argv[2] || ''

/** 按依赖顺序排：先纯逻辑，再起服务的，最后跑迁移（它会动整库） */
const ORDER = [
  'sessions-332',
  'legacy-token-332',
  'sessions-e2e-332',
  'desktop-auth-332',
  'desktop-client-332',
  'project-store-332',
  'project-api-332',
  'restore-332',
  'legacy-gate-332',
  'object-gc-332',
  'migrate-v2-332',
]

function listScripts() {
  const files = readdirSync(here)
    .filter((f) => /-332\.(mjs|cjs)$/.test(f) && !f.startsWith('run-all'))
    .map((f) => f.replace(/-332\.(mjs|cjs)$/, ''))
  // 已知的按 ORDER 排，未知的（新加的）追加到末尾 —— 不能因为忘了登记就不跑
  const known = ORDER.filter((n) => files.includes(n))
  const extra = files.filter((n) => !known.includes(n)).sort()
  return [...known, ...extra]
}

const all = listScripts().filter((n) => !filter || n.includes(filter))
if (!all.length) {
  console.error(`没有匹配 "${filter}" 的自检脚本`)
  process.exit(1)
}

const rows = []
let failed = 0
const t0 = Date.now()

for (const name of all) {
  const mjs = path.join(here, `${name}-332.mjs`)
  const cjs = path.join(here, `${name}-332.cjs`)
  const exists = readdirSync(here)
  const file = exists.includes(`${name}-332.mjs`) ? mjs : (exists.includes(`${name}-332.cjs`) ? cjs : null)
  if (!file) { rows.push({ name, ok: false, summary: '找不到脚本' }); failed++; continue }
  const started = Date.now()
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 180000 })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const lastLine = out.trim().split('\n').filter(Boolean).pop() || ''
  const ok = r.status === 0
  if (!ok) failed++
  rows.push({
    name, ok,
    ms: Date.now() - started,
    summary: lastLine.replace(/\s*（[^）]*）\s*$/, ''),
    detail: ok ? '' : out.slice(-800),
  })
  process.stdout.write(`${ok ? '✔' : '✘'} ${name.padEnd(22)} ${rows[rows.length - 1].summary}\n`)
}

const total = rows.length
const secs = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`\n${failed ? 'FAILED' : 'OK'} ${total - failed}/${total} 个自检通过（${secs}s）`)
if (failed) {
  for (const r of rows.filter((x) => !x.ok && x.detail)) {
    console.log(`\n---- ${r.name} ----\n${r.detail}`)
  }
  process.exit(1)
}
