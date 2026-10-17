/**
 * 视觉细节闸（2026-10-17 全局页签视觉巡检）
 *
 * 巡检发现的三处「空态/噪音」缺陷，都已修但很容易被后续改动改回去：
 *   ① 主从双栏页签（政治架构 / 经济基础 / 宗教信仰 / 司法制度）的**右栏空态**
 *      只有 `py-8` ⇒ 盒高 ~80px 贴顶、下方 500px+ 空白。正解是把空态盒撑满 + 居中
 *      （父容器 `flex-1 min-h-0 overflow-y-auto` 高度确定，空态是唯一子元素 ⇒ h-full 安全）。
 *      与 OPT-009 跑团互动空态同一招，别再各写各的。
 *   ② 背景设定「分节」里每一节都挂一枚 `variant="danger"` 的红色「删除」⇒ 长页面里
 *      红字反复抢眼。正解：常态淡灰、hover 才变危险色（可发现性靠文字与 title 保留）。
 *   ③ 时光机弹窗空态只有 `py-8` ⇒ 弹窗被压到 ~177px，看着像一条报错。
 *      正解：空态给最小高度 + 图标 + 居中。
 *
 * ⚠️ 这三条都不是「好看不好看」的主观偏好，而是**空态没撑满 / 危险色滥用 / 弹窗体量失真**
 *    这类可判定的结构问题，因此值得钉字面。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) {
    pass++
    console.log(`PASS ${name}${extra ? ' :: ' + extra : ''}`)
  } else {
    fail++
    console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`)
  }
}

// ---------- ① 主从双栏右栏空态 ----------
{
  const f = 'src/components/sheets/ParallelSetSheet.tsx'
  const src = read(f)
  ok('① 右栏空态有撑满+居中的包裹层（h-full flex items-center justify-center）',
    /className="h-full flex items-center justify-center"/.test(src))
  ok('① 空态文案仍在（左边点一条来编辑…）', src.includes('左边点一条来编辑'))
  ok('🔴 负向：空态盒不许退回「只有 py-8 贴顶」的写法',
    !/rounded-xl border border-ink-700 bg-ink-850\/40 px-4 py-8 text-center/.test(src))
  ok('① 父容器仍是 flex-1 + min-h-0 + overflow-y-auto（h-full 才有确定高度）',
    src.includes('flex-1 min-w-0 min-h-0 overflow-y-auto'))
}

// ---------- ② 背景设定分节删除钮 ----------
{
  const f = 'src/components/tavern/TavernWorld.tsx'
  const src = read(f)
  const at = src.indexOf('删掉这一节')
  // 窗口要往后取：className 在 title 之后、`>` 与「删除」之前（中间还有 onClick）
  const around = at < 0 ? '' : src.slice(Math.max(0, at - 460), at + 460)
  ok('② 分节删除钮找到', at > 0)
  ok('② 常态淡灰 + hover 危险色（text-ink-500 hover:text-danger）',
    around.includes('text-ink-500 hover:text-danger'))
  ok('🔴 负向：分节删除钮不许再用 variant="danger"（红字铺满长页面）',
    !/variant="danger"[\s\S]{0,60}删掉这一节/.test(src))
  ok('② 可发现性保留：仍带 title 提示', around.includes('title="删掉这一节"'))
}

// ---------- ③ 时光机空态弹窗 ----------
{
  const f = 'src/components/editor/EditorModals.tsx'
  const src = read(f)
  ok('③ 时光机空态有最小高度（min-h-[220px]）', src.includes('min-h-[220px]'))
  ok('③ 空态居中（flex flex-col items-center justify-center）',
    /min-h-\[220px\] flex flex-col items-center justify-center/.test(src))
  ok('③ 空态带图标（History），不再像一条报错', /min-h-\[220px\][\s\S]{0,200}<History size=/.test(src))
  ok('🔴 负向：空态不许退回「只有 py-8 的裸文本」',
    !/snaps\.length === 0 \? \(\s*<div className="py-8 text-center text-12 text-ink-500">/.test(src))
}

console.log(`\n视觉细节闸: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
