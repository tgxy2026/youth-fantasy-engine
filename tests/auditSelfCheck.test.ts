// ============ 3.4.1 · 审计工具自检：防止「搬文件 / 改目录后扫描器静默失明」 ============
//
// 守的是「坏配置必须被拦住」，不是「当前配置恰好是好的」：
//   · 登记路径缺失 / 图表清单重复、交叉、被清空 / 契约 id 重复 ⇒ 自检失败；
//   · AST 扫到 0 个文件、或与独立数出的真实文件数不符 ⇒ 自检失败（核心防失明）；
//   · 真实仓库自检通过、工具指纹可复现、主调度确实接了自检。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { validateRegistry, toolFingerprint, countSourceFiles } from '../scripts/audit/registry-check.mjs'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// source.mjs / scan.mjs 里写死的依赖也在自检登记范围内
const HARDCODED = ['src/lib/db/core.ts', 'server/index.mjs', 'scripts/portable-server.mjs']
// 🔴 夹具必须用真实路径：sourcePathGuard 会扫测试里所有 src/... 字面量，
//    虚构路径会被判「文件被搬走 ⇒ 相关断言可能静默失明」。
const CHART_A = 'src/components/world/RelationGraph.tsx'
const CHART_B = 'src/components/world/FactionGraph.tsx'
const NON_CHART = 'src/components/editor/NovelEditor.tsx'
const goodContracts = {
  required: [{ id: 'headers.case' }, { id: 'headers.syntax' }],
  charts: [CHART_A, CHART_B],
  nonChartMono: [{ file: NON_CHART, reason: 'not a chart' }],
}
const goodPolicy = {
  flagSources: { WEB: 'src/lib/app/platform.ts' },
  bridgeAdapters: ['src/lib/app/desktop.ts'],
  rawFlagAdapters: [] as string[],
  httpStoreAdapters: [] as string[],
  sidecars: [{ file: 'electron/main.cjs', symbol: 'BLOB_STORES', expected: [] as string[] }],
}
const known = new Set([
  ...Object.values(goodPolicy.flagSources), ...goodPolicy.bridgeAdapters,
  ...goodContracts.charts, ...goodContracts.nonChartMono.map(x => x.file),
  'electron/main.cjs', ...HARDCODED,
])
const base = {
  contracts: goodContracts,
  policy: goodPolicy,
  exists: (file: string) => known.has(file),
  srcFileCount: 100,
  staticFiles: 100,
}

const healthy = validateRegistry(base)
ok('正常配置：自检通过', healthy.ok)
ok('正常配置：4 项检查全过', healthy.checks.length === 4 && healthy.checks.every(c => c.status === 'passed'))
ok('正常配置：无 issues', healthy.issues.length === 0)

const broken: Array<[string, Partial<typeof base>, string]> = [
  ['登记路径缺失', { exists: (f: string) => f !== CHART_A }, '登记路径全部存在'],
  ['图表清单重复', { contracts: { ...goodContracts, charts: [CHART_A, CHART_A] } }, '图表清单健康'],
  ['图表清单与 nonChartMono 交叉', { contracts: { ...goodContracts, charts: [CHART_A, NON_CHART] } }, '图表清单健康'],
  ['图表清单被清空', { contracts: { ...goodContracts, charts: [] } }, '图表清单健康'],
  ['必要契约 id 重复', { contracts: { ...goodContracts, required: [{ id: 'x' }, { id: 'x' }] } }, '必要契约 id'],
  ['扫描 0 个文件（静默失明）', { staticFiles: 0 }, '静态扫描覆盖'],
  ['扫描文件数与源码不符', { staticFiles: 99 }, '静态扫描覆盖'],
]
for (const [name, patch, expect] of broken) {
  const r = validateRegistry({ ...base, ...patch })
  ok(`坏配置被拦：${name}`, !r.ok && r.issues.some(i => i.includes(expect)), r.issues.join(' | '))
}

// 真实仓库：用真实配置 + 独立 walk 的文件数核对登记项
const realContracts = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'scripts/audit/contracts.json'), 'utf8'))
const realPolicy = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'scripts/audit/platform/policy.json'), 'utf8'))
const realCount = countSourceFiles(path.join(process.cwd(), 'src'))
const realResult = validateRegistry({
  contracts: realContracts, policy: realPolicy,
  exists: (file: string) => fs.existsSync(path.join(process.cwd(), file)),
  srcFileCount: realCount, staticFiles: realCount,
})
ok('真实配置登记项健康', realResult.ok, realResult.issues.join(' | '))
ok('真实源码 ts/tsx 数量 > 0', realCount > 0, String(realCount))
ok('工具指纹为 64 位 sha256', /^[0-9a-f]{64}$/.test(toolFingerprint(process.cwd())))
ok('工具指纹可复现', toolFingerprint(process.cwd()) === toolFingerprint(process.cwd()))

// 端到端：CLI 真跑一遍，覆盖组装层 + AST 侧 sidecar 符号核对（不经过 esbuild bundle）
const cli = await new Promise<{ code: number | null; out: string }>((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/audit/self-check.mjs'], { cwd: process.cwd() })
  let out = ''
  child.stdout?.on('data', (d: Buffer) => { out += d.toString() })
  child.stderr?.on('data', (d: Buffer) => { out += d.toString() })
  child.once('error', reject)
  child.once('close', code => resolve({ code, out }))
})
ok('CLI 对真实仓库自检通过', cli.code === 0 && /Self-check PASSED/.test(cli.out), cli.out.slice(-400))
ok('CLI 覆盖 sidecar 符号核对', /sidecar 符号/.test(cli.out), cli.out.slice(-400))

// 主调度接线：防止以后有人把自检从 run.mjs 里摘掉，报告又变回「0 候选即绿灯」
const runSrc = fs.readFileSync(path.join(process.cwd(), 'scripts/audit/run.mjs'), 'utf8')
ok('主调度引入 auditSelfCheck', /import \{ auditSelfCheck \}/.test(runSrc))
ok('自检失败写入 blocked 诊断', /!selfCheck\.ok\)[\s\S]{0,160}diagnostics\.push/.test(runSrc))
ok('报告写入 appVersion 与 toolFingerprint', /appVersion:\s*selfCheck\.appVersion/.test(runSrc) && /toolFingerprint:\s*selfCheck\.toolFingerprint/.test(runSrc))
ok('自检复用同一次 scanAst 结果', /auditSelfCheck\(root, \{ staticResult \}\)/.test(runSrc))

console.log(`\n—— auditSelfCheck 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
