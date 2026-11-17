// ============ 结构约束契约闸（3.6.0 · 审计策略化第二轮）============
//
// 盯五件事：
//   ① 非 UI 层引用 UI 层必须被抓到（别名与相对路径两种写法都要认）；
//   ② 注释里举例的 import 不算（历史假命中点）；
//   ③ 未登记门面（几乎整文件再导出）要被抓，已声明的门面不能被误报；
//   ④ 门面名单自洽：登记了却不存在 / 缺理由 必须被拦；
//   ⑤ 真实仓库：两条硬线都是 0，且预算表把它们按 0 卡住。
import fs from 'node:fs'
import path from 'node:path'
import {
  DECLARED_FACADES, NON_UI_DIRS, scanStructure, validateFacadeRegistry,
} from '../scripts/audit/structure-checks.mjs'
import { validateStructureBudget } from '../scripts/audit/registry-check.mjs'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/**
 * 🔴 夹具路径用变量拼：`tests/sourcePathGuard.test.ts` 会把测试里所有 `'src/...'`
 *    字面量当仓库真实路径查磁盘，虚构名会判失败。
 */
const ROOT = '/fixture-root'
const SRC = 'src'
const rel = (...parts: string[]) => parts.join('/')
const abs = (relPath: string) => path.join(ROOT, relPath)

const fixture: Record<string, string> = {
  // ① 非 UI 层用别名引用 UI 层 ⇒ 必须报
  [abs(rel(SRC, 'lib', 'bad-alias.ts'))]: [
    "import { Button } from '@/components/common/Button'",
    'export const x = Button',
  ].join('\n'),
  // ① 相对路径引用 ⇒ 也要报
  [abs(rel(SRC, 'lib', 'deep', 'bad-relative.ts'))]: [
    "import { Modal } from '../../components/common/Modal'",
    'export const y = Modal',
  ].join('\n'),
  // ② 注释里的 import 不算
  [abs(rel(SRC, 'lib', 'commented.ts'))]: [
    '// 例如：import { Button } from "@/components/common/Button"',
    '/* import { Modal } from "../../components/x" */',
    'export const z = 1',
  ].join('\n'),
  // 正常：lib 内部互相引用
  [abs(rel(SRC, 'lib', 'fine.ts'))]: [
    "import { helper } from './helper'",
    'export const w = helper',
  ].join('\n'),
  // ③ 未登记门面：整文件只再导出
  [abs(rel(SRC, 'lib', 'facade-undeclared.ts'))]: [
    "export { a } from './a'",
    "export { b } from './b'",
    "export * from './c'",
  ].join('\n'),
  // ③ 已声明门面：同样形态但不该报
  [abs(rel(SRC, 'lib', 'db.ts'))]: [
    "export { a } from './db/a'",
    "export { b } from './db/b'",
  ].join('\n'),
  // ④ 带真实逻辑的文件不算门面
  [abs(rel(SRC, 'lib', 'impl.ts'))]: [
    "import { a } from './a'",
    'export function run() { return a() }',
    'export const K = 1',
  ].join('\n'),
}

const files = Object.keys(fixture).map(f => path.relative(ROOT, f).replaceAll('\\', '/'))
const readFile = (f: string) => fixture[f] ?? ''
const result = scanStructure(ROOT, { files, readFile })
const hits = (rule: string) => result.findings.filter(f => f.rule === rule)

console.log('—— structureChecks：结构约束（3.6.0 · 审计策略化第二轮）——')

// ---------- ① 反向依赖 ----------
{
  const reverse = hits('arch.reverse-import')
  const names = reverse.map(f => f.file)
  ok('🔴 ① 别名写法被抓获', names.some(n => n.endsWith('bad-alias.ts')))
  ok('🔴 ① 相对路径写法被抓获', names.some(n => n.endsWith('bad-relative.ts')))
  ok('① 命中带行号（能直接跳过去改）', reverse.every(f => f.line >= 1))
  ok('① 文案给出修法而不是只报错', /下沉成参数|提到 lib/.test(reverse[0]?.message ?? ''))
  ok('① 非 UI 层内部互相引用不报', !names.some(n => n.endsWith('fine.ts')))
  ok('① 非 UI 层目录定义包含 lib 与 data',
    NON_UI_DIRS.includes('src/lib/') && NON_UI_DIRS.includes('src/data/'))
}

// ---------- ② 注释不算 ----------
{
  ok('🔴 ② 注释里举例的 import 不报', !hits('arch.reverse-import').some(f => f.file.endsWith('commented.ts')))
}

// ---------- ③ 未登记门面 ----------
{
  const facades = hits('arch.facade-undeclared').map(f => f.file)
  ok('🔴 ③ 整文件再导出且未登记 ⇒ 报', facades.some(n => n.endsWith('facade-undeclared.ts')))
  ok('🔴 ③ 已声明门面不误报', !facades.some(n => n.endsWith('db.ts')))
  ok('③ 含真实逻辑的文件不算门面', !facades.some(n => n.endsWith('impl.ts')))
  ok('③ 文案要求「删或登记并写理由」', /DECLARED_FACADES/.test(hits('arch.facade-undeclared')[0]?.message ?? ''))
}

// ---------- ④ 门面名单自洽 ----------
{
  ok('④ 合规名单通过', validateFacadeRegistry(
    [{ file: rel(SRC, 'lib', 'db.ts'), reason: '存储层门面，实体在 src/lib/db/ 下的域模块里' }],
    () => true,
  ).ok)
  ok('🔴 ④ 登记了但文件不存在 ⇒ 失败', !validateFacadeRegistry(
    [{ file: rel(SRC, 'lib', 'gone.ts'), reason: '这个门面文件早就被删掉了但名单没清' }],
    () => false,
  ).ok)
  ok('🔴 ④ 缺理由 ⇒ 失败（写不出理由就不该进名单）', !validateFacadeRegistry(
    [{ file: rel(SRC, 'lib', 'db.ts'), reason: '门面' }],
    () => true,
  ).ok)
  ok('④ 非 src 路径 ⇒ 失败', !validateFacadeRegistry(
    [{ file: 'docs/x.md', reason: '理由写得足够长了但路径不对' }],
    () => true,
  ).ok)
}

// ---------- ⑤ 结构预算：预期长期为 0 ----------
{
  ok('⑤ 全 0 ⇒ 通过', validateStructureBudget({
    budget: { structure: { 'arch.reverse-import': 0, 'arch.facade-undeclared': 0 } },
    counts: { 'arch.reverse-import': 0, 'arch.facade-undeclared': 0 },
  }).ok)
  ok('🔴 ⑤ 出现 1 处反向依赖 ⇒ 失败（硬线，不留余量）', !validateStructureBudget({
    budget: { structure: { 'arch.reverse-import': 0 } },
    counts: { 'arch.reverse-import': 1 },
  }).ok)
  ok('⑤ 预算表缺规则时按 0 处理（不能靠漏写豁免）', !validateStructureBudget({
    budget: { structure: {} },
    counts: { 'arch.reverse-import': 1 },
  }).ok)
  ok('⑤ 没有任何规则计数 ⇒ 失败（防扫描器静默失明）', !validateStructureBudget({ budget: {}, counts: {} }).ok)
}

// ---------- ⑥ 真实仓库 ----------
{
  const real = scanStructure(process.cwd())
  ok('⑥ 真实仓库两条硬线都是 0',
    real.stats.reverseImports === 0 && real.stats.undeclaredFacades === 0,
    JSON.stringify(real.stats))
  ok('⑥ 真实仓库扫到了全部源码文件', real.stats.files > 900, String(real.stats.files))
  ok('⑥ 真实门面名单自洽', validateFacadeRegistry(
    DECLARED_FACADES, f => fs.existsSync(path.join(process.cwd(), f)),
  ).ok)
  const budget = JSON.parse(fs.readFileSync('scripts/audit/debt-budget.json', 'utf8'))
  ok('⑥ 预算表登记了这两条硬线且为 0',
    budget.structure?.['arch.reverse-import'] === 0 && budget.structure?.['arch.facade-undeclared'] === 0,
    JSON.stringify(budget.structure))
}

console.log(`\n———— structureChecks：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
