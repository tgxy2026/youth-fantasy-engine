// ============ 3.3.1 · P10：图标键的触摸热区（规划 §14.2） ============
//
// 规划原文：「常用触摸操作的命中区域拟定至少 44×44 CSS px，可通过按钮外层增加点击区域
// 而不强迫图标变大；紧凑排列仍需避免相邻误触。」
//
// 这批用例守的是**做法**（真机效果由 `mobile-hit-target-331.mjs` 验）：
//   · 热区只加给「纯图标键」，不能顺手把文字按钮也套上；
//   · 只对触点设备生效，桌面鼠标不塞隐形热区；
//   · 只扩命中不改尺寸（用 ::after，不加 padding —— 加 padding 会撑高工具栏）。
//
// 🔴 3.3.4 · P1 **改了第二条口径**（有实测依据，不是顺手放宽）：
//    P0 基线（docs/3.3.4-P0基线-2026-11-02.md §4.3）量出 60 处关键动作缺口，其中 47 处是
//    文字按钮（h-7/h-8/h-9 = 28/32/36px，宽度本来就 60～246px，差的只是高度）。所以现在
//    **文字按钮也加热区**，但只认 `data-button-sizing='standard'`、**排除表格内**（表格要
//    整体抬行高，见 P2）。手写裸 button 一律不自动放大，必须显式标 `data-touch-target="1"`。
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

const button = read('src/components/common/Button.tsx')
const css = read('src/index.css')

// ---------- ① 命中目标的判定放在组件层 ----------
{
  ok('🔴 组件判「只有一个图标」并加标记属性', /data-button-icon-only/.test(button))
  ok('判定从严格：恰好一个子节点且是元素',
    /Children\.toArray\(children\)/.test(button) && /childList\.length === 1 && isValidElement\(childList\[0\]\)/.test(button))
  ok('🔴 标记**不改变**尺寸：没有把 looksIconOnly 混进 sizeCls / sizing 的判断',
    !/sizeCls\s*=\s*[^\n]*looksIconOnly/.test(button) && !/sizing\s*=[^\n]*looksIconOnly/.test(button))
  ok('显式 iconOnly 的按钮不重复打标记（避免两套来源打架）', /!iconOnly && childList\.length === 1/.test(button))
}

// ---------- ② 样式只作用于触点设备与图标键 ----------
{
  const block = css.slice(css.indexOf('3.3.1 · P10：触摸设备的图标键热区'))
  ok('热区样式存在', block.length > 200, `${block.length} 字符`)
  ok('🔴 媒体查询同时要求 hover:none 与 pointer:coarse（桌面鼠标不生效）',
    /@media \(hover: none\) and \(pointer: coarse\)/.test(block))
  ok('🔴 只用 ::after 扩命中，不给按钮加 padding / 改宽高',
    /::after/.test(block) && !/(^|\n)\s*padding\s*:/.test(block) && !/(^|\n)\s*(width|height)\s*:\s*44px/.test(block.slice(0, block.indexOf('::after'))))
  ok('目标覆盖两类：sizing=icon 与 icon-only 标记',
    /data-button-sizing='icon'/.test(block) && /data-button-icon-only='1'/.test(block))
  ok('热区尺寸不小于 44×44', /max\(100%, 44px\)/g.test(block) && (block.match(/max\(100%, 44px\)/g) ?? []).length >= 2)
  ok('居中展开（不偏到一侧）', /left:\s*50%/.test(block) && /translate\(-50%,\s*-50%\)/.test(block))
}

// ---------- ③ 已知取舍必须写在源码里，不能只写在文档 ----------
{
  const block = css.slice(css.indexOf('3.3.1 · P10：触摸设备的图标键热区'))
  ok('🔴 把「紧凑排列热区可能相邻重叠、真机未验」写在样式旁边',
    /相邻重叠|重叠/.test(block) && /真机/.test(block))
}

// ---------- ④ 3.3.4 · P1：文字按钮与手写裸 button（P0 基线的 60 处缺口） ----------
{
  const block = css.slice(css.indexOf('3.3.4 · P1：把最小命中区'))
  ok('P1 段落存在', block.length > 600, `${block.length} 字符`)
  ok('🔴 文字按钮按 sizing=standard 选中，不做「所有 button 一律 44」',
    /button:where\(\[data-button-sizing='standard'\]\)/.test(block))
  ok('🔴 表格内的文字按钮排除在外（表格行高留给 P2 统一抬）', /:not\(table \*\)/.test(block))
  ok('🔴 手写裸 button 必须显式标记才放大',
    /\[data-touch-target='1'\]/.test(block) && !/^\s*button::after/m.test(block))
  ok('文字按钮同样只用 ::after 且尺寸 max(100%, 44px)',
    (block.match(/max\(100%, 44px\)/g) ?? []).length >= 2)
  ok('文字按钮不靠 padding / 固定宽高改布局', !/(^|\n)\s*padding\s*:/.test(block))
  ok('紧凑行内操作组给**真实** 44×44 盒子（不是隐形热区）',
    /\[data-touch-row\]\s*>\s*button/.test(block) && /min-width:\s*44px/.test(block) && /min-height:\s*44px/.test(block))
  ok('粗指针下 hover 才显形的行内键常显（触摸没有 hover）',
    /\[data-touch-row\]\s*\{[^}]*opacity:\s*1/.test(block) && /\[data-touch-row\]\s*>\s*button\s*\{[^}]*opacity:\s*1/.test(block))
  ok('P1 段落仍限制在 hover:none + pointer:coarse（桌面鼠标不生效）',
    /@media \(hover: none\) and \(pointer: coarse\)/.test(block))
  ok('不用 !important 抢样式', !/!important/.test(block))
}

// ---------- ⑤ 源码侧：P0 §4.3 点名的裸 button 都已标上 ----------
{
  const parallel = read('src/components/sheets/ParallelSetSheet.tsx')
  ok('制度四页签：行内「改名 / 删除」改由 data-touch-row 给真实 44 盒子',
    /data-touch-row/.test(parallel))
  ok('制度四页签：「新增」「从《世界设定》新建」标了 data-touch-target',
    (parallel.match(/data-touch-target="1"/g) ?? []).length >= 2)
  const geo = read('src/components/world/GeoMapParts.tsx')
  ok('地图编辑：地图行标 data-touch-row，新建图按钮标 data-touch-target',
    /data-touch-row/.test(geo) && /data-touch-target="1"/.test(geo))
  const outline = read('src/components/outline/OutlineSheet.tsx')
  const tavern = read('src/components/tavern/TavernFree.tsx')
  ok('「点击改名」文字键（分卷 / 章节细纲、酒馆自由对话）都标了',
    /data-touch-target="1"/.test(outline) && /data-touch-target="1"/.test(tavern))
}

console.log(`\n—— mobileTouch 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
