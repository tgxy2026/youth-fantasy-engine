// ============ 审计通用类型与工具（伏笔/连续性/错别字/文风 四引擎共用） ============

export type IssueSeverity = 'error' | 'warn' | 'info'

export type AuditLocation =
  | { kind: 'tab'; tabId: string; hint?: string }
  | { kind: 'chapter'; chapterId: string; hint?: string }
  | { kind: 'row'; tabId: string; rowId: string; hint?: string }

export interface AuditIssue {
  id: string
  severity: IssueSeverity
  /** 所属引擎分类（伏笔/连续性/错别字/文风） */
  category: string
  title: string
  detail: string
  location?: AuditLocation
}

export const SEVERITY_ORDER: Record<IssueSeverity, number> = { error: 0, warn: 1, info: 2 }

export const SEVERITY_LABEL: Record<IssueSeverity, string> = {
  error: '冲突',
  warn: '注意',
  info: '提示',
}

/** 把 "F01, F02"、"F01、F02"、"F01 F02" 统一拆成大写编码数组 */
export function splitCodes(raw: string | undefined): string[] {
  if (!raw) return []
  // 与 splitNames 同口径：分号也是常见手打分隔符
  return raw
    .split(/[,，、;；\s]+/)
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
}

/** 把出场人物之类 "陈渊、陈瑶（昏迷）、执事" 拆成候选人名，并去掉（…）注释 */
export function splitNames(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(/[，,、;；\s]+/)
    .map(s => s.replace(/[（(].*?[）)]/g, '').trim())
    .filter(Boolean)
}

/** 中文数字 → 阿拉伯数字（仅处理一~十，够用） */
export function cnNumToArabic(s: string): number {
  const map: Record<string, number> = {
    '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5,
    '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
  }
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  if (s === '十') return 10
  if (s.length === 2 && s[0] === '十') return 10 + (map[s[1]] ?? 0)
  if (s.length === 2 && s[1] === '十') return (map[s[0]] ?? 0) * 10
  if (s.length === 3 && s[1] === '十') return (map[s[0]] ?? 0) * 10 + (map[s[2]] ?? 0)
  return map[s] ?? NaN
}

/** 解析严格故事内日期 "3024年3月9日" / "4年1月1日" → 可比较整数；无法解析返回 null */
export function parseStoryDateKey(s: string | undefined): number | null {
  if (!s) return null
  const m = s.trim().match(/(\d+)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/)
  if (!m) return null
  const y = parseInt(m[1], 10)
  const mo = parseInt(m[2], 10)
  const d = parseInt(m[3], 10)
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return y * 10000 + mo * 100 + d
}

/** 从 "第5章 外门大比" / "第5章" 抽取章号数字 */
export function extractChapterNo(s: string | undefined): number | null {
  if (!s) return null
  const m = s.trim().match(/第\s*(\d+)\s*章/)
  return m ? parseInt(m[1], 10) : null
}
