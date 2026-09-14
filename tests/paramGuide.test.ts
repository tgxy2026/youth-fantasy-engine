// ============ 控制面板 · 数值项取值表（paramGuide）============
//
// 这份表是「说明」与「输入框范围」的**唯一真源**——所以它一旦自相矛盾，用户看到的解释就是错的，
// 而**说明写错比没写更坏**。这组断言锁三件事：
//   ① 分段首尾相接、无空隙无重叠、完整覆盖 [min,max]（否则会有取值落在"没有说明"的缝里）；
//   ② 每段都有档名与影响说明，且**恰好一个**推荐段；
//   ③ 推荐段真的装着内置默认值（改了默认值却忘了改推荐段，说明就在说谎）。
import { __resetMockStores } from './mock-memory'
import {
  PARAM_GUIDES, GUIDE_SAMPLING, bandOf,
  type ParamGuide,
} from '../src/lib/tavern/paramGuide'
import { DEFAULT_TAVERN_SETTINGS } from '../src/lib/tavern/settings'
import { TAVERN_DEFAULTS } from '../src/lib/tavern/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const ALL: [string, ParamGuide][] = [
  ...Object.entries(PARAM_GUIDES) as [string, ParamGuide][],
  ...Object.entries(GUIDE_SAMPLING).map(([k, v]) => [`sampling.${k}`, v] as [string, ParamGuide]),
]

async function main() {
  __resetMockStores()

  // ---------- 1) 分段完整性 ----------
  {
    for (const [key, g] of ALL) {
      const bs = g.bands
      const problems: string[] = []

      if (bs.length < 3) problems.push(`段数只有 ${bs.length}（分段说明至少要有"低/中/高"三档）`)
      if (bs[0]?.from !== g.min) problems.push(`首段 from=${bs[0]?.from} ≠ min=${g.min}`)
      if (bs[bs.length - 1]?.to !== g.max) problems.push(`末段 to=${bs[bs.length - 1]?.to} ≠ max=${g.max}`)

      for (let i = 0; i < bs.length; i++) {
        const b = bs[i]
        if (!(b.from <= b.to)) problems.push(`第 ${i + 1} 段区间倒置（${b.from} > ${b.to}）`)
        if (!b.name.trim()) problems.push(`第 ${i + 1} 段缺档名`)
        if (b.effect.trim().length < 12) problems.push(`第 ${i + 1} 段的影响说明太短（说清因果至少十几个字）`)
        if (i > 0) {
          const prev = bs[i - 1]
          if (b.from <= prev.from) problems.push(`第 ${i + 1} 段没有升序（from ${b.from} <= 上一段 ${prev.from}）`)
          // 允许"一个 step 的缝"：整数参数（step=1）的段与段之间天然是 0|1 而不是 0|0
          if (b.from > prev.to + g.step) {
            problems.push(`第 ${i}~${i + 1} 段之间有缝：${prev.to} → ${b.from}（宽于一个 step=${g.step}）`)
          }
          if (b.from < prev.to) problems.push(`第 ${i}~${i + 1} 段重叠：${prev.to} vs ${b.from}`)
        }
      }

      const rec = bs.filter(b => b.recommended)
      if (rec.length !== 1) problems.push(`推荐段有 ${rec.length} 个（应当恰好 1 个）`)

      ok(`${key}：分段自洽（覆盖 ${g.min}~${g.max}，无空隙/重叠，恰好一个推荐段）`,
        problems.length === 0, problems.join('；'))
    }
  }

  // ---------- 2) bandOf 的边界口径 ----------
  {
    const t = GUIDE_SAMPLING.temperature
    ok('bandOf：最小值 → 第一段', bandOf(t, 0).name === '死板', bandOf(t, 0).name)
    ok('bandOf：边界值归**下面那一段**（0.7 是「保守」的上界 → 高亮「保守」）',
      bandOf(t, 0.7).name === '保守', bandOf(t, 0.7).name)
    ok('bandOf：另一侧边界同样归下段（1.1 是「平衡」的上界 → 高亮「平衡」）',
      bandOf(t, 1.1).name === '平衡', bandOf(t, 1.1).name)
    ok('bandOf：段内中间值', bandOf(t, 0.9).name === '平衡', bandOf(t, 0.9).name)
    ok('bandOf：最大值 → 末段', bandOf(t, 2).name === '放飞', bandOf(t, 2).name)
    ok('bandOf：越界（低于 min）不崩、退回第一段', bandOf(t, -5).name === '死板', bandOf(t, -5).name)
    ok('bandOf：越界（高于 max）不崩、退回末段', bandOf(t, 99).name === '放飞', bandOf(t, 99).name)

    const k = GUIDE_SAMPLING.topK
    ok('bandOf：单点段（topK=0 的「关闭」）只在正好等于 0 时命中',
      bandOf(k, 0).name === '关闭' && bandOf(k, 1).name === '极窄',
      `${bandOf(k, 0).name} / ${bandOf(k, 1).name}`)
  }

  // ---------- 3) 推荐段必须真装着内置默认值 ----------
  // 这组是本文件最有价值的一条：默认值变了却没同步推荐段，界面上的"推荐"就是假的。
  {
    const d = DEFAULT_TAVERN_SETTINGS
    const cases: [string, ParamGuide, number][] = [
      ['上下文预算', PARAM_GUIDES.contextBudget, d.common.contextBudget],
      ['固定开销预留', PARAM_GUIDES.fixedOverheadChars, d.common.fixedOverheadChars],
      ['请求超时', PARAM_GUIDES.timeoutSec, d.common.timeoutSec],
      ['上下文窗口长度', PARAM_GUIDES.numCtx, d.common.numCtx],
      ['设定层占比（面板是百分数）', PARAM_GUIDES.plotSettingRatio, Math.round(d.plot.settingRatio * 100)],
      ['触发整理', PARAM_GUIDES.triggerMessages, d.free.triggerMessages],
      ['记忆软上限', PARAM_GUIDES.softLimit, d.free.softLimit],
      ['记忆硬上限', PARAM_GUIDES.hardLimit, d.free.hardLimit],
      ['长期摘要上限', PARAM_GUIDES.longTermLimit, d.free.longTermLimit],
      ['日记保留', PARAM_GUIDES.diaryKeep, d.free.diaryDays],
      ['自动整理最小间隔', PARAM_GUIDES.summaryInterval, d.free.summaryMinIntervalMin],
      ['整理锁有效期', PARAM_GUIDES.summaryLock, d.free.summaryLockTtlMin],
      ['推进间隔', PARAM_GUIDES.dailyAdvance, d.free.dailyAdvanceHours],
      ['生活记录保留', PARAM_GUIDES.dailyKeep, d.free.dailyLogKeep],
      ['温度（剧情）', GUIDE_SAMPLING.temperature, TAVERN_DEFAULTS.plot.temperature],
      ['温度（自由）', GUIDE_SAMPLING.temperature, TAVERN_DEFAULTS.free.temperature],
      ['核采样（两种模式）', GUIDE_SAMPLING.topP, TAVERN_DEFAULTS.free.topP],
      ['候选词上限', GUIDE_SAMPLING.topK, TAVERN_DEFAULTS.free.topK],
      ['重复惩罚', GUIDE_SAMPLING.repeatPenalty, TAVERN_DEFAULTS.free.repeatPenalty],
      ['新话题倾向（剧情）', GUIDE_SAMPLING.presencePenalty, TAVERN_DEFAULTS.plot.presencePenalty],
      ['新话题倾向（自由）', GUIDE_SAMPLING.presencePenalty, TAVERN_DEFAULTS.free.presencePenalty],
    ]
    for (const [label, g, v] of cases) {
      const b = bandOf(g, v)
      ok(`${label}：默认 ${v} 落在推荐段「${(g.bands.find(x => x.recommended) ?? b).name}」`,
        !!b.recommended, `实际落在「${b.name}」`)
    }
  }

  // ---------- 4) 采样五项在两个模式下共用一份（避免写两份互相漂移的表） ----------
  {
    const keys = Object.keys(GUIDE_SAMPLING)
    ok('采样参数表恰好 5 项（温度/核采样/候选词上限/重复惩罚/新话题倾向）',
      keys.length === 5, keys.join(','))
    ok('采样参数都有单位留空（它们是无单位的比值）',
      Object.values(GUIDE_SAMPLING).every(g => g.unit === undefined))
  }

  console.log(`\nparamGuide: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
