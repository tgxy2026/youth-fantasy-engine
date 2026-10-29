// ============ 3.3.1 · P4：答疑回答的解析与引用校验 ============
//
// 这批用例守的是「模型说了算不算数」：
//   · 来源必须来自**本次召回**的片段（编一个 id 出来不算）；
//   · 摘录必须能在原文里逐字找到（写得像不算）；
//   · 校验不过就不给「AI 回答」，退回手册检索；且失败文案不能把技术失败说成「手册没写」。
import fs from 'node:fs'
import path from 'node:path'
import {
  HELP_ANSWER_FAILURE_TEXT, MAX_PROMPT_HITS, MIN_QUOTE_LENGTH,
  buildHelpAnswerPrompt, parseHelpAnswer, readHelpAnswer, verifyHelpAnswer,
} from '../src/lib/aiTasks/helpAnswer'
import { getHelpArticle, searchHelp } from '../src/lib/help'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

/** 真实召回：不造片段，直接用检索结果，避免「自造样本自证」 */
const hits = searchHelp('保存状态怎么看')
const first = hits[0]
const firstText = first ? (getHelpArticle(first.articleId)?.sections.find(s => s.id === first.sectionId)?.body.join('\n') ?? '') : ''

// ---------- ① 提示词 ----------
{
  const prompt = buildHelpAnswerPrompt('保存状态怎么看', hits)
  ok('系统提示词要求「只根据片段回答」', prompt.system.includes('只根据下面给出的【手册片段】'))
  ok('系统提示词禁止编造按钮与能力', prompt.system.includes('不要编造'))
  ok('系统提示词规定了 JSON 结构与 quote 逐字要求', prompt.system.includes('"sources"') && prompt.system.includes('逐字'))
  ok('用户消息带上问题与片段 id', prompt.user.includes('保存状态怎么看')
    && !!first && prompt.user.includes(`${first.articleId}/${first.sectionId}`))
  ok('片段数量不超过上限', buildHelpAnswerPrompt('保存', hits).user.split('【片段').length - 1 <= MAX_PROMPT_HITS)
  const empty = buildHelpAnswerPrompt('保存', [])
  ok('没有召回时明确告诉模型「没有任何片段」', empty.user.includes('没有召回到任何手册片段'))
}

// ---------- ② 解析 ----------
{
  const good = JSON.stringify({
    answer: '看正文底部的保存状态。',
    sources: [{ articleId: first.articleId, sectionId: first.sectionId, quote: firstText.slice(0, 20) }],
  })
  const parsed = parseHelpAnswer(good)
  ok('合法 JSON 能解析', parsed.ok && parsed.value.sources.length === 1 && parsed.value.answer.length > 0)

  const fenced = '```json\n' + good + '\n```'
  ok('代码围栏里的 JSON 也能解析', parseHelpAnswer(fenced).ok)

  ok('完全不是 JSON 时如实失败', !parseHelpAnswer('我觉得应该点左上角那个按钮').ok)

  const partial = JSON.stringify({ answer: '答', sources: [{ articleId: '', sectionId: 'x', quote: 'y' }, { articleId: 'a', sectionId: 'b', quote: '一二三四五六七八九十' }] })
  const parsedPartial = parseHelpAnswer(partial)
  ok('缺字段的来源被丢弃，不留半条', parsedPartial.ok && parsedPartial.value.sources.length === 1)
}

// ---------- ③ 引用校验 ----------
{
  const goodQuote = firstText.slice(0, 24)
  const valid = verifyHelpAnswer({ answer: '答', sources: [{ articleId: first.articleId, sectionId: first.sectionId, quote: goodQuote }] }, hits)
  ok('来源在召回内且摘录逐字存在 ⇒ 通过', valid.ok)

  const outOfScope = verifyHelpAnswer({ answer: '答', sources: [{ articleId: 'no-such-article', sectionId: 'x', quote: goodQuote }] }, hits)
  ok('🔴 引用召回之外的文章 ⇒ 拒绝', !outOfScope.ok && outOfScope.reason === 'out-of-scope-source')

  const invented = verifyHelpAnswer({ answer: '答', sources: [{ articleId: first.articleId, sectionId: first.sectionId, quote: '这句话原文里根本没有出现过吧' }] }, hits)
  ok('🔴 摘录在原文里找不到 ⇒ 拒绝（写得像不算）', !invented.ok && invented.reason === 'unverifiable-source')

  const tooShort = verifyHelpAnswer({ answer: '答', sources: [{ articleId: first.articleId, sectionId: first.sectionId, quote: goodQuote.slice(0, MIN_QUOTE_LENGTH - 1) }] }, hits)
  ok(`摘录短于 ${MIN_QUOTE_LENGTH} 字 ⇒ 拒绝（太短等于没校验）`, !tooShort.ok && tooShort.reason === 'unverifiable-source')

  ok('没有任何来源 ⇒ 拒绝', (() => {
    const result = verifyHelpAnswer({ answer: '答', sources: [] }, hits)
    return !result.ok && result.reason === 'no-sources'
  })())
  ok('空回答 ⇒ 拒绝', (() => {
    const result = verifyHelpAnswer({ answer: '   ', sources: [{ articleId: first.articleId, sectionId: first.sectionId, quote: goodQuote }] }, hits)
    return !result.ok && result.reason === 'empty-answer'
  })())

  // 召回列表为空时，任何来源都不可信
  const noRecall = verifyHelpAnswer({ answer: '答', sources: [{ articleId: first.articleId, sectionId: first.sectionId, quote: goodQuote }] }, [])
  ok('本次没有召回时，不认任何来源', !noRecall.ok && noRecall.reason === 'out-of-scope-source')
}

// ---------- ④ 一步到位 + 失败文案 ----------
{
  const good = JSON.stringify({
    answer: '看正文底部的保存状态。',
    sources: [{ articleId: first.articleId, sectionId: first.sectionId, quote: firstText.slice(0, 20) }],
  })
  const done = readHelpAnswer(good, hits)
  ok('解析+校验一次完成（通过了才叫回答）', done.ok && done.answer.length > 0)

  const bad = readHelpAnswer('{"answer":"答","sources":[{"articleId":"x","sectionId":"y","quote":"一二三四五六七八九十"}]}', hits)
  ok('引用了召回外的内容 ⇒ 不当作回答', !bad.ok)

  const reasons = Object.keys(HELP_ANSWER_FAILURE_TEXT)
  ok('每种失败都有给作者看的话', reasons.length === 5 && reasons.every(key => (HELP_ANSWER_FAILURE_TEXT[key as keyof typeof HELP_ANSWER_FAILURE_TEXT] ?? '').length >= 8))
  ok('🔴 失败文案不把技术失败说成「手册没写」',
    reasons.every(key => !/没写|没有覆盖|未收录/.test(HELP_ANSWER_FAILURE_TEXT[key as keyof typeof HELP_ANSWER_FAILURE_TEXT])))
  ok('失败文案都指明退回手册检索', reasons.every(key => /退回手册检索/.test(HELP_ANSWER_FAILURE_TEXT[key as keyof typeof HELP_ANSWER_FAILURE_TEXT])))
}

// ---------- ⑤ 分层守卫 ----------
{
  const src = read('src/lib/aiTasks/helpAnswer.ts')
  ok('🔴 这一层不发起模型调用（只管判据，调用归属留给上层）', !/\bchat\s*\(/.test(src) && !/useTaskRunner/.test(src))
  ok('不直接读作者的正文或项目数据（无正文变量、无 db 依赖）',
    !/draftContent/.test(src) && !/from '@\/lib\/db'/.test(src) && !/getCurrentProjectId\(/.test(src))
  ok('依赖只走门面（不深挖 ai 内部实现细节）', /from '@\/lib\/ai\/aiParse'/.test(src) && /from '@\/lib\/help'/.test(src))
}

console.log(`\n—— helpAnswer 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
