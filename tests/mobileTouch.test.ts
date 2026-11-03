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
  // 只截到 P2 段落为止：P2 里对长表单弹窗用了 `!important`（覆盖行内 style），
  // 那是 P2 的口径，不能拿来判 P1「不给按钮加 padding / 宽高」。
  const block = css.slice(css.indexOf('3.3.4 · P1：把最小命中区'), css.indexOf('3.3.4 · P2：表格在粗指针下的密度'))
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

// ---------- ⑥ 3.3.4 · P2：表格行内控件（P0 §4.4 的 2641 处）----------
{
  const block = css.slice(css.indexOf('3.3.4 · P2：表格在粗指针下的密度'))
  ok('P2 段落存在', block.length > 500, `${block.length} 字符`)
  ok('🔴 表格行内原生控件抬到真实 44（不是隐形热区——相邻行会互抢点击）',
    /table :is\(input, select, textarea\)/.test(block) && /min-height:\s*44px/.test(block))
  ok('复选框 / 单选框不撑成 44（视觉图形不该变形）',
    /:not\(\[type='checkbox'\]\)/.test(block) && /:not\(\[type='radio'\]\)/.test(block))
  ok('自定义选择器触发器按标记覆盖（content 尺寸的 Button 标签规则抓不到）',
    /\[data-touch-control='1'\]/.test(block))
  ok('🔴 不动行首图标操作列（64px 列装不下 44×44 的 2×2）', !/table button/.test(block))
  ok('P2 段落仍只在 hover:none + pointer:coarse 内（桌面密度不变）',
    /@media \(hover: none\) and \(pointer: coarse\)/.test(block))
  ok('下拉菜单选项行在触摸下 44（Portal 里不互压）', /\[data-touch-menu\] button/.test(block))
  ok('单元格编号 chip 给真实 44×44（不用隐形热区，避免压到下一行）',
    /\[data-touch-chip='1'\]/.test(block) && /min-width:\s*44px/.test(block))
  ok('长表单弹窗在触摸下接近全屏，短确认框不受影响（按宽度档打标）',
    /\[data-modal-size='large'\]/.test(block) && /96vw !important/.test(block))
  ok('表格行内 chip 已标 data-touch-chip（TableSheetRow 3 处）',
    (read('src/components/sheets/TableSheetRow.tsx').match(/data-touch-chip="1"/g) ?? []).length >= 3)
  ok('五个下拉面板都标了 data-touch-menu',
    ['src/components/common/CustomSelect.tsx', 'src/components/sheets/TableRefSelect.tsx',
      'src/components/world/CharacterSelect.tsx', 'src/components/common/CalendarSelect.tsx',
      'src/components/common/CalendarPicker.tsx'].every(f => /data-touch-menu="1"/.test(read(f))))
  ok('Modal 按宽度档打 data-modal-size（≥576 才算长表单）',
    /data-modal-size=\{widthPx >= 576 \? 'large' : 'small'\}/.test(read('src/components/dialogs/Modal.tsx')))

  // 控件源码：五个自定义选择器的收起态触发器都标了
  const triggers = [
    'src/components/common/CustomSelect.tsx',
    'src/components/sheets/TableRefSelect.tsx',
    'src/components/world/CharacterSelect.tsx',
    'src/components/common/CalendarSelect.tsx',
    'src/components/common/CalendarPicker.tsx',
  ]
  for (const file of triggers) {
    ok(`${file.split('/').pop()} 的触发器标了 data-touch-control`,
      /data-touch-control="1"/.test(read(file)))
  }
}

// ---------- ⑦ 3.3.4 · P2：画布的点击式缩放（§3.2「不能只能鼠标拖拽」）----------
{
  const hook = read('src/components/world/useGeoMapModel.ts')
  const editor = read('src/components/world/GeoMapEditor.tsx')
  ok('视图层导出 zoomBy（与滚轮同一套锚点算法）',
    /const zoomBy = useCallback/.test(hook) && /zoomBy,/.test(hook))
  ok('缩放上下限与滚轮一致（0.04～3）',
    /Math\.min\(3, Math\.max\(0\.04/.test(hook))
  ok('地图工具栏有可点的放大 / 缩小键（触摸设备没有滚轮）',
    /aria-label="放大画面"/.test(editor) && /aria-label="缩小画面"/.test(editor)
    && (editor.match(/zoomBy\(/g) ?? []).length >= 2)
  ok('帮助与状态条写明 ＋/－ 可缩放（不只写滚轮）',
    /＋\/－/.test(editor) && /滚轮或 ＋\/－ 缩放/.test(editor))
}

console.log(`\n—— mobileTouch 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
