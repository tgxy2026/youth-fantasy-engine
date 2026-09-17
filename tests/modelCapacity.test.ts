// ============ 模型能力档案 · 本地 vs 云端的上限差异 + 跟着模型走的推荐值 ============
//
// 背景：酒馆的 `numCtx: 32768` / `contextBudget: 24000` 是**为本地 5090 + 27B q6_K 算出来的**
// （22GB 权重 + 8GB KV ≈ 32GB 显存），而 `num_ctx` 是 **Ollama 专有字段** ——
// 云端 OpenAI 兼容端点（硅基流动 / DeepSeek / 通义…）根本不认它。
// 不区分的话，接云端大窗口模型时用户会被"本地算出来的数"锁死，且有 8 倍空间却毫无提示。
//
// 本用例盯五条：
//   ① 本地：**不改动**用户的 numCtx，且不因模型标称大而放宽（它是显存安全阀）
//   ② 云端：识别模型窗口 → 按有效系数折减 → 给出可用的建议预算，并明说 num_ctx 无效
//   ③ 认不出模型时走保守兜底，且**如实标注来源**（不假装知道）
//   ④ **记忆档推荐**（软/硬上限、长期摘要、日记保留）跟着预算走，且 24000 下正好复现出厂值
//   ⑤ **输入框上限动态放宽**（scaleGuide）：1M 窗口的模型不该被 100000 的静态上限卡住，
//      放宽后 paramGuide 的三条不变量（首尾相接 / 完整覆盖 / 唯一推荐段）仍须成立
import {
  adviseCapacity, isLocalProvider, recommendTuning, scaleGuide, TUNING_LIMITS, lookupWindow,
  CLOUD_EFFECTIVE_RATIO, REPLY_RESERVE_TOKENS, FALLBACK_WINDOW,
} from '../src/lib/modelCapacity'
import { PARAM_GUIDES, type ParamGuide } from '../src/lib/tavern/paramGuide'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const CUR = { numCtx: 32768, contextBudget: 24000 }

// ---------- ① 本地 Ollama：一切保持原样 ----------
const local = adviseCapacity({ type: 'ollama', model: 'qwen3.5-27b' }, CUR)
ok('本地：推荐 numCtx 保持用户现值（不按模型标称放宽）', local.suggest.numCtx === 32768, String(local.suggest.numCtx))
ok('本地：建议预算保持现值', local.suggest.contextBudget === 24000, String(local.suggest.contextBudget))
ok('本地：windowTokens 用 numCtx（不是模型标称）', local.windowTokens === 32768, String(local.windowTokens))
ok('本地：note 说明显存决定、标称跑不到', /显存/.test(local.note) && /跑不到/.test(local.note), local.note)

// ---------- ② 云端 · 硅基流动 Qwen3.5-35B-A3B（256K） ----------
const qwen = adviseCapacity({ type: 'openai', local: false, model: 'Qwen/Qwen3.5-35B-A3B' }, CUR)
ok('云端 Qwen3.5-35B：识别出 256K 窗口', qwen.windowTokens === 262144, String(qwen.windowTokens))
ok('云端：windowSource=preset 且带标签', qwen.windowSource === 'preset' && !!qwen.windowLabel, String(qwen.windowLabel))
ok('云端：推荐 numCtx 为 null（该参数对云端无效）', qwen.suggest.numCtx === null)
const expectBudget = Math.floor(262144 * CLOUD_EFFECTIVE_RATIO) - REPLY_RESERVE_TOKENS
ok('云端：建议预算 = 窗口 × 系数 − 回复预留', qwen.suggest.contextBudget === expectBudget,
  `${qwen.suggest.contextBudget} vs ${expectBudget}`)
ok('云端：建议预算显著高于本地现值（这才叫"没被锁死"）',
  qwen.suggest.contextBudget > CUR.contextBudget * 3, `${qwen.suggest.contextBudget} vs ${CUR.contextBudget}`)
ok('云端：note 明确告知 num_ctx 无效', /num_ctx/.test(qwen.note) && /无效/.test(qwen.note), qwen.note)
ok('云端：headline 含窗口与占比，供界面直接显示',
  /云端/.test(qwen.headline) && /262144/.test(qwen.headline) && /\d+%/.test(qwen.headline), qwen.headline)

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
ok('超小窗口：预算不低于下限，不出负数', tiny.suggest.contextBudget >= 4000, String(tiny.suggest.contextBudget))

// ---------- ⑧ 记忆档推荐：出厂配比 + 跟着预算缩放 ----------
const base = recommendTuning(24000, 32768)
ok('记忆档：24000 预算下正好复现出厂值（软 2000 / 硬 3000 / 长期 500 / 日记 7）',
  base.softLimit === 2000 && base.hardLimit === 3000 && base.longTermLimit === 500 && base.diaryDays === 7,
  JSON.stringify(base))

const big = recommendTuning(qwen.suggest.contextBudget, null)
ok('记忆档：云端 256K 模型下三项都放大（这就是"推荐跟着模型变"）',
  big.hardLimit > 3000 && big.softLimit > 2000 && big.longTermLimit > 500, JSON.stringify(big))
ok('记忆档：软上限永远不超过硬上限', big.softLimit <= big.hardLimit, `${big.softLimit}/${big.hardLimit}`)
ok('记忆档：日记保留走开方，涨得比预算慢',
  big.diaryDays < Math.round(7 * (qwen.suggest.contextBudget / 24000)), `${big.diaryDays}`)

const small = recommendTuning(8000, 32768)
ok('记忆档：8000 小预算下同步收紧（不是只有"放大"一条路）',
  small.hardLimit < 3000 && small.softLimit <= small.hardLimit && small.longTermLimit < 500,
  JSON.stringify(small))

const huge = adviseCapacity({ type: 'openai', local: false, model: 'gpt-4.1' }, CUR)
ok('记忆档：1M 窗口模型下被静态上限顶住（记忆不该无限膨胀）',
  huge.suggest.hardLimit === TUNING_LIMITS.hardLimit.max &&
  huge.suggest.longTermLimit === TUNING_LIMITS.longTermLimit.max, JSON.stringify(huge.suggest))
ok('记忆档：1M 窗口模型的建议预算仍远大于 contextBudget 静态上限',
  huge.suggest.contextBudget > TUNING_LIMITS.contextBudget.max, String(huge.suggest.contextBudget))

// ---------- ⑨ 输入框范围动态放宽（scaleGuide）----------
const stretched = scaleGuide(PARAM_GUIDES.contextBudget, huge.suggest.contextBudget)
ok('scaleGuide：1M 窗口下上限确实被放宽', stretched.max > PARAM_GUIDES.contextBudget.max, `${stretched.max}`)
ok('scaleGuide：min 与 step 不变',
  stretched.min === PARAM_GUIDES.contextBudget.min && stretched.step === PARAM_GUIDES.contextBudget.step, '')
ok('scaleGuide：分段仍首尾相接、完整覆盖 [min,max]',
  stretched.bands[0].from === stretched.min &&
  stretched.bands[stretched.bands.length - 1].to === stretched.max &&
  stretched.bands.every((b, i) => i === 0 || b.from === stretched.bands[i - 1].to), '')
ok('scaleGuide：仍恰好一个 recommended 段（paramGuide 闸门的不变量）',
  stretched.bands.filter(b => b.recommended).length === 1)
ok('scaleGuide：段数与档名都没变（只延长末段，不改语义）',
  stretched.bands.length === PARAM_GUIDES.contextBudget.bands.length &&
  stretched.bands.map(b => b.name).join() === PARAM_GUIDES.contextBudget.bands.map(b => b.name).join())
ok('scaleGuide：不修改传入的 guide（纯函数）',
  PARAM_GUIDES.contextBudget.max === TUNING_LIMITS.contextBudget.max &&
  PARAM_GUIDES.contextBudget.bands[PARAM_GUIDES.contextBudget.bands.length - 1].to === TUNING_LIMITS.contextBudget.max)

const untouched = scaleGuide(PARAM_GUIDES.softLimit, 2000)
ok('scaleGuide：推荐值没超静态上限时原样返回同一对象（本地行为不变）',
  untouched === PARAM_GUIDES.softLimit)

// ---------- ⑩ TUNING_LIMITS 必须与 paramGuide 同源 ----------
// 两处各写一份边界会漂：说明里写的范围与输入框实际允许的范围对不上，比没写更坏。
const pairs: [keyof typeof TUNING_LIMITS, ParamGuide][] = [
  ['contextBudget', PARAM_GUIDES.contextBudget],
  ['numCtx', PARAM_GUIDES.numCtx],
  ['softLimit', PARAM_GUIDES.softLimit],
  ['hardLimit', PARAM_GUIDES.hardLimit],
  ['longTermLimit', PARAM_GUIDES.longTermLimit],
  ['diaryDays', PARAM_GUIDES.diaryKeep],
]
for (const [key, g] of pairs) {
  const L = TUNING_LIMITS[key]
  ok(`TUNING_LIMITS.${key} 与 paramGuide 的 min/max/step 一致`,
    L.min === g.min && L.max === g.max && L.step === g.step,
    `limits=${L.min}/${L.max}/${L.step} guide=${g.min}/${g.max}/${g.step}`)
}

// ---------- ⑪ lookupWindow：模型配置页用它做"留空会识别成什么"的实时提示 ----------
const lw = lookupWindow('Qwen/Qwen3.5-35B-A3B')
ok('lookupWindow：Qwen3.5-35B → 256K 且带预设标签', lw?.window === 262144 && !!lw?.label, JSON.stringify(lw))
ok('lookupWindow：认不出的模型返回 null（不假装知道）', lookupWindow('my-custom-llm-v9') === null)
ok('lookupWindow：空串 / undefined / null 都返回 null 而不是抛错',
  lookupWindow('') === null && lookupWindow(undefined) === null && lookupWindow(null) === null)
ok('lookupWindow 与 adviseCapacity 对同一模型给出同一窗口（配置页提示不会与面板算的对不上）',
  lw?.window === qwen.windowTokens, `${lw?.window} vs ${qwen.windowTokens}`)

console.log(`\n—— modelCapacity 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
