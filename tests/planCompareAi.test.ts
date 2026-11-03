// 3.2.1 · T-09 细纲与正文对照（AI 语义判定）· 单测
//
// 盯五件事（错一条这份报告就在伪造证据）：
//   ① **引文必须逐字落在正文里**：找不到就丢，并计入 unlocated；
//   ② 声称"已体现/部分体现/不同"却没有一条可定位引文 ⇒ 强制降级为「证据不足」；
//   ③ 计划原文以调用方传的为准，**不信模型回抄**；
//   ④ 模型漏掉的计划项补「证据不足」，不许静默消失（也不能算"未体现"）；
//   ⑤ 字段不在本次计划里的、状态不认识的，一律丢弃并计数。
import './mock-memory'
import { reviewPlanCompare, MAX_PLAN_COMPARE_ITEMS, type PlanItemInput } from '@/lib/aiTasks/planCompareAi'

let pass = 0, fail = 0
function ok(name: string, cond: unknown, extra = '') {
  if (cond) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, '::', extra) }
}

const body = '第一章开头。\n他跪在雪里，腕上金纹发烫。\n他站了起来，向北走去。'
const P = (id: string, quote: string): PlanItemInput => ({ planFieldId: id, planQuote: quote, templateVersion: 'v1' })
const rows = (arr: unknown[]) => JSON.stringify(arr)

function main() {
  // ---------- ① 正常：引文命中 ----------
  {
    const r = reviewPlanCompare(rows([
      { planFieldId: 'p1', status: 'completed', bodyQuotes: ['他跪在雪里，腕上金纹发烫。'], reason: '写到觉醒' },
    ]), [P('p1', '主角受辱后觉醒')], body)
    const it = r.items[0]
    ok('① 引文命中 ⇒ 保留并带段号', it.status === 'completed' && it.bodyQuotes.length === 1 && it.paragraphIndices.includes(1),
      JSON.stringify({ s: it.status, q: it.bodyQuotes, p: it.paragraphIndices }))
    ok('① 没有伪引文', r.unlocated === 0 && r.dropped === 0)
  }

  // ---------- ② 伪造引文 ⇒ 降级 ----------
  {
    const r = reviewPlanCompare(rows([
      { planFieldId: 'p1', status: 'completed', bodyQuotes: ['他仰天长啸，天地变色。'], reason: '很有气势' },
    ]), [P('p1', '主角受辱后觉醒')], body)
    const it = r.items[0]
    ok('② 正文里没有的引文被丢弃', it.bodyQuotes.length === 0, JSON.stringify(it.bodyQuotes))
    ok('② 计一次 unlocated', r.unlocated === 1, String(r.unlocated))
    ok('② 无证据不许称"已体现" ⇒ 降级 insufficient', it.status === 'insufficient', it.status)
    ok('② 降级理由写清"给不出原句"', /给不出能逐字落在正文里的原句/.test(it.reason), it.reason)
  }

  // ---------- ③ 部分命中 ----------
  {
    const r = reviewPlanCompare(rows([
      { planFieldId: 'p1', status: 'partial', bodyQuotes: ['他跪在雪里，腕上金纹发烫。', '编出来的下一句。'], reason: '只写了一半' },
    ]), [P('p1', '主角受辱后觉醒')], body)
    const it = r.items[0]
    ok('③ 只保留命中的那句', it.bodyQuotes.length === 1 && it.bodyQuotes[0] === '他跪在雪里，腕上金纹发烫。')
    ok('③ 有证据 ⇒ 保持 partial', it.status === 'partial', it.status)
    ok('③ 未命中的计入 unlocated', r.unlocated === 1)
  }

  // ---------- ④ 计划原文以调用方为准 ----------
  {
    const r = reviewPlanCompare(rows([
      { planFieldId: 'p1', status: 'completed', planQuote: '模型自己改过的计划原文', bodyQuotes: ['他跪在雪里，腕上金纹发烫。'], reason: 'x' },
    ]), [P('p1', '主角受辱后觉醒（作者原文）')], body)
    ok('④ 报告里的计划原文用调用方的，不用模型回抄', r.items[0].planQuote === '主角受辱后觉醒（作者原文）', r.items[0].planQuote)
    ok('④ 模板版本也用调用方的', r.items[0].templateVersion === 'v1')
  }

  // ---------- ⑤ 字段非法 / 状态非法 ----------
  {
    const r = reviewPlanCompare(rows([
      { planFieldId: 'ghost', status: 'completed', bodyQuotes: [], reason: 'x' },
      { planFieldId: 'p1', status: '已体现', bodyQuotes: [], reason: 'x' },
      { planFieldId: 'p1', status: 'not-found', bodyQuotes: [], reason: '没写' },
    ]), [P('p1', '计划')], body)
    ok('⑤ 不在计划里的字段被丢弃并记名', r.dropped === 2 && r.unknownFields.includes('ghost'), JSON.stringify({ d: r.dropped, u: r.unknownFields }))
    ok('⑤ 中文状态不被认（按非法丢弃）', r.items[0].status === 'not-found', r.items[0].status)
    ok('⑤ not-found 不需要引文', r.items[0].bodyQuotes.length === 0 && r.items[0].status === 'not-found')
  }

  // ---------- ⑥ 模型漏项 ⇒ 补"证据不足" ----------
  {
    const r = reviewPlanCompare(rows([
      { planFieldId: 'p1', status: 'not-found', bodyQuotes: [], reason: '没写' },
    ]), [P('p1', '计划一'), P('p2', '计划二')], body)
    const miss = r.items.find(x => x.planFieldId === 'p2')
    ok('⑥ 漏掉的计划项仍有结果（不消失）', !!miss && r.items.length === 2)
    ok('⑥ 补的是「证据不足」，不是「未体现」', miss?.status === 'insufficient', miss?.status)
    ok('⑥ 理由说明是"没给判定"', /没有给出这一项的计划对照判定/.test(miss?.reason ?? ''), miss?.reason)
  }

  // ---------- ⑦ 顺序跟随计划 / 上限 ----------
  {
    const many = Array.from({ length: MAX_PLAN_COMPARE_ITEMS + 3 }, (_, i) => P('p' + i, '计划' + i))
    const r = reviewPlanCompare(rows(many.map(p => ({ planFieldId: p.planFieldId, status: 'not-found', bodyQuotes: [], reason: '-' }))), many, body)
    ok('⑦ 超过上限被截断', r.items.length === MAX_PLAN_COMPARE_ITEMS && r.truncated === true, `${r.items.length}/${MAX_PLAN_COMPARE_ITEMS}`)
    ok('⑦ 顺序按调用方传入（p0 在最前）', r.items[0].planFieldId === 'p0', r.items[0].planFieldId)
  }

  // ---------- ⑧ 垃圾输入不抛 ----------
  {
    const r = reviewPlanCompare('这不是 JSON', [P('p1', '计划一')], body)
    ok('⑧ 解析不了也不抛，计划项仍补成证据不足', r.items.length === 1 && r.items[0].status === 'insufficient')
  }

  // ---------- ⑨ 汇总口径 ----------
  {
    const r = reviewPlanCompare(rows([
      { planFieldId: 'p1', status: 'completed', bodyQuotes: ['他站了起来，向北走去。'], reason: 'x' },
      { planFieldId: 'p2', status: 'not-found', bodyQuotes: [], reason: 'x' },
    ]), [P('p1', '一'), P('p2', '二')], body)
    ok('⑨ 汇总各项计数正确', r.summary.total === 2 && r.summary.completed === 1 && r.summary.notFound === 1,
      JSON.stringify(r.summary))
  }

  console.log(`\n———— planCompareAi：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

void main()
