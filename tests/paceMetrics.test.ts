// ============ 3.7.0 · W5 逐章节奏指标 ============
//
// 盯四件事（规划 §3 W5.3）：
//   ① 已知样本各指标值正确；空章 / 无爽点书不崩；
//   ② 抽稀到 ≤500 点且首尾必留；
//   ③ 立场：模块源码与观察文案不含判定类用词（禁词闸，沿 platformCheck 模式）；
//   ④ 观察句是可由数据核对的事实陈述。
import fs from 'node:fs'
import { computePaceSeries, samplePoints, type PaceChapterInput, type PaceHookInput } from '../src/lib/outline/paceMetrics'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const chapters: PaceChapterInput[] = [
  { id: 'c1', no: 1, title: '第1章', content: '第一段正文。\n\n「你来了。」他说。\n\n第二段正文继续写。' },
  { id: 'c2', no: 2, title: '第2章', content: '' },
  { id: 'c3', no: 3, title: '第3章', content: '只有一段。' },
]
const hooks: PaceHookInput[] = [
  { chapterNo: 1, strength: '大' },
  { chapterNo: 3, strength: '小' },
]

// ---------- ① 已知样本 ----------
{
  const s = computePaceSeries(chapters, hooks)
  ok('逐章一条点、按章号升序', s.points.map(p => p.chapterNo).join(',') === '1,2,3')
  ok('章 1 登记 1 条爽点、权重 = 大(3)', s.points[0].hooks === 1 && s.points[0].hookWeight === 3)
  ok('章 2 没有爽点、距上一个隔 1 章', s.points[1].hooks === 0 && s.points[1].hookGap === 1)
  ok('章 3 有爽点 ⇒ 间隔 0', s.points[2].hookGap === 0)
  ok('空章字数 0、占比 0、不崩', s.points[1].words === 0 && s.points[1].dialogueRatio === 0 && s.points[1].avgParagraph === 0)
  ok('章 1 对话占比 > 0（本地统计）', s.points[0].dialogueRatio > 0 && s.points[0].dialogueRatio <= 1, String(s.points[0].dialogueRatio))
  ok('章 1 平均段长 = 字数 / 段数（> 0）', s.points[0].avgParagraph > 0, String(s.points[0].avgParagraph))
  ok('段长离散度是非负数', s.points[0].paragraphCv >= 0)
  ok('空章被观察句如实列出', s.observations.some(o => o.includes('有 1 章还没有正文')), JSON.stringify(s.observations))
}

// ---------- ② 无爽点书 / 不占号章 ----------
{
  const none = computePaceSeries([{ id: 'x', no: 3, title: '第3章', content: '正文' }], [])
  ok('没有登记爽点 ⇒ 间隔为 null（不猜成 0）', none.points[0].hookGap === null)
  ok('无爽点书的最长空缺 = 全部章', none.longestHookGap?.length === 1)
  const empty = computePaceSeries([], [])
  ok('空书不崩：无点、无空缺、有观察句', empty.points.length === 0 && empty.longestHookGap === null && empty.observations.length > 0)
  const skipped = computePaceSeries([
    { id: 'a', no: 0, title: '序章', content: '序' },
    { id: 'b', no: 1, title: '第1章', content: '正文' },
  ], [])
  ok('不占号章（no=0）不进入曲线', skipped.points.map(p => p.chapterNo).join(',') === '1')
  const unknownStrength = computePaceSeries([{ id: 'c', no: 1, title: '第1章', content: '正文' }], [{ chapterNo: 1, strength: '巨型' }])
  ok('未知强度档按最小档计权（不猜成更高档）', unknownStrength.points[0].hookWeight === 1)
}

// ---------- ③ 抽稀 ----------
{
  const many = Array.from({ length: 1000 }, (_, i) => ({ chapterNo: i + 1, title: `第${i + 1}章`, words: 100, dialogueRatio: 0, avgParagraph: 10, paragraphCv: 0, hooks: 0, hookWeight: 0, hookGap: null }))
  const sampled = samplePoints(many)
  ok('千章抽稀到 ≤500 点', sampled.length <= 500, String(sampled.length))
  ok('首点与尾点必留', sampled[0].chapterNo === 1 && sampled[sampled.length - 1].chapterNo === 1000)
  ok('不足 500 点原样返回', samplePoints(many.slice(0, 12), 500).length === 12)
}

// ---------- ④ 立场闸（禁词） ----------
{
  const src = fs.readFileSync('src/lib/outline/paceMetrics.ts', 'utf8')
  const banned = '评分|评级|排名|合格|不合格'
  ok('模块源码不含判定类用词', !new RegExp(banned).test(src), (src.match(new RegExp(banned, 'g')) ?? []).join(','))
  const s = computePaceSeries(chapters, hooks)
  ok('观察文案不含判定类用词', !s.observations.some(o => new RegExp(banned).test(o)), JSON.stringify(s.observations))
  ok('观察句是事实陈述（带章号区间）', s.observations.every(o => /第\s*\d/.test(o)), JSON.stringify(s.observations))
}

console.log(`\n———— 结果：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)