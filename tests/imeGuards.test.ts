// ============ 3.3.0 · UX12 / AC12：中文选字期间不许抢键 ============
//
// 方案 AC12：「中文选字中 Enter/Esc、搜索、对话发送、弹窗关闭 —— 不误发送/提交/关闭/丢选区；
// 正常组合结束后按原规则生效」。真实的 IME 行为只能人工记录，但**代码层是否守了组合态**可以静态钉住：
// 一旦有人新写一个 `onKeyDown` 处理 Enter/Escape 却忘了 `isComposing`，中文作者按确认键就会误触发。
//
// 判定口径：内联事件按 TypeScript AST 提取自身函数体，不能借用旁边另一个事件的组合态判断。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type * as TypeScript from 'typescript'
const ts = createRequire(import.meta.url)('typescript') as typeof TypeScript

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel)
  }
  return out
}

const files = walk('src')
/** 剥掉注释：本仓注释里大量出现 "isComposing"/"Enter" 的说明文字，全文匹配会假绿 */
const codeOf = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

function unsafeInlineHandlers(source: string, file: string): string[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const offenders: string[] = []
  const visit = (node: TypeScript.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'onKeyDown' && node.initializer
      && ts.isJsxExpression(node.initializer) && node.initializer.expression
      && (ts.isArrowFunction(node.initializer.expression) || ts.isFunctionExpression(node.initializer.expression))) {
      const handler = node.initializer.expression
      let handlesCommitKey = false, compositionGuard = false
      const inspect = (part: TypeScript.Node) => {
        if (ts.isStringLiteral(part) && ['Enter', 'Escape'].includes(part.text)) handlesCommitKey = true
        if (ts.isPropertyAccessExpression(part) && part.name.text === 'isComposing') compositionGuard = true
        ts.forEachChild(part, inspect)
      }
      inspect(handler.body)
      if (handlesCommitKey && !compositionGuard) offenders.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return offenders
}

// ---------- ① 所有内联按键处理：提到 Enter/Escape 就必须守组合态 ----------
{
  const offenders: string[] = []
  for (const f of files) {
    offenders.push(...unsafeInlineHandlers(read(f), f))
  }
  ok('🔴 ① 每个处理 Enter/Escape 的 onKeyDown 都守了 isComposing', offenders.length === 0, JSON.stringify(offenders.slice(0, 6)))
  ok('① 阳性样本不能借用相邻处理器或注释里的组合态守卫', unsafeInlineHandlers(`const view = <><input onKeyDown={e => { /* isComposing */ if (e.key === 'Enter') send() }} /><input onKeyDown={e => { if (e.nativeEvent.isComposing) return }} /></>`, 'positive.tsx').length === 1)
  ok('① 正常组合态守卫的阴性样本不误报', unsafeInlineHandlers(`const view = <input onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') send() }} />`, 'negative.tsx').length === 0)
}

// ---------- ② 编辑器按键总入口：组合态直接早退，不碰 Tab/Enter ----------
{
  const editor = codeOf('src/components/editor/NovelEditor.tsx')
  ok('🔴 ② 编辑器的 handleEditorKeyDown 先判组合态再处理按键',
    /if \(e\.nativeEvent\.isComposing\) return/.test(editor))
  const guard = editor.indexOf('if (e.nativeEvent.isComposing) return')
  const enter = editor.indexOf("if (e.key === 'Enter'")
  ok('🔴 ② 组合态判断在 Enter 处理**之前**', guard > 0 && enter > guard, `${guard} vs ${enter}`)
  ok('② 编辑器仍保留 Enter 换行与 Tab 缩进（不是把功能删了）',
    editor.includes('insertNewlineWithIndent') && editor.includes('applyIndent'))
}

// ---------- ③ 对话/搜索发送：Enter 发送必须排除组合态 ----------
{
  const chat = codeOf('src/components/creative/InterviewChat.tsx')
  ok('🔴 ③ 对话发送的 Enter 排除组合态（选字中不误发）',
    /e\.key === 'Enter'[^\n]*isComposing/.test(chat))
  ok('③ 对话发送仍要求非 Shift（换行优先）', /e\.key === 'Enter'[^\n]*!e\.shiftKey/.test(chat))
  ok('③ 对话发送仍要求输入非空且不在忙态', /input\.trim\(\)/.test(chat) && /!busy/.test(chat))
}

// ---------- ④ 全局快捷键：不许把 Enter/Escape 当"全局激活"绕过组合态 ----------
{
  const globals = files.filter(f => codeOf(f).includes("addEventListener('keydown'"))
  const offenders = globals.filter(f => {
    const src = codeOf(f)
    // 全局监听里处理 Enter 的，必须同时出现组合态判断
    const idx = src.indexOf("addEventListener('keydown'")
    const seg = src.slice(idx, idx + 900)
    return /['"]Enter['"]/.test(seg) && !seg.includes('isComposing')
  })
  ok('🔴 ④ 全局 keydown 里若处理 Enter 也须守组合态', offenders.length === 0, JSON.stringify(offenders))
  ok('④ 全局按键监听仍走既有入口（Ctrl/Cmd+S 等）',
    globals.some(f => f.includes('useSaveHotkey')) && globals.some(f => f.includes('overlayScope')))
}

// ---------- ⑤ 弹窗关闭：Escape 走统一浮层作用域 ----------
{
  const overlay = codeOf('src/lib/app/overlayScope.ts')
  ok('🔴 ⑤ Escape 关闭集中在 overlayScope（不经各弹窗各写一份）',
    overlay.includes('Escape') && /if \(event\.defaultPrevented \|\| event\.isComposing\) return/.test(overlay))
  const rawEsc = files.filter(f => {
    if (f === 'src/lib/app/overlayScope.ts') return false
    const src = codeOf(f)
    const idx = src.indexOf("addEventListener('keydown'")
    if (idx < 0) return false
    const seg = src.slice(idx, idx + 900)
    return /['"]Escape['"]/.test(seg)
  })
  ok('🔴 ⑤ 除 overlayScope 外没有第二套全局 Escape 关闭', rawEsc.length === 0, JSON.stringify(rawEsc))
}

console.log(`\n———— imeGuards：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exitCode = 1
