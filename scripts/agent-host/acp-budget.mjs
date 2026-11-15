/**
 * 3.5.6 · ACP 上下文预算（纯逻辑，便于单测）
 *
 * 规划口径（docs/3.5.6-开发规划-ACP剩余AI功能接入与覆盖收口-2026-11-14.md）：
 *   ① 先确定**有效容量**：手填窗口 > 适配器可验证的会话能力 > 未知（不猜）；
 *   ② 按 Agent 与实际模型保存，手填值可以调小，不能越过已确认的服务/宿主上限；
 *   ③ 发送上限与输出预留由窗口推出，界面分别显示「自动值 / 手填值 / 本次生效值」。
 *
 * 🔴 三条不许让步的口径：
 *   · **未知就是未知**：组件不回报窗口时 `windowTokens = null`，由界面显示「实际窗口未知」；
 *     只有引擎内部需要兜底时才用 `ACP_FALLBACK_WINDOW`，并必须标明来源，不能冒充真实容量。
 *   · **手填不越界**：发送上限不得超过「窗口 − 输出预留 − 安全余量」；
 *     超出时 clamp 并给出原因，而不是照单全收后让请求被端点截断。
 *   · **本文件零依赖**：不读文件、不碰 Electron，runtime 与单测共用同一套判定。
 */

/** 组件不回报窗口时的保守估算（与 API 侧 `FALLBACK_WINDOW` 同值，口径一致） */
export const ACP_FALLBACK_WINDOW = 32768
/** 手填窗口的可信下限：小于它的值多半是把 K 当成了 tokens（与模型配置同一判据） */
export const MIN_ACP_BUDGET_WINDOW = 2000
/** 手填窗口上限：2M（与模型配置 `MAX_WINDOW` 同一上限） */
export const MAX_ACP_BUDGET_WINDOW = 2097152
/** 未手填时的默认输出预留（与 `REPLY_RESERVE_TOKENS` 同值） */
export const DEFAULT_ACP_OUTPUT_RESERVE = 8192
/** 资料可用窗口占比、安全余量、输出预留上限（与 `requestBudget.ts` 同口径） */
const MATERIAL_SHARE = 0.5
const SAFETY_MARGIN_RATIO = 0.05
const MAX_OUTPUT_SHARE = 0.4

/** 预算相关配置键（runtime settings 与 IPC 白名单共用） */
export const ACP_BUDGET_FIELDS = ['budgetWindow', 'budgetSend', 'budgetOutput']

/**
 * 把输入框里的值解析成正整数 tokens。
 * `''` / 缺省 / 非法值一律返回 null —— 调用方据此区分「自动」与「手填」。
 */
export function parseBudgetNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 ? Math.floor(value) : null
  }
  if (typeof value !== 'string' || !value.trim()) return null
  const n = Number(value.trim())
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/** 校验一个预算字段；返回中文原因，合法时返回 null。空字符串表示恢复自动。 */
export function budgetFieldError(key, value) {
  if (!ACP_BUDGET_FIELDS.includes(key)) return '未知的预算字段。'
  if (value === '') return null
  const n = parseBudgetNumber(value)
  if (n === null) return '请填写正整数（tokens）；留空表示按窗口自动推算。'
  if (key === 'budgetWindow') {
    if (n < MIN_ACP_BUDGET_WINDOW) {
      return `${n} tokens 太小了：这里填 token 数，不是「${n}K」——要表达 ${n}K 请填 ${n * 1024}。`
    }
    if (n > MAX_ACP_BUDGET_WINDOW) return `窗口不能超过 ${MAX_ACP_BUDGET_WINDOW}（2M tokens）。`
    return null
  }
  if (key === 'budgetSend') {
    if (n < 256) return '发送上限至少 256 tokens。'
    if (n > MAX_ACP_BUDGET_WINDOW) return '发送上限超出可配置范围。'
    return null
  }
  if (n < 64) return '输出预留至少 64 tokens。'
  if (n > MAX_ACP_BUDGET_WINDOW) return '输出预留超出可配置范围。'
  return null
}

/**
 * 从会话选项里取「适配器可验证的窗口」。
 *
 * 当前 Antigravity 的 `session/new` 只提供模型与推理档位，没有窗口字段 ⇒ 返回 null。
 * 这里只认**明确数字**：不接受从模型名猜、不接受调用方传入的数值（那不是权限依据）。
 */
export function readAdapterWindow(sessionOptions) {
  const raw = sessionOptions?.contextWindow
    ?? sessionOptions?.model?.contextWindow
    ?? sessionOptions?.model?.context_window
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  if (raw < MIN_ACP_BUDGET_WINDOW || raw > MAX_ACP_BUDGET_WINDOW) return null
  return Math.floor(raw)
}

/**
 * 解析当前 Agent + 实际模型的有效预算。
 *
 * @param {object} input
 * @param {string|null} input.agentId
 * @param {string} input.agentName
 * @param {string|null} input.model        实际模型标识（未选则为 Agent 默认）
 * @param {string} input.modelLabel        给人看的模型名
 * @param {object} input.config            该 Agent 保存的配置（含 budgetWindow/budgetSend/budgetOutput 字符串）
 * @param {object|null} input.sessionOptions 会话选项投影（可含 contextWindow）
 */
export function resolveAcpBudget({
  agentId = null,
  agentName = '',
  model = null,
  modelLabel = '',
  config = {},
  sessionOptions = null,
} = {}) {
  const userWindow = parseBudgetNumber(config.budgetWindow)
  const adapterWindow = readAdapterWindow(sessionOptions)
  const windowTokens = userWindow ?? adapterWindow ?? null
  const windowSource = userWindow ? 'user' : adapterWindow ? 'adapter' : 'unknown'
  const effectiveWindow = windowTokens ?? ACP_FALLBACK_WINDOW

  const userSend = parseBudgetNumber(config.budgetSend)
  const userOutput = parseBudgetNumber(config.budgetOutput)
  const autoOutput = Math.max(256, Math.min(DEFAULT_ACP_OUTPUT_RESERVE, Math.floor(effectiveWindow * MAX_OUTPUT_SHARE)))
  const outputReserveTokens = userOutput ?? autoOutput
  const safetyMarginTokens = Math.floor(effectiveWindow * SAFETY_MARGIN_RATIO)
  const autoSend = Math.max(256, Math.floor(effectiveWindow * MATERIAL_SHARE))
  const wantedSend = userSend ?? autoSend
  const ceiling = Math.max(0, effectiveWindow - outputReserveTokens - safetyMarginTokens)
  const sendBudgetTokens = Math.max(0, Math.min(wantedSend, ceiling))
  const sendClamped = wantedSend > ceiling

  const modelText = model || 'Agent 默认模型'
  const labelText = modelLabel || modelText
  let notice
  if (windowSource === 'user') {
    notice = `窗口按你为「${labelText}」手填的 ${windowTokens} tokens；本次最多发送 ${sendBudgetTokens}，预留输出 ${outputReserveTokens}。`
  } else if (windowSource === 'adapter') {
    notice = `窗口来自 Agent 会话回报（${windowTokens} tokens）；本次最多发送 ${sendBudgetTokens}，预留输出 ${outputReserveTokens}。`
  } else {
    notice = `实际窗口未知：${agentName ? `${agentName} ` : ''}当前没有回报上下文窗口，`
      + `引擎按 ${ACP_FALLBACK_WINDOW} tokens 保守估算。要使用真实容量，请在下方手填窗口。`
  }
  if (sendClamped) {
    notice += ` 手填发送上限 ${wantedSend} 超过窗口可用额度，已收敛到 ${sendBudgetTokens}（窗口 − 输出预留 − 安全余量）。`
  }

  return {
    agentId,
    agentName,
    model: model ?? null,
    modelLabel: labelText,
    configured: {
      window: typeof config.budgetWindow === 'string' ? config.budgetWindow : '',
      send: typeof config.budgetSend === 'string' ? config.budgetSend : '',
      output: typeof config.budgetOutput === 'string' ? config.budgetOutput : '',
    },
    windowTokens,
    windowSource,
    effectiveWindow,
    fallbackWindow: ACP_FALLBACK_WINDOW,
    sendBudgetTokens,
    sendBudgetSource: userSend ? 'user' : 'auto',
    outputReserveTokens,
    outputReserveSource: userOutput ? 'user' : 'auto',
    safetyMarginTokens,
    inputAllowanceTokens: sendBudgetTokens,
    fallbackUsed: windowTokens === null,
    notice,
  }
}
