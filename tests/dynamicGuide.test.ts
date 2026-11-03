// ============ 2.8.0 · 动态五档：档位围绕「当前模型的推荐值」生成 ============
//
// 背景：出厂那几档是按本地 32K 窗口定的。接上 128K / 256K / 1M 的模型后，
// 推荐值早就跑到最后一档去了，界面却仍在高亮「超长 / 超大窗口配套」——
// 作者看到的永远是「我怎么又拉过头了」。改成跟着推荐值走：换模型，整条刻度一起平移。
//
// 本用例盯四条：
//   ① 分段首尾相接、完整覆盖 [min,max]、无空隙无重叠（与静态表同一套闸门）
//   ② **恰好一个**推荐段，且**推荐值真的落在这一段里**（否则界面上的「推荐」是假的）
//   ③ min / step 沿用静态表 —— 只有上界与分段被重算，输入框手感不变
//   ④ 换模型 ⇒ 刻度整体平移（出厂值在大窗口模型下不再算「推荐」）
import { __resetMockStores } from './mock-memory'
import { dynamicGuide, bandOf, PARAM_GUIDES, type DynamicGuideKey } from '../src/lib/tavern/paramGuide'
import { DEFAULT_TAVERN_SETTINGS } from '../src/lib/tavern/settings'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 出厂推荐值（本地 32K 窗口下的出厂配比）—— 一律从默认值取，不写字面量 */
function factoryRec(): [DynamicGuideKey, number][] {
  const d = DEFAULT_TAVERN_SETTINGS
  return [
    ['contextBudget', d.common.contextBudget],
    ['numCtx', d.common.numCtx],
    ['fixedOverheadChars', d.common.fixedOverheadChars],
    ['softLimit', d.free.softLimit],
    ['hardLimit', d.free.hardLimit],
    ['longTermLimit', d.free.longTermLimit],
    ['diaryKeep', d.free.diaryDays],
  ]
}

async function main() {
  __resetMockStores()

  // ---------- ①②③ 出厂状态下七项都必须自洽 ----------
  for (const [key, rec] of factoryRec()) {
    const g = dynamicGuide(key, rec)
    const base = PARAM_GUIDES[key]
    const problems: string[] = []

    if (g.min !== base.min) problems.push(`min 被改成 ${g.min}（应沿用 ${base.min}）`)
    if (g.step !== base.step) problems.push(`step 被改成 ${g.step}（应沿用 ${base.step}）`)
    if (g.bands.length < 3) problems.push(`档位只剩 ${g.bands.length} 档`)
    if (g.bands[0].from !== g.min) problems.push(`首段 from=${g.bands[0].from} ≠ min=${g.min}`)
    if (g.bands[g.bands.length - 1].to !== g.max) problems.push(`末段 to=${g.bands[g.bands.length - 1].to} ≠ max=${g.max}`)

    for (let i = 1; i < g.bands.length; i++) {
      const b = g.bands[i]
      const prev = g.bands[i - 1]
      if (b.from > prev.to + g.step) problems.push(`第 ${i}~${i + 1} 档之间有缝：${prev.to} → ${b.from}`)
      if (b.from < prev.to) problems.push(`第 ${i}~${i + 1} 档重叠：${prev.to} vs ${b.from}`)
      if (!b.name.trim()) problems.push(`第 ${i + 1} 档缺档名`)
      if (b.effect.trim().length < 12) problems.push(`第 ${i + 1} 档说明太短`)
    }

    const recs = g.bands.filter(b => b.recommended)
    if (recs.length !== 1) problems.push(`推荐档有 ${recs.length} 个（应恰好 1 个）`)
    if (recs.length === 1 && bandOf(g, rec) !== recs[0]) {
      problems.push(`推荐值 ${rec} 落在「${bandOf(g, rec).name}」，不在推荐档里`)
    }

    ok(`${key}：出厂推荐 ${rec} 落在推荐档（${g.bands.length} 档，${g.min}~${g.max}）`,
      problems.length === 0, problems.join('；'))
  }

  // ---------- ④ 换模型 ⇒ 刻度整体平移 ----------
  {
    const small = dynamicGuide('contextBudget', 24000)      // 本地 32K
    const big = dynamicGuide('contextBudget', 146595)       // 云端 256K（窗口 ×0.6 − 8192）
    const recSmall = small.bands.findIndex(b => b.recommended)
    const recBig = big.bands.findIndex(b => b.recommended)
    ok('换模型：推荐档所在位置不变（仍在中间那档）', recSmall === recBig, `${recSmall} / ${recBig}`)
    ok('换模型：推荐档的上下界整体右移',
      big.bands[recBig].from > small.bands[recSmall].from && big.bands[recBig].to > small.bands[recSmall].to,
      `${small.bands[recSmall].from}~${small.bands[recSmall].to} → ${big.bands[recBig].from}~${big.bands[recBig].to}`)
    ok('换模型：出厂值 24000 在 256K 模型下不再算推荐',
      !bandOf(big, 24000).recommended, bandOf(big, 24000).name)
    ok('换模型：256K 模型下 24000 落在推荐档**下方**（这才叫"没被锁死"）',
      bandOf(big, 24000).from < big.bands[recBig].from, bandOf(big, 24000).name)
    ok('换模型：新的推荐值落在新推荐档里', !!bandOf(big, 146595).recommended)
  }

  // ---------- 边界：推荐值贴着 min / max 时退化但不崩 ----------
  {
    const atMin = dynamicGuide('diaryKeep', 1)
    ok('边界：推荐值贴 min 时仍命中推荐档', !!bandOf(atMin, 1).recommended, bandOf(atMin, 1).name)
    const atMax = dynamicGuide('diaryKeep', 30)
    ok('边界：推荐值贴 max 时仍命中推荐档', !!bandOf(atMax, 30).recommended, bandOf(atMax, 30).name)
    const hugeRec = dynamicGuide('contextBudget', PARAM_GUIDES.contextBudget.max)
    ok('边界：推荐值顶到静态上界时不崩、且仍是一个档',
      hugeRec.bands.filter(b => b.recommended).length === 1 && !!bandOf(hugeRec, PARAM_GUIDES.contextBudget.max).recommended)
  }

  // ---------- 文案纪律：推荐档念的是真实上下界，不写死数字 ----------
  {
    for (const [key, rec] of factoryRec()) {
      const g = dynamicGuide(key, rec * 4)
      const b = g.bands.find(x => x.recommended)
      ok(`${key}：推荐档文案念的是真实上下界（${b?.from} ~ ${b?.to}）`,
        !!b && (b.effect.includes(String(b.from)) || b.effect.includes(String(b.to))), b?.effect ?? '')
    }
  }

  console.log(`\ndynamicGuide: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
