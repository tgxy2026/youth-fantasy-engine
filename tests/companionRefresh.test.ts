// ============ AI 伴写：默认关闭 + 「换一句」（2.4.0 · A5 起改挂 Alt+/）============
//
// 两件事：
//   ① **默认关闭** —— 老大明确要求"需要用户手动开启"。这里把它钉死：判据必须是
//      「存过 '1' 才开」，而不是「不是 '0' 就开」——后者在老库（从未存过）时会**默认打开**。
//   ② **换一句** —— 原先同一个前文永远得到同一句（同 key 命中缓存），
//      所以"换一句"必须绕开缓存 + 把上一句喂回去要求换写法。缺任一条都会退化成原样返回。
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')
const ghost = read('src/components/editor/useNovelEditorGhost.ts')
const inline = read('src/lib/aiTasks/inline.ts')
const editor = read('src/components/editor/NovelEditor.tsx')

// ---------- ① 🔴 默认关闭 ----------
{
  ok('🔴 伴写默认关闭：只有明确存过 1 才开',
    /localStorage\.getItem\('novel-companion'\) === '1'/.test(ghost))
  ok('🔴 没有被改成"默认开"的写法（!== \'0\' 在老库上会默认打开）',
    !/novel-companion'\) !== '0'/.test(ghost))
  ok('总开关文案写明默认关闭', /默认关闭/.test(editor))
  ok('开关只由作者点击写入（没有别处偷偷写 1）',
    (ghost.match(/setItem\('novel-companion'/g) ?? []).length === 0
    && (editor.match(/setItem\('novel-companion'/g) ?? []).length === 1)
}

// ---------- ② 🔴 换一句：任务层支持 avoid ----------
{
  ok('aiInlineSuggest 增加 avoid 入参', /avoid\?: string/.test(inline))
  ok('🔴 avoid 的注入位置在「去 AI 味」规则**之前**（那条必须钉 system 末尾才有效）',
    inline.indexOf('【上一次已经给过、这次不要用的建议】') >= 0
    && inline.indexOf('【上一次已经给过、这次不要用的建议】') < inline.indexOf('if (opts.deAiFlavor !== false) layers.push(DEAI_INLINE_RULE)'))
  ok('🔴 要求「换一个明显不同的写法」，而不是同义改写（否则模型只会换几个词）',
    /换一个「明显不同」的写法/.test(inline)
    && /不要只把词换掉/.test(inline) && /不要同义改写/.test(inline))
  ok('给了退路：可以跳过这句、直接写它后面本该发生的事（小模型想不出新写法时不至于硬凑）',
    /跳过它/.test(inline))
  ok('上一句是整段喂回去的（只给关键词模型认不出要避开什么）',
    /【上一次已经给过、这次不要用的建议】\\n\$\{opts\.avoid\.trim\(\)\}/.test(inline))
}

// ---------- ③ 🔴 换一句：hook 绕缓存 ----------
{
  ok('hook 暴露了 refreshGhost', /const refreshGhost = \(\) =>/.test(ghost) && /refreshGhost,/.test(ghost))
  ok('🔴 refreshGhost 删掉该前文的缓存（不删则同前文必然返回一字不差的同一句）',
    /ghostCache\.current\.delete\(key\)/.test(ghost))
  ok('refreshGhost 把当前建议作为 avoid 传下去',
    /fireGhost\(before, at, key, ghost\?\.text \?\? ''\)/.test(ghost))
  ok('fireGhost 把 avoid 透传给 aiInlineSuggest',
    /\.\.\.\(avoid\.trim\(\) \? \{ avoid \} : \{\}\)/.test(ghost))
  ok('🔴 refreshGhost 重置熔断与 Esc 抑制（否则上一次的拒绝会挡住这次主动请求）',
    /ghostFail\.current = 0/.test(ghost) && /ghostDismissed\.current = null/.test(ghost))
  ok('前文太短时不发请求（与自动伴写同一道门槛）',
    /if \(before\.trim\(\)\.length < 12\) return/.test(ghost))
}

// ---------- ④ 🔴 按键接线（2.4.0 · A5 换过键位，见下）----------
{
  // 🆕 A5：Tab 无条件让给编辑器缩进 ⇒ 采纳改由 Ctrl+Enter 承担
  ok('🔴 Ctrl/Cmd+Enter 接到「采纳」（原 Tab 的职责）',
    /e\.key === 'Enter' && \(e\.ctrlKey \|\| e\.metaKey\)/.test(ghost) && /acceptGhost\(\)/.test(ghost))
  ok('🔴 采纳分支先 preventDefault（不让它落成换行）',
    /e\.preventDefault\(\)\s*\n\s*if \(e\.nativeEvent\.isComposing\) return/.test(ghost))
  ok('🔴 「换一句」改挂 Alt+/（原 Ctrl+Enter 让位给采纳）',
    /e\.altKey && \(e\.key === '\/' \|\| e\.code === 'Slash'\)/.test(ghost))
  ok('原有的 Alt+\\ 手动触发保留（那是"首次触发"，与"换一句"分工不同）',
    /e\.altKey && \(e\.key === '\\\\' \|\| e\.code === 'Backslash'\)/.test(ghost))
  ok('→ 采纳保留（光标已在正文末尾时）',
    /e\.key === 'ArrowRight' && ghost/.test(ghost))
  // 🔴 本用例的核心：Tab 必须**不再**出现在伴写的按键处理里 ——
  //    它已无条件归编辑器缩进；一旦"有建议＝采纳、无建议＝缩进"的双态回来，
  //    作者就无法预判按下去会发生什么（这正是 A5 换键位的理由）。
  ok('🔴 Tab 已从伴写按键里移除（无条件归编辑器缩进，不再一键两义）',
    !/['"]Tab['"]/.test(ghost))
}

// ---------- ⑤ 文案同步 ----------
{
  ok('🔴 伴写弹窗与工具帮助都写了 Ctrl+Enter（两处都提到，作者才找得到）',
    (editor.match(/Ctrl\+Enter/g) ?? []).length >= 2,
    `共 ${(editor.match(/Ctrl\+Enter/g) ?? []).length} 处`)
  ok('文案说明了"会避开刚才那句"（让作者知道它不是重试、而是换一个）',
    /避开刚才那句/.test(editor))
  // 🆕 A5：改键位必须连文案一起改，否则作者按帮助里写的旧键位会发现没反应
  ok('🔴 帮助文案同步了「换一句」的新键 Alt+/',
    /Alt\+\//.test(editor))
  ok('🔴 帮助文案说明 Tab 归编辑器缩进（免得作者以为 Tab 还能采纳）',
    /Tab \/ Shift\+Tab 归编辑器缩进/.test(editor))
}

console.log(`\n—— companionRefresh 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
