/**
 * 颉文姬「建议段」纯内容变换 —— 单测（3.5.3 · P2）
 *
 * insertAdvice / clearAdvice 的内容计算从 useNovelEditorModel 外抽到 adviceBlock.ts。
 * 这里独立验证原先只靠整条编辑器流程才覆盖到的数据敏感保障：
 *   ① 插入定位到选区所在段落末尾、绝不动原文；② 紧邻重复防护；
 *   ③ 清除前标记配对校验（不成对拒绝，避免跨正文误删）；④ 插入→清除可往返。
 * 状态 / UI 接线（updateContent / noteAiAssist / showToast）仍由 aiAssist 守门断言钉在模型上。
 */
import { computeAdviceInsert, computeAdviceClear } from '../src/components/editor/adviceBlock'
import { ADVICE_START, ADVICE_END } from '../src/components/jiewenji/jieWenJiParts'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const block = (body: string) => `\n\n${ADVICE_START}\n${body}\n${ADVICE_END}`

console.log('\n▶ adviceBlock')

// ---------- computeAdviceInsert ----------
{
  // 无选区 → 插到末尾
  const r = computeAdviceInsert('第一段', null, '改稿')
  ok('无选区插到末尾', r.ok && r.next === '第一段' + block('改稿'))
  ok('产出字数 = 改稿正文（不含标记）', r.ok && r.polishedChars === 2, r.ok ? `实得 ${r.polishedChars}` : '')

  // 选区在前段 → 插到该段末尾（空行前），后段原样保留
  const base = 'AAA\n\nBBB'
  const r2 = computeAdviceInsert(base, { start: 0, end: 1 }, 'X')
  ok('选区所在段落末尾插入（后段不动）', r2.ok && r2.next === 'AAA' + block('X') + '\n\nBBB', r2.ok ? r2.next : '')

  // 选区在最后一段（其后无空行）→ 插到全文末尾
  const r3 = computeAdviceInsert(base, { start: 5, end: 6 }, 'X')
  ok('末段选区插到全文末尾', r3.ok && r3.next === base + block('X'))

  // 非法选区（end < start）按无选区处理
  const r4 = computeAdviceInsert('AAA', { start: 2, end: 1 }, 'X')
  ok('非法选区按末尾插入', r4.ok && r4.next === 'AAA' + block('X'))

  // 紧邻已有建议段 → 拒绝（防同一改稿连点两次插两份）
  const dupBase = 'AAA' + block('旧')
  const r5 = computeAdviceInsert(dupBase, { start: 0, end: 1 }, '新')
  ok('紧邻已有建议段拒绝插入', !r5.ok && r5.reason === 'duplicate')

  // 改稿两端空白被修剪，字数按修剪后计
  const r6 = computeAdviceInsert('AAA', null, '  改稿  ')
  ok('改稿修剪后写入与计字', r6.ok && r6.next === 'AAA' + block('改稿') && r6.polishedChars === 2)

  // 纯函数：原字符串不被改动
  const orig = 'AAA\n\nBBB'
  computeAdviceInsert(orig, { start: 0, end: 1 }, 'X')
  ok('原内容不被改动（纯函数）', orig === 'AAA\n\nBBB')
}

// ---------- computeAdviceClear ----------
{
  ok('无建议段返回 none', (() => { const r = computeAdviceClear('普通正文'); return !r.ok && r.reason === 'none' })())

  // 标记不成对 → 拒绝并回报计数（避免孤立「开始」跨正文误删）
  const u1 = computeAdviceClear(`正文\n${ADVICE_START}\n孤立开始`)
  ok('孤立开始标记拒绝清除', !u1.ok && u1.reason === 'unpaired' && u1.starts === 1 && u1.ends === 0)
  const u2 = computeAdviceClear(`正文\n${ADVICE_END}\n孤立结束`)
  ok('孤立结束标记拒绝清除', !u2.ok && u2.reason === 'unpaired' && u2.starts === 0 && u2.ends === 1)

  // 单个成对块 → 清除，块外正文保留（原正则连同紧邻 ≤2 空行一并吃掉，此为既有行为）
  const single = '前文' + block('改稿') + '\n\n后文'
  const c1 = computeAdviceClear(single)
  ok('清除单个建议段保留块外正文', c1.ok && c1.next === '前文后文', c1.ok ? c1.next : '')

  // 多个成对块 → 全部清除
  const multi = 'A' + block('一') + '\n\nB' + block('二') + '\n\nC'
  const c2 = computeAdviceClear(multi)
  ok('清除全部建议段', c2.ok && c2.next === 'ABC', c2.ok ? c2.next : '')

  // 往返：末尾插入后再清除 → 回到原文
  const ins = computeAdviceInsert('原文', null, '改稿')
  if (ins.ok) {
    const c = computeAdviceClear(ins.next)
    ok('插入→清除往返还原', c.ok && c.next === '原文')
  } else {
    ok('插入→清除往返还原', false, '插入 unexpectedly 失败')
  }
}

console.log(`\n▶ adviceBlock: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)