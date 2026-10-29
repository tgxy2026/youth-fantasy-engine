// ============ 3.2.3 · R1：校对结果协议与正文应用 ============
//
// 这一批要钉死的是「模型给的东西能不能进正文」这条链，三处历史病灶：
//   ① 旧提示词允许把「修改建议」写进 fix，界面又拿 fix 直接替换 ⇒ **建议句被当正文写进去**；
//   ② 请求是 json-object、提示词却要顶层数组 ⇒ 协议自相矛盾；
//   ③ 定位失败时无条件 `indexOf` 回退 ⇒ 同一句出现多次时必定改错地方。
// 这里全部按「失败要能看见」写断言：解析不了 ≠ 没有问题，建议类 ≠ 可替换。
import fs from 'node:fs'
import path from 'node:path'
import { parseProofreadReply, isReplaceable, PROOFREAD_PROMPTS } from '../src/lib/aiTasks/proofread'
import { applyProofReplacement, reanchorIssues, countOccurrences, resolveProofLocation, APPLY_FAILURE_TEXT } from '../src/lib/editor/proofApply'
import type { ProofreadIssue } from '../src/lib/aiTasks/proofread'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

// ---------- ① 新协议：对象外壳 ----------
{
  const reply = JSON.stringify({
    schemaVersion: 1,
    issues: [
      { kind: 'replacement', type: '错别字', quote: '他走进走进了房间', replacement: '他走进了房间', why: '多字' },
      { kind: 'suggestion', type: '逻辑', quote: '他忽然决定离开', suggestion: '补一句他改变决定的理由', why: '缺少动机过渡' },
    ],
  })
  const r = parseProofreadReply(reply)
  ok('对象外壳解析出两条', !r.unparsed && r.issues.length === 2, JSON.stringify(r))
  ok('replacement 是可替换类型', r.issues[0].kind === 'replacement' && isReplaceable(r.issues[0]))
  ok('replacement 带上了替换文本', r.issues[0].kind === 'replacement' && r.issues[0].fix === '他走进了房间')
  ok('🔴 suggestion 不可替换（这是"建议句进正文"的闸）', r.issues[1].kind === 'suggestion' && !isReplaceable(r.issues[1]))
  ok('suggestion 的建议文本落在 suggestion 字段', r.issues[1].kind === 'suggestion' && r.issues[1].suggestion.includes('理由'))
  ok('空 issues 是合法的「没问题」', (() => { const e = parseProofreadReply('{"schemaVersion":1,"issues":[]}'); return !e.unparsed && e.issues.length === 0 })())
}

// ---------- ② 旧协议：仍可解析，但一律降级为建议 ----------
{
  const legacy = JSON.stringify([
    { type: '错别字', quote: '他的剑以经出鞘', fix: '他的剑已经出鞘', why: '同音字' },
    { type: '逻辑', quote: '他拔出了剑', 建议: '这里应交代剑从哪来', why: '缺少来源' },
  ])
  const r = parseProofreadReply(legacy)
  ok('旧顶层数组仍能解析（历史结果要能回看）', !r.unparsed && r.issues.length === 2)
  ok('🔴 旧格式没有 kind ⇒ 按建议展示，不靠关键词猜可替换',
    r.issues.every(i => i.kind === 'suggestion' && !isReplaceable(i)), JSON.stringify(r.issues.map(i => i.kind)))
  ok('旧 fix 的值保留为建议文本（信息不丢）', r.issues[0].kind === 'suggestion' && r.issues[0].suggestion === '他的剑已经出鞘')
  ok('「建议」别名也能取到文本', r.issues[1].kind === 'suggestion' && r.issues[1].suggestion.includes('剑从哪来'))
}

// ---------- ③ 非法返回：必须留下痕迹，不能变成"0 问题" ----------
{
  const cases: [string, string, string][] = [
    ['完全不是 JSON', '这次我就不查了，你自己看吧。', 'unparsed'],
    ['错外壳（没有 issues 数组）', '{"schemaVersion":1,"result":"ok"}', 'unparsed'],
    ['空回复', '   ', 'unparsed'],
    ['拒答式 JSON', '{"error":"content policy"}', 'unparsed'],
  ]
  for (const [name, raw, kind] of cases) {
    const r = parseProofreadReply(raw)
    const hit = kind === 'unparsed' ? r.unparsed && r.issues.length === 0 : false
    ok('非法返回标记为解析失败：' + name, hit, JSON.stringify(r))
  }
  const unknown = parseProofreadReply(JSON.stringify({ issues: [{ kind: 'delete', type: '逻辑', quote: '一二三四五六', why: 'x' }] }))
  ok('未知 kind 记入协议问题（不猜、不替换）',
    !unknown.unparsed && unknown.issues.length === 0 && unknown.protocolIssues.some(x => x.includes('delete')),
    JSON.stringify(unknown))
  const noQuote = parseProofreadReply(JSON.stringify({ issues: [{ kind: 'replacement', type: '错别字', quote: '', replacement: 'x' }] }))
  ok('缺引文记入协议问题', noQuote.protocolIssues.length === 1 && noQuote.issues.length === 0)
  const emptyFix = parseProofreadReply(JSON.stringify({ issues: [{ kind: 'replacement', type: '错别字', quote: '一二三四五六', replacement: '   ', why: 'x' }] }))
  ok('🔴 声明可替换却没给文本 ⇒ 降级为建议（不丢问题、也不许替换）',
    emptyFix.issues.length === 1 && emptyFix.issues[0].kind === 'suggestion')
  const same = parseProofreadReply(JSON.stringify({ issues: [{ kind: 'replacement', type: '错别字', quote: '一二三四五六', replacement: '一二三四五六', why: 'x' }] }))
  ok('🔴 替换文本与原文相同 ⇒ 降级为建议（模型复述不算改写）',
    same.issues.length === 1 && same.issues[0].kind === 'suggestion')
}

// ---------- ④ 应用到正文：只改该改的那一处 ----------
{
  const body = '他走进走进了房间。\n她笑了。\n他走进走进了房间。'
  const multi: ProofreadIssue = { kind: 'replacement', type: '错别字', quote: '他走进走进了房间', fix: '他走进了房间', why: '多字' }

  const ambiguous = applyProofReplacement(body, multi)
  ok('🔴 同一句出现多处且无精确位置 ⇒ 拒绝（旧实现会改第一处）',
    !ambiguous.ok && ambiguous.reason === 'ambiguous')

  const precise = applyProofReplacement(body, { ...multi, at: 15 })
  ok('有精确位置且逐字对上 ⇒ 只改那一处',
    precise.ok && precise.next === '他走进走进了房间。\n她笑了。\n他走进了房间。', precise.ok ? precise.next : precise.reason)

  const wholeBody = '他走进了房间。她笑了。'
  const unique = applyProofReplacement(wholeBody, { kind: 'replacement', type: '错别字', quote: '她笑了', fix: '她轻轻笑了', why: 'x' })
  ok('全文唯一命中时允许按引文定位', unique.ok && unique.next === '他走进了房间。她轻轻笑了。')

  const staleAt = applyProofReplacement(wholeBody, { kind: 'replacement', type: '错别字', quote: '她笑了', fix: '她轻轻笑了', why: 'x', at: 3 })
  ok('标注位置对不上时回到唯一性判断（不会因为 at 错就报成功）', staleAt.ok && staleAt.index === 7)

  const missing = applyProofReplacement(wholeBody, { kind: 'replacement', type: '错别字', quote: '他哭了', fix: '他笑了', why: 'x' })
  ok('引文找不到 ⇒ not-found', !missing.ok && missing.reason === 'not-found')

  const suggestion: ProofreadIssue = { kind: 'suggestion', type: '逻辑', quote: '她笑了', suggestion: '补一句动机', why: 'x' }
  const refused = applyProofReplacement(wholeBody, suggestion)
  ok('🔴 建议类在函数层就被拒绝（界面不显示按钮，函数也不给后门）',
    !refused.ok && refused.reason === 'not-replacement')

  const stale: ProofreadIssue = { kind: 'replacement', type: '错别字', quote: '她笑了', fix: '她轻轻笑了', why: 'x', stale: true }
  ok('已失效的结果拒绝替换', !applyProofReplacement(wholeBody, stale).ok)

  ok('空替换 / 同文替换都拒绝',
    !applyProofReplacement(wholeBody, { kind: 'replacement', type: 'x', quote: '她笑了', fix: '  ', why: '' }).ok
    && !applyProofReplacement(wholeBody, { kind: 'replacement', type: 'x', quote: '她笑了', fix: '她笑了', why: '' }).ok)

  ok('每种失败原因都有面向作者的说法', Object.values(APPLY_FAILURE_TEXT).every(t => t.length > 8))
  ok('countOccurrences 数得准', countOccurrences('aaaa', 'aa') === 2 && countOccurrences('abc', 'z') === 0)
  const locateSuggestion = resolveProofLocation('😀她笑了。', suggestion)
  ok('建议可只读定位，UTF-16 下标与文本范围一致', locateSuggestion.ok && locateSuggestion.start === 2 && locateSuggestion.end === 5)
  const overlapLocation = resolveProofLocation('aaa', { kind: 'suggestion', type: 'x', quote: 'aa', suggestion: 'y', why: '' })
  ok('重叠的重复引文也属于多义位置', !overlapLocation.ok && overlapLocation.reason === 'ambiguous')
  const overlapReplacement = applyProofReplacement('aaa', { kind: 'replacement', type: 'x', quote: 'aa', fix: 'b', why: '' })
  ok('重叠重复引文不能误替换第一处', !overlapReplacement.ok && overlapReplacement.reason === 'ambiguous')
  const staleLocation = resolveProofLocation(wholeBody, { ...suggestion, stale: true })
  ok('失效结果不能定位', !staleLocation.ok && staleLocation.reason === 'stale')
}

// ---------- ⑤ 重锚定：平移、保位、相交失效 ----------
{
  const next = '他走进了房间。她笑了。收尾。'
  const replaced: ProofreadIssue = { kind: 'replacement', type: '错别字', quote: '走进走进了房间', fix: '走进了房间', why: 'x', at: 1 }
  const after: ProofreadIssue = { kind: 'suggestion', type: '逻辑', quote: '她笑了', suggestion: 'x', why: 'y', at: 9 }
  const before: ProofreadIssue = { kind: 'suggestion', type: '逻辑', quote: '他', suggestion: 'x', why: 'y', at: 0 }
  const overlap: ProofreadIssue = { kind: 'suggestion', type: '逻辑', quote: '进了房', suggestion: 'x', why: 'y', at: 3 }

  const r = reanchorIssues([replaced, after, before, overlap], { from: 1, removed: 7, inserted: 5, next }, replaced)
  const ids = r.issues.map(i => i.quote)
  ok('被应用的那一条从列表移除', !ids.includes('走进走进了房间'))
  ok('替换点之后的整体平移', r.issues.find(i => i.quote === '她笑了')?.at === 7, JSON.stringify(r.issues))
  ok('替换点之前的位置不动', r.issues.find(i => i.quote === '他')?.at === 0)
  ok('🔴 与替换区间相交的标记失效（不拿旧下标改新正文）',
    r.issues.find(i => i.quote === '进了房')?.stale === true && r.issues.find(i => i.quote === '进了房')?.at === undefined)
  ok('失效条数如实返回', r.invalidated === 1, String(r.invalidated))
  ok('失效结果排序不因 at=undefined 插到最前', r.issues[r.issues.length - 1].quote === '进了房')
}

// ---------- ⑥ 提示词与请求协议一致 ----------
{
  const textSys = PROOFREAD_PROMPTS.find(p => p.meta.id === 'proofread-text')!.read()
  const logicSys = PROOFREAD_PROMPTS.find(p => p.meta.id === 'proofread-logic')!.read()
  const src = read('src/lib/aiTasks/proofread.ts')

  ok('🔴 两条提示词都改成对象外壳（请求侧一直是 json-object，此前协议自相矛盾）',
    /schemaVersion/.test(textSys) && /"issues"/.test(textSys) && /schemaVersion/.test(logicSys) && /"issues"/.test(logicSys))
  ok('🔴 两条提示词都要求写明 kind', /kind/.test(textSys) && /kind/.test(logicSys))
  ok('🔴 逻辑层不再教模型"把建议写进 fix 再替换"',
    !/把你的修改建议写进 fix/.test(logicSys) && !/它同样会被替换/.test(logicSys))
  ok('逻辑层明确建议类不会被替换进正文', /不会拿它替换正文/.test(logicSys))
  ok('请求侧确实是 json-object', /output: 'json-object'/.test(src))
  ok('两层都不再要求"只输出 JSON 数组"', !/只输出 JSON 数组/.test(textSys) && !/只输出 JSON 数组/.test(logicSys))
  ok('提示词里没有 markdown 星号（模型会模仿，正文会混进 **）', !textSys.includes('**') && !logicSys.includes('**'))
}

// ---------- ⑦ 界面：建议类不出现替换入口 ----------
{
  const ed = read('src/components/editor/EditorModals.tsx')
  const clinic = read('src/components/jiewenji/JieWenJiClinic.tsx')
  const model = read('src/components/jiewenji/useJieWenJiModel.ts')

  ok('编辑器用 isReplaceable 判定按钮（不再直接读 iss.fix）',
    /isReplaceable\(iss\)/.test(ed) && !/iss\.fix\.length/.test(ed))
  ok('编辑器替换走统一判据（applyProofReplacement）', /applyProofReplacement\(/.test(ed))
  ok('编辑器把失败原因说给作者听（不再静默 return）',
    /APPLY_FAILURE_TEXT\[out\.reason\]/.test(ed) && !/if \(idx < 0\) return/.test(ed))
  ok('🔴 编辑器「未发现」还要求协议无问题（解析失败不许冒充通过）',
    /st\.unparsedChunks === 0 && st\.protocolIssues\.length === 0/.test(ed) && /未发现错别字/.test(ed))
  ok('诊室同样用 isReplaceable', /isReplaceable\(iss\)/.test(clinic))
  ok('诊室「未发现问题」也守住协议层', /unparsedChunks === 0 && st\.protocolIssues\.length === 0/.test(clinic))
  ok('颉文姬替换走同一判据并给出原因', /applyProofReplacement\(content, iss\)/.test(model) && /APPLY_FAILURE_TEXT\[out\.reason\]/.test(model))
  ok('🔴 两处都不再"定位失败就回退 indexOf 改第一处"',
    !/else idx = .*indexOf\(iss\.quote\)/.test(ed) && !/indexOf\(iss\.quote\)/.test(model))
}

console.log(`\n—— proofreadProtocol 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
