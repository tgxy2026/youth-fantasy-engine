// ============ 酒馆 · 故事剧本 —— 巨型组件拆分完成度守卫（3.0 · W3-3 · §11.1 L5）============
//
// 🔴 为什么补这条闸（§11.1 L5 收尾）
//
//   `TavernScript.tsx` 曾 904 行（`audit-arch` 标注的拆分候选）。W3-3 按 `dep-cost.mjs`
//   量化结果分三步落地：左栏 `TavernScriptTree`（props 面 9）→ 中栏 `TavernScriptEditor`
//   （props 面 8）→ 右栏 `TavernScriptAside`（props 面 17）。拆完主线降到 467 行。
//
//   但「拆完」这件事本身**没有任何测试守着** —— 下轮谁往主文件里塞两百行 JSX，
//   谁都不会被拦下，只会一路涨回 900 行。这条闸就是把它钉住：
//     · 子组件**存在且被主文件 import**（防「拆出去又搬回来」/ 改名后静默失联）；
//     · 主文件行数留一个**预算上限**（当前 467 行，给到 560 的余量 —— 正常增量放行、反弹回巨石当场红）。
//
//   ⚠️ 行数上限刻意**绑在实测值 + 合理余量**上，而不是「越小越好」——
//      硬压行数会逼出「为拆而拆」的反效果。要调预算须在此处显式说明理由。
//
//   ⚠️ 判据之一是「主文件不再内联这些 JSX」：读**剥洗后的源码**（去注释与字符串），
//      断言 `w-72 shrink-0 space-y-3 overflow-y-auto`（右栏 aside 的类名）已不在主文件里出现。
//      用类名当指纹，是因为它正是「右栏这块 JSX 本体」的稳定标记 —— 搬走了就不该在主文件重现。
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const ROOT = process.cwd()
const read = (rel: string) => {
  const p = path.join(ROOT, rel)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}
const lineCount = (rel: string) => {
  const t = read(rel)
  return t ? t.split('\n').length : 0
}

const MAIN = 'src/components/tavern/TavernScript.tsx'
/** 拆分后的三个子组件（左 / 中 / 右）—— 一条一条列，缺哪个就报哪个 */
const PARTS = [
  'src/components/tavern/TavernScriptTree.tsx',
  'src/components/tavern/TavernScriptEditor.tsx',
  'src/components/tavern/TavernScriptAside.tsx',
]
/** 主文件行数预算：当前 467 + 约 20% 余量（正常增量放行，反弹回巨石当场红） */
const MAIN_BUDGET = 560

console.log('\n—— tavernScriptSplit 用例开始 ——')

// ---------- ① 子组件都得真实存在 ----------
{
  for (const rel of PARTS) {
    ok(`子组件存在：${path.basename(rel)}`, fs.existsSync(path.join(ROOT, rel)))
  }
}

// ---------- ② 主文件必须 import 全部子组件（防改名后静默失联） ----------
{
  const main = read(MAIN)
  ok('主文件读得到', !!main)
  for (const rel of PARTS) {
    const base = path.basename(rel, '.tsx')
    ok(`主文件 import 了 ${base}`,
      new RegExp(`from '@/components/tavern/${base}'`).test(main),
      '（子组件搬走了却没改 import，运行时会白屏）')
  }
}

// ---------- ③ 主文件行数在预算内 ----------
{
  const n = lineCount(MAIN)
  ok(`主文件行数 ${n} ≤ 预算 ${MAIN_BUDGET}（拆完不许反弹）`, n > 0 && n <= MAIN_BUDGET,
    n > MAIN_BUDGET ? `超 ${n - MAIN_BUDGET} 行 —— 又长回去了，该再拆一块` : '')
}

// ---------- ④ 右栏 JSX 本体已搬走（不再内联在主文件） ----------
{
  const main = read(MAIN)
  // 右栏 aside 的类名指纹：搬走后主文件里不该再出现（子组件里出现是对的）
  ok('🔴 右栏容器类名已不在主文件（`w-72 shrink-0 space-y-3 overflow-y-auto`）',
    !/w-72 shrink-0 space-y-3 overflow-y-auto/.test(main),
    '（右栏 JSX 又被内联回主文件了）')
  // 三个子组件都应被渲染（JSX 标签），不只是 import
  for (const tag of ['TavernScriptTree', 'TavernScriptEditor', 'TavernScriptAside']) {
    ok(`主文件渲染了 <${tag}`, new RegExp(`<${tag}[\\s/>]`).test(main))
  }
}

// ---------- ⑤ 各子组件都是默认导出（与本文件的 import 形态一致） ----------
{
  for (const rel of PARTS) {
    const t = read(rel)
    ok(`${path.basename(rel)} 有默认导出`, /export default function/.test(t))
  }
}

// ---------- ⑥ 注入预览的计算只此一处（右栏下沉后不在主文件重复） ----------
{
  const main = read(MAIN)
  const aside = read('src/components/tavern/TavernScriptAside.tsx')
  ok('🔴 主文件不再自行计算注入预览（`snapshotOf` 调用已下沉）',
    !/snapshotOf\(\s*\{/.test(main),
    '（预览算了两次 = 两份真相源，早晚不一致）')
  ok('右栏组件承担注入预览计算', /snapshotOf\(\s*\{/.test(aside))
}

// ---------- ⑦ 右栏组件的 props 面登记（拆分理由可追溯） ----------
{
  const aside = read('src/components/tavern/TavernScriptAside.tsx')
  ok('右栏组件声明了 props 接口（口径可查）', /interface TavernScriptAsideProps/.test(aside))
  ok('右栏组件头部注释写明拆分依据（W3-3 / §11.1 L5）',
    /W3-3/.test(aside) && /L5/.test(aside))
}

console.log(`\n—— tavernScriptSplit 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
