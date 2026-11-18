// ============ 未接线模块契约闸（3.6.0 · 审计补盲）============
//
// 盯五件事：
//   ① 解析：别名 `@/x`、相对 `./x`、目录入口 `x/index.ts`、动态 import()、再导出 都要算依赖；
//   ② 注释里写的 `from './x'` 不算依赖（否则删了文件也"有人用"）；
//   ③ 只有测试 import 的模块仍算未接线，但要标出 testImporters（区分"只为测试而活"）；
//   ④ 入口文件不算未接线；
//   ⑤ 台账：状态非法 / 理由过短 / 文件不存在 / 实测未登记 / 登记已失效 都要被拦；
//      真实仓库里 10 个未接线模块全部已登记。
import fs from 'node:fs'
import {
  ENTRY_FILES, importSpecifiers, reconcileUnwiredLedger, resolveImport,
  scanUnwiredModules, validateUnwiredLedger,
} from '../scripts/audit/unwired-modules.mjs'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 🔴 夹具路径用变量拼：`tests/sourcePathGuard.test.ts` 会把 `'src/...'` 字面量当真实路径查磁盘 */
const ROOT = '/fixture-root'
const SRC = 'src'
const rel = (...parts: string[]) => parts.join('/')

const fixture: Record<string, string> = {
  // 入口：谁都不 import 它，也不该报
  [rel(SRC, 'main.tsx')]: "import { a } from './lib/a'\n",
  // 被入口 import ⇒ 已接线
  [rel(SRC, 'lib', 'a.ts')]: [
    "import { b } from './b'",
    "import { c } from '@/lib/c'",
    "import { d } from '@/lib/deep'",
    "export const a = [b, c, d]",
  ].join('\n'),
  // 被相对路径 import ⇒ 已接线
  // 与 `a.ts` 同名的**目录**（`lib/a/`）：验证解析不会把目录当文件命中
  [rel(SRC, 'lib', 'a', 'index.ts')]: 'export const aDir = 0\n',
  [rel(SRC, 'lib', 'b.ts')]: 'export const b = 1\n',
  // 被别名 import ⇒ 已接线
  [rel(SRC, 'lib', 'c.ts')]: 'export const c = 2\n',
  // 目录入口：`@/lib/deep` 应解析到 deep/index.ts ⇒ 已接线
  [rel(SRC, 'lib', 'deep', 'index.ts')]: 'export const d = 3\n',
  // 只被测试 import ⇒ 未接线（但 testImporters=1）
  [rel(SRC, 'lib', 'only-tested.ts')]: 'export const e = 4\n',
  // 完全没人用 ⇒ 未接线
  [rel(SRC, 'lib', 'orphan.ts')]: 'export const f = 5\n',
  // 注释里提到 import，但没有任何真实依赖 ⇒ 仍是未接线（不能因为注释就洗白）
  [rel(SRC, 'lib', 'comment-only.ts')]: [
    "// 以前这里写着 import { g } from './g'，早就删了",
    'export const h = 6',
  ].join('\n'),
  // 再导出是依赖 ⇒ 目标算已接线
  [rel(SRC, 'lib', 'facade.ts')]: "export { i } from './reexported'\n",
  [rel(SRC, 'lib', 'reexported.ts')]: 'export const i = 7\n',
  [rel(SRC, 'lib', 'uses-facade.ts')]: "import { i } from './facade'\nexport const j = i\n",
  // 动态 import 也算依赖
  [rel(SRC, 'lib', 'lazy-host.ts')]: "export const load = () => import('./lazy-target')\n",
  [rel(SRC, 'lib', 'lazy-target.ts')]: 'export const k = 8\n',
}
// 让 facade / lazy-host 自身被接线（否则它们自己会进未接线清单，干扰计数）
fixture[rel(SRC, 'lib', 'entry-wires.ts')] = [
  "import { j } from './uses-facade'",
  "import { load } from './lazy-host'",
  'export const w = [j, load]',
].join('\n')

const testFixture: Record<string, string> = {
  [rel('tests', 'only-tested.test.ts')]: "import { e } from '@/lib/only-tested'\nexport const t = e\n",
}

const readFile = (f: string) => {
  if (f in fixture) return fixture[f]
  if (f in testFixture) return testFixture[f]
  throw new Error('no such fixture: ' + f)
}

// ---------- ① 解析规则 ----------
{
  const exists = (p: string) => p in fixture
  ok('① 别名 @/x 解析到 src/', resolveImport(rel(SRC, 'lib', 'a.ts'), '@/lib/c', exists) === rel(SRC, 'lib', 'c.ts'))
  ok('① 相对路径解析', resolveImport(rel(SRC, 'lib', 'a.ts'), './b', exists) === rel(SRC, 'lib', 'b.ts'))
  ok('① 目录入口补 index.ts', resolveImport(rel(SRC, 'lib', 'a.ts'), '@/lib/deep', exists) === rel(SRC, 'lib', 'deep', 'index.ts'))
  ok('① 第三方包不算仓库依赖', resolveImport(rel(SRC, 'lib', 'a.ts'), 'react', exists) === null)
  // 🔴 目录与同名文件并存时（`lib/a/` 与 `lib/a.ts`），必须选**文件**。
  //    生产里传给 resolveImport 的是「文件集合」（目录永远不在里面）——
  //    这正是修掉「用 fs.existsSync 先命中目录、把门面误判成未接线」那个 bug 的方式。
  const filesOnly = (p: string) => p in fixture
  ok('🔴 ① 目录与同名文件并存时选文件（用 fs.existsSync 会先命中目录）',
    filesOnly(rel(SRC, 'lib', 'a', 'index.ts'))
    && resolveImport(rel(SRC, 'lib', 'b.ts'), '@/lib/a', filesOnly) === rel(SRC, 'lib', 'a.ts'))
}

// ---------- ② 说明符抽取 ----------
{
  const specs = importSpecifiers([
    "import x from './x'",
    "export { y } from './y'",
    "const z = await import('./z')",
    "const r = require('./r')",
    "// import bad from './commented'",
    'const s = "from \'./in-string\'"',
  ].join('\n'))
  ok('② 静态 import / 再导出 / 动态 import / require 都抽到',
    ['./x', './y', './z', './r'].every(s => specs.includes(s)))
  ok('🔴 ② 注释里的 import 不抽（否则删了文件也"有人用"）', !specs.includes('./commented'))
}

// ---------- ③ 扫描结果 ----------
const result = scanUnwiredModules(ROOT, {
  files: Object.keys(fixture),
  testFiles: Object.keys(testFixture),
  readFile,
})
{
  const byFile = new Map(result.findings.map(f => [f.file, f]))
  ok('③ 被入口引用的文件不算未接线', !byFile.has(rel(SRC, 'lib', 'a.ts')))
  ok('③ 目录入口（deep/index.ts）不算未接线', !byFile.has(rel(SRC, 'lib', 'deep', 'index.ts')))
  ok('③ 再导出目标不算未接线', !byFile.has(rel(SRC, 'lib', 'reexported.ts')))
  ok('③ 动态 import 目标不算未接线', !byFile.has(rel(SRC, 'lib', 'lazy-target.ts')))
  ok('🔴 ③ 入口文件本身不算未接线', !byFile.has(rel(SRC, 'main.tsx')) && ENTRY_FILES.includes(rel(SRC, 'main.tsx')))
  ok('③ 完全没人用的模块被报出来', byFile.has(rel(SRC, 'lib', 'orphan.ts')))
  ok('🔴 ③ 只在注释里被提到的模块仍算未接线', byFile.has(rel(SRC, 'lib', 'comment-only.ts')))
  ok('③ 只被测试 import 的模块仍算未接线，且标出 testImporters',
    byFile.get(rel(SRC, 'lib', 'only-tested.ts'))?.testImporters === 1,
    JSON.stringify(byFile.get(rel(SRC, 'lib', 'only-tested.ts'))))
  ok('③ 统计自洽（wired + unwired + 入口 = 文件数）',
    result.stats.wired + result.stats.unwired + ENTRY_FILES.filter(f => f in fixture).length === result.stats.files,
    JSON.stringify(result.stats))
}

// ---------- ④ 台账校验 ----------
{
  const exists = (p: string) => p in fixture
  const good = validateUnwiredLedger([
    { file: rel(SRC, 'lib', 'orphan.ts'), status: 'gap', reason: '这套逻辑按方案实现了但产品侧没有入口，接线需要界面位置，属产品决定' },
  ], exists)
  ok('④ 合法台账通过', good.ok, good.issues.join('; '))

  const badStatus = validateUnwiredLedger([{ file: rel(SRC, 'lib', 'orphan.ts'), status: 'whatever', reason: '这套逻辑按方案实现了但产品侧没有入口，接线需要界面位置' }], exists)
  ok('🔴 ④ 状态非法被拦', !badStatus.ok && badStatus.issues.some(i => i.includes('status')))

  const shortReason = validateUnwiredLedger([{ file: rel(SRC, 'lib', 'orphan.ts'), status: 'gap', reason: '暂时留着' }], exists)
  ok('🔴 ④ 理由太短被拦（敷衍等于没写）', !shortReason.ok && shortReason.issues.some(i => i.includes('理由太短')))

  const gone = validateUnwiredLedger([{ file: rel(SRC, 'lib', 'gone.ts'), status: 'gap', reason: '这条故意指向不存在的文件，用来验证登记未清理会被拦' }], exists)
  ok('🔴 ④ 登记指向已删除文件被拦', !gone.ok && gone.issues.some(i => i.includes('已不存在')))

  const dup = validateUnwiredLedger([
    { file: rel(SRC, 'lib', 'orphan.ts'), status: 'gap', reason: '第一条理由写得足够长，用来验证重复登记会被拦下来' },
    { file: rel(SRC, 'lib', 'orphan.ts'), status: 'harness', reason: '第二条同样写得够长，重复登记必须被拦，否则台账对不上' },
  ], exists)
  ok('④ 重复登记被拦', !dup.ok && dup.issues.some(i => i.includes('重复登记')))
}

// ---------- ⑤ 台账对账 ----------
{
  const findings = [{ rule: 'wired.missing' as const, confidence: 'review' as const, file: rel(SRC, 'lib', 'orphan.ts'), line: 1, testImporters: 0, message: 'x' }]
  const recon = reconcileUnwiredLedger(findings, [
    { file: rel(SRC, 'lib', 'orphan.ts'), status: 'gap' as const, reason: '已登记' },
    { file: rel(SRC, 'lib', 'wired-now.ts'), status: 'gap' as const, reason: '登记了但现在已经接线' },
  ])
  ok('⑤ 实测已登记 ⇒ 无 unregistered', recon.unregistered.length === 0)
  ok('🔴 ⑤ 登记了但现在已接线 ⇒ 判为失效（台账不能变谎言）', recon.stale.includes(rel(SRC, 'lib', 'wired-now.ts')))

  const recon2 = reconcileUnwiredLedger(
    [...findings, { rule: 'wired.missing' as const, confidence: 'review' as const, file: rel(SRC, 'lib', 'new-gap.ts'), line: 1, testImporters: 0, message: 'x' }],
    [{ file: rel(SRC, 'lib', 'orphan.ts'), status: 'gap' as const, reason: '已登记' }],
  )
  ok('🔴 ⑤ 新增未接线没登记 ⇒ 判为 unregistered', recon2.unregistered.includes(rel(SRC, 'lib', 'new-gap.ts')))
}

// ---------- ⑥ 真实仓库 ----------
{
  const root = process.cwd()
  const real = scanUnwiredModules(root)
  const ledger = JSON.parse(fs.readFileSync(`${root}/scripts/audit/unwired-ledger.json`, 'utf8')).entries as Array<{ file: string }>
  const recon = reconcileUnwiredLedger(real.findings, ledger as never)
  ok('🔴 ⑥ 真实仓库里每个未接线模块都已登记（新增一个就会红）',
    recon.unregistered.length === 0, recon.unregistered.join(', '))
  ok('🔴 ⑥ 台账没有失效项（接线了要清）', recon.stale.length === 0, recon.stale.join(', '))
  ok('⑥ 台账状态与理由齐全',
    validateUnwiredLedger(ledger, f => fs.existsSync(`${root}/${f}`)).ok)
  ok('⑥ 真实仓库的未接线里含已判定的能力缺口（台账不是空壳）',
    real.findings.some(f => ledger.some(e => e.file === f.file)))
}

console.log(`\n———— 未接线模块：${pass} 通过 / ${fail} 失败 ————`)
if (fail) process.exit(1)
