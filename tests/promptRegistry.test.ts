// 3.0 · W2-3b 提示词注册完整性 · 单测
//
// 盯四件事（🔴 把原先只在运行时 console.warn 的检查，变成**测试期硬断言**）：
//   ① 静态闸：`components/**` 里**禁止** `registerPrompt(` —— 提示词注册必须在 lib 层（静态可达）；
//   ② 一致性闸：`PROMPT_ORDER` 与各 `*_PROMPTS` 集合的 id **双向包含**；
//   ③ 关键条目在册：`assist-planner`（W2-3 修的那个漏注册）等 6 条就地注册的都在
//      **静态可达路径**上（import 相关模块后 listPrompts() 里就有）；
//   ④ 可复位契约：每个 PromptEntry 都带 `defaultText` / `overridden`。
//
// 📌 用例名刻意写清「为什么」，将来有人想绕过闸时能看懂代价。
import fs from 'node:fs'
import path from 'node:path'
// 🔴 裸 import：触发各处的注册副作用（与真实 App 的加载路径一致）
import '../src/lib/ai'          // aiCore/prompts(4 条) + aiAssistPrompt(1 条)
import '../src/lib/aiTasks'     // PROMPT_ORDER 中央循环（34 条）
import '../src/lib/autoContinue' // setting-update-detect(1 条)
import { listPrompts, PROMPT_GROUPS } from '../src/lib/promptSettings'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n—— promptRegistry 用例开始 ——')

// ---------- ① 静态闸：components 里禁 registerPrompt ----------
{
  const dir = 'src/components'
  const offenders: string[] = []
  // 🔴 2026-10-10（G2）：组件已按领域搬进子目录（components/tavern/ 等）——
  //    原先只 `readdirSync(顶层)` ⇒ 子目录里的组件**一个都不查** ⇒
  //    这条「禁调 registerPrompt」的**负向**闸会悄悄失效（全绿但没查）。改成递归。
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
    const p = path.join(d, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.tsx?$/.test(e.name) ? [p] : []
  })
  for (const f of walk(dir)) {
    const text = fs.readFileSync(f, 'utf8')
    // 只看**调用**（注释里提到 registerPrompt 不算；用行首非注释的匹配）
    const hit = text.split('\n').some(l => /^\s*registerPrompt\s*\(/.test(l))
    if (hit) offenders.push(path.relative(process.cwd(), f).replace(/\\/g, '/'))
  }
  ok('🔴 components/ 里无人调用 registerPrompt（必须在 lib 层，静态可达）',
    offenders.length === 0, offenders.join(', '))
}

// ---------- ② 一致性闸：PROMPT_ORDER 与 *_PROMPTS 双向包含 ----------
{
  const aiTasks = fs.readFileSync('src/lib/aiTasks.ts', 'utf8')
  const orderBlock = aiTasks.slice(aiTasks.indexOf('const PROMPT_ORDER = ['), aiTasks.indexOf('\n]', aiTasks.indexOf('const PROMPT_ORDER = [')))
  const inOrder = [...orderBlock.matchAll(/'([a-z0-9-]+)'/g)].map(m => m[1])
  ok('PROMPT_ORDER 非空且已解析', inOrder.length >= 30, 'n=' + inOrder.length)

  // 各 *_PROMPTS 集合里的 id（源码解析）
  const files = [
    ...fs.readdirSync('src/lib/aiTasks').filter(f => f.endsWith('.ts')).map(f => path.join('src/lib/aiTasks', f)),
    'src/lib/marketRadar.ts', 'src/lib/styleFingerprint.ts',
  ]
  const inSets = new Set<string>()
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8')
    for (const m of text.matchAll(/id:\s*'([a-z0-9-]+)'/g)) inSets.add(m[1])
  }
  const missingFromSets = inOrder.filter(id => !inSets.has(id))
  ok('🔴 PROMPT_ORDER 里每个 id 都能在某个 *_PROMPTS 集合里找到',
    missingFromSets.length === 0, missingFromSets.join(', '))
}

// ---------- ③ 关键条目在册（本批修的那条 + 另外 5 条就地注册）----------
{
  const ids = new Set(listPrompts().map(p => p.id))
  const must = [
    'assist-planner',          // 🔴 W2-3 修的：原先在懒加载组件里注册，会漏
    'fill-template', 'fill-outline-master', 'fill-outline-volume', 'fill-outline-chapter',
    'setting-update-detect',
  ]
  const missing = must.filter(id => !ids.has(id))
  ok('🔴 6 条「就地注册」的提示词全部在册（含懒加载那个坑）',
    missing.length === 0, 'missing=' + missing.join(', '))
  ok('🔴 assist-planner 在册（不再受「灵感工具」页是否打开过影响）', ids.has('assist-planner'))

  // 反向兜底：注册表里不该出现空 id
  ok('注册表里没有空 id', listPrompts().every(p => !!p.id))
}

// ---------- ④ 可复位契约 ----------
{
  const list = listPrompts()
  const bad = list.filter(p => typeof p.defaultText !== 'string' || typeof p.overridden !== 'boolean' || !p.name)
  ok('🔴 每条都带 defaultText / overridden / name（「还原出厂」的前提）',
    bad.length === 0, bad.map(p => p.id).join(', '))
  ok('出厂文本非空（还原才有意义）', list.every(p => p.defaultText.trim().length > 0))
  ok('分组都在 PROMPT_GROUPS 白名单内', list.every(p => PROMPT_GROUPS.includes(p.group)))

  const aiAssist = list.find(p => p.id === 'assist-planner')
  ok('assist-planner 的出厂文本就是原组件里那段（逐字搬家的证明）',
    !!aiAssist && aiAssist.defaultText.includes('你是一位网络小说创作的辅助助手')
    && aiAssist.defaultText.includes('不要替作者直接写出小说正文章节'))
}

// ---------- ⑤ 静态可达性（源码闸）：ai.ts 必须裸引入 aiAssistPrompt ----------
{
  const ai = fs.readFileSync('src/lib/ai.ts', 'utf8')
  ok('🔴 ai.ts 裸 import aiAssistPrompt（静态可达 ⇒ 一定注册）',
    /^import '(?:\.\/aiAssistPrompt|@\/lib\/aiAssistPrompt)'$/m.test(ai))
  ok('aiAssistPrompt 模块自带 registerPrompt（搬走后仍会注册）',
    fs.readFileSync('src/lib/aiAssistPrompt.ts', 'utf8').includes("registerPrompt("))
  ok('🔴 AIAssist 组件已不再持有 SYSTEM_PROMPT 常量（源码级）',
    !/^let SYSTEM_PROMPT = `/m.test(fs.readFileSync('src/components/AIAssist.tsx', 'utf8')))
}

console.log(`\n———— 结果：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
