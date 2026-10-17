process.env.YFE_AUDIT_FULL ??= '1'
// 功能性审查扫描器（只读）—— 补「功能是否真可用、是否达到设计目的」里**能静态判定**的那部分
// 用法：node .workbuddy/tmp/audit-func.mjs [工作区路径]
// 判不了的是实机部分（点得通不通、对齐了没有）→ 那归 novel-studio-ui-livecheck；
// 能判的是：组件有没有被挂到页面上、AI 按钮有没有就绪守卫、失败有没有让用户看见。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = (process.argv[2] || 'G:/AI软件/youth-fantasy-engine开发源码').replace(/\\/g, '/')
const SRC = path.join(ROOT, 'src')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(e.name)) out.push(p)
  }
  return out
}
const skipDir = d => /(node_modules|\.git|dist|dist-web|release)$/.test(d)
function walkAll(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!skipDir(e.name)) walkAll(p, out) }
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(e.name)) out.push(p)
  }
  return out
}
const rel = f => path.relative(ROOT, f).replace(/\\/g, '/')

const tsFiles = walk(SRC)
const allCode = walkAll(ROOT)
const src = new Map()
for (const f of [...tsFiles, ...allCode]) if (!src.has(f)) src.set(f, fs.readFileSync(f, 'utf8'))

const tsxFiles = tsFiles.filter(f => /\.tsx$/.test(f))
// 🔴 F1 的扫描面 = 「组件目录下的 ts + tsx」，不能只看 .tsx。
// 起因（2026-09-19 D4 拆分实测）：原本写在 .tsx 组件里的 AI 调用被搬进同目录的 .ts 子 hook
// （`useFreeTurn.ts` / `useFreeRoundEnd.ts` / `useNovelEditorGhost.ts` …），只看 .tsx 会让这些
// 调用点整个脱离 F1 视野 —— 表现为「分子分母一起变小」，那是**口径变窄**，不是「守卫变好」。
// 判据不能只看文件后缀，要看它是不是「界面单元」（UI 组件或它自己的 hook）。
const uiUnits = tsFiles.filter(f => f.replace(/\\/g, '/').includes('/src/components/'))
const out = []
const P = s => out.push(s)

// ── F1. AI 功能：有没有「就绪守卫」────────────────────────────────
// 典型翻车：没配模型时按钮照样可点 → 点了没反应（或白等 180s 才超时），用户以为软件坏了。
{
  const AI_CALL = /(?:from\s+['"][^'"]*\/lib\/(?:ai|aiTasks|aiWorkflow)['"])|aiChatJson|\bai\.chat\b|runAi|aiInlineSuggest/
  const GUARD = /useAIReady|aiReady|!cfg|!cap\s*\||isAIReady|!model\b|ensureReady/
  const users = uiUnits.filter(f => AI_CALL.test(src.get(f)))
  const noGuard = users.filter(f => !GUARD.test(src.get(f)))
  P(`\n── F1. 会调 AI 但未见就绪守卫的界面单元（${noGuard.length}/${users.length}）──`)
  P('  判读：逐个在未配置模型的机器上点一遍 —— 应当要么禁用、要么提示去配置，而不是点了没反应。')
  P('  ⚠️ 守卫可能来自父组件 props（本文件看不到），所以没命中不代表一定漏，要人工确认一层。')
  for (const f of (process.env.YFE_AUDIT_FULL === '1' ? noGuard : noGuard.slice(0, 15))) P(`  ▸ ${rel(f)}`)
  if (!noGuard.length) P('  ✅ 全部有就绪判断')
}

// ── F2. 组件是否真的被挂到页面上 ──────────────────────────────────
// 「写完了但没接入口」= 功能在，用户用不到。这是 audit-dead 的组件专版：
// 那里的语义是"死代码"，这里是"功能缺口"（该接入口而不是删）。
{
  const comps = []
  for (const f of tsxFiles) {
    const s = src.get(f)
    const names = new Set()
    for (const mm of s.matchAll(/export\s+(?:default\s+)?(?:const|function)\s+([A-Z]\w*)/g)) names.add(mm[1])
    for (const mm of s.matchAll(/export\s+default\s+([A-Z]\w*)/g)) names.add(mm[1])
    for (const name of names) {
      // app 入口与 index 不算引用彼方 —— 要找的是"有没有组件子树引用它"
      let refs = 0
      for (const g of tsFiles) {
        if (g === f) continue
        refs += [...src.get(g).matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length
      }
      comps.push({ name, file: rel(f), refs })
    }
  }
  const orphans = comps.filter(c => c.refs === 0).sort((a, b) => a.file.localeCompare(b.file))
  P(`\n── F2. 未被任何地方引用的组件（${orphans.length} 个）──`)
  P('  判读：先分清性质 ——')
  P('   · 「真死」：语义已被替代/历史遗留 → 删')
  P('   · 「能力缺口」：实现完整只是没接口 → **保留**，报告里建议接入口（删了等于扔掉唯一的自救工具）')
  P('  ⚠️ 通过字符串映射动态渲染的组件会显示为 0，属已知假报，须抽 3~5 个回源码确认。')
  for (const c of (process.env.YFE_AUDIT_FULL === '1' ? orphans : orphans.slice(0, 20))) P(`  ▸ ${c.name}  ${c.file}`)
  if (!orphans.length) P('  ✅ 所有导出组件都有引用')
}

// ── F3. AI / 异步操作的失败是否让用户看见 ─────────────────────────
{
  const bad = [], deep = []
  for (const f of tsFiles) {
    const s = src.get(f)
    if (!/await\s+.*(?:chat|ai[A-Z]|run[A-Z]|generate|extract|suggest)/.test(s)) continue
    if (/catch\s*\(/.test(s)) continue
    if (/toast|showToast|confirmDialog|setErr|onError/.test(s)) continue
    // ⚠️ lib 层的错误常由调用方统一接住（实测 11 条全是 src/lib/tavern/* —— 上层 UI 有 catch），
    //    整份混报会变成纯噪声。拆两栏：**界面层**才是有害的那个。
    (/\.tsx$/.test(f) ? bad : deep).push(rel(f))
  }
  P(`\n── F3. await 了 AI/长任务却不见 try-catch 也不见错误提示 ──`)
  P('  判读：uncaught rejection → 按钮转瞬即回、界面毫无反馈，用户只会以为「没反应」。')
  P(`  ▸ 界面层（有害 · ${bad.length} 个）`)
  for (const f of (process.env.YFE_AUDIT_FULL === '1' ? bad : bad.slice(0, 15))) P(`       ${f}`)
  if (!bad.length) P('       ✅ 界面层都有兜底')
  P(`  ▸ 底层模块（${deep.length} 个）—— 多半由调用方统一 catch，噪音大，仅供顺手一瞥`)
  for (const f of (process.env.YFE_AUDIT_FULL === '1' ? deep : deep.slice(0, 8))) P(`       ${f}`)
}

// ── F4. 项目自带的两道闸（提示，顺手在这里纳入口径）────────────────
{
  const gates = ['tests/feature-deps-check.mjs', 'tests/seed-schema-check.mjs', 'tests/importCycles.test.ts']
  const missing = gates.filter(g => !fs.existsSync(path.join(ROOT, g)))
  P(`\n── F4. 字符串弱引用闸（tsc 抓不到，必须单跑）──`)
  if (missing.length) P(`  ⚠️ 未找到：${missing.join('、')}`)
  else {
    P('  ✅ 三道闸都在 —— 改 schema/功能门/import 关系后必跑：')
    P('       node tests/feature-deps-check.mjs     # 功能门 id ↔ 页签 id')
    P('       node tests/seed-schema-check.mjs      # 种子键 ↔ schema 列名')
    P('       node tests/build-test.mjs importCycles  # 循环依赖（只在浏览器 TDZ 崩）')
  }
}

console.log(out.join('\n'))
console.log('\n⚠️ 功能「能不能用」最终要靠实机与实弹：静态只能看到入口/守卫/报错三条线。')
const { printSupplement } = await import('../compat.mjs')
printSupplement(ROOT, 'func')
