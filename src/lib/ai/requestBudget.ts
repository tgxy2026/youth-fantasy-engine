/**
 * 3.2.0 · WQ4：**请求预算**与**发送材料清单**（方案 §16.5）
 *
 * 方案要求的调用顺序（逐字）：
 *   > 解析实际 provider → 固定任务配置 → 选择材料 → **核对完整请求** → 调用
 *
 * 本文件负责其中两块纯计算：
 *   1. `planRequestBudget()` —— 按**实际模型窗口**算出这次请求能放多少输入、留多少输出，
 *      并把"字符数"与"词元数"分开报告（未知 tokenizer 用保守估算并**标明来源**）。
 *   2. `buildMaterialManifest()` —— 记录这次到底发了什么：来源、读取修订、字段定义与权限依据、
 *      包含/裁剪范围、输出协议、预算。它随调用一起走，**不在生成结束后回读最新记录**当"当时依据"。
 *
 * 🔴 三条不许让步的口径：
 *   · 预算是**按实际模型**算的，不是按"默认活动模型"或全局最近一次结果算的（分工模型窗口不同）；
 *   · 放不下时**申报**，不静默裁掉后继续假装完整（那是"看起来检查过了"的假绿）；
 *   · 字符 ≠ 词元：中文 1 字≈1 token、ASCII ≈ 4 字符/token，混排按两者分别累计 ——
 *     只报其中一个数，作者就无法判断"到底还剩多少"。
 */
import { REPLY_RESERVE_TOKENS } from '@/lib/ai/modelCapacity'

/** 资料可用的窗口占比（方案口径：上下文预算 = 模型窗口 × 0.5） */
export const MATERIAL_SHARE_OF_WINDOW = 0.5
/** 安全余量占窗口比例 */
export const SAFETY_MARGIN_RATIO = 0.05
/** 输出预留的窗口上限占比（再大就不该由"资料让位"承担） */
export const MAX_OUTPUT_SHARE_OF_WINDOW = 0.4

export type TokenSource = 'exact' | 'heuristic-mixed'

export interface TokenEstimate {
  /** 估算词元数 */
  tokens: number
  /** 原始字符数（与词元数分开报告） */
  chars: number
  /** 估算依据 —— 未知 tokenizer 时必须如实说明是估算 */
  source: TokenSource
}

const CJK_RE = /[\u3000-\u9fff\uf900-\ufaff\uac00-\ud7af]/

/**
 * 估算一段文本的词元数。
 *
 * 🔴 保守估算（宁可高估）：中文/全角字符按 1 字 1 token，其余按 4 字符 1 token。
 *    低估的后果是"以为放得下、实际被端点截断"，而截断是静默的 —— 高估只会让作者少塞一点资料。
 *    本函数**不假装精确**：`source` 恒为 `heuristic-mixed`，除非将来接入真实 tokenizer。
 */
export function estimateTokens(text: string | null | undefined): TokenEstimate {
  const s = String(text ?? '')
  if (!s) return { tokens: 0, chars: 0, source: 'heuristic-mixed' }
  let cjk = 0
  let other = 0
  for (const ch of s) {
    if (CJK_RE.test(ch)) cjk += 1
    else other += 1
  }
  // 换行/空白也要算一点：端点把它们当分隔符，不是零成本
  const tokens = cjk + Math.ceil(other / 4)
  return { tokens, chars: s.length, source: 'heuristic-mixed' }
}

export interface RequestBudgetInput {
  /** 实际模型的上下文窗口（token）；取不到就传 null/undefined */
  window?: number | null
  /** 窗口来源，如实透传给界面 */
  windowSource?: 'user' | 'preset' | 'fallback' | 'unknown'
  /** 系统提示（含作者自定义提示词注入后的结果） */
  systemPrompt?: string
  /** 本次要发的正文 / 资料正文 */
  body?: string
  /** 附件（每份单独估，避免"整块"被平摊掉） */
  attachments?: readonly string[]
  /** 期望的输出上限（任务声明）；缺省用全局预留 */
  outputTokens?: number
}

export interface RequestBudget {
  windowTokens: number
  windowSource: NonNullable<RequestBudgetInput['windowSource']>
  /** 资料可用额度（输入侧上限） */
  inputAllowanceTokens: number
  outputReserveTokens: number
  safetyMarginTokens: number
  estimates: {
    system: TokenEstimate
    body: TokenEstimate
    attachments: TokenEstimate
    /** 本次请求的全部输入 */
    input: TokenEstimate
  }
  fits: boolean
  /** 超出多少（`fits=false` 时 > 0） */
  overflowTokens: number
  /** 不得不让人知道的事（估算来源、窗口用了兜底值、输出预留被压缩…） */
  warnings: string[]
}

/**
 * 算一次请求的预算。
 *
 * 配额分配（顺序固定，别反过来）：
 *   ① 输出预留：任务声明值 或 全局 `REPLY_RESERVE_TOKENS`，且不超过窗口的 40%；
 *   ② 安全余量：窗口的 5%（端点还会加自己的模板/工具描述，不能把窗口占满）；
 *   ③ 输入额度：`min(窗口 × 0.5, 窗口 - 输出预留 - 安全余量)`。
 * 🔴 先用固定占比再用剩余量取 min：只按占比，小窗口模型会被输出预留挤成负数；
 *    只按剩余量，大窗口模型会把资料铺满整个窗口（那正是"上下文一长就崩"的来源）。
 */
export function planRequestBudget(input: RequestBudgetInput = {}): RequestBudget {
  const warnings: string[] = []
  const rawWindow = Number(input.window)
  const windowTokens = Number.isFinite(rawWindow) && rawWindow > 0 ? Math.floor(rawWindow) : 0
  const windowSource = input.windowSource ?? (windowTokens > 0 ? 'user' : 'unknown')
  if (windowTokens <= 0) {
    warnings.push('取不到模型上下文窗口，预算按 32K 保守估算（估算值，不是模型标称值）')
  }
  const win = windowTokens > 0 ? windowTokens : 32768

  const declaredOut = Number(input.outputTokens)
  const wantedOut = Number.isFinite(declaredOut) && declaredOut > 0 ? Math.floor(declaredOut) : REPLY_RESERVE_TOKENS
  const outputReserveTokens = Math.max(256, Math.min(wantedOut, Math.floor(win * MAX_OUTPUT_SHARE_OF_WINDOW)))
  if (outputReserveTokens < wantedOut) {
    warnings.push(`输出预留从 ${wantedOut} 压缩到 ${outputReserveTokens}（不超过窗口的 40%）`)
  }

  const safetyMarginTokens = Math.floor(win * SAFETY_MARGIN_RATIO)
  const byShare = Math.floor(win * MATERIAL_SHARE_OF_WINDOW)
  const byRemainder = win - outputReserveTokens - safetyMarginTokens
  const inputAllowanceTokens = Math.max(0, Math.min(byShare, byRemainder))

  const system = estimateTokens(input.systemPrompt)
  const body = estimateTokens(input.body)
  let attachTokens = 0
  let attachChars = 0
  for (const a of input.attachments ?? []) {
    const e = estimateTokens(a)
    attachTokens += e.tokens
    attachChars += e.chars
  }
  const attachments: TokenEstimate = { tokens: attachTokens, chars: attachChars, source: 'heuristic-mixed' }
  const inputEst: TokenEstimate = {
    tokens: system.tokens + body.tokens + attachTokens,
    chars: system.chars + body.chars + attachChars,
    source: 'heuristic-mixed',
  }

  const overflowTokens = Math.max(0, inputEst.tokens - inputAllowanceTokens)
  if (inputEst.tokens > 0) {
    warnings.push(`词元数为保守估算（中文 1 字≈1 token，其余 4 字符≈1 token），不是真实 tokenizer 结果`)
  }
  return {
    windowTokens: win,
    windowSource,
    inputAllowanceTokens,
    outputReserveTokens,
    safetyMarginTokens,
    estimates: { system, body, attachments, input: inputEst },
    fits: overflowTokens === 0,
    overflowTokens,
    warnings,
  }
}

/** 一句话结论（界面/错误信息直接展示） */
export function describeBudget(b: RequestBudget): string {
  const win = `${b.windowTokens} token 窗口`
  return b.fits
    ? `${win}：输入约 ${b.estimates.input.tokens} / 可用 ${b.inputAllowanceTokens} token（输出预留 ${b.outputReserveTokens}）`
    : `${win}：输入约 ${b.estimates.input.tokens} token，超出可用额度 ${b.inputAllowanceTokens} token ${b.overflowTokens} token`
}

/**
 * 完整请求放不下时抛它。
 *
 * 🔴 为什么必须是一个**可识别**的错误类型：调用方要把「需要缩小范围 / 减少附件」
 *    原样展示给作者；如果混在普通网络错误里，界面只会显示"请求失败"，作者会反复重试。
 */
export class AIContextOverflowError extends Error {
  readonly code = 'context-overflow'
  constructor(readonly budget: RequestBudget) {
    super(
      `本次请求超出模型上下文预算：${describeBudget(budget)}。`
      + '请缩小本次范围（减少章节/资料/附件），或换用窗口更大的模型。',
    )
    this.name = 'AIContextOverflowError'
  }
}

// ────────────────────────── 发送材料清单（MaterialManifest） ──────────────────────────

/** 一条材料的来源依据 */
export interface MaterialSource {
  /** 来源种类：设定页签 / 章节 / 附件 / 检索命中 */
  kind: 'tab' | 'chapter' | 'attachment' | 'recall' | 'instruction'
  /** 稳定引用（页签 id / 章节 id / 附件名） */
  ref: string
  /** 读取时的修订号或内容摘要（**当时**的依据） */
  revision?: string
  /** 字段定义依据（模板 id + 版本），改名/改义后能对上 */
  fieldBasis?: string
  /** 权限依据：为何允许进入本次上下文 */
  permissionBasis?: string
}

/** 一条材料的装入结果 */
export interface MaterialEntry {
  source: MaterialSource
  /** 装进去了多少字符 */
  includedChars: number
  /** `full` 全量 / `trimmed` 裁剪 / `dropped` 未带入 */
  scope: 'full' | 'trimmed' | 'dropped'
  /** 未带入的原因（`scope==='dropped'` 时必填） */
  reason?: string
}

export interface MaterialManifest {
  /** 任务意图（如 chapter-review / chapter-continue / setting-extract） */
  intent: string
  /** 输出协议（text / json-object / json-schema） */
  output: 'text' | 'json-object' | 'json-schema'
  entries: MaterialEntry[]
  budget: RequestBudget
  /** 装配耗时（ms），用于诊断"慢在检索还是慢在模型" */
  assembleMs?: number
  /** 检索/读取的失败原因码（hit / no-match / disabled / stale-index / unavailable / forbidden） */
  recallStates?: Record<string, 'hit' | 'no-match' | 'disabled' | 'stale-index' | 'unavailable' | 'forbidden'>
}

/**
 * 组装发送清单。
 *
 * 🔴 清单只记录"**这次实际发了什么**"：装配结果传进来就是事实，
 *    不在这里重新读库、也不在生成结束后回读最新记录当"当时的依据"——
 *    那会把"后来改过的内容"记成"当时发过的内容"，出了问题无从复核。
 * 🔴 重复来源按 `kind+ref+revision` 去重：同一份资料被两个分段各装一次，
 *    预算被吃两遍，清单里也该只算一次。
 */
export function buildMaterialManifest(args: {
  intent: string
  output: MaterialManifest['output']
  budget: RequestBudget
  entries: readonly MaterialEntry[]
  assembleMs?: number
  recallStates?: MaterialManifest['recallStates']
}): MaterialManifest {
  const seen = new Set<string>()
  const entries: MaterialEntry[] = []
  for (const e of args.entries) {
    const key = `${e.source.kind}␁${e.source.ref}␁${e.source.revision ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push(e)
  }
  return {
    intent: args.intent,
    output: args.output,
    entries,
    budget: args.budget,
    ...(args.assembleMs != null ? { assembleMs: args.assembleMs } : {}),
    ...(args.recallStates ? { recallStates: args.recallStates } : {}),
  }
}

/** 清单里"没带进来"的部分（界面据此显示"未带入原因"，而不是只显示一个总数） */
export function manifestGaps(m: MaterialManifest): MaterialEntry[] {
  return m.entries.filter(e => e.scope !== 'full')
}
