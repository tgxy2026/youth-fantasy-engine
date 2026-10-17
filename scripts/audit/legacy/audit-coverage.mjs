process.env.YFE_AUDIT_FULL ??= '1'
// 测试覆盖矩阵扫描器（只读）—— 回答「谁没人测」
// 用法：node .workbuddy/tmp/audit-coverage.mjs [工作区路径]
//
// 为什么需要它：六维审计看的是「代码写得对不对」，不看「有没有人守着」。
// 项目里有若干**改了没人拦、坏了没人报**的模块 —— 直到用户在真实数据上遇到。
// 判据：该文件是否被任何测试或闸「引入」（import 路径命中）或「按名提及」（符号命中）。
//
// ⚠️ 输出是「零覆盖候选」：纯展示型组件、类型文件、数据表天然无需单测，
//    判断哪个**该测**要看它的性质（安全 / 数据 / 算法 > 展示）。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = (process.argv[2] || 'G:/AI软件/youth-fantasy-engine开发源码').replace(/\\/g, '/')
const SRC = path.join(ROOT, 'src')
const TESTS = path.join(ROOT, 'tests')
const rel = f => path.relative(ROOT, f).replace(/\\/g, '/')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (/(node_modules|\.git|dist|dist-web|release)$/.test(e.name)) continue
      walk(p, out)
    } else out.push(p)
  }
  return out
}
const read = f => fs.readFileSync(f, 'utf8')

const srcFiles = walk(SRC).filter(f => /\.(ts|tsx)$/.test(f))
const testFiles = fs.existsSync(TESTS)
  ? fs.readdirSync(TESTS)
      // ✅ 只算「真测试（*.test.ts）」与「闸（*-check.mjs）」；
      //    排除 `.` 开头的构建产物、桩（mock-*/fake-*）与运行器（build-test/run-all）——
      //    把它们算进来会让覆盖率虚高（桩文件也 import 产品代码）
      .filter(f => /\.test\.ts$/.test(f) || (/-check\.mjs$/.test(f) && !f.startsWith('.')))
      .map(f => path.join(TESTS, f))
  : []

// ---- ① 收集所有被 import 的路径 ----
const imported = new Set()
const testAll = []
for (const f of testFiles) {
  const s = read(f)
  testAll.push(s)
  for (const m of s.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) imported.add(m[1])
}
const allTestText = testAll.join('\n')

// ---- ② 判定每个 src 文件的覆盖 ----
const norm = p => p.replace(/\\/g, '/').replace(/\.(ts|tsx)$/, '')
const missing = []
for (const f of srcFiles) {
  const n = norm(rel(f))                       // src/lib/tavern/store
  const base = path.basename(f, path.extname(f))
  const stem = n.replace(/^src\//, '')         // lib/tavern/store
  // 命中口径：① 任一处 import 的路径以该 stem 结尾；② 测试文本里出现 `lib/xxx` 形态；③ 出现独特 basename
  const byImport = [...imported].some(imp => {
    const i = imp.replace(/^[./]+/, '').replace(/\.(ts|tsx)$/, '')
    return i === stem || i.endsWith('/' + stem) || i === n || i.endsWith('/' + n)
  })
  const byText = allTestText.includes(stem) || new RegExp('\\b' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(allTestText)
  if (!byImport && !byText) {
    missing.push({ f, lines: read(f).split(/\r?\n/).length })
  }
}

// ---- ③ 分级：安全 / 数据 / 算法 类优先 ----
const HOT = /(crypto|backup|sync|db|migrat|export|import|store|budget|parse|guard|lock|tombstone)/i
const hot = [], normal = []
for (const m of missing) (HOT.test(m.f) ? hot : normal).push(m)
hot.sort((a, b) => b.lines - a.lines)
normal.sort((a, b) => b.lines - a.lines)

const total = srcFiles.length
const pct = ((1 - missing.length / total) * 100).toFixed(1)
const out = []
out.push(`src/ 下共 ${total} 个 TS/TSX 文件；零测试提及 ${missing.length} 个（覆盖率 ${pct}%）`)
out.push(`测试与闸共 ${testFiles.length} 个文件参与判定`)
out.push('')
out.push('─'.repeat(72))
out.push(`■ A. 零覆盖 · 安全/数据/算法类（优先看，共 ${hot.length}）`)
out.push('─'.repeat(72))
for (const m of hot) out.push(`  ${String(m.lines).padStart(5)} 行  ${rel(m.f)}`)
out.push('')
out.push('─'.repeat(72))
out.push(`■ B. 零覆盖 · 其余（多为展示组件/类型/数据表，多数无需单测，共 ${normal.length}）`)
out.push('─'.repeat(72))
for (const m of (process.env.YFE_AUDIT_FULL === '1' ? normal : normal.slice(0, 40))) out.push(`  ${String(m.lines).padStart(5)} 行  ${rel(m.f)}`)
if (normal.length > 40) out.push(`  … 另有 ${normal.length - 40} 个`)
out.push('')
out.push('说明：判据是「被测试 import 或按名提及」。展示型组件与纯类型天然无需单测；')
out.push('      A 类里若出现「有真实消费者却零测试」，那才是真正该补的薄弱点。')

console.log(out.join('\n'))
const { printSupplement } = await import('../compat.mjs')
printSupplement(ROOT, 'coverage')
