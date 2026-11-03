// ============ 3.3.1 · P7：校对结果「定位原文」============
//
// 钉死三件事：
//   ① 定位与替换**同源**（`resolveLocation`）：`at` 逐字命中 → 全文唯一 → 否则拒绝，绝不猜第一处；
//   ② 定位是**只读**的：只算区间与上下文，不碰正文、不调替换函数；
//   ③ 两处入口（工具弹窗 / 颉文姬诊室）都把结果交给正文，且弹窗先收起再定位 ——
//      否则滚动和选区都作用在被遮住的元素上，作者什么也看不到。
import fs from 'node:fs'
import path from 'node:path'
import { locateFailureText, locateProofIssue, locateQuote, LOCATE_FAILURE_TEXT } from '../src/lib/editor/proofLocate'
import { resolveLocation } from '../src/lib/editor/proofApply'
import type { ProofreadIssue } from '../src/lib/aiTasks/proofread'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')
/** 测试桩：本用例只关心 quote / at / stale 三项，其余字段给合法默认值（`as` 仅为并集收窄） */
function issue(patch: Partial<ProofreadIssue>): ProofreadIssue {
  return { kind: 'suggestion', type: '语病', quote: '', suggestion: '（建议）', why: '', ...patch } as ProofreadIssue
}

// ---------- ① 判据与替换同源 ----------
{
  const body = '他在门口站了一会，随后推门进去。'
  const at = body.indexOf('一会')
  const hit = locateQuote(body, { quote: '一会', at })
  ok('at 逐字命中 ⇒ 直接采用模型标注的位置', hit.ok && hit.start === at && hit.end === at + 2)

  const moved = locateQuote(body, { quote: '一会', at: 0 })
  ok('at 失效但引文全文唯一 ⇒ 回退到唯一命中', moved.ok && moved.start === at)

  const twice = '他说好。她又说好。'
  const ambiguous = locateQuote(twice, { quote: '说好', at: null })
  ok('引文多处且没有可用位置 ⇒ 拒绝（不猜第一处）', !ambiguous.ok && ambiguous.reason === 'ambiguous')

  const second = twice.indexOf('说好', 2)
  const anchored = locateQuote(twice, { quote: '说好', at: second })
  ok('多处但 at 精确命中 ⇒ 仍然接受（位置是确定的）', anchored.ok && anchored.start === second && second === 6)

  const missing = locateQuote(body, { quote: '早就走了', at: 3 })
  ok('正文里找不到引文 ⇒ not-found', !missing.ok && missing.reason === 'not-found')

  const empty = locateQuote(body, { quote: '' })
  ok('空引文 ⇒ not-found（不返回 0 长度区间）', !empty.ok && empty.reason === 'not-found')

  const stale = locateQuote(body, { quote: '一会', at, stale: true })
  ok('已失效的结果 ⇒ stale（不因正文还找得到就复活）', !stale.ok && stale.reason === 'stale')
}

// ---------- ② 下标口径与 textarea 一致（UTF-16）----------
{
  const body = '😀她笑了，然后离开。'
  const hit = locateProofIssue(body, issue({ quote: '她笑了' }))
  // '😀' 占两个 UTF-16 单位 ⇒ 引文从 2 开始；按「字符数」算会得到 1，与 selectionStart 差一格
  ok('emoji 前后位置按 UTF-16 单位计算', hit.ok && hit.start === 2 && hit.end === 5)

  const multiline = '第一段。\n第二段有错别字。\n第三段。'
  const line = locateProofIssue(multiline, issue({ quote: '错别字' }))
  ok('跨行正文的下标含换行符', line.ok && multiline.slice(line.start, line.end) === '错别字')
}

// ---------- ③ 上下文片段：够辨认、不越界 ----------
{
  const body = '前面一大段铺垫文字。目标句子在这里。后面还有一大段收尾文字。'
  const hit = locateProofIssue(body, issue({ quote: '目标句子在这里。' }))
  ok('命中区间逐字等于引文', hit.ok && body.slice(hit.start, hit.end) === '目标句子在这里。')
  ok('前文片段不超过设定长度', hit.ok && hit.before.length > 0 && hit.before.length <= 12
    && body.slice(0, hit.start).endsWith(hit.before))
  ok('后文片段不超过设定长度', hit.ok && hit.after.length > 0 && hit.after.length <= 12
    && body.slice(hit.end).startsWith(hit.after))

  const head = locateProofIssue('目标在开头。后面很长很长的一段话。', issue({ quote: '目标在开头。' }))
  ok('命中在正文开头时前文为空字符串（不是 undefined）', head.ok && head.before === '')
  const tail = locateProofIssue('很长很长的一段话。目标在结尾', issue({ quote: '目标在结尾' }))
  ok('命中在正文结尾时后文为空字符串', tail.ok && tail.after === '')
}

// ---------- ④ 定位核与替换判据不漂移 ----------
{
  const body = 'aaa'
  const core = resolveLocation(body, 'aa')
  const legacy = locateQuote(body, { quote: 'aa' })
  ok('重叠引文在核与定位结果里都是多义', !core.ok && core.reason === 'ambiguous' && !legacy.ok && legacy.reason === 'ambiguous')
  const bad = resolveLocation('abc', 'b', 5)
  ok('at 越界不会抛错，退回唯一命中', bad.ok && bad.start === 1)
  const nonInteger = resolveLocation('abcabc', 'bc', 1.5)
  ok('at 非整数按无位置处理（多处 ⇒ 拒绝）', !nonInteger.ok && nonInteger.reason === 'ambiguous')
}

// ---------- ⑤ 失败原因都有作者能读懂的话 ----------
{
  const reasons = ['stale', 'not-found', 'ambiguous'] as const
  ok('三种失败原因都有文案', reasons.every(r => (LOCATE_FAILURE_TEXT[r] ?? '').trim().length >= 8))
  ok('文案里不出现代码术语', reasons.every(r => !/undefined|null|indexOf/.test(LOCATE_FAILURE_TEXT[r])))
  ok('locateFailureText 与表一致', reasons.every(r => locateFailureText(r) === LOCATE_FAILURE_TEXT[r]))
}

// ---------- ⑥ 源码守卫 ----------
{
  const locateSrc = read('src/lib/editor/proofLocate.ts')
  const jump = read('src/components/editor/useProofLocateJump.ts')
  const channel = read('src/components/editor/proofLocateChannel.ts')
  const ed = read('src/components/editor/EditorModals.tsx')
  const clinic = read('src/components/jiewenji/JieWenJiClinic.tsx')
  const editor = read('src/components/editor/NovelEditor.tsx')

  ok('🔴 定位层不调用任何写入函数', !/applyProofReplacement\(/.test(locateSrc) && !/applyProofReplacement\(/.test(jump))
  ok('🔴 消费端用引文重新校验，不盲信请求里的下标', /locateQuote\(ta\.value, \{ quote: request\.quote, at: request\.start \}\)/.test(jump))
  ok('消费端校验章节归属（跨章不跳）', /request\.chapterId !== currentChapter/.test(jump) && /!currentChapter/.test(jump))
  ok('消费端定位后同步编辑器选区状态', /notify\?\.\(\{ start: located\.start, end: located\.end \}\)/.test(jump))
  ok('失败要说原因（不静默）', /locateFailureText\(located\.reason\)/.test(jump))
  ok('通道只通知订阅者、处理结果如实返回', /if \(handler\(request\)\) handled = true/.test(channel) && /return handled/.test(channel))
  ok('通道带单调递增 id（连点只看最新）', /id: \+\+sequence/.test(channel))

  ok('工具弹窗把结果交给父级定位（source: tool）', /onLocate\(\{/.test(ed) && /source: 'tool'/.test(ed))
  ok('工具弹窗对失效/多义结果禁用定位并说明', /disabled=\{!canLocate\}/.test(ed) && /locateFailureText\(located\.reason\)/.test(ed))
  ok('诊室同样接入（source: clinic）', /requestProofLocate\(\{/.test(clinic) && /source: 'clinic'/.test(clinic))
  ok('两处入口都用同一定位判据', /locateProofIssue\(text, iss\)/.test(ed) && /locateProofIssue\(bodyText, iss\)/.test(clinic))

  const closeFirst = editor.indexOf('setModal(null)')
  const sendRequest = editor.indexOf('requestProofLocate(target)')
  ok('🔴 弹窗先收起再定位（否则滚动作用在遮住的正文上）',
    closeFirst >= 0 && sendRequest > closeFirst && /if \(!requestProofLocate\(target\)\) showToast/.test(editor))
  ok('正文提供「返回校对结果」入口（结果与会话不丢）', /ProofLocateReturnBar/.test(editor) && /返回校对结果/.test(read('src/components/editor/ProofLocateReturnBar.tsx')))
  ok('返回时把列表滚回那一条并高亮', /scrollIntoView\(\{ block: 'center' \}\)/.test(ed) && /locateHighlight === key/.test(ed))
}

console.log(`\n—— proofLocate 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
