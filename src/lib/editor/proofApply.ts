// ============ 校对结果的应用与重锚定（纯函数，可单测） ============
//
// 3.2.3 · R1：把「能不能替换」这件事从界面里挪出来，做成可测的判据。
//
// 为什么要有这一层：
//   ① 旧实现里 `iss.fix` 既可能是「改好的文本」，也可能是模型写的一句修改建议，
//      两者都直接拼进正文 —— 建议句会当成正文写进去（见 3.2.3 可靠性收口方案 §5）。
//      现在只有 kind === 'replacement' 才允许替换，suggestion 永远只能看/复制。
//   ② 旧实现定位失败时无条件回退 `text.indexOf(quote)` —— 同一句在正文出现多次时，
//      永远命中第一处，会改错位置。现在只有「全文唯一」才允许回退，多义直接拒绝。
//   ③ 替换后另一块结果的坐标会漂：相交的必须失效（不许拿旧下标继续改新正文），
//      只有完全在替换点之后的才能按位移平移。
import type { ProofreadIssue } from '@/lib/aiTasks/proofread'

/** 替换失败的原因 —— 界面上要按原因说人话，不能只说"失败了" */
export type ProofApplyFailure =
  /** 不是可替换类型（建议类结果） */
  | 'not-replacement'
  /** 替换文本为空 */
  | 'empty-replacement'
  /** 替换文本与原文相同（替换没有意义，多半是模型复述） */
  | 'same-as-quote'
  /** 正文里找不到这段引文（正文已被改过） */
  | 'not-found'
  /** 引文在正文中出现多处，无法确定改哪一处 */
  | 'ambiguous'
  /** 结果已被判定失效（相交替换/正文变动后） */
  | 'stale'

export type ProofApplyOutcome =
  | { ok: true; next: string; index: number; delta: number }
  | { ok: false; reason: ProofApplyFailure }

/** 引文在正文中出现的次数（用于判断是否唯一） */
export function countOccurrences(text: string, quote: string): number {
  if (!quote) return 0
  let count = 0
  let from = 0
  for (;;) {
    const hit = text.indexOf(quote, from)
    if (hit < 0) return count
    count++
    from = hit + quote.length
    // 极端防御：空步进会死循环（quote 非空时不会发生，但别留下这种可能）
    if (from <= hit) return count
  }
}

/** 只读定位供建议和替换共用；未确认的位置绝不猜第一处。下标按 JS 字符串的 UTF-16 单位。 */
export function resolveProofLocation(text: string, issue: ProofreadIssue):
  | { ok: true; start: number; end: number }
  | { ok: false; reason: 'stale' | 'not-found' | 'ambiguous' } {
  if (issue.stale) return { ok: false, reason: 'stale' }
  const quote = issue.quote
  if (!quote) return { ok: false, reason: 'not-found' }
  if (issue.at != null && Number.isInteger(issue.at) && issue.at >= 0 && text.slice(issue.at, issue.at + quote.length) === quote) {
    return { ok: true, start: issue.at, end: issue.at + quote.length }
  }
  const first = text.indexOf(quote)
  if (first < 0) return { ok: false, reason: 'not-found' }
  // 从下一个字符开始查重，重叠的引文也属于多义位置。
  if (text.indexOf(quote, first + 1) >= 0) return { ok: false, reason: 'ambiguous' }
  return { ok: true, start: first, end: first + quote.length }
}

/**
 * 应用一条「替换类」校对结果。
 *
 * 定位优先级：
 *   1. 命中 `at` 且该位置的文本与引文逐字一致 ⇒ 用它（这是模型标注的精确位置）；
 *   2. 否则只有引文在正文里**唯一**出现时才回退 indexOf；
 *   3. 找不到或多义 ⇒ 拒绝，并给出原因（绝不"随便找一处改"）。
 */
export function applyProofReplacement(text: string, issue: ProofreadIssue): ProofApplyOutcome {
  if (issue.kind !== 'replacement') return { ok: false, reason: 'not-replacement' }
  if (issue.stale) return { ok: false, reason: 'stale' }
  const fix = issue.fix ?? ''
  if (!fix.trim()) return { ok: false, reason: 'empty-replacement' }
  if (fix === issue.quote) return { ok: false, reason: 'same-as-quote' }

  const location = resolveProofLocation(text, issue)
  if (!location.ok) return location
  const index = location.start
  const next = text.slice(0, index) + fix + text.slice(index + issue.quote.length)
  return { ok: true, next, index, delta: fix.length - issue.quote.length }
}

/** 失败原因 → 给作者看的话（界面与 toast 共用一份，避免两处措辞不一致） */
export const APPLY_FAILURE_TEXT: Record<ProofApplyFailure, string> = {
  'not-replacement': '这条只是修改建议，不能直接替换 —— 请按建议自己改，或用「复制建议」。',
  'empty-replacement': '这条没有给出可用的替换文本，不能替换。',
  'same-as-quote': '替换文本与原文相同，这一条不需要替换。',
  'not-found': '定位失败：正文可能已经改过，这段引文找不到了，请重新校对。',
  'ambiguous': '这段引文在正文里出现多处，无法确定要改哪一处 —— 请重新校对后再试。',
  'stale': '这条结果已失效（正文或其它替换已改动这段），请重新校对。',
}

/**
 * 替换成功后，重算**两块**结果的坐标。
 *
 * @param issues   某一层的问题列表（调用方两层各调一次）
 * @param edit     本次替换的位置与长度变化
 * @param exclude  刚被应用的那一条（identity 比较，应用完就该从列表里消失）
 *
 * 规则：
 *   · 完全落在替换区间**之后** ⇒ 整体平移 delta；
 *   · 完全落在**之前** ⇒ 不动；
 *   · 与替换区间**相交**（含起点落在区间内）⇒ 标记 `stale`（失效，不可再替换），保留展示。
 *     🔴 不能保留旧 `at`：正文已经变了，旧下标指向的完全是别的字。
 */
export function reanchorIssues(
  issues: ProofreadIssue[],
  edit: { from: number; removed: number; inserted: number; next: string },
  exclude?: ProofreadIssue,
): { issues: ProofreadIssue[]; invalidated: number } {
  const delta = edit.inserted - edit.removed
  const end = edit.from + edit.removed
  let invalidated = 0
  const out: ProofreadIssue[] = []
  for (const issue of issues) {
    if (exclude && issue === exclude) continue
    if (issue.at == null) { out.push(issue); continue }
    const start = issue.at
    const stop = issue.at + issue.quote.length
    if (start >= end) {
      const moved = start + delta
      // 平移后仍要逐字对上，否则说明这段本来就被别的改动碰过
      const ok = edit.next.slice(moved, moved + issue.quote.length) === issue.quote
      if (ok) { out.push({ ...issue, at: moved, stale: false }); continue }
      invalidated++
      out.push({ ...issue, at: undefined, stale: true })
      continue
    }
    if (stop <= edit.from) { out.push(issue); continue }
    invalidated++
    out.push({ ...issue, at: undefined, stale: true })
  }
  out.sort((a, b) => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER))
  return { issues: out, invalidated }
}
