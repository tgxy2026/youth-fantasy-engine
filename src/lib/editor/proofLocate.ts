// ============ 校对结果的「只读定位」（纯函数，可单测） ============
//
// 3.3.1 · P7：作者在工具校对弹窗 / 颉文姬诊室看到一条结果，想直接回到正文那一句去改，
// 而不是复制引文再自己搜一遍。
//
// 🔴 与替换的分工（规划 §7.3）：
//    · 定位只读 —— 绝不调用 `applyProofReplacement` 之类的写入函数，也不改正文、不标「已修复」；
//    · 定位对**建议类**同样开放：建议类不能替换，但作者完全可以自己走过去手改；
//    · 位置判据与替换**共用** `resolveProofLocation`（`at` 逐字命中 → 全文唯一 → 否则拒绝），
//      不给「好找」放宽误替换保护；多义/失效一律说清原因，绝不猜第一处。
//
// 下标口径：JS 字符串 UTF-16 单位，与 textarea 的 `selectionStart/End` 一致
//（含 emoji 时一个字符占两个单位，所以不能按「字符数」算）。
import type { ProofreadIssue } from '@/lib/aiTasks/proofread'
import { resolveLocation, resolveProofLocation } from './proofApply'

/** 定位失败原因 —— 与替换失败部分重叠，但语义是「找不到可跳的位置」，不是「不能改」 */
export type ProofLocateFailure =
  /** 结果已失效（正文被改过 / 相交替换） */
  | 'stale'
  /** 引文为空或正文里已找不到 */
  | 'not-found'
  /** 引文出现多处，无法确定跳哪一处 */
  | 'ambiguous'

export type ProofLocateOutcome =
  | {
      ok: true
      /** 命中区间 [start, end)，可直接喂给 `setSelectionRange` */
      start: number
      end: number
      /** 本次命中的原文（逐字等于 issue.quote） */
      quote: string
      /** 命中前后的少量上下文，供界面帮作者确认「就是这一句」 */
      before: string
      after: string
    }
  | { ok: false; reason: ProofLocateFailure }

/** 上下文取多少字：够辨认即可，取多了在窄面板里会把引文挤掉 */
export const LOCATE_CONTEXT_CHARS = 12

/** 消费端手里只有这两样时用它重新定位（判据与替换同源，见 `resolveLocation`） */
export interface ProofLocateQuery {
  quote: string
  at?: number | null
  stale?: boolean
}

/**
 * 只凭「引文 + 上次位置」重新定位。
 *
 * 🔴 消费端（编辑器）必须用它、而不是直接用请求里的 `start`：
 *    从点击到真正跳到正文之间，作者可能已经改过字、换过段，旧下标会指到别的句子。
 *    这里仍按「`at` 逐字命中 → 全文唯一 → 拒绝」判定，位置过期就如实失败。
 */
export function locateQuote(text: string, query: ProofLocateQuery): ProofLocateOutcome {
  const quote = query.quote ?? ''
  if (!quote) return { ok: false, reason: 'not-found' }
  const location = resolveLocation(text, quote, query.at, query.stale)
  if (!location.ok) return { ok: false, reason: location.reason }
  const { start, end } = location
  return {
    ok: true,
    start,
    end,
    quote,
    before: text.slice(Math.max(0, start - LOCATE_CONTEXT_CHARS), start),
    after: text.slice(end, Math.min(text.length, end + LOCATE_CONTEXT_CHARS)),
  }
}

/**
 * 把一条校对结果解析成正文里的可选中区间。
 *
 * @param text  当前正文（调用方必须传「结果所依据的那份正文」，不要拿别的章去解析）
 * @param issue 校对结果
 */
export function locateProofIssue(text: string, issue: ProofreadIssue): ProofLocateOutcome {
  const location = resolveProofLocation(text, issue)
  if (!location.ok) return { ok: false, reason: location.reason }
  const { start, end } = location
  const quote = issue.quote ?? ''
  return {
    ok: true,
    start,
    end,
    quote,
    before: text.slice(Math.max(0, start - LOCATE_CONTEXT_CHARS), start),
    after: text.slice(end, Math.min(text.length, end + LOCATE_CONTEXT_CHARS)),
  }
}

/** 失败原因 → 给作者看的话（两处入口共用一份，避免措辞不一致） */
export const LOCATE_FAILURE_TEXT: Record<ProofLocateFailure, string> = {
  'stale': '这条结果已失效（正文或其它替换改动过这段），无法定位 —— 请重新校对。',
  'not-found': '定位失败：正文里已经找不到这段引文了，请重新校对。',
  'ambiguous': '这段引文在正文里出现多处，无法确定跳哪一处 —— 请重新校对，或直接用「复制」后自行查找。',
}

/** 一句话说明「为什么定位不了」，供按钮 title 与提示条复用 */
export function locateFailureText(reason: ProofLocateFailure): string {
  return LOCATE_FAILURE_TEXT[reason]
}
