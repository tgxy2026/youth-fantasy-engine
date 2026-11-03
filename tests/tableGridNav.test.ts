// ============ 3.3.1 · §8：设定表的方向键 ============
//
// 这批用例守的是「什么时候该让、什么时候该接」：
//   · 数字框 / 原生下拉 / 折行的长文本 ⇒ 方向键是它们自己的，**必须让**；
//   · 单行输入框 / 没折行的单元格文本域 / 按钮 ⇒ 上下箭头本来什么也不做，**可以接**；
//   · 判据不看页签、不看列名、不看输入法（规划明令禁止逐输入法分支）。
// 以及界面接线：组合态不抢、带修饰键不抢、到头交回浏览器、不在决定之前就 preventDefault。
import fs from 'node:fs'
import path from 'node:path'
import { nativeConsumesVerticalArrow, neighborRowIndex } from '../src/lib/table/gridNav'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

// ---------- 让：控件自己会用方向键 ----------
{
  ok('数字输入框让行（上下＝加减）',
    nativeConsumesVerticalArrow({ tagName: 'INPUT', type: 'number' }))
  ok('滑块让行', nativeConsumesVerticalArrow({ tagName: 'INPUT', type: 'range' }))
  ok('日期输入框让行', nativeConsumesVerticalArrow({ tagName: 'INPUT', type: 'date' }))
  ok('日期时间输入框让行', nativeConsumesVerticalArrow({ tagName: 'INPUT', type: 'datetime-local' }))
  ok('原生下拉让行（上下＝换选项）', nativeConsumesVerticalArrow({ tagName: 'SELECT' }))
  ok('🔴 折了行的单元格文本域让行（上下＝在自己行间移光标）',
    nativeConsumesVerticalArrow({ tagName: 'TEXTAREA', scrollHeight: 66, clientHeight: 22 }))
}

// ---------- 接：控件自己不用方向键 ----------
{
  ok('普通文本输入框可以接', !nativeConsumesVerticalArrow({ tagName: 'INPUT', type: 'text' }))
  ok('没写 type 的输入框按文本算', !nativeConsumesVerticalArrow({ tagName: 'INPUT' }))
  ok('🔴 没折行的单元格文本域可以接（rows=1，上下本来什么都不做）',
    !nativeConsumesVerticalArrow({ tagName: 'TEXTAREA', scrollHeight: 22, clientHeight: 22 }))
  /**
   * 实测抓到的假阳性：单元格文本域带 `py-1`，`scrollHeight` 含上下 8px 内边距、`clientHeight` 不含，
   * 直接比差会判成「折了行」⇒ 方向键全被让掉、一行都跳不动。减掉 padding 后必须判为单行。
   */
  ok('🔴 有内边距的单行文本域仍算单行（8px padding 不许当成折行）',
    !nativeConsumesVerticalArrow({ tagName: 'TEXTAREA', scrollHeight: 30, clientHeight: 22, lineHeight: 22, paddingY: 8 }))
  ok('真折成两行时让行（内容高 ≈ 2 倍行高）',
    nativeConsumesVerticalArrow({ tagName: 'TEXTAREA', scrollHeight: 52, clientHeight: 22, lineHeight: 22, paddingY: 8 }))
  ok('行高取整差 1px 仍算单行（不误判成折行）',
    !nativeConsumesVerticalArrow({ tagName: 'TEXTAREA', scrollHeight: 23, clientHeight: 22 }))
  ok('按钮可以接', !nativeConsumesVerticalArrow({ tagName: 'BUTTON' }))
  ok('普通容器可以接', !nativeConsumesVerticalArrow({ tagName: 'DIV' }))
}

// ---------- 相邻行 ----------
{
  ok('中间行按下走到下一行', neighborRowIndex(1, 5, 'ArrowDown') === 2)
  ok('中间行按上走到上一行', neighborRowIndex(1, 5, 'ArrowUp') === 0)
  ok('🔴 第一行再按上：交回浏览器（不循环到最后一行）', neighborRowIndex(0, 5, 'ArrowUp') === null)
  ok('🔴 最后一行再按下：交回浏览器', neighborRowIndex(4, 5, 'ArrowDown') === null)
  ok('只有一个渲染行时上下都到头', neighborRowIndex(0, 1, 'ArrowUp') === null && neighborRowIndex(0, 1, 'ArrowDown') === null)
  ok('空表/越界下标不给目标', neighborRowIndex(0, 0, 'ArrowDown') === null && neighborRowIndex(9, 5, 'ArrowDown') === null)
  ok('非整数下标不给目标', neighborRowIndex(1.5, 5, 'ArrowDown') === null)
}

// ---------- 界面接线 ----------
{
  const sheet = read('src/components/sheets/TableSheet.tsx')
  ok('🔴 表格容器上挂了方向键处理', /data-guide="table-body"\s*\n\s*onKeyDown=\{onGridKeyDown\}/.test(sheet))
  ok('🔴 组合输入期间不抢（中文打字不会打一半跳行）', /event\.nativeEvent\.isComposing\) return/.test(sheet))
  ok('带修饰键不抢（Alt/Ctrl/Meta/Shift 保留给系统快捷键）',
    /altKey \|\| event\.ctrlKey \|\| event\.metaKey \|\| event\.shiftKey\) return/.test(sheet))
  ok('只处理上下箭头（左右留给输入框移光标）',
    /event\.key !== 'ArrowUp' && event\.key !== 'ArrowDown'\) return/.test(sheet)
    && !/'ArrowLeft'/.test(sheet))
  ok('🔴 判据走 gridNav，而不是在这里另写一份',
    /nativeConsumesVerticalArrow\(\{/.test(sheet) && /neighborRowIndex\(/.test(sheet))
  ok('🔴 没有按页签/列名写例外（那是猜）',
    !/tab\.id === '(?:terms|foreshadow)'[\s\S]{0,80}ArrowDown/.test(sheet))
  ok('只在**确定能跳**之后才 preventDefault（否则会吃掉原生方向键）',
    sheet.indexOf('event.preventDefault()') > sheet.indexOf('if (!focusable) return'))
  ok('目标行会滚进可视区（表格是窗口化的，不滚就看不见）',
    /list\.scrollTop \+= \(rect\.bottom - bounds\.bottom\)/.test(sheet))
}

console.log(`\n用例结束：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
