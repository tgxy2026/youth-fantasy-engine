// 3.0 · W2-1a 未来影响分析 · 单测
//
// 盯三件事：
//   ① 判据是**严格大于**（变化章自身不是未来计划）；
//   ② 合并口径（同章号以新标记为准）与上限；
//   ③ 🔴 **源码闸** —— 改写链路必须接线、且只在 `rewritten` 时打标（`generated` 不误伤）。
import fs from 'node:fs'
import { planImpact, mergeMarks, type ImpactMark } from '../src/lib/outline/futureImpact'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n—— futureImpact 用例开始 ——')

// ---------- ① planImpact：严格大于 + 去重 + 排序 ----------
{
  const at = 1000
  const r = planImpact(5, [3, 6, 7, 7, 9], '正文改写', at)
  ok('只取章号 > 变化章（5）', r.map(m => m.chapterNo).join(',') === '6,7,9')
  ok('去重（7 只出现一次）', r.filter(m => m.chapterNo === 7).length === 1)
  ok('按章号升序', r.every((m, i) => i === 0 || m.chapterNo > r[i - 1].chapterNo))
  ok('携带 fromChapterNo / reason / at', r[0].fromChapterNo === 5 && r[0].reason === '正文改写' && r[0].at === at)

  ok('等于变化章的**不**算未来计划（严格大于）', planImpact(5, [5], 'x', at).length === 0)
  ok('全部小于 → 空', planImpact(10, [1, 2, 3], 'x', at).length === 0)
  ok('非法 fromNo（0 / 负 / NaN）→ 空', planImpact(0, [1], 'x', at).length === 0
    && planImpact(-2, [1], 'x', at).length === 0 && planImpact(NaN, [1], 'x', at).length === 0)
  ok('未来列表含脏值不炸（NaN / 0 / 负 被滤掉）',
    planImpact(1, [NaN, 0, -3, 2, 4], 'x', at).map(m => m.chapterNo).join(',') === '2,4')
}

// ---------- ② mergeMarks：同章号新覆盖旧 ----------
{
  const old: ImpactMark[] = [
    { chapterNo: 6, fromChapterNo: 3, reason: '旧', at: 1 },
    { chapterNo: 8, fromChapterNo: 3, reason: '旧', at: 1 },
  ]
  const news: ImpactMark[] = [
    { chapterNo: 6, fromChapterNo: 5, reason: '新', at: 2 },
    { chapterNo: 9, fromChapterNo: 5, reason: '新', at: 2 },
  ]
  const m = mergeMarks(old, news)
  ok('并集（6/8/9）', m.map(x => x.chapterNo).join(',') === '6,8,9')
  ok('同章号以新标记为准', m.find(x => x.chapterNo === 6)!.reason === '新'
    && m.find(x => x.chapterNo === 6)!.fromChapterNo === 5)
  ok('结果升序', m.every((x, i) => i === 0 || x.chapterNo > m[i - 1].chapterNo))
  ok('空 + 空 = 空', mergeMarks([], []).length === 0)
  ok('脏旧数据（chapterNo 非法）被丢弃', mergeMarks(
    [{ chapterNo: 0, fromChapterNo: 1, reason: 'x', at: 1 }] as ImpactMark[], news,
  ).every(x => x.chapterNo > 0))
}

// ---------- ③ 🔴 源码闸：改写链路接线 ----------
{
  const src = fs.readFileSync('src/lib/editor/chapterRewrite.ts', 'utf8')
  ok('applyChapterRewrite 接了 analyzeFutureImpact',
    src.includes('analyzeFutureImpact(seq,'))
  ok('🔴 只在 rewritten 时打标（generated 是推进、不误伤）',
    /kind === 'rewritten'.*analyzeFutureImpact/.test(src.replace(/\n/g, ' ')))
  ok('打标失败静默（.catch(() => {})）',
    src.includes("analyzeFutureImpact(seq, '正文改写').catch(() => {})"))
  ok('只在序号可用时打标（seq > 0）', src.includes('seq > 0'))

  // 未来影响模块自身的红线：只标记不改章纲（不 import schema 写入 API 的写函数）
  const fi = fs.readFileSync('src/lib/outline/futureImpact.ts', 'utf8')
  ok('🔴 不写章纲内容（无 saveCardRecord / saveTableRow）',
    !fi.includes('saveCardRecord') && !fi.includes('saveTableRow'))
  ok('走 settingsKV（getSetting/setSetting），自带项目前缀',
    fi.includes('getSetting') && fi.includes('setSetting') && fi.includes("'futureImpact'"))
}

console.log(`\n———— 结果：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
