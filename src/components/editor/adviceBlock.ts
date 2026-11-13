// ============ 颉文姬「建议段」纯内容变换（3.5.3 · P2，D4-2 层一：不碰 React）============
//
// 从 useNovelEditorModel 的 insertAdvice / clearAdvice 外抽可独立验证的内容计算：
// 插入定位到选区所在段落末尾、紧邻重复防护、清除前标记配对校验。行为逐字不变。
// 🔴 updateContent / noteAiAssist / showToast 等状态与 UI 接线仍留在模型层 ——
//    AI 记账（noteAiAssist('polished')）与唯一落库出口不变，aiAssist 守门断言仍钉在模型上。
import { ADVICE_START, ADVICE_END } from '@/components/jiewenji/jieWenJiParts'

export type AdviceInsertResult =
  | { ok: false; reason: 'duplicate' }
  | { ok: true; next: string; polishedChars: number }

/** 把 AI 改稿作为「建议段」插入原文下方（绝不动原文）。sel 为选区起止，null 表示插到末尾。 */
export function computeAdviceInsert(
  base: string,
  sel: { start: number; end: number } | null,
  rewritten: string,
): AdviceInsertResult {
  const rng = sel && sel.start >= 0 && sel.end >= sel.start ? sel : null
  let insertAt = base.length
  if (rng) {
    // 定位选区所在段落的末尾（段落 = 以空行分隔的块）
    const paraEnd = base.indexOf('\n\n', rng.end)
    insertAt = paraEnd === -1 ? base.length : paraEnd
  }
  // 防重复：同一位置紧邻已有建议段则拒绝（避免同一改稿连点两次插两份）
  const near = base.slice(Math.max(0, insertAt - 3), insertAt + ADVICE_START.length + 3)
  if (near.includes(ADVICE_START)) return { ok: false, reason: 'duplicate' }
  const block = `\n\n${ADVICE_START}\n${rewritten.trim()}\n${ADVICE_END}`
  const next = base.slice(0, insertAt) + block + base.slice(insertAt)
  // 🔴 产出字数算**建议段正文**（不含两端标记行）；采不采用由作者定，但「产出过」要如实记。
  return { ok: true, next, polishedChars: rewritten.trim().length }
}

export type AdviceClearResult =
  | { ok: false; reason: 'unpaired'; starts: number; ends: number }
  | { ok: false; reason: 'none' }
  | { ok: true; next: string }

/** 清除正文里全部建议段。标记不成对时拒绝（避免孤立「开始」标记跨正文误删到下一个「结束」）。 */
export function computeAdviceClear(base: string): AdviceClearResult {
  const starts = (base.match(/【颉文姬建议·开始】/g) ?? []).length
  const ends = (base.match(/【颉文姬建议·结束】/g) ?? []).length
  if (starts !== ends) return { ok: false, reason: 'unpaired', starts, ends }
  const re = /\n{0,2}【颉文姬建议·开始】[\s\S]*?【颉文姬建议·结束】\n{0,2}/g
  const next = base.replace(re, '')
  if (next === base) return { ok: false, reason: 'none' }
  return { ok: true, next }
}