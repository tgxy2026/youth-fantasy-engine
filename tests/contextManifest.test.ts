// ============ 3.2.0 · WQ4：发送清单端到端（装配 → 上下文返回值 → 运行账本快照） ============
//
// 钉四件事：
//   ① `buildProjectContext()` 真的把清单带回来（不是只有类型）；
//   ② 清单的段数与 `sections` / `dropped` 对得上（不许一套说发了、一套说没发）；
//   ③ 预算按**本次实际窗口/传入预算**算，来源如实标注；
//   ④ 账本快照（`lastContextAssembly` + `pickContextSnapshot`）带着同一份清单 ——
//      作者事后能查到"那次到底发了什么、为什么没发全"。
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'
import { buildProjectContext, lastContextAssembly } from '@/lib/ai/aiContext'
import { pickContextSnapshot } from '@/lib/ai/aiRunLedger'
import { manifestGaps } from '@/lib/ai/requestBudget'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const PID = 'p-ctx'

async function main() {
  __resetMockStores()
  await db.setCurrentProject(PID)
  // 造一点资料，保证装配至少带入一段
  await db.saveFormData('worldbase', { '一、世界总览::世界名称': '九霄界' })
  await db.saveFormData('char-main', { '姓名': '林昭', '身份定位': '主角' })

  // ────────────────────────── ① 清单随返回值 ──────────────────────────
  const t0 = Date.now()
  const res = await buildProjectContext({ budget: 6000, intent: 'unit-test' })
  ok('① 返回值带 manifest', Boolean(res.manifest), JSON.stringify(Object.keys(res)))
  ok('① 清单记住任务意图', res.manifest?.intent === 'unit-test', String(res.manifest?.intent))
  ok('① 清单里有段级明细', (res.manifest?.entries.length ?? 0) > 0, String(res.manifest?.entries.length))
  ok('① 明细带来源引用（段标题）',
    (res.manifest?.entries ?? []).every(e => typeof e.source.ref === 'string' && e.source.ref.length > 0))

  // ────────────────────────── ② 与 sections / dropped 口径一致 ──────────────────────────
  {
    const m = res.manifest!
    const included = m.entries.filter(e => e.scope !== 'dropped').map(e => e.source.ref).sort()
    const sections = [...res.sections].sort()
    ok('🔴 清单"已带入"与 sections 逐项一致', JSON.stringify(included) === JSON.stringify(sections),
      `\n清单=${included.join(',')}\n段=${sections.join(',')}`)
    const omitted = m.entries.filter(e => e.scope === 'dropped').map(e => e.source.ref).sort()
    ok('🔴 清单"未带入"与 dropped 逐项一致', JSON.stringify(omitted) === JSON.stringify([...res.dropped].sort()),
      `\n清单=${omitted.join(',')}\n段=${[...res.dropped].sort().join(',')}`)
    ok('② 未带入项都写清了原因',
      m.entries.filter(e => e.scope === 'dropped').every(e => Boolean(e.reason)),
      JSON.stringify(m.entries.filter(e => e.scope === 'dropped')))
    ok('② 预算来源如实（无 provider 时标兜底）',
      m.budget.windowTokens > 0 && ['user', 'preset', 'fallback', 'unknown'].includes(m.budget.windowSource),
      String(m.budget.windowSource))
    ok('② 装配耗时被记下', typeof m.assembleMs === 'number' && m.assembleMs >= 0, String(m.assembleMs))
  }

  // ────────────────────────── ③ 小预算 ⇒ 明确申报，不静默裁光 ──────────────────────────
  {
    // 先塞一段很大的资料（用「全书总纲」的已知模块/字段名，确保真的会渲染），
    // 否则 400 预算也能全部装下，"放不下"的场景根本没发生。
    await db.saveFormData('master', {
      '一、故事内核::主线一句话': '少年以吞噬神体逆天改命'.repeat(200),
      '一、故事内核::核心冲突': '人族与收割者的千年之局'.repeat(200),
    })
    const tight = await buildProjectContext({ budget: 400, intent: 'tight' })
    ok('③ 极小预算时清单仍然存在（不是"没有上下文就没有清单"）', Boolean(tight.manifest))
    const gaps = tight.manifest ? manifestGaps(tight.manifest) : []
    ok('③ 放不下的段被如实列为未带入/只带一部分', gaps.length > 0,
      JSON.stringify({ gaps, sections: tight.sections, dropped: tight.dropped, chars: tight.chars }))
    ok('③ 被丢的段说明原因，而不是只留一个标题',
      gaps.every(g => Boolean(g.reason)), JSON.stringify(gaps.map(g => g.reason)))
  }

  // ────────────────────────── ④ 账本快照带着同一份清单 ──────────────────────────
  {
    const snap = lastContextAssembly()
    ok('④ 最近一次装配记进了快照', snap !== null)
    ok('④ 快照带 manifest（不是丢在返回值里就完）', Boolean(snap?.manifest), JSON.stringify(Object.keys(snap ?? {})))
    ok('④ 快照清单与返回值同源（同一 intent）', snap?.manifest?.intent === 'tight', String(snap?.manifest?.intent))

    const picked = pickContextSnapshot(snap, t0 - 1000)
    ok('④ 归属判定后清单仍在', Boolean(picked?.manifest), JSON.stringify(Object.keys(picked ?? {})))
    const stale = pickContextSnapshot(snap, Date.now() + 10_000)
    ok('④ 归属不符（快照早于任务）⇒ 不冒充，返回 null', stale === null)
  }
}

main().then(() => {
  console.log(`\ncontextManifest: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})
