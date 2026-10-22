// ============ A2 细纲与正文对照 · AI 语义判定（3.2.1 · T-09） ============
// 2026-10-22
//
// 【为什么需要这一层】
//   `lib/aiTasks/planCompare.ts` 是**纯本地字符串匹配**：`indexOf` 找引文 + 按长度比猜完成度。
//   它回答得了「计划里这句话正文里有没有逐字出现」，回答不了「计划里的**意思**写到了没有」
//   （比如计划写「主角被羞辱后觉醒」，正文写成「他跪在雪里，腕上金纹发烫」—— 一个字都不重合）。
//   方案 §5.2 要求复用 `review` 路由做语义判定 + 五态完成情况，本文件就是那块。
//
// 【两条硬约束（错一条就会伪造证据）】
//   ① **引文必须逐字落在正文里**：模型给的 `bodyQuotes` 一律过 `locatePlanQuote`，
//      找不到就丢弃并计 `unlocated`；若某条除了"没有可定位引文"以外还声称"已体现"，
//      强制降级成 `insufficient`（证据不足）—— 绝不能让"模型说有"变成"证据说在"。
//   ② **计划原文以调用方传进来的为准**，不信模型回抄的 `planQuote`（回抄会被改写，报告就对不上原件）。
//
// 🔴 本文件是纯业务逻辑，不 import 任何 UI；`reviewPlanCompare` 是纯函数，AI 调用在它外面。
import { chat, requireProviderFor, CHAT_TIMEOUT_MS, composeSystemPrompt } from '@/lib/ai'
import { parseObjectArrayDetailed, asText } from '@/lib/ai/aiParse'
import { newAuthorFence, authorBlock } from '@/lib/ai/promptGuard'
import type { CallRequestContext } from '@/lib/ai/callTracking'
import type { PromptDef } from '@/lib/ai/promptSettings'
import { locatePlanQuote, summarizePlanCompare, type PlanCompletionStatus, type PlanCompareResult, type PlanCompareSummary } from '@/lib/aiTasks/planCompare'

/** 方案 §5.2：列表最多 20 项，超出要标明结果数量限制 */
export const MAX_PLAN_COMPARE_ITEMS = 20

/** 一条待核对的计划（调用方从模板用途 / 作者勾选里取，**不擅自把全部备注当计划**） */
export interface PlanItemInput {
  planFieldId: string
  /** 计划原文（以它为准，模型回抄的不采信） */
  planQuote: string
  templateVersion: string
}

export interface PlanCompareReview {
  /** 每条计划都有一条结果（模型漏掉的补成"证据不足"，不静默消失） */
  items: PlanCompareResult[]
  /** 汇总（新增/删除/完成/部分/未找到/不同/证据不足） */
  summary: PlanCompareSummary
  /** 模型给了引文、但正文里**逐字找不到**的条数（不是 0 就说明这份报告有伪引文） */
  unlocated: number
  /** 被丢弃的条目数（字段不在本次计划里 / 状态不认识） */
  dropped: number
  /** 模型多给的字段 id（不在本次计划里，已丢弃） */
  unknownFields: string[]
  /** 是否因 20 项上限被截断 */
  truncated: boolean
}

const STATUSES: readonly PlanCompletionStatus[] = ['completed', 'partial', 'not-found', 'different', 'insufficient']

/** 需要正文证据的判定 —— 这三态没有可定位引文就不能成立 */
const NEEDS_EVIDENCE: readonly PlanCompletionStatus[] = ['completed', 'partial', 'different']

/**
 * 把模型返回的 JSON 过一遍本地闸（**纯函数**，供单测）。
 *
 * 步骤：字段校验 → 状态校验 → 引文逐字定位 → 无证据降级 → 补齐缺失计划项 → 截断。
 */
export function reviewPlanCompare(
  raw: string,
  planItems: readonly PlanItemInput[],
  bodyText: string,
): PlanCompareReview {
  const parsed = parseObjectArrayDetailed(raw)
  const rows = parsed.outcome === 'valid' ? parsed.data : []
  const byField = new Map(planItems.map(p => [p.planFieldId, p]))
  const got = new Map<string, PlanCompareResult>()
  let unlocated = 0
  let dropped = 0
  const unknownFields: string[] = []

  for (const row of rows) {
    const fieldId = asText(row.planFieldId ?? row.fieldId ?? row.id).trim()
    if (!fieldId || !byField.has(fieldId)) {
      dropped++
      if (fieldId) unknownFields.push(fieldId)
      continue
    }
    const rawStatus = asText(row.status).trim() as PlanCompletionStatus
    if (!STATUSES.includes(rawStatus)) { dropped++; continue }

    const plan = byField.get(fieldId)!
    const quotesRaw = Array.isArray(row.bodyQuotes) ? row.bodyQuotes : Array.isArray(row.quotes) ? row.quotes : []
    const quotes = quotesRaw.map(q => asText(q).trim()).filter(Boolean)

    // 🔴 引文闸：一条一条逐字定位，命中才留；命中的把段号一起带上
    const located: string[] = []
    const paraIdx: number[] = []
    for (const q of quotes) {
      const hit = locatePlanQuote(q, bodyText)
      if (hit.located) { located.push(q); paraIdx.push(...hit.paragraphIndices) }
      else unlocated++
    }

    let status = rawStatus
    let reason = asText(row.reason).trim() || '模型未给出理由'
    if (NEEDS_EVIDENCE.includes(status) && located.length === 0) {
      // 没有一句能落在正文里 ⇒ 只能算"证据不足"，不许写成"已体现"
      status = 'insufficient'
      reason = `模型判定为「${rawStatus}」，但给不出能逐字落在正文里的原句 ⇒ 按证据不足处理。${reason ? '（模型理由：' + reason + '）' : ''}`
    }

    got.set(fieldId, {
      planFieldId: fieldId,
      templateVersion: plan.templateVersion,
      // 计划原文用调用方的，不用模型回抄的
      planQuote: plan.planQuote,
      status,
      bodyQuotes: located,
      reason,
      ...(asText(row.suggestion).trim() ? { suggestion: asText(row.suggestion).trim() } : {}),
      paragraphIndices: [...new Set(paraIdx)].sort((a, b) => a - b),
    })
  }

  // 模型漏掉的计划项：补一条"证据不足"，并如实写清是"没给判定"而不是"没体现"
  for (const p of planItems) {
    if (got.has(p.planFieldId)) continue
    got.set(p.planFieldId, {
      planFieldId: p.planFieldId,
      templateVersion: p.templateVersion,
      planQuote: p.planQuote,
      status: 'insufficient',
      bodyQuotes: [],
      reason: '模型没有给出这一项的计划对照判定（不算"未体现"，只是没判定）。',
      paragraphIndices: [],
    })
  }

  // 顺序跟调用方传入的计划顺序一致（报告要能按细纲顺序读）
  const ordered = planItems.map(p => got.get(p.planFieldId)!).filter(Boolean)
  const truncated = ordered.length > MAX_PLAN_COMPARE_ITEMS
  const items = truncated ? ordered.slice(0, MAX_PLAN_COMPARE_ITEMS) : ordered

  return {
    items,
    summary: summarizePlanCompare(items, []),
    unlocated,
    dropped,
    unknownFields,
    truncated,
  }
}

/** 就地声明提示词（与 audit / readerProbe 同范式；注册在 `lib/ai/aiTasks.ts`） */
let P_plan_compare = `你是长篇小说的「细纲与正文对照」审校员。作者会给你一批**计划项**（每条有计划字段 id 与计划原文），以及**本章正文**。

【任务】逐条判断：这条计划在正文里体现到什么程度。

【完成情况只有五档，必须原样使用】
- completed（已体现）：正文有明确对应内容，且你能摘出**逐字存在于正文中的原句**作为证据；
- partial（部分体现）：体现了一部分，同样要摘原句；
- not-found（未找到体现）：正文里找不到对应内容；
- different（与计划不同）：正文写了，但写法与计划不一致（不是"写错了"，只是偏离计划）；
- insufficient（证据不足）：正文太短 / 相关内容含糊，无法判断。

【硬性要求】
1. **bodyQuotes 里的每一句必须从正文原样复制**，一个字都不能改、不能补标点、不能改写。摘不出原句时，bodyQuotes 给空数组，并把 status 设为 insufficient —— 编造引文比不判定更糟。
2. 只处理给定的计划项，**不要新增字段 id**，不要合并或拆分计划项。
3. 不要评价文笔好坏，不要给修改建议清单（suggestion 至多一句话）。
4. 判定「different」时要说明差异点；判定「not-found」时不要凭空推测作者意图。
5. 只输出 JSON 数组，不要解释文字。每项形如：
{"planFieldId":"字段id","status":"completed","bodyQuotes":["正文原句"],"reason":"一句话理由","suggestion":"可选"}`

export const PLAN_COMPARE_PROMPTS: PromptDef[] = [
  {
    meta: {
      id: 'plan-compare',
      group: '编辑与审校',
      name: '细纲与正文对照',
      note: '把本章细纲 / 计划项逐条与正文对照，判定「已体现 / 部分体现 / 未找到体现 / 与计划不同 / 证据不足」。引文必须逐字来自正文，摘不出原句就判证据不足——不编造证据。',
    },
    read: () => P_plan_compare,
    write: t => { P_plan_compare = t },
  },
]

export interface PlanCompareAiOpts {
  signal?: AbortSignal
  request?: CallRequestContext
  onToken?: (delta: string) => void
}

export interface PlanCompareAiOutcome {
  /** completed＝模型给了合法结构；invalid＝解析不出数组；failed＝调用失败/取消 */
  state: 'completed' | 'invalid' | 'failed'
  review?: PlanCompareReview
  error?: string
}

/**
 * 调模型做语义对照，再过本地闸。
 *
 * 🔴 失败口径：调用失败 / 取消 / 解析不出数组 ⇒ 返回 state，**不返回半份结果**
 *    （半份结果会让作者以为"其余几条都没问题"）。
 */
export async function aiComparePlanWithBody(
  planItems: readonly PlanItemInput[],
  chapterText: string,
  opts: PlanCompareAiOpts = {},
): Promise<PlanCompareAiOutcome> {
  if (!planItems.length) return { state: 'completed', review: reviewPlanCompare('[]', [], chapterText) }
  try {
    const cfg = await requireProviderFor('review')
    const fence = newAuthorFence()
    const planBlock = planItems
      .map((p, i) => `${i + 1}. planFieldId=${p.planFieldId}\n   计划原文：${p.planQuote}`)
      .join('\n')
    const user = `【计划项（共 ${planItems.length} 条）】
${authorBlock(fence, planBlock)}

【本章正文】
${authorBlock(fence, chapterText.trim() || '（空章节）')}

请逐条对照，返回 JSON 数组。`
    const text = await chat(
      cfg,
      [{ role: 'system', content: composeSystemPrompt(P_plan_compare, cfg) }, { role: 'user', content: user }],
      {
        output: 'json-object',
        reasoning: 'off',
        timeoutMs: CHAT_TIMEOUT_MS,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.onToken ? { onToken: opts.onToken } : {}),
        ...(opts.request ? { request: opts.request } : {}),
      },
    )
    const parsed = parseObjectArrayDetailed(text)
    if (parsed.outcome !== 'valid') {
      return {
        state: 'invalid',
        error: parsed.outcome === 'invalid' ? '模型没有返回可解析的 JSON 数组' : '模型返回被截断，判定不完整',
      }
    }
    return { state: 'completed', review: reviewPlanCompare(text, planItems, chapterText) }
  } catch (e) {
    return { state: 'failed', error: e instanceof Error ? e.message : String(e) }
  }
}
