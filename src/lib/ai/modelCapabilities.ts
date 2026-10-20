// ============ Q5 输出协议与能力 · 能力配置 ============
// 2026-10-20 · 方案 §11 / WQ5
//
// 🔴 本文件是纯业务逻辑，不 import 任何 UI。
//    它负责：
//    ① 模型能力检测与配置
//    ② JSON 输出能力声明
//    ③ 思考模式控制
//    ④ 能力降级策略

/**
 * 🔴 能力类型**住在本文件**，不放进 `revision/revisionTypes.ts`：
 *    那个文件是 MQ0 冻结的**跨包共用契约**，而"模型能力"是 AI 层的领域概念，
 *    只有本模块与测试使用。放契约里会把共用文件变成谁都能塞的抽屉
 *    （2026-10-20 已发生过一次整文件覆盖的事故）。
 */
export interface ModelCapability {
  /** 能力名 */
  name: string
  /** 是否支持 */
  supported: boolean
  /** 备注 */
  note?: string
}

export interface ModelCapabilities {
  /** 模型 ID */
  modelId: string
  /** 是否支持 JSON 输出 */
  jsonOutput: boolean
  /** 是否支持思考模式 */
  thinking: boolean
  /** 最大上下文长度 */
  maxContext: number
  /** 最大输出长度 */
  maxOutput: number
  /** 额外能力 */
  extra: ModelCapability[]
}

// ============ 默认能力配置 ============
export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  modelId: 'default',
  jsonOutput: true,
  thinking: false,
  maxContext: 32768,
  maxOutput: 4096,
  extra: [],
}

// ============ 能力检测 ============
/** 根据模型 ID 推断能力（首版用静态表，后续可接入模型注册表） */
export function detectCapabilities(modelId: string): ModelCapabilities {
  // 已知模型能力表（按模型家族推断）
  const known: Record<string, Partial<ModelCapabilities>> = {
    // 深度推理模型
    'deepseek-r1': { jsonOutput: true, thinking: true, maxContext: 65536, maxOutput: 32768 },
    'qwen3': { jsonOutput: true, thinking: true, maxContext: 32768, maxOutput: 8192 },
    'qwen3-thinking': { jsonOutput: true, thinking: true, maxContext: 32768, maxOutput: 8192 },
    // 通用模型
    'gpt-4o': { jsonOutput: true, thinking: false, maxContext: 128000, maxOutput: 16384 },
    'gpt-4o-mini': { jsonOutput: true, thinking: false, maxContext: 128000, maxOutput: 16384 },
    'claude-3.5-sonnet': { jsonOutput: true, thinking: false, maxContext: 200000, maxOutput: 8192 },
    'claude-3.5-haiku': { jsonOutput: true, thinking: false, maxContext: 200000, maxOutput: 8192 },
    // 本地小模型
    'qwen2.5': { jsonOutput: true, thinking: false, maxContext: 32768, maxOutput: 4096 },
    'llama3': { jsonOutput: true, thinking: false, maxContext: 8192, maxOutput: 2048 },
    'mistral': { jsonOutput: true, thinking: false, maxContext: 32768, maxOutput: 4096 },
  }

  // 精确匹配
  if (known[modelId]) {
    return { ...DEFAULT_CAPABILITIES, ...known[modelId], modelId }
  }

  // 前缀匹配（如 qwen3:4b、deepseek-r1:free）
  for (const [prefix, caps] of Object.entries(known)) {
    if (modelId.startsWith(prefix + ':') || modelId.startsWith(prefix + '-')) {
      return { ...DEFAULT_CAPABILITIES, ...caps, modelId }
    }
  }

  // 未知模型：保守默认
  return { ...DEFAULT_CAPABILITIES, modelId }
}

// ============ JSON 输出能力声明 ============
/** 是否应启用 JSON 模式（向请求同步声明 schema/format） */
export function shouldUseJsonMode(caps: ModelCapabilities): boolean {
  return caps.jsonOutput
}

// ============ 思考模式控制 ============
/** 是否应启用思考模式 */
export function shouldUseThinking(caps: ModelCapabilities, taskType: string): boolean {
  // 推理类任务优先用思考模式
  const thinkingTasks = ['chapter-review', 'setting-audit', 'continuity-check', 'proofread']
  if (thinkingTasks.includes(taskType)) {
    return caps.thinking
  }
  // 其他任务默认不启用（避免过度思考）
  return false
}

// ============ 能力降级策略 ============
export interface CapabilityDowngrade {
  /** 原始能力 */
  original: string
  /** 降级后的能力 */
  downgraded: string
  /** 是否成功降级 */
  ok: boolean
  /** 降级原因 */
  reason?: string
}

/** 当 JSON 输出失败时，降级为文本输出 + 后解析 */
export function downgradeJsonOutput(caps: ModelCapabilities): CapabilityDowngrade {
  if (!caps.jsonOutput) {
    return { original: 'jsonOutput', downgraded: 'textOutput', ok: true, reason: '已处于文本模式' }
  }
  return { original: 'jsonOutput', downgraded: 'textOutput', ok: true, reason: 'JSON 输出失败，降级为文本+后解析' }
}

/** 当思考模式不可用时，降级为普通模式 */
export function downgradeThinking(caps: ModelCapabilities): CapabilityDowngrade {
  if (!caps.thinking) {
    return { original: 'thinking', downgraded: 'normal', ok: true, reason: '已处于普通模式' }
  }
  return { original: 'thinking', downgraded: 'normal', ok: true, reason: '思考模式不可用，降级为普通模式' }
}

// ============ 能力校验 ============
export interface CapabilityCheckResult {
  ok: boolean
  /** 缺失的能力 */
  missing: string[]
  /** 建议 */
  suggestions: string[]
}

/** 校验任务所需能力是否满足 */
export function checkCapabilities(
  caps: ModelCapabilities,
  required: { json?: boolean; thinking?: boolean; minContext?: number; minOutput?: number },
): CapabilityCheckResult {
  const missing: string[] = []
  const suggestions: string[] = []

  if (required.json && !caps.jsonOutput) {
    missing.push('jsonOutput')
    suggestions.push('当前模型不支持 JSON 输出，将降级为文本+后解析')
  }
  if (required.thinking && !caps.thinking) {
    missing.push('thinking')
    suggestions.push('当前模型不支持思考模式，将降级为普通模式')
  }
  if (required.minContext && caps.maxContext < required.minContext) {
    missing.push(`maxContext (需要 ${required.minContext}, 实际 ${caps.maxContext})`)
    suggestions.push(`上下文不足，建议拆分任务或使用更大上下文的模型`)
  }
  if (required.minOutput && caps.maxOutput < required.minOutput) {
    missing.push(`maxOutput (需要 ${required.minOutput}, 实际 ${caps.maxOutput})`)
    suggestions.push(`输出长度不足，建议启用流式输出或拆分任务`)
  }

  return {
    ok: missing.length === 0,
    missing,
    suggestions,
  }
}
