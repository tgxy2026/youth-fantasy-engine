// ============ 章节树重渲染回归闸（3.6.2 · W4 切章长任务）============
//
// 背景（docs/3.6.2-开发记录-2026-11-21.md §1.5c）：
//   800 章长书里每次切章多出约 88ms 长任务、堆涨约 50MB。CPU profile 采不到（见记录），
//   最终靠逐层排除定位到**三处「与切哪一章无关却跟着切章重渲染 800 行树」**：
//     ① 树组件没 memo → 父组件每次渲染（含每次敲键、切章后的第二次提交）都重渲染整棵树；
//     ② 写回执 effect 依赖 activeId → 每次切章重读库 + setState，再触发一次全树渲染；
//     ③ useResizable 每次返回新对象 → 依赖它的子组件 memo 全失效。
//
// 本闸钉住修复形状。都是**结构闸**，不跑渲染：
//   · 只防"被悄悄改回去"（这轮修的正是最容易被后来者顺手改回去的写法）。
//   · 判据尽量松（允许改名以外的格式差异），宁可少报也不误报。
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

const tree = read('src/components/editor/NovelEditorChapterTree.tsx')
const editor = read('src/components/editor/NovelEditor.tsx')
const resizable = read('src/lib/app/useResizable.ts')

// ── ① 树组件 memo ──
ok('树组件显式导入 memo', /\bimport\s*\{[^}]*\bmemo\b[^}]*\}\s*from\s*['"]react['"]/.test(tree))
ok('树组件以 memo 包装导出（且唯一默认导出）',
  /export\s+default\s+memo\(\s*NovelEditorChapterTree\s*\)/.test(tree)
  && (tree.match(/export\s+default\b/g) ?? []).length === 1,
  (tree.match(/export\s+default[^\n]*/g) ?? []).join(' | '))

// ── ② 写回执 effect 与 activeId 解耦 ──
// 定位到调用 chapterWriteIssues 的那个 useEffect 块，检查它的依赖数组。
const receiptAt = tree.indexOf('chapterWriteIssues(')
ok('写回执 effect 仍在（chapterWriteIssues 被调用）', receiptAt >= 0)
if (receiptAt >= 0) {
  const before = tree.slice(0, receiptAt)
  const effectAt = before.lastIndexOf('useEffect(')
  const depAt = tree.indexOf(']', receiptAt)
  const effectBody = effectAt >= 0 && depAt > receiptAt ? tree.slice(effectAt, depAt + 1) : ''
  ok('写回执 effect 不再依赖 activeId',
    effectBody.length > 0 && !/\[\s*[^\]]*\bactiveId\b[^\]]*\]/.test(effectBody),
    effectBody.slice(-120))
  ok('写回执 effect 仍拿 chapters 当依赖（保存后才可能变化）',
    /\[\s*chapters\s*\]/.test(effectBody),
    effectBody.slice(-120))
}

// ── ③ 父组件传树的动作全是稳定引用 ──
ok('父组件用 latest-ref 转发树动作',
  /treeActionRef\.current\s*=\s*\{[\s\S]{0,300}openChapter/.test(editor))
const arrowProps = editor.match(/\b(?:openChapter|removeVolume|removeChapter|toggleExcludeNumbering|resetDrag|handleDrop|moveByKeyboard)=\{\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g)
ok('传树的 props 没有内联箭头函数', !arrowProps, (arrowProps ?? []).join(' | '))
ok('树收到的 openChapter 是 useCallback 稳定引用',
  /const\s+treeOpenChapter\s*=\s*useCallback\(/.test(editor) && /openChapter=\{treeOpenChapter\}/.test(editor))
ok('pane 走 useMemo（紧凑模式另开对象也不破坏引用）',
  /const\s+treePane\s*=\s*useMemo\(/.test(editor) && /pane=\{treePane\}/.test(editor))

// ── ④ useResizable 返回值引用稳定 ──
ok('useResizable 返回 useMemo 包装的对象',
  /return\s+useMemo\(\s*\(\s*\)\s*=>\s*\(\s*\{[\s\S]{0,400}onDragStart[\s\S]{0,400}\}\s*\)\s*,/.test(resizable),
  '建议：return useMemo(() => ({ … }), [size, min, max, dragging, onDragStart, adjust, reset, setWidth])')

console.log(`\neditorChapterTreeMemo: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1