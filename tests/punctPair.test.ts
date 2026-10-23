// 3.2.0 · 中文标点自动配对 · 单测（3.2.2 重写判据）
//
// 盯五件事：
//   ① 打左标点就补右半边，光标落在两个标点**中间**；
//   ② 后面已经紧跟右标点 ⇒ 不重复补（否则出现 “””）；
//   ③ 粘贴 / 撤销 / 替换多字符、英文引号、普通文字 ⇒ 一律不插手；
//   ④ 配对表只收中文全角；
//   ⑤ 接线：**组合态一律早退**，且早退在配对之前（与 3.2.1 的 T-13 顺序**相反**）。
//
// 🔴 3.2.2 · 2026-10-23 读者反馈：「按一下只出后引号，再按一下出很多引号」。
//    实测（CDP 模拟输入法）事件序列：
//      input(composing=true,  value="“")      ← 3.2.1 在这里补 ” ⇒ “”，并把光标移回中间
//      beforeinput(composing=false, data="“") ← 输入法随后把 "“" 提交到**我们移动后的光标处**
//      input(composing=false, value="““”")   ← 于是变成 ““”，再按一下 “““”
//    结论：组合期间的 `value` 是**未提交的预览串**，此时改 DOM 必然破坏输入法提交。
//    3.2.1 的 T-13 把「组合态也补」当成解法，方向错了；正解是**等提交之后再补**——
//    提交那次 `input` 事件的 `isComposing` 已是 false，且 `data` 就是被提交的字符。
//    判据也随之更换：不再用「prev/next 长度差」（组合态下从来对不上），改用事件自带 `data`。
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { planPunctPair, planPunctPairAtCaret, CN_PUNCT_PAIRS } from '@/lib/editor/punctPair'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 模拟"在 pos 处输入一个字符"（data 就是那个字符） */
function type(prev: string, ch: string, pos = prev.length) {
  const next = prev.slice(0, pos) + ch + prev.slice(pos)
  const caret = pos + 1
  return { prev, next, caret, plan: planPunctPair(next, caret, ch) }
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
    ok('② 后面紧跟右标点 ⇒ 不补（避免 “””）', planPunctPair('他说：“”后面还有字', 4, '“') === null)
    // 输入法自己已经补了左右两只：光标停在两标点之间、data 是左引号
    ok('🔴 ② 输入法已自补右半边 ⇒ 不重复补（微信输入法就是这种）',
      planPunctPair('“”', 1, '“') === null)
  }

  // ---------- 三、一律不插手的情况 ----------
  {
    ok('③ 插入普通汉字 ⇒ null', type('他说', '好').plan === null)
    ok('③ 英文双引号 ⇒ null（那是代码/英文引号，补了会打断输入）', type('ab', '"').plan === null)
    ok('③ 英文单引号 ⇒ null', type('ab', "'").plan === null)
    ok('③ 英文括号 ⇒ null', type('ab', '(').plan === null)
    ok('③ 粘贴多字符 ⇒ null（data 长度 > 1）', planPunctPair('“你好”', 3, '“你好”') === null)
    ok('③ 粘贴 / 撤销（data 为 null 或 undefined）⇒ null',
      planPunctPair('“', 1, null) === null && planPunctPair('“', 1, undefined) === null)
    // 中间插入（不是末尾）
    const mid = type('前后', '“', 1)
    ok('③ 在中间插入也补，且插在光标处（不跑到末尾）', mid.plan?.value === '前“”后', mid.plan?.value)
    ok('③ 越界光标 ⇒ null', planPunctPair('“', 5, '“') === null && planPunctPair('“', 0, '“') === null)
    // data 与光标前那个字不一致 ⇒ 不是"刚打进正文"的那一下，不插手
    // 光标前那个字是「乙」而事件说刚输入「“」⇒ 不是刚打进正文的那一下
    ok('③ data 与光标前的字不符 ⇒ null（防误补）', planPunctPair('甲“乙', 3, '“') === null)
  }


  // ---------- 六、在自己造的引号里再按一次 ⇒ 跳出去（type-over） ----------
  //
  // 🔴 3.2.2 · 读者反馈「再按一下出很多引号」：原先第二下只会多一个孤零零的左引号，
  //    连按三次就是 “““”。现在改成「跳出去」，连按的节奏是：成对 → 跳出 → 再开一对。
  {
    // 第一下：他| 打 “  ⇒ “” 光标居中
    const first = type('他', '“')
    ok('⑥ 第一下成对', first.plan?.value === '他“”' && first.plan?.caret === 2, JSON.stringify(first.plan))
    // 第二下：在 “|” 中间又打 “ ⇒ 删掉刚插入的左引号、光标越过右引号
    const second = planPunctPair('他““”', 3, '“')
    ok('🔴 ⑥ 第二下跳出引号（不留多余左引号）', second?.value === '他“”' && second?.caret === 3,
      JSON.stringify(second))
    // 第三下：光标已在引号之后 ⇒ 正常再开一对
    const third = planPunctPair('他“”' + '“', 4, '“')
    ok('⑥ 第三下再开一对（不叠加）', third?.value === '他“”“”' && third?.caret === 4, JSON.stringify(third))
    // 正当写法不受影响：回头给已有的 ” 补开引号
    ok('🔴 ⑥ 回头补开引号仍是 null（不误删）', planPunctPair('他说：“”后面', 4, '“') === null)
  }

  // ---------- 七、组合结束后的补标点（按光标判断） ----------
  {
    ok('⑦ 组合结束：光标在左引号后 ⇒ 补右半边',
      planPunctPairAtCaret('他说：“', 4)?.value === '他说：“”')
    ok('⑦ 组合结束：光标在两标点之间（输入法已自补）⇒ 不动', planPunctPairAtCaret('“”', 1) === null)
    ok('🔴 ⑦ 组合结束：在自己那对里又按一次 ⇒ 跳出', JSON.stringify(planPunctPairAtCaret('““”', 2)) === JSON.stringify({ value: '“”', caret: 2 }))
    ok('⑦ 组合结束：普通文字 ⇒ 不动', planPunctPairAtCaret('他说', 2) === null)
    ok('⑦ 组合结束：空串 / 越界 ⇒ 不动',
      planPunctPairAtCaret('', 0) === null && planPunctPairAtCaret('“', 9) === null)
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
    const iGuard = ed.indexOf('if (ev.isComposing) { onContentChange(next); return }')
    const iPlan = ed.indexOf('planPunctPair(next, ta.selectionStart, ev.data)')

    ok('🔴 ⑤ 正文输入接了 planPunctPair（用 value / caret / data 三参）', iPlan > 0)
    ok('🔴 ⑤ 组合态**一律早退**、不碰 DOM（2026-10-23 读者 bug 的根因）', iGuard > 0,
      '缺少「组合态直接交接原值」这条守卫')
    ok('🔴 ⑤ 早退在配对之前（与 T-13 顺序相反：先判组合态，再谈补标点）',
      iGuard > 0 && iPlan > 0 && iGuard < iPlan,
      '顺序错了：组合态里补标点会把输入法的提交挤到我们移动后的光标处')
    ok('🔴 ⑤ 不再用「prev/next 长度差」旧判据',
      !/planPunctPair\(draftContent,\s*next/.test(ed),
      '旧判据在组合态下永不成立，正是它被取代的原因')
    ok('🔴 ⑤ 光标用 rAF 在 React 写完 DOM 之后再设（否则被推到末尾）',
      /requestAnimationFrame\(\(\) => \{[\s\S]{0,200}setSelectionRange\(plan\.caret/.test(ed))
    ok('⑤ 不补时仍把原文交给 onContentChange（不吞字）', /if \(!plan\) \{ onContentChange\(next\); return \}/.test(ed))
    ok('🔴 ⑤ 接了 onCompositionEnd（有些输入法只把字留在组合里、不发提交事件）',
      /onCompositionEnd=\{e => \{/.test(ed) && ed.includes('planPunctPairAtCaret(ta.value, ta.selectionStart)'))
  }

  console.log(`\n▶ punctPair: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
