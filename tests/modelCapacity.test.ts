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
//   ⑥ **上下文窗口是必填项**（2026-10-04·2.8.0）：留空 / 疑似「把 K 当词元数」/ 超上限
//      全部拦在保存前；校验函数与界面共用（checkContextWindow），识别表降级为老数据兜底
import {
  adviseCapacity, isLocalProvider, recommendTuning, scaleGuide, TUNING_LIMITS, lookupWindow,
  CLOUD_EFFECTIVE_RATIO, REPLY_RESERVE_TOKENS, FALLBACK_WINDOW, MIN_SANE_WINDOW, MAX_WINDOW,
  checkContextWindow, modelFingerprintOf, shouldApplyTuning,
} from '../src/lib/ai/modelCapacity'
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
// 🔴 2.8.0：上界已放宽 —— 记忆档必须**按比例跟着预算走**，否则「窗口越大、记忆越不匹配」。
//    旧的 20000 / 2000 会把 1M 窗口下算出的 7.75 万硬夹回去，这条断言就是要盯住它不再发生。
ok('记忆档：1M 窗口模型下按比例放大（不再被旧的 20000 上界顶住）',
  huge.suggest.hardLimit > 20000 && huge.suggest.longTermLimit > 2000,
  JSON.stringify(huge.suggest))
ok('记忆档：放大后仍在放宽后的静态上界内（不是无限膨胀）',
  huge.suggest.hardLimit <= TUNING_LIMITS.hardLimit.max &&
  huge.suggest.longTermLimit <= TUNING_LIMITS.longTermLimit.max, JSON.stringify(huge.suggest))
// 2026-10-03：上限从 100000 提到 2097152（与模型配置输入框一致）后，
// 1M 云端窗口的建议预算（41 万）**不再被静态上限截断** —— 这正是当年「1M 模型可用到 41 万却被输入框卡住」的修复。
ok('记忆档：1M 窗口模型的建议预算不再被静态上限截断（41 万能直接填）',
  huge.suggest.contextBudget > 100000 && huge.suggest.contextBudget <= TUNING_LIMITS.contextBudget.max,
  String(huge.suggest.contextBudget))

// ---------- ⑧-b 本地手填窗口 ⇒ 预算与记忆档一起放大（2.8.0 老大定案）----------
{
  const b128 = adviseCapacity(
    { type: 'ollama', local: true, model: 'qwen3.8-27b-write', contextWindow: 131072 },
    { numCtx: 32768, contextBudget: 24000 },
  )
  ok('🔴 本地手填 128K：建议预算按窗口放大到约 9.6 万（此前恒定 24000）',
    Math.abs(b128.suggest.contextBudget - Math.floor(131072 * (24000 / 32768))) <= 500,
    String(b128.suggest.contextBudget))
  ok('🔴 本地手填 128K：记忆档按放大后的预算同比放大（硬上限 > 出厂 3000）',
    b128.suggest.hardLimit > 3000 && b128.suggest.softLimit > 2000, JSON.stringify(b128.suggest))
  ok('🔴 固定开销预留：出厂 24000 预算下仍是 400（默认行为不变）',
    recommendTuning(24000, 32768).fixedOverhead === 400, String(recommendTuning(24000, 32768).fixedOverhead))
  ok('🔴 固定开销预留：大预算下跟着涨（1M 云端 → 数千字）',
    huge.suggest.fixedOverhead > 400 && huge.suggest.fixedOverhead <= TUNING_LIMITS.fixedOverhead.max,
    String(huge.suggest.fixedOverhead))
}

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

// 🔴 2.8.0 语义变更：本地改为**按窗口主动放大**，建议值一律取「窗口 × 出厂配比」
//    （出厂 32K ⇒ 正好 24000，默认行为不变）。用户手调的值仍然留得住 ——
//    因为自动套用只在「换模型」时发生，判据见 ⑬ 的指纹判定链。
const lowered = adviseCapacity({ type: 'ollama', model: 'qwen3.5-27b' }, { numCtx: 32768, contextBudget: 12000 })
ok('超窗口：低于上限时同样按窗口给出建议值（本地也主动放大）',
  !lowered.overWindow && lowered.suggest.contextBudget === 24000, String(lowered.suggest.contextBudget))

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

// ---------- ⑥ 「把 K 当词元」的误填（2026-10-04 新增，MIN_SANE_WINDOW）----------
// 真实来路：作者在模型配置里把「128K」写成 128、「96K」写成 96。
// 若照单全收，窗口就成了 128 个词元 —— 预算与记忆档全塌成下限值，而作者还以为配对了。
{
  ok('常量：可信下限在 2K 量级（与 TUNING_LIMITS.numCtx.min 同档）', MIN_SANE_WINDOW >= 2000, String(MIN_SANE_WINDOW))

  const localSlip = adviseCapacity({ type: 'ollama', model: 'm-x', contextWindow: 128 }, { numCtx: 32768, contextBudget: 24000 })
  ok('🔴 本地填 128（疑似 128K）→ 不采纳，窗口回落面板现值',
    localSlip.windowTokens === 32768, String(localSlip.windowTokens))
  ok('🔴 本地填 128 → numCtxFromUserWindow 为假（不会把这值写回酒馆设置）',
    localSlip.numCtxFromUserWindow === false)

  const cloudSlip = adviseCapacity({ type: 'openai', local: false, model: 'qwen3-max', contextWindow: 96 }, { numCtx: 32768, contextBudget: 24000 })
  ok('🔴 云端填 96（疑似 96K）→ 不采纳，改按模型名识别',
    cloudSlip.windowSource === 'preset', cloudSlip.windowSource)
  ok('云端填 96 → 落地的是识别值 131072（Qwen3 系列）',
    cloudSlip.windowTokens === 131072, String(cloudSlip.windowTokens))

  const okValue = adviseCapacity({ type: 'openai', local: false, model: 'qwen3-max', contextWindow: 98304 }, { numCtx: 32768, contextBudget: 24000 })
  ok('对照：填 98304（真词元数）照常采纳',
    okValue.windowSource === 'user' && okValue.windowTokens === 98304, `${okValue.windowSource}/${okValue.windowTokens}`)
}

// ---------- ⑭ 必填校验（2026-10-04 老大定案：这一项从选填改必填）----------
// 背景：原先留空时按模型名去识别表猜窗口 —— 那张表要跟着各家发布节奏常年维护，
// 且本地 / 自建 / 冷门模型永远认不出。改成必填 + 强制换算提示后，"猜错"这条路就不存在了。
// 🔴 界面（模型配置页的实时提示与保存拦截）与这里**共用同一个函数**，不得各写一套。
{
  ok('常量：输入框上限与面板 numCtx 上限同源（不两套标准）',
    MAX_WINDOW === TUNING_LIMITS.numCtx.max, `${MAX_WINDOW} vs ${TUNING_LIMITS.numCtx.max}`)

  const empty = checkContextWindow(undefined)
  ok('必填：未填 → 不通过，且给出中文原因（可直接显示）',
    !empty.ok && /必填/.test(empty.error ?? ''), empty.error)
  ok('必填：null / NaN 同样不通过',
    !checkContextWindow(null).ok && !checkContextWindow(Number.NaN).ok)

  const slip = checkContextWindow(128)
  ok('🔴 必填：填 128（疑似把 K 当词元）→ 不通过，并给出换算建议 131072',
    !slip.ok && slip.suggest === 131072, JSON.stringify(slip))
  ok('必填：原因文案里带上应填的数（界面会直接显示）',
    (slip.error ?? '').includes('131072'), slip.error)

  ok('必填：正常值通过（98304 / 131072）',
    checkContextWindow(98304).ok && checkContextWindow(131072).ok)
  ok('必填：正好等于可信下限算通过（边界不误伤）',
    checkContextWindow(MIN_SANE_WINDOW).ok)
  ok('必填：超上限不通过（多打一位要拦下来）',
    !checkContextWindow(MAX_WINDOW + 1).ok)
  ok('必填：校验与算法同源 —— 通过的值一定被 adviseCapacity 采纳为用户窗口',
    checkContextWindow(131072).ok &&
    adviseCapacity({ type: 'openai', local: false, model: 'x', contextWindow: 131072 }, CUR).windowSource === 'user')
}

console.log(`\n—— modelCapacity 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
