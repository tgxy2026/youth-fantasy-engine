// ============ 宽表格「按住拖动平移 + 表头冻结」· 硬断言（3.1.2）============
//
// 需求口径（主人 2026-10-17）：世界构建 / 创作管理两组里比较大的表格，
//   ① **左键**按住拖动即可横向查看（不用去拖底部滚动条）—— 按键经 review 拍板收窄为「只左键」；
//   ② 表头冻结 —— 往下翻时列名与筛选框不消失，只滚动内容区。
//
// 为什么值得闸：这两个都是**交互/样式**改动 —— 写错了不会报错、不会崩，
// 只是「拖不动」或「表头跟着滚」，肉眼不逐一对照根本发现不了。
// 且改的是**全组共用**的 TableSheet（18 张表一个出口），回归面比看起来大。
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const ROOT = process.cwd()
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

console.log('—— tablePan：拖拽平移 + 表头冻结闸（3.1.2）——')

const hook = read('src/lib/app/usePanScroll.ts')
const sheet = read('src/components/sheets/TableSheet.tsx')

// ---------- ① 目标组的所有 table 页签确实走这张通用表 ----------
{
  const parts = ['part1', 'part2', 'part3']
  const rows: { id: string; name: string; group: string }[] = []
  for (const p of parts) {
    const src = read(`src/lib/schemaTabs/${p}.ts`)
    // id: 'xxx', name: 'yyy', group: 'zzz', type: 'table'
    const re = /id:\s*'([^']+)',\s*name:\s*'([^']+)',\s*group:\s*'([^']+)',\s*type:\s*'table'/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) rows.push({ id: m[1], name: m[2], group: m[3] })
  }
  const want = rows.filter(r => r.group === '世界构建' || r.group === '创作管理')
  // TableSheet 里**无条件**走特殊渲染、根本不进通用表格的（relations＝人物关系分组视图）。
  // ⚠️ faction-rels（势力关系）不算：它只在「切到关系图视图」时走 FactionGraph，
  //    默认表格视图仍走本文件改的通用表格 —— 别把它错算成漏网。
  const special = ['relations']
  const off = want.filter(r => special.includes(r.id))
  ok(`① 目标组共 ${want.length} 张 table 页签（世界构建 ${want.filter(r => r.group === '世界构建').length} + 创作管理 ${want.filter(r => r.group === '创作管理').length}）`,
    want.length >= 10, `实际 ${want.length} 张：${want.map(r => r.id).join(',')}`)
  ok('① 目标组没有「无条件走特殊渲染」的表（改动全覆盖；faction-rels 的关系图只是可切视图）',
    off.length === 0, off.map(r => r.id).join(','))

  // 三个视图模式（graph / storyline / timeline）是 tab 级开关，切回表格视图仍走通用表
  ok('① 视图模式只是切换（faction-rels/relations 等特殊渲染不在目标组）', true)
}

// ---------- ② 拖拽平移：只认左键、阈值、排除区、click 抑制 ----------
// 按键口径（主人 2026-10-17 review 拍板）：原口径「左键或右键」，改为「保留一个常用的就好」⇒ 只左键。
ok('② 只认左键（button === 0）—— 右键不再启动拖拽',
  hook.includes('if (e.button !== 0) return'))
ok('🔴 反向守卫：不再有右键拖拽口子（无 onContextMenu 实现 / 无 buttons 选项）',
  !/const onContextMenu\b/.test(hook) && !/buttons\?:/.test(hook) &&
  !hook.includes('onMouseLeave, onContextMenu }'))
ok('② 有位移阈值（默认 4px）—— 防止把「单击进单元格」误判成拖拽',
  hook.includes("optsRef.current.threshold ?? 4"))
ok('② 排除区：`[data-nodrag]` 不启动平移（列宽手柄靠它）',
  hook.includes("target.closest('[data-nodrag]')"))
ok('② 表单元素不抢（input/select/button/a/contenteditable 一律排除）',
  hook.includes("'input, select, textarea, button, a, [contenteditable]'"))
// 🔴 2026-10-17 全量审计（P2）：数据单元格本身就是 CellTextarea ⇒ 原「textarea 一并排除」
//    让整张表体不可拖，平移只剩表头能用（实测表体起拖 scrollLeft 恒 0）。
//    现口径：表头表单元素排除，**表体 textarea 允许起拖**（<4px 仍是单击编辑）。
ok('🔴 表体 textarea 允许起拖（否则整张表体不可拖，平移只剩表头能用）',
  hook.includes("if (formEl.tagName !== 'TEXTAREA' || !formEl.closest('tbody')) return false"))
ok('🔴 已在编辑的那个 textarea 不抢（点进去后拖拽＝选文字，不能被平移吃掉）',
  hook.includes('return document.activeElement !== formEl'))
ok('🔴 表头筛选框 / 下拉仍被排除（thead 里的表单元素不启动平移）',
  hook.includes("target.closest('thead input, thead select, thead textarea, thead [contenteditable]')"))
ok('🔴 拖拽成立时 blur 掉焦点中的 textarea（平移意图明确，别留光标/选区）',
  hook.includes("ae.tagName === 'TEXTAREA' && el.contains(ae)) ae.blur()"))
ok('② 拖拽中给容器 select-none（不然一拖把整表文字选蓝）',
  sheet.includes("pan.dragging ? 'cursor-grabbing select-none ' : 'cursor-grab '"))
// 🔴 2026-10-17 全量审计（P2）：原实现「拖拽一开始挂 document 监听 + setTimeout(0) 移除」
//    —— 监听一次 tick 后就被拆掉，而 click 在 mouseup 之后几百毫秒才派发 ⇒ 等于没吃掉。
//    现口径：finish() 打时间戳 + onClickCapture 时间窗拦 400ms 内的第一次 click。
ok('② 拖拽成立后吃掉随后那次 click（时间戳 + onClickCapture，防「拖完顺手点开单元格」）',
  hook.includes('suppressClickAt.current = performance.now()')
  && hook.includes('performance.now() - at < 400')
  && hook.includes('onClickCapture'))
ok('🔴 反向守卫：不再用「拖拽开始即挂 document 监听 + setTimeout(0)」（那是失效实现）',
  !hook.includes("setTimeout(() => document.removeEventListener('click', kill, true), 0)"))
ok('② 容器已接 onClickCapture（拦截必须挂在滚动容器上，捕获阶段早于单元格 onClick）',
  sheet.includes('onClickCapture={pan.handlers.onClickCapture}'))
ok('② 横向滚动既保留了原生滚动条，也支持拖动（overflow-x-auto 仍在）',
  sheet.includes('overflow-x-auto overflow-y-auto'))

// ---------- ③ 表头冻结 ----------
ok('③ 表头行 sticky + z-10（纵向滚动时钉在顶部）',
  /className="sticky top-0 z-10 bg-ink-800 border-b border-ink-700"/.test(sheet))
ok('③ 每个 th 都有不透明背景（否则滚动时下面几行会从表头透出来）',
  (sheet.match(/<th[^>]*className="bg-ink-800 /g) ?? []).length >= 3)
ok('③ 表头里原有的列名 + 筛选框一起被冻住（select 与 input 两个分支都还在）',
  /<th key=\{col\.name\}[^>]*className="bg-ink-800[\s\S]*?col\.type === 'select'[\s\S]*?<input/.test(sheet))
ok('③ 内容区独立滚动（maxHeight 用 foldVh 折算，跟随界面缩放）',
  sheet.includes('foldVh(') && /maxHeight:\s*foldVh\('62vh'\)/.test(sheet))
ok('③ 用 maxHeight 而非 height —— 行数少时表格自适应、不出现大片空白',
  !/height:\s*foldVh\('62vh'\)/.test(sheet))

// ---------- ④ 接线位置与回归面 ----------
ok('④ usePanScroll 在 early return 之前调用（rules-of-hooks）',
  sheet.indexOf('const pan = usePanScroll') < sheet.indexOf('if (!loaded) return <LoadingState />'))
ok('④ 容器挂了 ref 与四个处理器（左键拖拽不需要 onContextMenu）', sheet.includes('ref={pan.ref}') &&
  sheet.includes('onMouseDown={pan.handlers.onMouseDown}') &&
  sheet.includes('onMouseMove={pan.handlers.onMouseMove}') &&
  sheet.includes('onMouseUp={pan.handlers.onMouseUp}') &&
  sheet.includes('onMouseLeave={pan.handlers.onMouseLeave}') &&
  !sheet.includes('onContextMenu={pan.handlers.onContextMenu}'))
ok('④ 列宽手柄标了 data-nodrag（拖表格不会顺手改列宽）',
  (sheet.match(/data-nodrag/g) ?? []).length >= 1)
// 🔴 反向守卫：别把 hook 的 ref 类型写错导致 React 19/18 ref 不匹配（编译期已挡，这里再钉一次形状）
ok('④ 反向守卫：hook 返回 ref/handlers/dragging 三件套（handlers 含 onClickCapture）',
  /ref,\s*$/m.test(hook) && hook.includes('handlers: { onMouseDown, onMouseMove, onMouseUp, onMouseLeave, onClickCapture }'))

console.log(`\ntablePan: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
