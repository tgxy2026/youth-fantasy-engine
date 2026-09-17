// ============ 模型能力档案 · 本地 vs 云端的上限差异 ============
//
// 背景：酒馆的 `numCtx: 32768` / `contextBudget: 24000` 是**为本地 5090 + 27B q6_K 算出来的**
// （22GB 权重 + 8GB KV ≈ 32GB 显存），而 `num_ctx` 是 **Ollama 专有字段** ——
// 云端 OpenAI 兼容端点（硅基流动 / DeepSeek / 通义…）根本不认它。
// 不区分的话，接云端大窗口模型时用户会被"本地算出来的数"锁死，且有 8 倍空间却毫无提示。
//
// 本用例盯三条：
//   ① 本地：**不改动**用户的 numCtx，且不因模型标称大而放宽（它是显存安全阀）
//   ② 云端：识别模型窗口 → 按有效系数折减 → 给出可用的建议预算，并明说 num_ctx 无效
//   ③ 认不出模型时走保守兜底，且**如实标注来源**（不假装知道）
import {
  adviseCapacity, isLocalProvider,
  CLOUD_EFFECTIVE_RATIO, REPLY_RESERVE_TOKENS, FALLBACK_WINDOW,
} from '../src/lib/modelCapacity'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const CUR = { numCtx: 32768, contextBudget: 24000 }

// ---------- ① 本地 Ollama：一切保持原样 ----------
const local = adviseCapacity({ type: 'ollama', model: 'qwen3.5-27b' }, CUR)
ok('本地：suggestNumCtx 保持用户现值（不按模型标称放宽）', local.suggestNumCtx === 32768, String(local.suggestNumCtx))
ok('本地：建议预算保持现值', local.suggestContextBudget === 24000, String(local.suggestContextBudget))
ok('本地：windowTokens 用 numCtx（不是模型标称）', local.windowTokens === 32768, String(local.windowTokens))
ok('本地：note 说明显存决定、标称跑不到', /显存/.test(local.note) && /跑不到/.test(local.note), local.note)

// ---------- ② 云端 · 硅基流动 Qwen3.5-35B-A3B（256K） ----------
const qwen = adviseCapacity({ type: 'openai', local: false, model: 'Qwen/Qwen3.5-35B-A3B' }, CUR)
ok('云端 Qwen3.5-35B：识别出 256K 窗口', qwen.windowTokens === 262144, String(qwen.windowTokens))
ok('云端：windowSource=preset 且带标签', qwen.windowSource === 'preset' && !!qwen.windowLabel, String(qwen.windowLabel))
ok('云端：suggestNumCtx 为 null（该参数对云端无效）', qwen.suggestNumCtx === null)
const expectBudget = Math.floor(262144 * CLOUD_EFFECTIVE_RATIO) - REPLY_RESERVE_TOKENS
ok('云端：建议预算 = 窗口 × 系数 − 回复预留', qwen.suggestContextBudget === expectBudget,
  `${qwen.suggestContextBudget} vs ${expectBudget}`)
ok('云端：建议预算显著高于本地现值（这才叫"没被锁死"）',
  qwen.suggestContextBudget > CUR.contextBudget * 3, `${qwen.suggestContextBudget} vs ${CUR.contextBudget}`)
ok('云端：note 明确告知 num_ctx 无效', /num_ctx/.test(qwen.note) && /无效/.test(qwen.note), qwen.note)

// ---------- ③ 其它已收录模型 ----------
const cases: [string, number][] = [
  ['deepseek-ai/DeepSeek-V3.1', 131072],
  ['deepseek-ai/DeepSeek-R1', 98304],
  ['zai-org/GLM-4.6', 204800],
  ['moonshotai/Kimi-K2-Instruct-0905', 262144],
  ['Qwen/Qwen3-235B-A22B', 131072],
]
for (const [model, win] of cases) {
  const a = adviseCapacity({ type: 'openai', local: false, model }, CUR)
  ok(`预设识别：${model} → ${win}`, a.windowTokens === win, String(a.windowTokens))
}

// ---------- ④ 未知模型：保守兜底且如实标注 ----------
const unknown = adviseCapacity({ type: 'openai', local: false, model: 'my-custom-llm-v9' }, CUR)
ok('未知模型：走保守兜底窗口', unknown.windowTokens === FALLBACK_WINDOW && unknown.windowSource === 'fallback',
  `${unknown.windowTokens}/${unknown.windowSource}`)
ok('未知模型：note 如实说明"未识别"并可手填', /未识别/.test(unknown.note) && /手填/.test(unknown.note), unknown.note)

// ---------- ⑤ 手填窗口优先 ----------
const manual = adviseCapacity({ type: 'openai', local: false, model: 'Qwen/Qwen3.5-35B-A3B', contextWindow: 100000 }, CUR)
ok('手填 contextWindow 优先于预设识别', manual.windowTokens === 100000 && manual.windowSource === 'user',
  `${manual.windowTokens}/${manual.windowSource}`)

// ---------- ⑥ 本地判定 ----------
ok('Ollama → 本地', isLocalProvider({ type: 'ollama' }) === true)
ok('local:true 的 openai 端点（LM Studio 等）→ 本地', isLocalProvider({ type: 'openai', local: true }) === true)
ok('云端 openai → 非本地', isLocalProvider({ type: 'openai', local: false }) === false)
ok('provider 为 null → 按本地保守处理', isLocalProvider(null) === true)

// ---------- ⑦ 边界 ----------
const tiny = adviseCapacity({ type: 'openai', local: false, model: 'x', contextWindow: 1000 }, CUR)
ok('超小窗口：预算不低于下限，不出负数', tiny.suggestContextBudget >= 4000, String(tiny.suggestContextBudget))

console.log(`\n—— modelCapacity 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
