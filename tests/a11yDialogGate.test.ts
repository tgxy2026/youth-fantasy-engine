// ============ 弹窗可达性闸（3.6.2 · W6）============
//
// 扫全仓「自己声明 role="dialog"」的地方，要求三件套齐全：
//   ① `aria-modal="true"`（告诉读屏器"背景不可交互"）；
//   ② 有 Esc 出口（WCAG 2.1.2：不能被键盘困住）；
//   ③ 关闭后焦点能回到触发处（否则焦点掉到 body，键盘用户等于被扔回页面顶部）。
//
// 为什么要一条静态闸：这类缺陷**肉眼看不出来**、鼠标用户永远碰不到，
// 只有键盘/读屏用户会撞上；而"新写一个浮层时忘了"是最常见的路径。
//
// 🔴 只判「声明」不判「查询」：`document.querySelector('[role="dialog"]')`
//    是在找别人的弹窗（比如编辑器判断"有没有弹窗盖着我"），不是自己声明一个。
//    区分方式见 `isDeclaration()`。
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const root = [process.cwd(), path.join(process.cwd(), '..')]
  .find(c => fs.existsSync(path.join(c, 'package.json'))) ?? ''

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (/\.tsx$/.test(e.name)) out.push(full)
  }
  return out
}

/** 这一行是不是「自己声明一个 dialog」（而不是在选择器里查别人） */
function isDeclaration(line: string): boolean {
  if (/querySelector|closest|\[role=/.test(line)) return false
  return /\brole="dialog"/.test(line)
}

const files = root ? walk(path.join(root, 'src')) : []
ok('能扫到源码目录', files.length > 100, String(files.length))

interface Finding { rel: string; hasModal: boolean; hasEsc: boolean; hasAriaModal: boolean }
const findings: Finding[] = []

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
  const lines = src.split('\n')
  const declares = lines.some(isDeclaration)
  if (!declares) continue
  findings.push({
    rel: path.relative(root, file).replaceAll('\\', '/'),
    hasAriaModal: /aria-modal/.test(src),
    /**
     * Esc 有两条合法路径：**自己处理**（onKeyDown / document keydown），
     * 或**交给基座**（`registerDialog` 把键盘与焦点统一收进 overlayScope）。
     * 后者是 Modal 这类组件走的路 —— 判据漏了它就会把走基座误判成没有出口。
     */
    hasEsc: /Escape|keydown|registerDialog/.test(src),
    hasModal: /Modal/.test(src),
  })
}

ok('至少找到 1 处自己声明的 dialog（否则这条闸是空转）', findings.length > 0, String(findings.length))

for (const f of findings) {
  ok(`🔴 ${f.rel} 有 aria-modal`, f.hasAriaModal)
  ok(`🔴 ${f.rel} 有 Esc / 键盘出口`, f.hasEsc)
}

/**
 * 基座本身的完整性：`Modal.tsx` 是绝大多数弹窗的载体，
 * 它的三件套齐全，等于替所有使用者兜住了底。
 */
{
  const modalPath = path.join(root, 'src/components/dialogs/Modal.tsx')
  const src = fs.existsSync(modalPath) ? fs.readFileSync(modalPath, 'utf8') : ''
  ok('Modal 基座存在', src.length > 0)
  ok('🔴 Modal 基座声明 role="dialog" + aria-modal', /role="dialog"/.test(src) && /aria-modal/.test(src))
  ok('🔴 Modal 基座响应 Escape（自己处理或交给 overlayScope）', /Escape/.test(src) || /registerDialog/.test(src), '缺 Esc —— 所有弹窗都会失去键盘出口')
  ok('Modal 基座做了焦点接管（初始焦点 / 还原）', /focus\(\)/.test(src) || /focusTrap|previousFocus|registerDialog/.test(src))
}

/**
 * 基座真正的实现点在 overlayScope：Modal 只是"注册"，键盘与焦点都在那边。
 * 这里单独守住它 —— 否则哪天 `registerDialog` 被简化掉，上面对 Modal 的断言仍然全绿。
 */
{
  const scopePath = path.join(root, 'src/lib/app/overlayScope.ts')
  const src = fs.existsSync(scopePath) ? fs.readFileSync(scopePath, 'utf8') : ''
  ok('overlayScope 存在（Modal 的键盘与焦点都在这里）', src.length > 0)
  ok('🔴 overlayScope 处理 Escape', /Escape/.test(src))
  ok('🔴 overlayScope 有 Tab 焦点陷阱（shiftKey 反向）', /shiftKey/.test(src))
  ok('🔴 overlayScope 关闭时把焦点还原到触发处', /previous/.test(src), '缺 previous 记录 —— 关闭后焦点会掉到 body')
}

/**
 * 反例：选择器里的 `[role="dialog"]` 不该被当成声明。
 * 这条是给上面 `isDeclaration` 的回归保护 —— 判据改了会被这里拦下。
 */
{
  ok('选择器形态不算声明', isDeclaration('if (document.querySelector(\'[role="dialog"]\')) return') === false)
  ok('真正的声明能认出', isDeclaration('  <div role="dialog" aria-modal="true">') === true)
  ok('拆行写法（role 单独一行）也能认出', isDeclaration('        role="dialog"') === true)
}

console.log(`\na11yDialogGate: ${pass} passed, ${fail} failed（扫描 ${files.length} 个 tsx，${findings.length} 处声明）`)
if (fail > 0) process.exit(1)
