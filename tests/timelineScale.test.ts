// ============ 等比时间轴的「空档封顶」算法（2026-10-02 · 2.7.2）============
//
// 纯等比轴遇到超长空档（主线密集在 1 年、中间夹一段「三千年前」的传说）会把整条轴撑爆，
// 密集段挤成一坨 —— 这就是当初不做等比的原因。解法是 **axis break**：密集段保持等比、
// 超长空档压缩并在轴上标出真实跨度。`cappedPositions` 是这套逻辑的唯一真源，算法错了
// 会**静默画歪**，故钉住三条最要紧的保证：
//   ① 单调：x 严格递增（否则卡片/圆点会叠在一起）；
//   ② 封顶：超长空档被压到有界宽度，且被登记进 breaks（供界面画断裂符）；
//   ③ 退化：无空档时 = 纯等比（等间隔）；空 / 单点不崩、不 NaN。
import { cappedPositions, formatDurationHuman, DEFAULT_CALENDAR_RULE } from '../src/lib/app/storyDate'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ timelineScale')

const RULE = DEFAULT_CALENDAR_RULE // 默认 12 月 × 30 天（一年 360 天）
const SLOT = 240

// ---------- 1. 退化输入 ----------
{
  const e = cappedPositions([], { slot: SLOT })
  ok('空输入 → 空坐标、无断裂', e.x.length === 0 && e.breaks.length === 0)
  const one = cappedPositions([12345], { slot: SLOT })
  ok('单点 → 居中一格', one.x.length === 1 && one.x[0] === SLOT / 2 && one.breaks.length === 0)
}

// ---------- 2. 纯等比（等间隔）----------
{
  const keys = [0, 10000, 20000, 30000]
  const { x, breaks } = cappedPositions(keys, { slot: SLOT })
  ok('等间隔 → 无障碍（不产生断裂）', breaks.length === 0, JSON.stringify(breaks))
  const steps = [x[1] - x[0], x[2] - x[1], x[3] - x[2]]
  ok('等间隔 → 每格宽度 ≈ slot（等比手感与等距轴一致）',
    steps.every(s => Math.abs(s - SLOT) < 1e-6), steps.join(','))
  ok('x 严格递增', x[1] > x[0] && x[2] > x[1] && x[3] > x[2])
}

// ---------- 3. 超长空档被封顶 + 登记断裂 ----------
{
  const keys = [0, 24, 48, 1e9]           // 前两格很近，末尾一格是天量空档
  const { x, breaks } = cappedPositions(keys, { slot: SLOT })
  ok('🔴 超长空档被登记进 breaks', breaks.includes(2), JSON.stringify(breaks))
  const lastStep = x[3] - x[2]
  ok('🔴 超长空档的渲染宽度被压到有界（远小于真实跨度）',
    lastStep < SLOT * 8, `lastStep=${lastStep.toFixed(1)}`)
  ok('密集段仍保持等比（前两格按真实比例）',
    Math.abs((x[1] - x[0]) - (x[2] - x[1])) < 1e-6, `${(x[1] - x[0]).toFixed(1)} vs ${(x[2] - x[1]).toFixed(1)}`)
  ok('x 仍严格递增（封顶不会把后面的点推到前面）', x[3] > x[2] && x[2] > x[1] && x[1] > x[0])
}

// ---------- 4. 极小空档有下限（不挤成一点）----------
{
  const keys = [0, 100, 101, 1000]
  const { x } = cappedPositions(keys, { slot: SLOT })
  const tiny = x[2] - x[1]                 // 真实 gap = 1（极小）
  ok('极小空档有宽度下限（卡片不会叠死）', tiny > 0 && tiny >= 1, tiny.toFixed(2))
  ok('全部相邻点严格递增', x.every((v, i) => i === 0 || v > x[i - 1]), x.map(v => v.toFixed(1)).join(','))
}

// ---------- 5. 确定性 ----------
{
  const keys = [0, 5, 10, 100000, 100005]
  const a = cappedPositions(keys, { slot: SLOT })
  const b = cappedPositions(keys, { slot: SLOT })
  ok('确定性：同输入两次调用逐位一致', JSON.stringify(a) === JSON.stringify(b))
}

// ---------- 6. 时长人话化 ----------
{
  ok('≥ 一年 → 约 N 年', formatDurationHuman(360 * 3000, RULE) === '约 3000 年', formatDurationHuman(360 * 3000, RULE))
  ok('跨年但不足整年也归到年（1080 天 = 约 3 年）', formatDurationHuman(1080, RULE) === '约 3 年', formatDurationHuman(1080, RULE))
  ok('≥ 一月 → 约 N 个月', formatDurationHuman(60, RULE) === '约 2 个月', formatDurationHuman(60, RULE))
  ok('不足一月 → 约 N 天', formatDurationHuman(5, RULE) === '约 5 天', formatDurationHuman(5, RULE))
  ok('负数按绝对值（填反了也要能显示跨度）', formatDurationHuman(-360, RULE) === '约 1 年', formatDurationHuman(-360, RULE))
}

console.log(`\n${fail === 0 ? '✅' : '❌'} timelineScale 共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`)
if (fail) process.exit(1)
