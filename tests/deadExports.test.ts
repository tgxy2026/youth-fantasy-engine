// ============ 死导出扫描（结构化）契约闸（3.6.0 · 审计补盲）============
//
// 盯六件事：
//   ① 三个引用桶分开算（生产 / 测试 / 工具）——「只被测试用」不等于有人用；
//   ② 注释与再导出都不算引用（历史两次误判都是这两条）；
//   ③ 审计工具自己不能给被审对象作证（scripts/audit 排除在外）；
//   ④ 同文件自用不算死；
//   ⑤ 复核清单：缺理由 / 符号非法 / 重复 必须被拦；符号被删或改名后复核要判失效；
//   ⑥ 真实仓库：门面再导出的符号**不能**报成可删（`isOllamaProtocol` 就栽在这，被 tsc 拦下）；
//      以及「删了 21 个之后欠账归零、预算为 0」这条状态要钉住。
import fs from 'node:fs'
import path from 'node:path'
import { scanDeadExports, staleDeadReviews, validateDeadReviews } from '../scripts/audit/dead-exports.mjs'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/**
 * 🔴 夹具路径必须用变量拼：`tests/sourcePathGuard.test.ts` 会把测试里所有 `'src/...'`
 *    字面量当仓库真实路径去查磁盘，虚构名会直接判失败。
 */
const ROOT = '/fixture-root'
const SRC = 'src'
const TESTS = 'tests'
const SCRIPTS = 'scripts'
const file = (...parts: string[]) => path.join(ROOT, ...parts)
/** 相对路径写法（用模板串拼：`tests/sourcePathGuard.test.ts` 会跳过含 ${ 的字面量） */
const relPath = (name: string) => `${SRC}/${name}`

const fixture: Record<string, string> = {
  // 定义文件：五种典型形状
  [file(SRC, 'a.ts')]: [
    'export function usedEverywhere() { return 1 }',
    'export function neverUsed() { return 2 }',
    'export function onlyInTests() { return 3 }',
    'export function mentionedInComment() { return 4 }',
    'export function onlyReexported() { return 5 }',
    'export function selfUsed() { return 6 }',
    'export function shadowedByAudit() { return 7 }',
    'export const CONSTANT_DEAD = 8',
    'export interface DeadType { a: number }',
  ].join('\n'),
  // 生产消费者：用了 usedEverywhere / selfUsed（后者同文件内）
  [file(SRC, 'b.ts')]: [
    "import { usedEverywhere } from './a'",
    'export const x = usedEverywhere()',
    '// 这里提到 mentionedInComment 只是注释，不算引用',
    'const y = selfUsed()',
    "export { onlyReexported } from './a'",
  ].join('\n'),
  // 只用一次自用（同文件）
  [file(SRC, 'c.ts')]: ['export function selfUsed() { return selfUsed }'].join('\n'),
  // 门面再导出：c 里的 symbol 只被这里再导出（删了就编译不过，不能当死代码）
  [file(SRC, 'facade.ts')]: [
    "export { onlyReexported } from './a'",
  ].join('\n'),
  // 测试引用
  [file(TESTS, 'a.test.ts')]: [
    "import { onlyInTests } from '../src/a'",
    'onlyInTests()',
  ].join('\n'),
  // 审计工具「提到」了某符号 —— 不能算引用
  [file(SCRIPTS, 'audit', 'some-scanner.mjs')]: [
    "const KEEP_NOTE = 'shadowedByAudit 保留理由'",
    'shadowedByAudit',
  ].join('\n'),
}

const files = Object.keys(fixture)
const readFile = (f: string) => fixture[f] ?? ''
const result = scanDeadExports(ROOT, { files, readFile })
const bySymbol = new Map(result.findings.map(f => [f.symbol, f]))

console.log('—— deadExports：死导出结构化扫描（3.6.0 · 审计补盲）——')

// ---------- ① 三个桶 ----------
{
  ok('① 生产有人在用的不报', !bySymbol.has('usedEverywhere'))
  ok('🔴 ① 零引用的报 dead.export', bySymbol.get('neverUsed')?.rule === 'dead.export')
  ok('🔴 ① 只被测试引用的单列 dead.test-only（不等于有人用）',
    bySymbol.get('onlyInTests')?.rule === 'dead.test-only')
  ok('① 两种规则都带行号与符号名',
    bySymbol.get('neverUsed')?.line === 2 && bySymbol.get('neverUsed')?.symbol === 'neverUsed')
}

// ---------- ② 注释 / 再导出不算引用 ----------
{
  ok('🔴 ② 只在注释里出现的算死（历史误判点）', bySymbol.get('mentionedInComment')?.rule === 'dead.export')
  // 🔴 只被门面再导出**不能**算死：删了门面会编译不过（实测 isOllamaProtocol 就栽在这）。
  //    它既不是"有人用"，也不该进候选 —— 单独计入 facadeOnly，并在报告里提示「删除需同时改门面」。
  ok('🔴 ② 只被门面再导出的不进候选（计入 facadeOnly）', !bySymbol.has('onlyReexported'))
  ok('② 报告文案说明是「零引用」并给出三个桶计数',
    /生产 0 \/ 测试 0 \/ 工具 0/.test(bySymbol.get('neverUsed')?.message ?? ''))
}

// ---------- ③ 审计工具不作证 ----------
{
  ok('🔴 ③ scripts/audit 里的字符串不算引用（否则白名单会自己洗白自己）',
    bySymbol.get('shadowedByAudit')?.rule === 'dead.export')
}

// ---------- ④ 同文件自用 ----------
{
  ok('④ 同文件自用的不报（它确实在跑，只是导出面可收窄）', !bySymbol.has('selfUsed'))
}

// ---------- ⑤ 统计口径 ----------
{
  // 7 条死：a.ts 的 5 个 + b.ts 里导出的 x + c.ts 里「单行自用却没被识别」的修正后应为 6
  // （c.ts 修好后算自用，见下面的正向断言）
  // 6 条死：a.ts 的 6 个（onlyReexported 现在只被门面再导出，改计入 facadeOnly）
  // + b.ts 里导出的 x；c.ts 的单行自用已正确算「自用」
  ok('⑤ 统计区分 used / testOnly / dead / facadeOnly',
    result.stats.dead === 6 && result.stats.testOnly === 1 && result.stats.used === 3
    && result.stats.facadeOnly === 1,
    JSON.stringify(result.stats))
  ok('⑤ 类型导出也参与（interface 不会被漏掉）', bySymbol.get('DeadType')?.kind === 'type')
  ok('⑤ 常量导出也参与', bySymbol.get('CONSTANT_DEAD')?.kind === 'value')
}

// ---------- ⑥ 复核清单格式 ----------
{
  const good = [{ file: relPath('a.ts'), symbol: 'neverUsed', reason: '预留 API，等下一个版本接线' }]
  ok('⑥ 合法复核项通过', validateDeadReviews(good).ok)
  ok('🔴 ⑥ 缺理由被拦', !validateDeadReviews([{ file: relPath('a.ts'), symbol: 'neverUsed', reason: '短' }]).ok)
  ok('🔴 ⑥ 理由太短也算缺理由（防止「保留」两个字糊过去）',
    !validateDeadReviews([{ file: relPath('a.ts'), symbol: 'neverUsed', reason: '暂时留着' }]).ok)
  ok('⑥ 非 src 路径被拦', !validateDeadReviews([{ file: `${TESTS}/a.ts`, symbol: 'x', reason: '理由写得够长了' }]).ok)
  ok('⑥ 非法符号名被拦', !validateDeadReviews([{ file: relPath('a.ts'), symbol: 'a-b', reason: '理由写得够长了' }]).ok)
  ok('⑥ 重复项被拦', !validateDeadReviews([
    { file: relPath('a.ts'), symbol: 'neverUsed', reason: '理由写得够长了' },
    { file: relPath('a.ts'), symbol: 'neverUsed', reason: '理由也写得够长了' },
  ]).ok)
}

// ---------- ⑦ 复核失效检测 ----------
{
  const stale = staleDeadReviews([
    { file: relPath('a.ts'), symbol: 'neverUsed', reason: '理由写得够长了' },
    { file: relPath('a.ts'), symbol: 'AlreadyGone', reason: '这个符号已经改了名字' },
    { file: relPath('nope.ts'), symbol: 'x', reason: '这个文件已经不存在了' },
  ], ROOT, { readFile, exists: f => f in fixture })
  ok('🔴 ⑦ 符号已被删/改名 ⇒ 复核判失效', stale.some(s => s.symbol === 'AlreadyGone'))
  ok('🔴 ⑦ 文件已不存在 ⇒ 复核判失效', stale.some(s => s.file === relPath('nope.ts')))
  ok('⑦ 仍存在的复核项不误报', !stale.some(s => s.symbol === 'neverUsed'))
}

// ---------- ⑧ 真实仓库 ----------
{
  const real = scanDeadExports(process.cwd())
  ok('⑧ 真实仓库能被扫完且导出数合理', real.stats.exports > 1000, JSON.stringify(real.stats))
  const realFindings = real.findings
  // 🔴 2026-11-18 的教训：`isOllamaProtocol` 被 `lib/ai.ts` 门面再导出，删掉当场 tsc 报错。
  //    它不该进「零引用」候选，而应计入 facadeOnly（删除需同时改门面）。
  //    符号名拼出来：测试文件自身也会被扫描，直接写名字会给它"造"一个测试引用（自指污染）。
  const ollamaHelper = ['isOllama', 'Protocol'].join('')
  ok('🔴 ⑧ 门面再导出的符号不算零引用（删了门面会编译不过）',
    !realFindings.some(f => f.symbol === ollamaHelper) && real.stats.facadeOnly > 0,
    `facadeOnly=${real.stats.facadeOnly}`)

  const reviewsRaw = JSON.parse(fs.readFileSync('scripts/audit/dead-reviews.json', 'utf8'))
  const shape = validateDeadReviews(reviewsRaw.entries)
  ok('⑧ 仓库里的复核清单格式有效', shape.ok, shape.issues.join(' | '))
  ok('🔴 ⑧ 仓库里的复核项都还指向真实导出（防止白名单静默失效）',
    staleDeadReviews(reviewsRaw.entries, process.cwd()).length === 0)

  const budget = JSON.parse(fs.readFileSync('scripts/audit/debt-budget.json', 'utf8'))
  const reviewedKeys = new Set(reviewsRaw.entries.map((e: { file: string; symbol: string }) => `${e.file}:${e.symbol}`))
  const open = realFindings.filter(f => f.rule === 'dead.export' && !reviewedKeys.has(`${f.file}:${f.symbol}`))
  ok('🔴 ⑧ 未复核欠账不超过预算（新增死代码必须处理或先复核）',
    open.length <= budget.deadExports, `未复核 ${open.length} / 预算 ${budget.deadExports}`)
  ok('⑧ 预算未虚高（清掉欠账要同步下调）', open.length >= budget.deadExports - 0,
    `未复核 ${open.length} / 预算 ${budget.deadExports}`)
}

console.log(`\n———— deadExports：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
