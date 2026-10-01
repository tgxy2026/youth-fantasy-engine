// ============ AI 伴写结果后处理（trimInlineSuggestion）单元测试 ============
// 这是纯函数：把模型返回的文本洗成「可直接按 Tab 采纳的一段」。
// 它守着一条体验底线——**ghost 绝不能以半句悬空收尾**（作者采纳后半截话悬在那里最恼人），
// 以及"宁缺毋滥"——洗出来不足 4 字就当没有建议，不往界面上透垃圾。
// 故此处用精确断言（而非只要求不炸的软断言）锁死行为。
import { trimInlineSuggestion, foldGhostNewlines, INLINE_SUGGEST_LIMITS } from '../src/lib/aiTasks'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- 1. 清洗：围栏 / 前言 / 引号 / 换行 ----------
{
  ok('剥裸 ``` 围栏', trimInlineSuggestion('```\n他抬起头。\n```', 40) === '他抬起头。')
  ok('剥 ```json 围栏', trimInlineSuggestion('```json\n他抬起头。\n```', 40) === '他抬起头。')
  ok('剥「好的，」开场', trimInlineSuggestion('好的，他抬起头。', 40) === '他抬起头。')
  ok('剥「续写：」开场', trimInlineSuggestion('续写：他抬起头。', 40) === '他抬起头。')
  ok('剥「以下是……」开场', trimInlineSuggestion('以下是续写内容：他抬起头。', 40) === '他抬起头。')
  ok('剥整段包裹的引号', trimInlineSuggestion('“他抬起头。”', 40) === '他抬起头。')
  ok('折掉单换行（ghost 只占一行）', trimInlineSuggestion('他抬起头，\n看见山影。', 40) === '他抬起头，看见山影。')
  ok('只取第一段（模型偶尔多续一段）', trimInlineSuggestion('他抬起头。\n\n补充说明：这里该写景。', 40) === '他抬起头。')
}

// ---------- 2. 长度守卫：切在句末标点，绝不半句悬空 ----------
{
  const sentence = '甲'.repeat(30) + '。' + '乙'.repeat(30)
  // 反例守卫：不截断的话原文确实超限 —— 证明下面这条用例不是"恰好没超"而通过
  ok('反例：不截断时原文确实超过上限（证明截断用例有效）', sentence.length > 40, `长度=${sentence.length}`)
  ok('超长时切在句末标点（不出现半句悬空）', trimInlineSuggestion(sentence, 40) === '甲'.repeat(30) + '。')

  const commas = '甲'.repeat(30) + '，' + '乙'.repeat(30)
  ok('无句末标点时退到逗号', trimInlineSuggestion(commas, 40) === '甲'.repeat(30) + '，')

  // 标点出现太靠前（不足上限 40%）时不该照切，否则 ghost 只剩一小截
  const early = '甲。' + '乙'.repeat(50)
  ok('句末标点过靠前时不照切（退到硬切上限）', trimInlineSuggestion(early, 40) === early.slice(0, 40), trimInlineSuggestion(early, 40))

  const noPunct = '甲'.repeat(60)
  ok('完全无标点时硬切到上限', trimInlineSuggestion(noPunct, 40) === '甲'.repeat(40))

  ok('未超限时原样保留', trimInlineSuggestion('他抬起头，看见远处的山影。', 40) === '他抬起头，看见远处的山影。')
}

// ---------- 3. 宁缺毋滥：洗出来不足 4 字 / 空 → 当作没有建议 ----------
{
  ok('空串 → 空串', trimInlineSuggestion('', 40) === '')
  ok('纯空白 → 空串', trimInlineSuggestion('   \n\t  ', 40) === '')
  ok('洗后不足 4 字 → 空串（不显示垃圾建议）', trimInlineSuggestion('好。', 40) === '')
  ok('洗后恰好 4 字 → 保留', trimInlineSuggestion('他抬头看。', 40) === '他抬头看。')
}

// ---------- 4. 档位上限自洽：三档必须递增且都够写一句话 ----------
{
  ok('短句 < 一句话 < 两句', INLINE_SUGGEST_LIMITS.short.chars < INLINE_SUGGEST_LIMITS.sentence.chars
    && INLINE_SUGGEST_LIMITS.sentence.chars < INLINE_SUGGEST_LIMITS.two.chars)
  ok('「一句话」档默认 40 字', INLINE_SUGGEST_LIMITS.sentence.chars === 40)
  ok('numPredict 与字数上限同向递增',
    INLINE_SUGGEST_LIMITS.short.numPredict <= INLINE_SUGGEST_LIMITS.sentence.numPredict
    && INLINE_SUGGEST_LIMITS.sentence.numPredict <= INLINE_SUGGEST_LIMITS.two.numPredict)
}

// ---------- 5. 折换行时补回句中标点（社区反馈：输出的一句话中间漏逗号） ----------
{
  const got = trimInlineSuggestion('他转过身\n看向门外', 40)
  ok('断处无标点 → 补逗号（不把两个小句粘成一串）', got === '他转过身，看向门外', got)
  ok('断处已有逗号 → 不重复补', trimInlineSuggestion('他转过身，\n看向门外。', 40) === '他转过身，看向门外。')
  ok('断处是句号 → 只折行不补', trimInlineSuggestion('他转过身。\n看向门外。', 40) === '他转过身。看向门外。')
  // 双换行是**段落**分隔（模型多续了一段）→ 走「只取第一段」，不把第二段粘进来
  ok('连续双换行按段落只取第一段', trimInlineSuggestion('他转过身\n\n看向门外', 40) === '他转过身')
  ok('行首换行不补标点（没有上一句）', trimInlineSuggestion('\n他抬起头。', 40) === '他抬起头。')
  ok('foldGhostNewlines 可单独单测', foldGhostNewlines('甲\n乙') === '甲，乙', foldGhostNewlines('甲\n乙'))
  // 反例守卫：证明第一条不是「恰好没走到折行那段代码」
  ok('反例：确有换行需要折叠（证明用例有效）', '他转过身\n看向门外'.includes('\n'))
}

console.log(`\ninlineSuggest: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
