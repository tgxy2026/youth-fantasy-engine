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
 *     （设定 + 记忆 + 对话历史要同时命中），故取**偏保守的 0.4**。
 *
 * 本模块是纯逻辑、零运行时依赖（只 `import type`），便于单测。
 */
import type { AIProvider } from './ai'

/** 本地部署判定：Ollama 原生，或标记为「本机/局域网」的 OpenAI 兼容服务 */
export function isLocalProvider(p: Pick<AIProvider, 'type' | 'local'> | null | undefined): boolean {
  if (!p) return true // 未知就当本地（保守：不放宽预算）
  return p.type === 'ollama' || p.local === true
}

/**
 * 已知模型的上下文窗口（tokens）。
 * ⚠️ 只收录**能确认**的；查不到就走保守兜底（见 FALLBACK_WINDOW），并把 windowSource 标成 fallback，
 *    让 UI 能如实告诉用户"这是猜的，你可以在模型配置里手填"。
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

/** 云端有效系数：标称窗口 × 它 ≈ 可靠推理长度。依据见文件头注释。 */
export const CLOUD_EFFECTIVE_RATIO = 0.4

/** 给回复预留的 token（本地与云端都留 —— 预算算的是"输入能放多少"） */
export const REPLY_RESERVE_TOKENS = 8192

export interface CapacityAdvice {
  local: boolean
  windowTokens: number
  windowSource: 'user' | 'preset' | 'fallback'
  /** 预设标签（windowSource==='preset' 时给出，用于界面显示"识别为 Qwen3.5 系列"） */
  windowLabel?: string
  /** 建议的 numCtx；null = 云端，该参数对当前 provider 无效 */
  suggestNumCtx: number | null
  /** 建议的上下文预算（字符，≈ token 数） */
  suggestContextBudget: number
  /** 按建议预算估算的每轮输入 token（≈ 字符数，中文场景 1 字 ≈ 1 token） */
  approxPromptTokens: number
  /** 给界面用的一句人话解释 */
  note: string
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
  if (typeof userSet === 'number' && userSet > 0) {
    windowTokens = Math.floor(userSet)
    windowSource = 'user'
  } else {
    const hit = KNOWN_WINDOWS.find(k => k.re.test(String(p?.model ?? '')))
    if (hit) { windowTokens = hit.window; windowSource = 'preset'; windowLabel = hit.label }
    else windowTokens = FALLBACK_WINDOW
  }

  if (local) {
    // 本地：numCtx 由显存决定，**不按模型标称放宽**；预算保持用户现值
    return {
      local: true,
      windowTokens: current.numCtx,
      windowSource: 'user',
      suggestNumCtx: current.numCtx,
      suggestContextBudget: current.contextBudget,
      approxPromptTokens: current.contextBudget,
      note: `本地部署：上下文窗口由显存决定（当前 ${current.numCtx}），不随模型标称值放宽。` +
        `模型标称 ${windowTokens >= 1000 ? Math.round(windowTokens / 1024) + 'K' : windowTokens} 属架构容量，单卡跑不到。`,
    }
  }

  // 云端：有效可用 = 窗口 × 系数 − 回复预留
  const usable = Math.floor(windowTokens * CLOUD_EFFECTIVE_RATIO) - REPLY_RESERVE_TOKENS
  const suggestContextBudget = Math.max(4000, usable)
  const kind = windowSource === 'user' ? '你填写的窗口'
    : windowSource === 'preset' ? `识别为 ${windowLabel}`
    : `未识别到该模型，按保守值 ${FALLBACK_WINDOW} 估算（可在模型配置里手填窗口）`

  return {
    local: false,
    windowTokens,
    windowSource,
    windowLabel,
    suggestNumCtx: null,
    suggestContextBudget,
    approxPromptTokens: suggestContextBudget,
    note: `云端模型：${kind} → 窗口 ${windowTokens} tokens，` +
      `按有效系数 ${CLOUD_EFFECTIVE_RATIO} 折减并预留 ${REPLY_RESERVE_TOKENS} 给回复，` +
      `建议预算约 ${suggestContextBudget} 字符。「上下文窗口长度（num_ctx）」对云端无效，可忽略。`,
  }
}
