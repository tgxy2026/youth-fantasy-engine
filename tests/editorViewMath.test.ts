// ============ 3.3.0 · UX06：正文工作现场的纯计算 + 接线闸 ============
//
// 两层：
//   ① 纯函数：内容摘要、选区夹取、滚动比例、排版变化时改用相对位置；
//   ② 源码静态闸：捕获/恢复**确实接上了**，且没有退回「吞失败 / 存正文 / 抢焦点」的写法。
//      （这些行为没有 DOM 就测不到，靠契约钉住；真实浏览器另见 scripts/verify/frontend-editor-view.mjs）
import fs from 'node:fs'
import path from 'node:path'
import { clampSelection, contentRevision, scrollRatio, scrollTopFor } from '../src/lib/editor/editorViewMath'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

// ---------- ① 内容摘要：同文同摘要、异文异摘要、只含安全字符 ----------
{
  const a = contentRevision('雨停在城门外，守门人仍站在原地。')
  const b = contentRevision('雨停在城门外，守门人仍站在原地。')
  const c = contentRevision('城门外雨歇，守门人静立如初。')
  ok('🔴 ① 同一段正文得到同一摘要（跨会话可比）', a === b)
  ok('🔴 ① 改一个字摘要就变（内容变了不许套旧选区）', a !== c)
  ok('① 空正文也有稳定摘要', contentRevision('') === contentRevision(''))
  ok('🔴 ① 摘要只含 URL 安全字符（存储层 opaqueId 校验用它）', /^[a-zA-Z0-9_.:-]{1,256}$/.test(a), a)
  ok('① 只移动位置不改内容时摘要不变', contentRevision('abc') === contentRevision('abc'))
  ok('🔴 ① 换行/空格差异也算内容变化', contentRevision('a\nb') !== contentRevision('a b'))
  // 长度不同的同前缀文本不能撞成同一个摘要
  ok('① 长度参与摘要（前缀相同不误判）', contentRevision('abcdef') !== contentRevision('abc'))
}

// ---------- ② 选区夹取：不许越界、不许反向 ----------
{
  const inside = clampSelection(10, 20, 100, 'backward')
  ok('② 正常选区原样保留（含方向）', inside.start === 10 && inside.end === 20 && inside.direction === 'backward')
  const over = clampSelection(120, 400, 100)
  ok('🔴 ② 超出正文长度时夹到末尾', over.start === 100 && over.end === 100)
  const reversed = clampSelection(80, 30, 100)
  ok('🔴 ② 起点大于终点时收敛成空选区', reversed.start === 80 && reversed.end === 80)
  const broken = clampSelection(Number.NaN, -5, 50)
  ok('② 非法数字收敛到 0', broken.start === 0 && broken.end === 0)
  ok('② 负值不产生负偏移', clampSelection(-3, 5, 50).start === 0)
}

// ---------- ③ 滚动比例与恢复方案 ----------
{
  ok('🔴 ③ 触底比例为 1', scrollRatio(500, 500) === 1)
  ok('③ 顶部比例为 0', scrollRatio(0, 500) === 0)
  ok('🔴 ③ 内容不足一屏时除零不炸（返回 0）', scrollRatio(0, 0) === 0)
  ok('③ 比例夹在 0..1', scrollRatio(9e9, 500) === 1)

  const saved = { width: 800, height: 400, fontSize: 18, lineHeight: 34 }
  const same = scrollTopFor({ top: 320, ratio: 0.64, outerTop: 0, outerRatio: 0 }, saved, { ...saved }, 1000)
  ok('🔴 ③ 排版没变 ⇒ 用绝对位置（原样对位）', same.mode === 'absolute' && same.top === 320)

  const zoomed = scrollTopFor({ top: 320, ratio: 0.64, outerTop: 0, outerRatio: 0 }, saved, { ...saved, fontSize: 22 }, 1000)
  ok('🔴 ③ 字号变了 ⇒ 改用相对比例', zoomed.mode === 'ratio' && zoomed.top === 640)

  const narrow = scrollTopFor({ top: 320, ratio: 0.5, outerTop: 0, outerRatio: 0 }, saved, { ...saved, width: 420 }, 1000)
  ok('🔴 ③ 宽度变了（换窗口/换密度）⇒ 也走相对比例', narrow.mode === 'ratio' && narrow.top === 500)

  const clamp = scrollTopFor({ top: 9999, ratio: 1, outerTop: 0, outerRatio: 0 }, saved, { ...saved }, 100)
  ok('③ 绝对位置超过可滚范围时夹到最大值', clamp.top === 100)
}

// ---------- ④ 源码闸：接线与红线 ----------
{
  const hook = read('src/components/editor/useEditorWorkspaceView.ts')
  const model = read('src/components/editor/useNovelEditorModel.ts')
  const editor = read('src/components/editor/NovelEditor.tsx')

  ok('🔴 ④ 编辑器挂上工作现场 hook', /useEditorWorkspaceView\(\{/.test(editor))
  ok('🔴 ④ 捕获登记到 workspaceRuntime', /registerWorkspaceCapture\(/.test(hook))
  ok('🔴 ④ 捕获以 textarea.value 为准（state 会晚一拍）', /const text = ta\.value/.test(hook))
  ok('🔴 ④ 捕获带内容摘要与长度，不带正文', /revision: contentRevision\(text\)/.test(hook) && !/content: text/.test(hook))
  ok('🔴 ④ 恢复前校验内容摘要，不一致就只回章首', /contentRevision\(text\) !== record\.revision/.test(hook) && /ta\.scrollTop = 0/.test(hook))
  ok('🔴 ④ 章节优先：记录的对象必须等于当前章才恢复（显式定位不会被会话记忆覆盖）',
    /record\.kind !== 'editor' \|\| record\.objectId !== activeId/.test(hook))
  ok('🔴 ④ 作者动手就作废在途恢复（键入/输入法/按键/指针/滚轮）',
    /'input'/.test(hook) && /'compositionstart'/.test(hook) && /'keydown'/.test(hook) && /'pointerdown'/.test(hook) && /'wheel'/.test(hook))
  ok('🔴 ④ 换身份/换后端清库时作废（订阅失效通知）', /subscribeInvalidation\(/.test(hook))
  // 判「代码里没用 setTimeout」，注释里那句「不靠固定 setTimeout 猜时机」不算
  const hookCode = hook.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  ok('🔴 ④ 等布局稳定再恢复，不用固定 setTimeout 猜时机', /settleLayout/.test(hookCode) && !/setTimeout/.test(hookCode))
  ok('🔴 ④ 不抢焦点：只在原本聚焦正文且无弹窗时可还给焦点', /\[role="dialog"\]/.test(hook) && /preventScroll: true/.test(hook))
  ok('🔴 ④ 恢复失败不影响编辑（整段落 catch）', /\.catch\(\(\) => \{/.test(hook))
  ok('🔴 ④ 捕获/恢复不写 localStorage / sessionStorage', !/localStorage|sessionStorage/.test(hook))
  ok('🔴 ④ 模型切章前捕获（保存屏障之前）', /captureWorkspaceView\(\)[\s\S]{0,400}const r = await commitContent/.test(model))
  ok('🔴 ④ 显式跳章也先捕获', /consumedOpenIdRef\.current = openChapterId\s*\n\s*captureWorkspaceView\(\)/.test(model))
  ok('④ 模型行数仍守 1200 硬上限', model.split('\n').length <= 1200, String(model.split('\n').length))
}

console.log(`\n———— editorViewMath：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
