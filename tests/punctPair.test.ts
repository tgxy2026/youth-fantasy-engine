// 3.2.0 · 中文标点自动配对 · 单测
//
// 盯四件事：
//   ① 打左标点就补右半边，光标落在两个标点**中间**；
//   ② 后面已经紧跟右标点 ⇒ 不重复补（否则出现 “””）；
//   ③ 粘贴 / 撤销 / 替换多字符、英文引号、普通文字 ⇒ 一律不插手；
//   ④ 接线守住了 IME：**组合态只在命中「单个中文左标点」时才补，其余一律早退**。
//      ⚠️ 3.2.1 · T-13 修正：旧契约是「isComposing 一律早退」，实测在搜狗 / 微软拼音下
//      上屏标点时 isComposing 仍为 true ⇒ 功能永远不生效（左半边出、右半边不补）。
//      现在把配对判断放在前面，只有「多字符 / 非标点候选」才会走到早退，照样不打断上屏。
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { planPunctPair, CN_PUNCT_PAIRS } from '@/lib/editor/punctPair'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 模拟"在 pos 处插入一个字符" */
function type(prev: string, ch: string, pos = prev.length) {
  const next = prev.slice(0, pos) + ch + prev.slice(pos)
  return { prev, next, caret: pos + 1, plan: planPunctPair(prev, next, pos + 1) }
}

function main() {
  // ---------- 一、六种左标点都补 ----------
  {
    const cases: [string, string][] = [
      ['“', '”'], ['《', '》'], ['「', '」'], ['『', '』'], ['（', '）'], ['【', '】'],
    ]
    for (const [left, right] of cases) {
      const t = type('他说：', left)
      ok(`① 打「${left}」⇒ 得到「${left}${right}」`, t.plan?.value === `他说：${left}${right}`, t.plan?.value)
      ok(`① 「${left}」补完光标在两个标点之间（caret=${t.caret}）`, t.plan?.caret === t.caret, String(t.plan?.caret))
    }
  }

  // ---------- 二、不重复补 ----------
  {
    // 在已有 ” 前插入 “（作者回头补开引号）⇒ 不该再补一个
    const prev = '他说：”后面还有字'
    const next = '他说：“”后面还有字'
    ok('② 后面紧跟右标点 ⇒ 不补（避免 “””）', planPunctPair(prev, next, 4) === null)
  }

  // ---------- 三、一律不插手的情况 ----------
  {
    ok('③ 插入普通汉字 ⇒ null', type('他说', '好').plan === null)
    ok('③ 英文双引号 ⇒ null（那是代码/英文引号，补了会打断输入）', type('ab', '"').plan === null)
    ok('③ 英文单引号 ⇒ null', type('ab', "'").plan === null)
    ok('③ 英文括号 ⇒ null', type('ab', '(').plan === null)
    ok('③ 粘贴多字符 ⇒ null（长度差不成立）', planPunctPair('', '“你好”', 3) === null)
    ok('③ 删除一个字符 ⇒ null', planPunctPair('“”', '“', 1) === null)
    // 中间插入（不是末尾）
    const mid = '前后'
    const midNext = '前“后'
    const midPlan = planPunctPair(mid, midNext, 2)
    ok('③ 在中间插入也补，且插在光标处（不跑到末尾）', midPlan?.value === '前“”后', midPlan?.value)
    ok('③ 越界光标 ⇒ null', planPunctPair('', '“', 5) === null && planPunctPair('', '“', 0) === null)
  }

  // ---------- 四、配对表本身 ----------
  {
    ok('④ 配对表只收中文全角（不含半角引号/括号）',
      !Object.keys(CN_PUNCT_PAIRS).some(k => ['"', "'", '(', '[', '{'].includes(k)),
      Object.keys(CN_PUNCT_PAIRS).join(''))
    ok('④ 左右标点全部成对且不同字', Object.entries(CN_PUNCT_PAIRS).every(([l, r]) => l !== r))
  }

  // ---------- 五、接线断言（IME 守卫是这条功能的生死线） ----------
  {
    const root = process.cwd()
    const ed = readFileSync(path.join(root, 'src/components/editor/NovelEditor.tsx'), 'utf8')
    ok('🔴 ④ 正文输入接了 planPunctPair', /planPunctPair\(draftContent, next, ta\.selectionStart\)/.test(ed))
    ok('🔴 ④ 组合态只在命中单个左标点时才补，其余早退（不打断上屏）',
      /isComposing && !plan\) \{ onContentChange\(next\); return \}/.test(ed),
      '缺少「组合态 + 未命中 ⇒ 早退」这条守卫')
    ok('🔴 ④ 配对判断在组合态早退之前（否则真实输入法下永远不补）',
      ed.indexOf('planPunctPair(draftContent') > 0
      && ed.indexOf('planPunctPair(draftContent') < ed.indexOf('isComposing && !plan)'),
      '顺序错了：真实输入法上屏标点时 isComposing 仍为 true，先早退就永远补不上')
    ok('🔴 ④ 光标用 rAF 在 React 写完 DOM 之后再设（否则被推到末尾）',
      /requestAnimationFrame\(\(\) => \{[\s\S]{0,200}setSelectionRange\(plan\.caret/.test(ed))
    ok('④ 不补时仍把原文交给 onContentChange（不吞字）', /if \(!plan\) \{ onContentChange\(next\); return \}/.test(ed))
  }

  console.log(`\n▶ punctPair: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
