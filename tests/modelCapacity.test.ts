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
  modelFingerprintOf, shouldApplyTuning,
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
ok('本地（未手填窗口）：note 说明沿用面板现值、且提示去模型配置手填',
  /面板/.test(local.note) && /手填/.test(local.note), local.note)
ok('🔴 本地（未手填）：不算「手填真源」，同步链不会冲掉面板值',
  local.numCtxFromUserWindow === false, String(local.numCtxFromUserWindow))

// ---------- ①-b 本地 · 手填了窗口（2026-10-03 老大定案：手填即真源）----------
{
  const filled = adviseCapacity(
    { type: 'ollama', local: true, model: 'gemma-4-31b-mm', contextWindow: 131072 },
    { numCtx: 32768, contextBudget: 24000 },
  )
  ok('🔴 本地手填 128K：窗口以手填为准（不是面板的 32K）', filled.windowTokens === 131072, String(filled.windowTokens))
  ok('🔴 手填后建议窗口 = 手填值（会写回酒馆设置）',
    filled.suggest.numCtx === 131072 && filled.numCtxFromUserWindow === true, String(filled.suggest.numCtx))
  ok('🔴 手填 128K 后安全上限按 128K 算（24000 预算不再算超限）',
    filled.overWindow === false, String(filled.overWindow))
  ok('🔴 手填后预算上限跟着放大（不再被 32K×0.732 卡在 23400）',
    filled.overWindow === false && Math.floor(131072 * (24000 / 32768)) > 90000)
  const shrink = adviseCapacity(
    { type: 'ollama', local: true, model: 'qwen3.8-27b-write', contextWindow: 98304 },
    { numCtx: 262144, contextBudget: 24000 },
  )
  ok('🔴 手填「比面板小」也照填（主人可能主动收窄）', shrink.windowTokens === 98304, String(shrink.windowTokens))
}

// ---------- ①-c 上限提到 256K（2026-10-03：实测有两个模型能跑 262144）----------
ok('🔴 numCtx 上限与模型配置输入框一致（2097152 = 2M，不再自己拍小）', TUNING_LIMITS.numCtx.max === 2097152, String(TUNING_LIMITS.numCtx.max))
ok('🔴 contextBudget 与 numCtx 同量级（避免「窗口 2M、预算 26 万」错配）', TUNING_LIMITS.contextBudget.max === TUNING_LIMITS.numCtx.max, String(TUNING_LIMITS.contextBudget.max))
{
  // 256K 窗口按出厂配比 ⇒ 建议预算约 19 万字；上限 100000 时会被截断，现在不会
  const big = recommendTuning(191900, 262144)
  ok('🔴 256K 窗口的配套预算（19 万字）不被截断',
    big.contextBudget === 191900, String(big.contextBudget))
}

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
// 2026-10-03：上限从 100000 提到 2097152（与模型配置输入框一致）后，
// 1M 云端窗口的建议预算（41 万）**不再被静态上限截断** —— 这正是当年「1M 模型可用到 41 万却被输入框卡住」的修复。
ok('记忆档：1M 窗口模型的建议预算不再被静态上限截断（41 万能直接填）',
  huge.suggest.contextBudget > 100000 && huge.suggest.contextBudget <= TUNING_LIMITS.contextBudget.max,
  String(huge.suggest.contextBudget))

// ---------- ⑨ 输入框范围动态放宽（scaleGuide）----------
// 上限已足够大 ⇒ 1M 窗口这条路上**用不到** scaleGuide 了；但它本身仍要能工作（更大窗口时兜底）。
ok('scaleGuide：1M 窗口下无需放宽（上限已足够）',
  scaleGuide(PARAM_GUIDES.contextBudget, huge.suggest.contextBudget).max === PARAM_GUIDES.contextBudget.max,
  String(PARAM_GUIDES.contextBudget.max))
const stretchedFar = scaleGuide(PARAM_GUIDES.contextBudget, 3_000_000)
ok('scaleGuide：真的超上限时仍会放宽（自身逻辑没坏）',
  stretchedFar.max > PARAM_GUIDES.contextBudget.max, `${stretchedFar.max}`)
const stretched = stretchedFar
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

// ---------- ⑫ 超窗口保护：预算被云端放大过、窗口却是本地的 ----------
// 场景：先在云端把预算用到 9.6 万（那是按 256K 窗口算的），再切回本地 —— 本地 numCtx 仍由显存决定。
// 此时预算 > 窗口承载，prompt 会被 Ollama **静默截断**（先裁协议与设定），所以必须给回落建议。
const carried = adviseCapacity({ type: 'ollama', model: 'qwen3.5-27b' }, { numCtx: 32768, contextBudget: 96665 })
ok('超窗口：标记 overWindow', carried.overWindow === true)
ok('超窗口：建议预算回落到窗口承载范围内',
  carried.suggest.contextBudget < 96665 && carried.suggest.contextBudget <= 32768,
  String(carried.suggest.contextBudget))
ok('超窗口：回落值 = 窗口 × 出厂配比(24000/32768)，且对齐 step',
  carried.suggest.contextBudget === 24000, String(carried.suggest.contextBudget))
ok('超窗口：headline 与 note 都点明"会被静默截断"',
  /超窗口承载/.test(carried.headline) && /截断/.test(carried.note), carried.headline)
ok('超窗口：记忆档按回落后的预算算，不按超限值',
  carried.suggest.hardLimit === 3000 && carried.suggest.diaryDays === 7, JSON.stringify(carried.suggest))

// 边界：正好等于安全上限（出厂 24000/32768 就是这个比例）→ 不算超限，出厂配置零变化
const atEdge = adviseCapacity({ type: 'ollama', model: 'qwen3.5-27b' }, { numCtx: 32768, contextBudget: 24000 })
ok('超窗口：正好等于安全上限时不触发（出厂配置零变化）',
  !atEdge.overWindow && atEdge.suggest.contextBudget === 24000)

// 用户刻意调小预算 → 不该被"推荐"顶回去
const lowered = adviseCapacity({ type: 'ollama', model: 'qwen3.5-27b' }, { numCtx: 32768, contextBudget: 12000 })
ok('超窗口：低于上限时尊重用户现值（不往上顶）',
  !lowered.overWindow && lowered.suggest.contextBudget === 12000, String(lowered.suggest.contextBudget))

// 小显存设备：窗口 8192 → 安全上限同步变小
const smallCtx = adviseCapacity({ type: 'ollama', model: 'llama3-8b' }, { numCtx: 8192, contextBudget: 24000 })
ok('超窗口：安全上限跟着 numCtx 缩放（小显存设备同样要回落）',
  smallCtx.overWindow === true && smallCtx.suggest.contextBudget === 6000, String(smallCtx.suggest.contextBudget))
ok('超窗口：云端不用这个标记（云端预算本就按窗口算出来）', !qwen.overWindow)

// ---------- ⑬ 额度自动跟随的判定链（"自动"与"手工覆盖"共存）----------
// 🔴 这是本次改动的**核心不变量**：自动套用只在"换了模型"时发生。
//    判定若写成"发现偏离就纠正"，用户手调的值会在每次同步时被改回去，手工覆盖就成了空话。
const fp = modelFingerprintOf({ id: 'v', model: 'Qwen3.5-35B', contextWindow: undefined })
ok('指纹：同 provider 同 model → 指纹相同',
  fp === modelFingerprintOf({ id: 'v', model: 'Qwen3.5-35B', contextWindow: undefined }), fp)
ok('指纹：换模型 / 改窗口声明 / 换 provider 都会变',
  fp !== modelFingerprintOf({ id: 'v', model: 'DeepSeek-V3', contextWindow: undefined }) &&
  fp !== modelFingerprintOf({ id: 'v', model: 'Qwen3.5-35B', contextWindow: 100000 }) &&
  fp !== modelFingerprintOf({ id: 'v2', model: 'Qwen3.5-35B', contextWindow: undefined }), fp)
ok('指纹：无 provider 也有稳定取值（不会因 undefined 反复触发套用）',
  modelFingerprintOf(null) === 'none' && modelFingerprintOf(undefined) === 'none')

ok('判定：关掉开关 → off（完全手工）',
  shouldApplyTuning({ autoTune: false, tunedFor: 'x', fingerprint: 'y' }) === 'off')
ok('判定：首次（未登记）→ registered（只登记，不动老用户已调好的配置）',
  shouldApplyTuning({ autoTune: true, tunedFor: undefined, fingerprint: 'y' }) === 'registered')
ok('🔴 判定：同模型 → same-model（用户手调的值必须留住）',
  shouldApplyTuning({ autoTune: true, tunedFor: 'y', fingerprint: 'y' }) === 'same-model')
ok('判定：换了模型 → apply',
  shouldApplyTuning({ autoTune: true, tunedFor: 'y', fingerprint: 'z' }) === 'apply')
ok('判定：tunedFor 为空串按"未登记"处理（真实指纹不会是空串，故不会误判）',
  shouldApplyTuning({ autoTune: true, tunedFor: '', fingerprint: 'y' }) === 'registered')

console.log(`\n—— modelCapacity 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
