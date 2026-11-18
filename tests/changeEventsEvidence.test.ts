// ============ 变化依据（证据层）契约（3.6.1 · B4）============
//
// 3.6.0 时 `revision/changeEvents` 是 `gap`。3.6.1 的定案：**只接证据层，不接处置状态机**。
// 依据 = 变化处的「改前 → 改后」那一小段（各 ≤300 字），随 `futureImpact` 的标记一起存。
//
// 这里钉四件事：
//   ① 只取**真正变了的那一段**（剥公共前后缀）—— 整章改写时开头往往没变，给开头等于没给；
//   ② 一律 ≤300 字并标注已截断（依据是提示，不是正文副本）；
//   ③ 标记带证据；旧标记（3.6.1 之前打的）没有证据 → 界面必须能如实说"没留下引用"；
//   ④ 同一章再次变化时，新证据覆盖旧的（作者关注最近一次）。
import { buildChangeEvidence, changedSpan, MAX_QUOTE_LENGTH } from '../src/lib/revision/changeEvents'
import { mergeMarks, planImpact, type ImpactMark } from '../src/lib/outline/futureImpact'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

function main() {
  // ① 只取变化段
  {
    const span = changedSpan('少年负剑出山门，一路向北。', '少年负剑出山门，一路向南。')
    ok('剥离公共前缀，只留变化处', span.beforeSpan === '北' && span.afterSpan === '南', JSON.stringify(span))
    const insert = changedSpan('abc', 'abXYc')
    ok('纯插入：改前为空', insert.beforeSpan === '' && insert.afterSpan === 'XY', JSON.stringify(insert))
    const remove = changedSpan('abXYc', 'abc')
    ok('纯删除：改后为空', remove.beforeSpan === 'XY' && remove.afterSpan === '', JSON.stringify(remove))
    const same = changedSpan('一模一样', '一模一样')
    ok('完全相同时两侧都为空（不凭空造依据）', same.beforeSpan === '' && same.afterSpan === '', JSON.stringify(same))
    const empty = changedSpan('', '')
    ok('空文本不崩', empty.beforeSpan === '' && empty.afterSpan === '')
  }

  // ② 300 字上限
  {
    // 整段都被替换（没有公共前后缀）才是真正会超长的情况
    const span = changedSpan('甲'.repeat(1000), '乙'.repeat(1000))
    ok('超长变化段被截断到 300 字以内', span.afterSpan.length < 340, String(span.afterSpan.length))
    ok('截断时标注已截断与原长度', span.afterSpan.includes('已截断'), span.afterSpan.slice(-30))
    ok('上限常量就是 300（与方案一致）', MAX_QUOTE_LENGTH === 300, String(MAX_QUOTE_LENGTH))
    const evidence = buildChangeEvidence({ type: 'body-change', sourceRef: 'chapter:c1', before: '旧正文', after: '新正文', reason: '正文改写' })
    ok('依据里存的是片段而不是全文', evidence.afterSummary.length <= MAX_QUOTE_LENGTH + 40, String(evidence.afterSummary.length))
    ok('依据带事件 id 与来源定位', !!evidence.eventId && evidence.sourceRef === 'chapter:c1', JSON.stringify(evidence))
  }

  // ③ 标记携带证据 / 旧标记兼容
  {
    const evidence = buildChangeEvidence({ type: 'body-change', sourceRef: 'chapter:c1', before: '旧', after: '新', reason: '正文改写' })
    const marks = planImpact(3, [5, 4], '正文改写', 1000, evidence)
    ok('只为「变化章之后」的章打标', marks.map(m => m.chapterNo).join(',') === '4,5', marks.map(m => m.chapterNo).join(','))
    ok('每条标记都带上同一份依据', marks.every(m => m.evidence?.eventId === evidence.eventId))
    const withoutEvidence = planImpact(3, [4], '正文改写', 1000)
    ok('不传依据时不造假字段（界面据此如实提示）', withoutEvidence[0]?.evidence === undefined)
    const legacy: ImpactMark[] = [{ chapterNo: 4, fromChapterNo: 2, reason: '正文改写', at: 1 }]
    ok('旧标记（无依据）能正常读入', legacy[0].evidence === undefined)
  }

  // ④ 同章再变：新证据覆盖旧的
  {
    const older = buildChangeEvidence({ type: 'body-change', sourceRef: 'chapter:c1', before: '一', after: '二', reason: '正文改写' })
    const newer = buildChangeEvidence({ type: 'body-change', sourceRef: 'chapter:c1', before: '二', after: '三', reason: '正文改写' })
    const oldMarks = planImpact(3, [4], '正文改写', 1000, older)
    const newMarks = planImpact(3, [4], '正文改写', 2000, newer)
    const merged = mergeMarks(oldMarks, newMarks)
    ok('同一章只留一条', merged.length === 1, String(merged.length))
    ok('保留最近一次的依据', merged[0].evidence?.afterSummary === newer.afterSummary, JSON.stringify(merged[0].evidence))
    ok('按章号排序', mergeMarks(planImpact(1, [9, 3], 'x', 1), []).map(m => m.chapterNo).join(',') === '3,9')
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} changeEventsEvidence ${pass}/${pass + fail}`)
  if (fail) process.exitCode = 1
}

main()
