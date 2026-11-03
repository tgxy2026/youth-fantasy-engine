// ============ 源码路径闸：测试里写死的 src/ 路径必须真实存在 ============
//
// 🔴 为什么必须有这条闸（2026-10-04 / 2026-10-10 两次真实踩坑）
//
//   很多测试用「读源码再断言」的手法（读某个 src 文件，断言里面/不含某段字）。
//   文件一旦被**搬走或改名**，这种测试有两种下场，而且都不好：
//     · 断言「**包含**」的那条 → 当场转红（这还算好的，至少看得见）；
//     · 断言「**不包含**」的那条 → **恒真、永远绿**，其实什么都没测（最危险）。
//
//   `tests/sourceScan.ts` 顶部注释记的就是第一次踩坑（ai.ts / schema.ts 拆分）。
//   2026-10-10 的目录结构优化会让**几百个**这样的字面量同时面临搬迁风险，
//   ⇒ 与其逐个靠人记，不如把这一类风险**一次性变成响亮失败**：
//
//     本闸扫 `tests/**`（排除构建产物）里所有 `'src/…'` 字符串字面量，逐个查磁盘是否真的存在。
//     文件一搬走 ⇒ 立刻列出「哪个测试文件、第几行、哪个路径」——照着改即可，不可能再静默失明。
//
// 判据边界（刻意宽松，避免误报 —— 踩过这四种）：
//   · 只扫**源码**：排除 `tests/.xxx.mjs` 这类 esbuild 产物（它们会把源码里每个字面量复制一遍）；
//   · 跳过**模板串插值**（含 `${`）：那是运行时拼出来的（如从目录列表拼文件名），静态查不了；
//   · 跳过**通配符/省略号**（含 `*` `...` `…`）：如 `src/lib/**` 是文档里的示意；
//   · 跳过**注释行**（行首 `//` `*` `/*`）：文档里举的例子不是路径。
//   · 文件或**目录**存在都算过（helper 也可能读目录）。
//   · 「**刻意断言某文件不存在**」的路径登记进 `INTENTIONALLY_ABSENT`（具名豁免 + 写明理由，
//     与 `structureGates` 的 TYPE_FILE_OK / JSON_PARSE_OK 同一套手法）。
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/**
 * 具名豁免：**刻意断言「它不存在」**的路径。
 * 这类路径"不存在"正是测试要的结论，不该被本闸判失败。新增请写清理由。
 */
const INTENTIONALLY_ABSENT: Record<string, string> = {
  'src/components/AutoContinue.tsx': '测试刻意断言它已被删除（能力并入创意写作），见 creativeModes.test.ts',
}

const root = process.cwd()
const testsDir = path.join(root, 'tests')

const testFiles = fs.readdirSync(testsDir)
  .filter(f => /\.(ts|mjs)$/.test(f) && !f.startsWith('.'))
  .map(f => path.join(testsDir, f))

/** 引号包起来的 `src/…` 字面量（三种引号都认） */
const LIT_RE = /(['"`])(src\/[^'"`\n]+)\1/g
const SKIP_IN = /\$\{|\*|\.\.\.|…/

const found: { file: string; line: number; p: string }[] = []
for (const f of testFiles) {
  const lines = fs.readFileSync(f, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    LIT_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = LIT_RE.exec(lines[i]))) {
      if (SKIP_IN.test(m[2])) continue
      found.push({ file: path.relative(root, f).replace(/\\/g, '/'), line: i + 1, p: m[2] })
    }
  }
}

const missing = found.filter(x => !fs.existsSync(path.join(root, x.p)) && !INTENTIONALLY_ABSENT[x.p])

ok(`🧭 扫到测试里的 src/ 路径字面量（${found.length} 条 / ${new Set(found.map(x => x.file)).size} 个文件；豁免 ${Object.keys(INTENTIONALLY_ABSENT).length} 条）`,
  found.length > 100,
  `只有 ${found.length} 条 —— 少于 100 条说明扫描本身可能失效（正则/过滤被改坏？）`)

ok('🔴 每个路径都真实存在（不存在 = 文件被搬走，相关断言可能已**静默失明**）',
  missing.length === 0,
  missing.slice(0, 8).map(x => `${x.file}:${x.line} ${x.p}`).join(' ｜ '))

if (missing.length) {
  console.log('\n需要同步的路径（文件 / 行 / 原路径）：')
  for (const x of missing) console.log(`  · ${x.file}:${x.line}  ${x.p}`)
}

console.log(`\nsourcePathGuard: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
