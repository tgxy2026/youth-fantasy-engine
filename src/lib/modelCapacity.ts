/**
 * 模型能力档案：按「当前接的是谁」推算上下文上限与推荐预算。
 *
 * 【为什么需要这个模块】
 * 酒馆的 `numCtx: 32768` 与 `contextBudget: 24000` 是**为本地 5090 + 27B q6_K 算出来的**
 * （22GB 权重 + 8GB KV cache ≈ 32GB 显存上限，见 `tavern/types.ts` 的注释）。
 * 但 `num_ctx` 是 **Ollama 专有字段** —— 云端 OpenAI 兼容端点（硅基流动 / DeepSeek / 通义…）
 * 根本不认它（会被 `openaiSampling()` 的白名单丢弃）。
 *
 * 于是接上云端大窗口模型（如 Qwen3.5-35B 标称 256K）时，面板里仍是 32768 / 24000，
 * 明明有 8 倍空间却用不上，而且**界面上没有任何提示**告诉用户"这两个数在云端是无效/过小的"。
 * 本模块就是补这个缺口：识别当前 provider 属于哪一类，给出该类的合理上限。
 *
 * 【两条原则】
 *  ① **本地绝不放宽**：numCtx 是显存安全阀 —— 不能因为"模型标称很大"就跟着放大，放大就跑不动。
 *  ② **云端按「标称窗口 × 有效系数」**：标称窗口不是可靠推理长度（RULER/NIAH-2 实测有效值
 *     通常只有标称的 30~65%，多针检索还要再低 15~40 分）；酒馆又是典型"多针"场景
 *     （设定 + 记忆 + 对话历史要同时命中），故取 **0.6**（2026-10-04 老大定案：原 0.4
 *     偏保守 —— 128K 模型只给 4.4 万字预算，作者反馈「取值和赋值过于保守」）。
 *
 * 【2026-09-17 扩展：从"只管预算"到"管一整批跟着模型走的数"】
 * 老大的原话是「取值范围和推荐都是基于我的设备定的，能不能跟着模型变」。
 * 于是本模块算的不只是预算与窗口，还有**记忆档**（软上限 / 硬上限 / 长期摘要 / 日记保留），
 * 并给出 `scaleGuide()` 用来**动态放宽输入框上限** —— 那些上限同样是按本地设备定的：
 * `contextBudget` 静态上限 100000，1M 窗口的云端模型本可用到 41 万，却被输入框卡住。
 *
 * 本模块是纯逻辑、零运行时依赖（只 `import type`），便于单测。
 */
import type { AIProvider } from './ai'
import type { ParamGuide } from './tavern/paramGuide'

/** 本地部署判定：Ollama 原生，或标记为「本机/局域网」的 OpenAI 兼容服务 */
export function isLocalProvider(p: Pick<AIProvider, 'type' | 'local'> | null | undefined): boolean {
  if (!p) return true // 未知就当本地（保守：不放宽预算）
  return p.type === 'ollama' || p.local === true
}

/**
 * 已知模型的上下文窗口（tokens）。
 *
 * 🔴 2026-10-04（2.8.0）**已降级为老数据兜底**：模型配置里的「上下文窗口」改成**必填**之后，
 *    识别表不再是推荐路径 —— 它只为**老库里还没填窗口的模型**兜住底线
 *    （免得升级瞬间把它们的预算与记忆档从"识别值"塌成 32K）。
 *
 * 🔴 所以**不要再往里补数值**（老大明确：不必常年跟着各家发布节奏维护这张表）。
 *    某个模型的窗口要修正，让作者在「模型配置」里手填 —— 那是唯一真源。
 *
 * ⚠️ 仍然只收录**能确认**的；查不到就走保守兜底（见 FALLBACK_WINDOW），并把 windowSource 标成 fallback。
 * 顺序敏感：先匹配先生效（更具体的写在前面）。
 */
const KNOWN_WINDOWS: { re: RegExp; window: number; label: string }[] = [
  // 通义千问 Qwen3.5 / 3.6 系列：硅基流动标注 256K（同款 Qwen3.5-Flash 官方默认到 1M）
  { re: /qwen3?\.?[56]/i, window: 262144, label: 'Qwen3.5/3.6 系列（256K）' },
  { re: /qwen3(?!\.?[56])/i, window: 131072, label: 'Qwen3 系列（128K）' },
  { re: /qwen2\.5/i, window: 131072, label: 'Qwen2.5（128K）' },
  // DeepSeek：V3 系列 128K、R1 系列 96K（硅基流动 2025-05 升级后）
  { re: /deepseek-r1/i, window: 98304, label: 'DeepSeek-R1（96K）' },
  { re: /deepseek-v3/i, window: 131072, label: 'DeepSeek-V3（128K）' },
  { re: /glm-4\.[56]/i, window: 204800, label: 'GLM-4.5/4.6（200K）' },
  { re: /kimi-k2/i, window: 262144, label: 'Kimi-K2（256K）' },
  { re: /gpt-4\.1/i, window: 1047576, label: 'GPT-4.1（1M）' },
  { re: /gpt-4o/i, window: 131072, label: 'GPT-4o（128K）' },
  { re: /claude/i, window: 204800, label: 'Claude（200K）' },
  { re: /gemini/i, window: 1048576, label: 'Gemini（1M）' },
]

/** 认不出来时的保守默认（宁可少给，也不要让用户一上来就付长上下文的账） */
export const FALLBACK_WINDOW = 32768

/**
 * 「上下文窗口」输入框的**可信下限**（词元）。
 *
 * 🔴 2026-10-04（2.8.0）老大定案：填小于它的值，几乎只有一种来路 ——
 *    作者把「128K」写成了 `128`（把 K 当成了词元数）。真实模型里窗口最小的也在 32K 量级
 *    （Qwen3-0.6B 与 gemma3:1b 都是 32K），2K 以下的窗口已属罕见。
 *
 * 这类值**一律不采纳**（不当作手填，继续走「按模型名识别 → 保守兜底」）：
 *    否则 128 会被当成「只有 128 个词元的窗口」，把预算与记忆档全塌成下限值，
 *    而作者还以为自己配对了个大窗口模型 —— 这种错**在界面上看不出来**，最危险。
 *
 * 🔴 界面侧（`AIConfigPanel`）必须复用**这一个**常量去给换算提示（「128K 应填 131072」），
 *    别在组件里另写一个阈值 —— 两处各写一份必然漂移。
 */
export const MIN_SANE_WINDOW = 2000

/**
 * 上下文窗口输入框的**上限**（tokens）= 2M。
 *
 * 与 `TUNING_LIMITS.numCtx.max` **同一真源**（单测比对，漂了就红）——
 * 免得出现"模型配置允许填的数"与"酒馆面板允许填的数"两套标准。
 */
export const MAX_WINDOW = 2097152

export interface WindowCheck {
  ok: boolean
  /** 不合法时的**中文原因**（可直接显示，界面不必再拼文案） */
  error?: string
  /** 疑似「把 K 当词元数」时给出的换算建议（`K × 1024`），界面据此渲染一键换算 */
  suggest?: number
}

/**
 * 校验「模型配置 → 上下文窗口」的输入。
 *
 * 🔴 2026-10-04（2.8.0）老大定案：这一项由**选填**改为**必填**。
 *    原先留空时靠上面的识别表按模型名猜窗口，而那张表得跟着各家发布节奏常年维护
 *    （同一个模型不同版本窗口能差一倍），本地 / 自建 / 冷门模型更是永远认不出。
 *    改成必填 + 强制换算提示后，作者按自己的部署填一次（**1K = 1024 tokens**），
 *    全项目读同一个数，"猜错"这条路就不存在了。
 *
 * 🔴 界面（`AIConfigPanel`）的实时提示与保存拦截**必须共用这一个函数** ——
 *    两边各写一套阈值必然漂移（这是本项目反复踩过的老坑）。
 *
 * @param v 输入框里的原始值（可能未填 / 非数）
 */
export function checkContextWindow(v: number | null | undefined): WindowCheck {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return { ok: false, error: '请填写上下文窗口（tokens）—— 这一栏是必填：填模型标称的 token 数，1K = 1024。' }
  }
  if (v < MIN_SANE_WINDOW) {
    const k = v * 1024
    return {
      ok: false,
      suggest: k,
      error: `${v} tokens 太小了 —— 这一栏填的是 token 数量，不是「${v}K」：`
        + `要表达 ${v}K 请填 ${k}（${v} × 1024）。`,
    }
  }
  if (v > MAX_WINDOW) {
    return { ok: false, error: `超出上限 ${MAX_WINDOW}（2M tokens）—— 请核对是否多打了一位。` }
  }
  return { ok: true }
}

/**
 * 查「这个模型名能认出多大窗口」——认不出返回 null。
 *
 * ⚠️ 2026-10-04 起**不再用于界面提示**（窗口已改必填）：模型配置页那句
 *    「留空会识别成什么」的实时提示已随之移除。现在只有 `adviseCapacity`
 *    在「老库里的模型没填窗口」时调它兜底 —— 界面不再向作者承诺任何自动识别。
 */
export function lookupWindow(model: string | undefined | null): { window: number; label: string } | null {
  const hit = KNOWN_WINDOWS.find(k => k.re.test(String(model ?? '')))
  return hit ? { window: hit.window, label: hit.label } : null
}

/** 云端有效系数：标称窗口 × 它 ≈ 可靠推理长度。依据见文件头注释。 */
export const CLOUD_EFFECTIVE_RATIO = 0.6

/** 给回复预留的 token（本地与云端都留 —— 预算算的是"输入能放多少"） */
export const REPLY_RESERVE_TOKENS = 8192

/**
 * 本地「预算 : 窗口」的**出厂配比** = 24000 / 32768 ≈ 0.732。
 *
 * 预算必须小于 numCtx 才有意义（预算 > 窗口 ⇒ 塞进去的内容被静默截断）。
 * 出厂值就是按这个比例配的，故用它当**安全上限**：超过它说明这份预算多半来自云端
 * （云端可到 41 万），切回本地后需要回落。
 */
const LOCAL_BUDGET_OF_CTX = 24000 / 32768

// ============================================================
// 记忆档：跟着预算走的推荐
// ============================================================

/**
 * 各参数的硬边界与步长 —— **必须与 `tavern/paramGuide.ts` 的 `ParamGuide.min/max/step` 一致**，
 * `tests/modelCapacity.test.ts` 会逐项比对，漂了就红。
 *
 * 为什么不直接 import `PARAM_GUIDES`：本模块刻意保持**零运行时依赖**（只 `import type`），
 * 这样单测能直接跑、也不会和 tavern 那套形成环。一致性交给测试守。
 */
// 🔴 2026-10-03 老大定案：**上限不再自己设小**，与「模型配置 → 上下文窗口」那个输入框一致（2097152 = 2M）。
//    起因：本机实测四个模型窗口是 96K / 128K / 256K / 256K（差 2.7 倍），而原上限 131072（128K）
//    会让 256K 的模型**根本调不上去**；再往上调到 2M 也是同理 —— 限制该由「模型能跑多少」决定，
//    不该由这个文件替用户拍板。
//    ⚠️ 上限放开 ≠ 风险消失，真正的守门在两处**必要提醒**：
//      ① `adviseCapacity` 本地分支的「超窗口保护」：预算 > 窗口 × 出厂配比 ⇒ 会被 Ollama 静默截断（先裁协议与设定）；
//      ② 分段说明（`paramGuide`）里写清「超出会加载失败或被截断，按你实测的上限填」。
//    contextBudget 与 numCtx 保持同量级：配比 0.732 下两者必须匹配，否则会出现「窗口 2M、预算 26 万」的错配。
export const TUNING_LIMITS = {
  contextBudget: { min: 1000, max: MAX_WINDOW, step: 500 },
  numCtx: { min: 2048, max: MAX_WINDOW, step: 1024 },
  // 🔴 2026-10-04（2.8.0）：三项记忆上限的**静态上界必须跟着预算一起放宽** ——
  //    1M 云端窗口的预算约 54 万字 ⇒ 硬上限按 12.5% 该是 6.8 万，却被旧上界 20000 夹住，
  //    结果是「窗口越大、记忆反而越不匹配」。上界只作兜底，真实刻度交给动态五档。
  softLimit: { min: 200, max: 200000, step: 100 },
  hardLimit: { min: 200, max: 400000, step: 100 },
  longTermLimit: { min: 100, max: 40000, step: 50 },
  diaryDays: { min: 1, max: 30, step: 1 },
  /** 与 `paramGuide.fixedOverheadChars` 同源（min/max/step 由单测比对，漂了就红） */
  fixedOverhead: { min: 0, max: 20000, step: 100 },
} as const

/**
 * 记忆档的推荐比例 —— **以出厂值为基准反推**，不是另拍一套。
 *
 * 出厂 `contextBudget 24000 → 软 2000 / 硬 3000 / 长期 500 / 日记 7 天`，
 * 是当初在本地 27B 上把配比调好的结果。换模型只该改「总量」，
 * 内在配比跟着缩放即可 —— 否则换个模型记忆就长得不成比例，是另一种"手感漂移"。
 */
const MEM_SOFT_RATIO = 2000 / 24000      // ≈ 8.3% 的预算
const MEM_HARD_RATIO = 3000 / 24000      // = 12.5% 的预算
const MEM_LONGTERM_OF_HARD = 500 / 3000  // ≈ 16.7% 的硬上限
const DIARY_BASE = 7
const DIARY_BASE_BUDGET = 24000

/**
 * 固定开销预留（字）：按预算的约 1% 给，**下限锁在出厂值 400** ——
 * 出厂 24000 预算算出来是 240，仍取 400 ⇒ 默认行为一字不变。
 */
const FIXED_OVERHEAD_RATIO = 0.01
const FIXED_OVERHEAD_FLOOR = 400

/** 对齐到 step 的最近倍数：推出来的值带着零头的话，用户改一下就对不齐输入框步长 */
function snap(v: number, step: number): number {
  return Math.round(v / step) * step
}

function clampTo(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** 一批「跟着当前模型走」的推荐值 */
export interface TuningAdvice {
  /** 上下文预算（字符 ≈ token） */
  contextBudget: number
  /** 本地生效的上下文窗口；**云端为 null**（`num_ctx` 对 OpenAI 兼容端点无效） */
  numCtx: number | null
  softLimit: number
  hardLimit: number
  longTermLimit: number
  diaryDays: number
  /** 固定开销预留（字）：预算的约 1%，下限为出厂值 400 */
  fixedOverhead: number
}

/**
 * 由「上下文预算」推出记忆档的推荐值。
 *
 * 三项记忆上限按预算**线性**缩放；「日记保留」走**开方**缩放 ——
 * 它数的是"生活痕迹有几条"，与窗口大小的相关性本来就弱，
 * 线性放大会让云端模型存下几十条日记、反过来挤占对话历史。
 *
 * 推出来的值一律 clamp 到静态范围内（`hardLimit` 先算，软上限再以它为顶 ——
 * 软上限高于硬上限等于没有上限）。
 */
export function recommendTuning(budget: number, numCtx: number | null): TuningAdvice {
  const B = Math.max(1, budget)
  const L = TUNING_LIMITS

  const hardLimit = clampTo(snap(B * MEM_HARD_RATIO, L.hardLimit.step), L.hardLimit.min, L.hardLimit.max)
  const softLimit = clampTo(
    snap(B * MEM_SOFT_RATIO, L.softLimit.step),
    L.softLimit.min,
    Math.min(L.softLimit.max, hardLimit),
  )
  const longTermLimit = clampTo(
    snap(hardLimit * MEM_LONGTERM_OF_HARD, L.longTermLimit.step),
    L.longTermLimit.min,
    L.longTermLimit.max,
  )
  const diaryDays = clampTo(
    Math.round(DIARY_BASE * Math.sqrt(B / DIARY_BASE_BUDGET)),
    L.diaryDays.min,
    L.diaryDays.max,
  )

  // 🔴 下限用 FIXED_OVERHEAD_FLOOR（出厂 400）而不是 L.fixedOverhead.min（0）：
  //    小预算下 1% 只算出几十字，那点余量挡不住「模型端比我们估的多吃一点」。
  const fixedOverhead = clampTo(
    snap(B * FIXED_OVERHEAD_RATIO, L.fixedOverhead.step),
    FIXED_OVERHEAD_FLOOR,
    L.fixedOverhead.max,
  )

  return { contextBudget: B, numCtx, softLimit, hardLimit, longTermLimit, diaryDays, fixedOverhead }
}

/**
 * 动态放宽一个参数的取值范围。
 *
 * 起因：**输入框的上限也是按本地设备定的** —— `contextBudget` 静态上限 100000，
 * 接上 1M 窗口的云端模型时，41 万的建议值根本填不进去（输入框会自动夹回 100000）。
 *
 * 抬法刻意保守：**只延长最后一段的上界**，不动任何分段边界、不动 min/step、
 * 不动那唯一一个 `recommended` 段 —— 于是 `paramGuide` 的三条不变量
 * （分段首尾相接 / 完整覆盖 [min,max] / 恰好一个推荐段）仍然成立。
 *
 * 本地、或推荐值没超过静态上限时**原样返回同一对象**，行为与改造前完全一致。
 */
export function scaleGuide(guide: ParamGuide, suggested: number): ParamGuide {
  const target = Math.max(guide.max, Math.ceil(suggested * 1.5))
  if (target <= guide.max) return guide
  const bands = guide.bands.map((b, i) =>
    i === guide.bands.length - 1 ? { ...b, to: target } : { ...b },
  )
  return { ...guide, max: target, bands }
}

// ============================================================
// 额度自动跟随：判定（纯函数，便于单测）
// ============================================================

/**
 * 模型指纹：**模型换了**（或窗口声明改了）才需要重新套用推荐额度。
 * 同一模型下手调的值必须留住 —— 这是"自动跟随"与"手工覆盖"能共存的依据。
 */
export function modelFingerprintOf(
  p: Pick<AIProvider, 'id' | 'model' | 'contextWindow'> | null | undefined,
): string {
  return p ? `${p.id}|${p.model ?? ''}|${p.contextWindow ?? ''}` : 'none'
}

export type TuningSyncVerdict =
  /** 用户关掉了自动跟随 → 什么都不动 */
  | 'off'
  /** 首次（指纹未登记）→ 只登记指纹、不改值（老用户升级时不惊动他的配置） */
  | 'registered'
  /** 没换模型 → 不动（保住用户手调的值） */
  | 'same-model'
  /** 换模型了 → 套用推荐值 */
  | 'apply'

/**
 * 该不该把额度套用成推荐值。
 *
 * 抽成纯函数是为了让这段判定**能被单测锁住**：一旦写成"发现偏离就纠正"，
 * 用户手调的值会在每次读设置/开对话时被悄悄改回去 —— 而这种回归在界面上几乎看不出来
 * （只是"我明明改过，怎么又变回来了"）。
 */
export function shouldApplyTuning(opts: {
  autoTune: boolean
  tunedFor: string | undefined
  fingerprint: string
}): TuningSyncVerdict {
  if (!opts.autoTune) return 'off'
  if (!opts.tunedFor) return 'registered'
  if (opts.tunedFor === opts.fingerprint) return 'same-model'
  return 'apply'
}

export interface CapacityAdvice {
  local: boolean
  windowTokens: number
  windowSource: 'user' | 'preset' | 'fallback'
  /** 预设标签（windowSource==='preset' 时给出，用于界面显示"识别为 Qwen3.5 系列"） */
  windowLabel?: string
  /**
   * 窗口数是否来自**模型配置里手填的那个数**（2026-10-03）。
   *
   * 🔴 这是「手填即真源」与「面板自定」两条路的分界：`syncTuningWithModel` 只在它为 true 时
   *    把窗口写回酒馆设置，否则每次换模型都会把面板里调好的值冲掉。
   */
  numCtxFromUserWindow?: boolean
  /** 跟着当前模型走的**一整批**推荐值：上下文预算 + 记忆档四项 */
  suggest: TuningAdvice
  /** 按建议预算估算的每轮输入 token（≈ 字符数，中文场景 1 字 ≈ 1 token） */
  approxPromptTokens: number
  /** 摘要行（界面直接显示）：模型 → 窗口 → 建议预算 → 占比 */
  headline: string
  /** 给界面用的一段人话解释 */
  note: string
  /**
   * 本地专用：当前预算已超出窗口承载范围（预算 > numCtx × 出厂配比）。
   * 多为「先在云端用过大预算、再切回本地」造成，需要回落，否则 prompt 会被静默截断。
   */
  overWindow?: boolean
}

/**
 * 推算当前 provider 的上下文能力与推荐预算。
 *
 * @param p       当前 provider（拿不到就传 null，按本地保守处理）
 * @param current 面板里当前的设置（本地时用于"保持用户现值"，不擅自改）
 */
export function adviseCapacity(
  p: Pick<AIProvider, 'type' | 'local' | 'model' | 'contextWindow'> | null | undefined,
  current: { numCtx: number; contextBudget: number },
): CapacityAdvice {
  const local = isLocalProvider(p)

  // ---- 窗口大小：用户手填 > 预设识别 > 保守兜底 ----
  let windowTokens: number
  let windowSource: CapacityAdvice['windowSource'] = 'fallback'
  let windowLabel: string | undefined
  const userSet = p?.contextWindow
  // 🔴 小于 MIN_SANE_WINDOW 的值判为「疑似把 K 当词元」（见该常量的注释）⇒ **不采纳**，
  //    继续走「按模型名识别 → 保守兜底」，绝不让 128 这种值变成"窗口只有 128 个词元"。
  if (typeof userSet === 'number' && userSet >= MIN_SANE_WINDOW) {
    windowTokens = Math.floor(userSet)
    windowSource = 'user'
  } else {
    const hit = lookupWindow(p?.model)
    if (hit) { windowTokens = hit.window; windowSource = 'preset'; windowLabel = hit.label }
    else windowTokens = FALLBACK_WINDOW
  }

  if (local) {
    // 🔴🔴 2026-10-03 老大定案：**用户手填的窗口就是真源**（本地也一样），随模型走。
    //
    //    为什么改：原先本地一律沿用酒馆面板的 numCtx（出厂 32768），而模型配置页对本地
    //    **禁填**窗口（`AIConfigPanel` 的 disabled）—— 理由是「单一真源」。但本机四个模型实测
    //    窗口是 96K / 128K / 256K / 256K（差 2.7 倍），把「本地」当成一种模型就等于
    //    永远 32K，**换任何模型都发挥不出能力**。
    //    现在的口径：**手填 > 面板现值**；没手填才沿用面板现值（绝不按模型标称自动放宽，
    //    那条显存安全阀的原则仍然留着）。
    const userWindow = windowSource === 'user' ? windowTokens : 0
    const effectiveCtx = userWindow || current.numCtx
    const claim = effectiveCtx >= 1000 ? Math.round(effectiveCtx / 1024) + 'K' : effectiveCtx

    /**
     * 🔴 超窗口保护：预算也可能被云端放大过（云端可达 41 万），而 numCtx 是本地显存定的。
     * 两者不匹配时 prompt 会超过 num_ctx，被 Ollama **静默截断** —— 而被裁掉的恰恰是最前面的
     * 协议与设定（`engine.ts` 里是 `const total = p.contextBudget`，运行时没有任何 clamp）。
     * 故以「出厂配比 × 当前窗口」为安全上限：**只有超限才给回落建议**，
     * 低于上限时一律尊重用户现值（他很可能是刻意调小的）。
     */
    /**
     * 🔴 2026-10-04（2.8.0）老大定案：**本地也按窗口主动放大**（此前只在「超窗口」时回落）。
     *    出厂 32K 窗口下 `窗口 × 出厂配比` 正好 = 24000 —— 与出厂预算**逐字相同**，
     *    所以默认行为不变；手填 128K ⇒ 95,952、256K ⇒ 187,432，窗口一放大预算立刻跟上。
     *    ⚠️ 本地放大 = 显存放大，加载失败就调小窗口 —— 这句提醒必须留在界面上。
     */
    const safeMax = Math.floor(effectiveCtx * LOCAL_BUDGET_OF_CTX)
    const budget = clampTo(
      snap(safeMax, TUNING_LIMITS.contextBudget.step),
      TUNING_LIMITS.contextBudget.min,
      TUNING_LIMITS.contextBudget.max,
    )
    /** 预算超过窗口承载（多为「云端用过再切回本地」）⇒ 会被 Ollama 静默截断，界面要提示回落 */
    const overWindow = current.contextBudget > safeMax

    return {
      local: true,
      windowTokens: effectiveCtx,
      windowSource: 'user',
      /** 🔴 本次窗口是不是来自「模型配置里手填的那个数」—— 决定要不要写回酒馆设置（见 tavern/settings 的 syncTuningWithModel） */
      numCtxFromUserWindow: userWindow > 0,
      overWindow,
      suggest: recommendTuning(budget, effectiveCtx),
      approxPromptTokens: budget,
      headline: `本地 Ollama · 窗口 ${effectiveCtx} 词元（${userWindow ? '按你手填的' : '面板现值'}）· 预算 ${current.contextBudget} 字`
        + (overWindow ? `（超窗口承载，建议 ${budget}）` : (budget !== current.contextBudget ? ` · 建议 ${budget}` : '')),
      note: `本地部署：${userWindow
        ? `窗口以你在模型配置里手填的 ${effectiveCtx} 为准（酒馆的窗口长度、上下文预算与记忆档都跟着它变）。`
        : `窗口取面板现值 ${effectiveCtx}（模型配置里还没手填）；想让预算跟着模型放大，去那里填上窗口。`}` +
        `预算按窗口承载上限给出 ${budget} 字 —— 窗口放大它也放大，显存占用同步上升，` +
        `加载失败就把窗口调小（模型标称 ${claim} 只作参考）。记忆档按 ${budget} 字同比推荐。`
        + (overWindow
          ? `⚠️ 当前预算 ${current.contextBudget} 字已超过本地窗口 ${effectiveCtx} 的承载范围，`
            + `发给模型的资料会被静默截断（先裁协议与设定）。建议回落到 ${budget} 字。`
          : ''),
    }
  }

  // 云端：有效可用 = 窗口 × 系数 − 回复预留
  const usable = Math.max(4000, Math.floor(windowTokens * CLOUD_EFFECTIVE_RATIO) - REPLY_RESERVE_TOKENS)
  const kind = windowSource === 'user' ? '你填写的窗口'
    : windowSource === 'preset' ? `识别为 ${windowLabel}`
    : `未识别到该模型，按保守值 ${FALLBACK_WINDOW} 估算（可在模型配置里手填窗口）`
  const short = windowSource === 'user' ? '你填写的窗口'
    : windowSource === 'preset' ? (windowLabel ?? '')
    : `未识别模型（按 ${FALLBACK_WINDOW} 保守估算）`
  const pct = Math.min(100, Math.round((usable / windowTokens) * 100))

  return {
    local: false,
    windowTokens,
    windowSource,
    windowLabel,
    suggest: recommendTuning(usable, null),
    approxPromptTokens: usable,
    headline: `云端 · ${short} · 窗口 ${windowTokens} 词元 · 建议预算 ${usable} 字（约占窗口 ${pct}%）`,
    note: `云端模型：${kind} → 窗口 ${windowTokens} tokens，` +
      `按有效系数 ${CLOUD_EFFECTIVE_RATIO} 折减并预留 ${REPLY_RESERVE_TOKENS} 给回复，` +
      `建议预算约 ${usable} 字符（记忆档一并按此预算推荐，见下方各项）。` +
      `「上下文窗口长度（num_ctx）」是 Ollama 专有字段，对云端无效、可忽略。`,
  }
}
