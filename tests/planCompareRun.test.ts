// 3.2.1 · T-09 细纲对照编排层 · 单测
//
// 盯三件事：
//   ① 计划项**只取作者填过的**，且跳过登记/衔接类字段（否则报告里全是噪音"未体现"）；
//   ② 只有「未找到体现 / 与计划不同」进问题清单；「部分体现 / 证据不足 / 已体现」不进（不自动生成执行指令）；
//   ③ 结果文案如实：没填细纲、失败、有伪引文都要说清。
import './mock-memory'
import { collectPlanItems, planFindingsFromReview, describePlanCompareRun } from '@/lib/app/planCompareRun'
import type { PlanCompareReview } from '@/lib/aiTasks/planCompareAi'
import type { PlanCompareResult } from '@/lib/aiTasks/planCompare'
import { MAX_PLAN_COMPARE_ITEMS } from '@/lib/aiTasks/planCompareAi'

let pass = 0, fail = 0
function ok(name: string, cond: unknown, extra = '') {
  if (cond) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, '::', extra) }
}

const item = (over: Partial<PlanCompareResult> = {}): PlanCompareResult => ({
  planFieldId: 'k', templateVersion: 'chapter-outline', planQuote: '计划原文', status: 'completed',
  bodyQuotes: [], reason: '理由', paragraphIndices: [], ...over,
})
const review = (items: PlanCompareResult[], unlocated = 0): PlanCompareReview => ({
  items,
  summary: {
    total: items.length,
    completed: items.filter(i => i.status === 'completed').length,
    partial: items.filter(i => i.status === 'partial').length,
    notFound: items.filter(i => i.status === 'not-found').length,
    different: items.filter(i => i.status === 'different').length,
    insufficient: items.filter(i => i.status === 'insufficient').length,
    extraChanges: [],
  },
  unlocated, dropped: 0, unknownFields: [], truncated: false,
})

function main() {
  // ---------- ① 计划项筛选 ----------
  {
    const items = collectPlanItems({ data: {
      '一、本章定位::本章一句话事件': '测灵大典判定废脉',
      '一、本章定位::出场人物': '陈渊、陈瑶',
      '四、衔接与登记::伏笔操作': '埋 F0001',
      '二、场景细纲::场景1': '演武场：测灵珠不亮',
      '二、场景细纲::场景2': '   ',
      '二、场景细纲::场景3': '深夜：胎记发烫',
    } })
    ok('① 只留有内容的计划字段（空值跳过）', items.length === 3, JSON.stringify(items.map(i => i.planFieldId)))
    ok('① 跳过「出场人物」这类登记字段', !items.some(i => i.planFieldId.includes('出场人物')))
    ok('① 跳过「伏笔操作」这类衔接字段', !items.some(i => i.planFieldId.includes('伏笔操作')))
    ok('① 计划原文去掉首尾空白', items.every(i => i.planQuote === i.planQuote.trim()))
    ok('① 空卡 ⇒ 空数组', collectPlanItems(null).length === 0 && collectPlanItems({ data: {} }).length === 0)
    const many = collectPlanItems({ data: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`场景${i}`, '内容' + i])) })
    ok(`① 最多 ${MAX_PLAN_COMPARE_ITEMS} 条`, many.length === MAX_PLAN_COMPARE_ITEMS, String(many.length))
  }

  // ---------- ② 哪些进问题清单 ----------
  {
    const f = planFindingsFromReview(review([
      item({ planFieldId: 'a', status: 'not-found', planQuote: '计划A' }),
      item({ planFieldId: 'b', status: 'different', planQuote: '计划B' }),
      item({ planFieldId: 'c', status: 'partial', planQuote: '计划C' }),
      item({ planFieldId: 'd', status: 'insufficient', planQuote: '计划D' }),
      item({ planFieldId: 'e', status: 'completed', planQuote: '计划E', bodyQuotes: ['原句'] }),
    ]))
    ok('② 只有未体现/不同进清单', f.length === 2, JSON.stringify(f.map(x => x.title)))
    ok('② 都归「中等」（isWorthPersisting 才收）', f.every(x => x.level === '中等'), JSON.stringify(f.map(x => x.level)))
    ok('② 标题带计划摘要', f.some(x => String(x.title).includes('计划未体现')) && f.some(x => String(x.title).includes('与计划不同')))
    ok('② 部分体现 / 证据不足 / 已体现都不进', !f.some(x => String(x.title).includes('计划C') || String(x.title).includes('计划D') || String(x.title).includes('计划E')))
    const withWhere = planFindingsFromReview(review([item({ status: 'not-found', paragraphIndices: [2, 4] })]))
    ok('② 有段号时写进 where（1 基）', String(withWhere[0].where) === '第 3、5 段', String(withWhere[0].where))
  }

  // ---------- ③ 结果文案 ----------
  {
    ok('③ 没填细纲说得具体', /还没填计划项/.test(describePlanCompareRun({ state: 'empty', saved: 0 })))
    ok('③ 解析失败不装作成功', /没有返回可解析的结果/.test(describePlanCompareRun({ state: 'invalid', saved: 0 })))
    ok('③ 调用失败带原因', /对照失败：超时/.test(describePlanCompareRun({ state: 'failed', saved: 0, error: '超时' })))
    const clean = describePlanCompareRun({ state: 'completed', saved: 0, review: review([
      item({ status: 'completed', bodyQuotes: ['原句'] }),
    ]) })
    ok('③ 全部已体现时说"没有需要处置的偏离"', /没有需要处置的偏离/.test(clean), clean)
    const dirty = describePlanCompareRun({ state: 'completed', saved: 1, review: review([
      item({ status: 'not-found' }), item({ status: 'different' }), item({ status: 'completed' }),
    ], 2) })
    ok('③ 有偏离时给数量并说明已留档', /1 条未体现 \/ 1 条与计划不同/.test(dirty) && /已留档/.test(dirty), dirty)
    ok('③ 伪引文要如实说被丢弃', /2 句引文在正文里找不到/.test(dirty), dirty)
  }

  console.log(`\n———— planCompareRun：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

void main()
