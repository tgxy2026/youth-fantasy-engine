// ============ 3.2.0 · W3 候选生成与应用 · Diff 生成 ============
// 2026-10-20 · 方案 §9.1 / §13.1
//
// 🔴 本文件是纯函数，不 import 任何 UI。
//    列表只读元数据；打开某章才加载正文和 diff。
//    量级验收目标：500 章项目、200 个载荷下列表首屏不预读全部候选。

// ============ Diff 行 ============
export interface RevisionDiffLine {
  /** 行类型 */
  kind: 'equal' | 'add' | 'remove' | 'change'
  /** 原文（remove / change 时） */
  old?: string
  /** 新文（add / change 时） */
  new?: string
}

// ============ Diff 结果 ============
export interface RevisionDiff {
  /** 是否完全相同 */
  identical: boolean
  /** 差异行 */
  lines: RevisionDiffLine[]
  /** 新增行数 */
  added: number
  /** 删除行数 */
  removed: number
  /** 变化行数 */
  changed: number
  /** 总行数（新文） */
  totalLines: number
}

// ============ 按行分割（保留换行符） ============
function splitLines(text: string): string[] {
  // 空文本 → 空数组
  if (!text) return []
  // 保留换行符，便于逐行对比
  return text.split(/(\r?\n)/)
}

// ============ 简单逐行 diff ============
// 首版用逐行对比（O(n)），不引入 LCS 算法。
// 理由：候选文本通常 200-2000 行，逐行对比足够快；
//       LCS 的 O(n*m) 在 2000 行时可能卡顿。
// 后续若需更精细的 diff，可替换为 LCS。
export function generateDiff(before: string, after: string): RevisionDiff {
  const oldLines = splitLines(before)
  const newLines = splitLines(after)

  // 过滤纯换行分隔符（与相邻内容行合并显示）
  const contentOld = oldLines.filter((_, i) => i % 2 === 0)
  const contentNew = newLines.filter((_, i) => i % 2 === 0)

  const maxLen = Math.max(contentOld.length, contentNew.length)
  const lines: RevisionDiffLine[] = []
  let added = 0
  let removed = 0
  let changed = 0

  for (let i = 0; i < maxLen; i++) {
    const o = contentOld[i]
    const n = contentNew[i]

    if (o !== undefined && n !== undefined) {
      if (o === n) {
        lines.push({ kind: 'equal', old: o, new: n })
      } else {
        lines.push({ kind: 'change', old: o, new: n })
        changed++
      }
    } else if (o !== undefined && n === undefined) {
      lines.push({ kind: 'remove', old: o })
      removed++
    } else if (o === undefined && n !== undefined) {
      lines.push({ kind: 'add', new: n })
      added++
    }
  }

  return {
    identical: added === 0 && removed === 0 && changed === 0,
    lines,
    added,
    removed,
    changed,
    totalLines: contentNew.length,
  }
}

// ============ Diff 摘要 ============
export interface RevisionDiffSummary {
  /** 是否完全相同 */
  identical: boolean
  /** 新增行数 */
  added: number
  /** 删除行数 */
  removed: number
  /** 变化行数 */
  changed: number
  /** 总行数（新文） */
  totalLines: number
  /** 人类可读摘要 */
  text: string
}

export function summarizeDiff(diff: RevisionDiff): RevisionDiffSummary {
  let text: string
  if (diff.identical) {
    text = '无变化'
  } else if (diff.added > 0 && diff.removed === 0 && diff.changed === 0) {
    text = `新增 ${diff.added} 行`
  } else if (diff.added === 0 && diff.removed > 0 && diff.changed === 0) {
    text = `删除 ${diff.removed} 行`
  } else {
    text = `新增 ${diff.added} 行，删除 ${diff.removed} 行，修改 ${diff.changed} 行`
  }
  return {
    identical: diff.identical,
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
    totalLines: diff.totalLines,
    text,
  }
}

// ============ Diff 统计（用于候选列表展示） ============
export interface RevisionDiffStats {
  added: number
  removed: number
  changed: number
  identical: boolean
}

export function diffStats(before: string, after: string): RevisionDiffStats {
  const diff = generateDiff(before, after)
  return {
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
    identical: diff.identical,
  }
}

// ============ 字数变化统计 ============
export interface RevisionWordChange {
  beforeWords: number
  afterWords: number
  delta: number
  /** 百分比变化（正=增加，负=减少） */
  percent: number
}

/** 简单中英文混合字数统计（按非空白字符计数） */
function countWords(text: string): number {
  if (!text) return 0
  // 中文：每个汉字算 1 字；英文：按空格分词
  const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const english = text
    .replace(/[\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0).length
  return chinese + english
}

export function wordChange(before: string, after: string): RevisionWordChange {
  const beforeWords = countWords(before)
  const afterWords = countWords(after)
  const delta = afterWords - beforeWords
  const percent = beforeWords > 0 ? Math.round((delta / beforeWords) * 1000) / 10 : (afterWords > 0 ? 100 : 0)
  return { beforeWords, afterWords, delta, percent }
}
