// ============ 跑团互动空态盒「等高 + 居中」闸（3.1.2 · OPT-009）============
//
// 需求口径（主人 2026-10-17）：酒馆模式组 → 跑团互动，空白页时左右两行提示文字
//   「还没有跑团互动，点击新建一局」（左）与「从左边选一局或新建一局」（右）
//   一个两行一个一行 ⇒ 两个文本框高度不一样。要求：**调整成一致的高度，并都居中显示**。
//
// 落点：RunPanel.tsx 两个空态提示盒。父级两栏容器 `flex flex-1 min-h-0 gap-3` 本就
//   stretch 等高 ⇒ 盒加 h-full 即自然等高（空态时盒是栏内唯一子元素，h-full 安全）。
//   原实现两盒「内容贴内容」且 padding 一 p-3 一 p-4，落差被进一步放大。
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const ROOT = process.cwd()
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

console.log('—— tavernRunEmptyState：跑团互动空态等高闸（3.1.2）——')

const rp = read('src/components/tavern/RunPanel.tsx')

// 两个空态盒的**完整 className 必须逐字一致**（等高 + 居中 + 同 padding）
const BOX = 'rounded-lg border border-ink-700 bg-ink-850/30 p-4 text-12 leading-relaxed text-ink-400 h-full flex items-center justify-center text-center'

// ---------- ① 两个空态盒同款：撑满栏高 + 双向居中 + text-center ----------
{
  ok('① 左栏空态盒：h-full + items/justify-center + text-center',
    rp.includes(`<div className="${BOX}">\n              还没有跑团互动。`))
  ok('① 右栏空态盒：与左栏逐字同款',
    rp.includes(`<div className="${BOX}">\n              从左边选一局，或新建一局。`))
}

// ---------- ② 负向：旧的不等高形态不许复活 ----------
{
  // 左盒原 p-3 / 右盒原 p-4（内容贴内容、不等高）——两个旧串都必须绝迹
  ok('② 负向：旧「p-3 内容贴内容」左盒形态绝迹',
    !rp.includes('bg-ink-850/30 p-3 text-12 leading-relaxed text-ink-400'))
  ok('② 负向：旧「p-4 内容贴内容」右盒形态绝迹',
    !rp.includes('bg-ink-850/30 p-4 text-12 leading-relaxed text-ink-400">\n              从左边选一局'))
  // 两个空态盒 className 必须完全相同（数一遍出现次数）
  const count = rp.split(`className="${BOX}"`).length - 1
  ok('② 两个空态盒 className 完全一致（各出现一次）', count === 2, `实际出现 ${count} 次`)
}

// ---------- ③ 父级两栏结构不动（等高的前提是 stretch） ----------
// 若有人把父容器改成 items-start / 去掉 flex，h-full 就失去等高基准
{
  ok('③ 父级两栏容器仍为 flex + 默认 stretch（等高基准）',
    rp.includes('<div className="flex flex-1 min-h-0 gap-3 pt-3">'))
  ok('③ 两栏滚动容器形态未动（aside w-72 / section flex-1，各滚各的）',
    rp.includes('<aside className="w-72 shrink-0 space-y-1.5 overflow-y-auto">')
    && rp.includes('<section className="flex-1 min-w-0 overflow-y-auto pr-1">'))
}

console.log(`\ntavernRunEmptyState: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
