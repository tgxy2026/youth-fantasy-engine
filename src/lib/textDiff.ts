/**
 * 行级差异（2.4.0 · A3）—— 让作者看清「从这一版到那一版，到底改了哪些段落」。
 *
 * 【为什么不引通用 diff 库】
 * 这里只有一种需求：**同一章节的两版正文对比**（某份快照 vs 当前稿）。
 * 为它引一个几十 KB 的依赖不划算，而且这类库的输出（hunk / patch）还得再翻译一层。
 *
 * 【性能保护（这道是必需的，不是优化）】
 * LCS 的 DP 是 O(n×m)。网文一章几百到几千行，而两版之间通常只有中间一小段不同 ——
 * 所以先**剪掉公共前后缀**（实测常能把规模从 3000×3000 压到几十×几十），再对剩余部分做 DP。
 * 万一剩余部分仍然巨大（等于整章重写），直接退化为「旧的全删 + 新的全增」——
 * 结果依然正确，只是不够精细，**关键是绝不卡住界面**。
 *
 * ⚠️ 纯函数、无依赖 ⇒ 落地即被 `tests/textDiff.test.ts` 覆盖。
 */

export type DiffKind = 'same' | 'add' | 'del'

export interface DiffLine {
  kind: DiffKind
  text: string
}

/** DP 单元数上限：超过就退化为整段替换（保护主线程） */
const MAX_DP_CELLS = 4_000_000

/**
 * 拆行：**空串视为「没有行」**，而不是「一个空行」。
 * 否则 `diffLines('', 'x')` 会多报一条"删除了一个空行"——
 * 而作者看到的事实是"这章本来就没有内容，现在有了一行"。空稿是个真实且常见的场景（新建章节）。
 */
function splitLines(s: string): string[] {
  return s === '' ? [] : s.split('\n')
}

/** 逐行对比两版正文；`before` ＝ 旧版，`after` ＝ 新版 */
export function diffLines(before: string, after: string): DiffLine[] {
  if (before === after) return splitLines(before).map(text => ({ kind: 'same' as const, text }))
  const a = splitLines(before)
  const b = splitLines(after)

  // ① 公共前缀
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  // ② 公共后缀（不能与前缀重叠）
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++

  const head: DiffLine[] = a.slice(0, p).map(text => ({ kind: 'same' as const, text }))
  const mid = diffMiddle(a.slice(p, a.length - s), b.slice(p, b.length - s))
  const tail: DiffLine[] = s > 0 ? a.slice(a.length - s).map(text => ({ kind: 'same' as const, text })) : []
  return [...head, ...mid, ...tail]
}

/** 对「剪枝后的中段」做 LCS；规模过大则整段替换 */
function diffMiddle(a: string[], b: string[]): DiffLine[] {
  const n = a.length, m = b.length
  if (n === 0) return b.map(text => ({ kind: 'add' as const, text }))
  if (m === 0) return a.map(text => ({ kind: 'del' as const, text }))
  if (n * m > MAX_DP_CELLS) {
    return [
      ...a.map(text => ({ kind: 'del' as const, text })),
      ...b.map(text => ({ kind: 'add' as const, text })),
    ]
  }

  // dp[i][j] ＝ a[i..] 与 b[j..] 的最长公共子序列长度（一维展开存整张表，便于回溯）
  const w = m + 1
  const dp = new Int32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + (j + 1)] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)])
    }
  }

  const out: DiffLine[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i++; j++ }
    else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) { out.push({ kind: 'del', text: a[i] }); i++ }
    else { out.push({ kind: 'add', text: b[j] }); j++ }
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] })
  while (j < m) out.push({ kind: 'add', text: b[j++] })
  return out
}

/**
 * 统计新增 / 删除行数；`changed` 是"被改写的行"的粗略估计（增删成对出现的那部分）。
 * 界面用它显示「新增 3 段 · 删除 3 段 · 改动约 3 段」，比只报"有多少处不同"更好理解。
 */
export function diffStats(lines: DiffLine[]): { added: number; deleted: number; changed: number } {
  let added = 0, deleted = 0
  for (const l of lines) {
    if (l.kind === 'add') added++
    else if (l.kind === 'del') deleted++
  }
  return { added, deleted, changed: Math.min(added, deleted) }
}
