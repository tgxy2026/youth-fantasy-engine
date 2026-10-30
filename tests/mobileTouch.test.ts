// ============ 3.3.1 · P10：图标键的触摸热区（规划 §14.2） ============
//
// 规划原文：「常用触摸操作的命中区域拟定至少 44×44 CSS px，可通过按钮外层增加点击区域
// 而不强迫图标变大；紧凑排列仍需避免相邻误触。」
//
// 这批用例守的是**做法**（真机效果由 `mobile-hit-target-331.mjs` 验）：
//   · 热区只加给「纯图标键」，不能顺手把文字按钮也套上；
//   · 只对触点设备生效，桌面鼠标不塞隐形热区；
//   · 只扩命中不改尺寸（用 ::after，不加 padding —— 加 padding 会撑高工具栏）。
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

console.log(`\n—— mobileTouch 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
