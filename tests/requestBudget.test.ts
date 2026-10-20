// ============ 3.2.0 · WQ4：请求预算与发送材料清单 ============
//
// 钉四件事（方案 §16.5）：
//   ① 预算是按**实际模型窗口**算的：窗口不同、额度不同（不是全局一个数）；
//   ② 字符与词元**分开报告**；未知 tokenizer 如实标"估算"；
//   ③ 放不下时**明确申报**（`AIContextOverflowError`），不静默截断后假装完整；
//   ④ 发送清单按来源去重，`dropped/trimmed` 必须带原因 —— 作者要知道"没带什么、为什么"。
import {
  planRequestBudget, estimateTokens, describeBudget, buildMaterialManifest, manifestGaps,
  manifestFromAssembled,
  AIContextOverflowError, MATERIAL_SHARE_OF_WINDOW, SAFETY_MARGIN_RATIO, MAX_OUTPUT_SHARE_OF_WINDOW,
  type MaterialEntry,
} from '@/lib/ai/requestBudget'
import { REPLY_RESERVE_TOKENS } from '@/lib/ai/modelCapacity'
import { chat } from '@/lib/aiCore/chat'
import type { AIProvider } from '@/lib/aiCore/core'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

async function main() {
  // ────────────────────────── ① 词元估算 ──────────────────────────
  {
    const zh = estimateTokens('龙族血脉')
    ok('① 中文 4 字 ≈ 4 token', zh.tokens === 4 && zh.chars === 4, JSON.stringify(zh))
    ok('① 中文字符数与词元数分开报告', zh.chars === 4 && zh.tokens === 4)
    const en = estimateTokens('abcdefgh')
    ok('① 英文 8 字符 ≈ 2 token（4 字符/token）', en.tokens === 2 && en.chars === 8, JSON.stringify(en))
    ok('① 混排两种分别累计（1 汉字 + 7 ASCII → 1 + ⌈7/4⌉ = 3）', (() => {
      const m = estimateTokens('龙abcdefg')
      return m.tokens === 3
    })())
    ok('① 空文本为 0', estimateTokens('').tokens === 0 && estimateTokens(null).tokens === 0)
    ok('🔴 估算来源如实标注（不是精确 tokenizer）', estimateTokens('x').source === 'heuristic-mixed')
  }

  // ────────────────────────── ② 预算分配 ──────────────────────────
  {
    const b = planRequestBudget({ window: 32768, windowSource: 'user', body: '字'.repeat(1000) })
    ok('② 资料额度 = 窗口 × 0.5', b.inputAllowanceTokens === Math.floor(32768 * MATERIAL_SHARE_OF_WINDOW), String(b.inputAllowanceTokens))
    ok('② 输出预留取全局值', b.outputReserveTokens === REPLY_RESERVE_TOKENS, String(b.outputReserveTokens))
    ok('② 安全余量 = 窗口 × 5%', b.safetyMarginTokens === Math.floor(32768 * SAFETY_MARGIN_RATIO), String(b.safetyMarginTokens))
    ok('② 小请求放得下', b.fits && b.overflowTokens === 0)
    ok('② 窗口来源透传', b.windowSource === 'user')
    ok('② 估算来源如实标注', b.warnings.some(w => w.includes('保守估算')), JSON.stringify(b.warnings))

    const big = planRequestBudget({ window: 32768, body: '字'.repeat(20000) })
    ok('🔴 超额度 ⇒ fits=false 且报出超出量', !big.fits && big.overflowTokens === 20000 - big.inputAllowanceTokens,
      `overflow=${big.overflowTokens} allowance=${big.inputAllowanceTokens}`)
    ok('② 超额度时一句话结论可读', describeBudget(big).includes('超出'), describeBudget(big))

    // 分工模型：窗口不同 ⇒ 额度不同（方案验收第一条）
    const small = planRequestBudget({ window: 8192, windowSource: 'user' })
    const large = planRequestBudget({ window: 131072, windowSource: 'user' })
    ok('🔴 不同窗口给出不同额度', small.inputAllowanceTokens === 4096 && large.inputAllowanceTokens === 65536,
      `${small.inputAllowanceTokens} / ${large.inputAllowanceTokens}`)
  }

  // ────────────────────────── ③ 边界：小窗口与超大输出声明 ──────────────────────────
  {
    const tiny = planRequestBudget({ window: 2000, outputTokens: 100000 })
    ok('③ 输出预留不超过窗口 40%',
      tiny.outputReserveTokens === Math.floor(2000 * MAX_OUTPUT_SHARE_OF_WINDOW), String(tiny.outputReserveTokens))
    ok('③ 输出预留被压缩时给出提示', tiny.warnings.some(w => w.includes('压缩')), JSON.stringify(tiny.warnings))
    ok('③ 额度不会被算成负数', tiny.inputAllowanceTokens >= 0, String(tiny.inputAllowanceTokens))

    const unknown = planRequestBudget({})
    ok('③ 取不到窗口 ⇒ 32K 保守估算并标注', unknown.windowTokens === 32768
      && unknown.windowSource === 'unknown'
      && unknown.warnings.some(w => w.includes('32K')), JSON.stringify(unknown.windowSource))
  }

  // ────────────────────────── ④ 发送材料清单 ──────────────────────────
  {
    const budget = planRequestBudget({ window: 32768 })
    const entries: MaterialEntry[] = [
      { source: { kind: 'tab', ref: 'char-main', revision: 'r3', fieldBasis: 'tpl_char@v2', permissionBasis: 'aiRead' }, includedChars: 120, scope: 'full' },
      // 同一来源重复装入（两个分段各装一次）⇒ 清单只算一次
      { source: { kind: 'tab', ref: 'char-main', revision: 'r3' }, includedChars: 120, scope: 'full' },
      { source: { kind: 'chapter', ref: 'ch12', revision: 'h9' }, includedChars: 800, scope: 'trimmed', reason: '超出单段上限，保尾裁剪' },
      { source: { kind: 'recall', ref: 'sem-42' }, includedChars: 0, scope: 'dropped', reason: '索引已过期（stale-index）' },
    ]
    const m = buildMaterialManifest({
      intent: 'chapter-review', output: 'json-object', budget, entries,
      assembleMs: 37, recallStates: { 'sem-42': 'stale-index' },
    })
    ok('④ 重复来源去重（4 条 → 3 条）', m.entries.length === 3, String(m.entries.length))
    ok('④ 记住当时的读取修订', m.entries[0].source.revision === 'r3')
    ok('④ 记住字段定义与权限依据',
      m.entries[0].source.fieldBasis === 'tpl_char@v2' && m.entries[0].source.permissionBasis === 'aiRead')
    ok('④ 裁剪/未带入都带原因', manifestGaps(m).every(e => e.scope === 'full' || Boolean(e.reason)),
      JSON.stringify(manifestGaps(m)))
    ok('④ 未带入条数可统计', manifestGaps(m).length === 2, String(manifestGaps(m).length))
    ok('④ 输出协议与装配耗时随清单走', m.output === 'json-object' && m.assembleMs === 37)
    ok('④ 检索原因码可追溯', m.recallStates?.['sem-42'] === 'stale-index')
  }

  // ────────────────────────── ④-b 装配结果 → 清单（生产端） ──────────────────────────
  {
    const m = manifestFromAssembled({
      text: '字'.repeat(1200),
      entries: [
        { title: '世界设定', includedChars: 400, scope: 'full' },
        { title: '主要角色', includedChars: 260, scope: 'trimmed', reason: '超出单段上限，保留 20/40 行' },
        { title: '远期待办', includedChars: 0, scope: 'dropped', reason: '剩余预算不足 200 字符' },
      ],
    }, { intent: 'chapter-review', window: 32768, windowSource: 'user', assembleMs: 12 })

    ok('④-b 清单来自装配真实结果（3 段）', m.entries.length === 3, String(m.entries.length))
    ok('④-b 段标题成为来源引用', m.entries[0].source.ref === '世界设定' && m.entries[0].source.kind === 'tab')
    ok('④-b 裁剪/丢弃的原因原样带出',
      m.entries[1].reason?.includes('20/40') === true && m.entries[2].reason?.includes('不足') === true,
      JSON.stringify(m.entries.map(e => e.reason)))
    ok('④-b 预算按传入窗口算（不是 32K 兜底）', m.budget.windowTokens === 32768 && m.budget.windowSource === 'user')
    ok('④-b 清单预算包含正文估算', m.budget.estimates.body.tokens === 1200, String(m.budget.estimates.body.tokens))
    ok('④-b 未带入项可枚举', m.intent === 'chapter-review' && manifestGaps(m).length === 2)

    const noWindow = manifestFromAssembled({ text: '短', entries: [] }, { intent: 'x' })
    ok('④-b 取不到窗口时预算标注兜底（不冒充精确）',
      noWindow.budget.windowSource === 'unknown'
      && noWindow.budget.warnings.some(w => w.includes('32K')), JSON.stringify(noWindow.budget.windowSource))
  }

  // ────────────────────────── ⑤ chat() 发送前拦截 ──────────────────────────
  {
    const provider = {
      id: 'p1', name: '测试', type: 'ollama', baseUrl: 'http://127.0.0.1:9', model: 'stub',
      contextWindow: 2000,
    } as unknown as AIProvider

    // 输入远超 2000 窗口 ⇒ 必须在**发起请求之前**抛可识别的预算错误
    let err: unknown = null
    try {
      await chat(provider, [{ role: 'user', content: '字'.repeat(5000) }])
    } catch (e) { err = e }
    ok('🔴 超窗口 ⇒ 抛 AIContextOverflowError（不是普通网络错误）', err instanceof AIContextOverflowError)
    ok('🔴 错误里带预算明细，作者知道要缩小多少',
      err instanceof AIContextOverflowError
      && err.budget.windowTokens === 2000
      && err.budget.overflowTokens > 0
      && err.message.includes('缩小'), err instanceof Error ? err.message : String(err))

    // 逃生口：显式 allowOverflow 时不再拦（会继续尝试请求 ⇒ 连接失败，但不是预算错）
    let err2: unknown = null
    try {
      await chat(provider, [{ role: 'user', content: '字'.repeat(5000) }], { allowOverflow: true })
    } catch (e) { err2 = e }
    ok('⑤ allowOverflow 显式逃生（不再是预算错）', !(err2 instanceof AIContextOverflowError))

    // 小请求不受影响：能进到网络阶段（这里连不上，但错误来自连接而不是预算）
    let err3: unknown = null
    try {
      await chat(provider, [{ role: 'user', content: '你好' }])
    } catch (e) { err3 = e }
    ok('⑤ 正常请求不被预算误拦', !(err3 instanceof AIContextOverflowError), String(err3))
  }
}

main().then(() => {
  console.log(`\nrequestBudget: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})
