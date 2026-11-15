/**
 * 3.5.6 · 单章正文的分段读取（MCP 长资料取材）
 *
 * 规划口径：外部客户端先定位、再按范围取材；引擎负责返回**稳定位置、下一段游标与数据版本**，
 * 单章完整读取的旧语义保留（不传 offset/limit 时行为与 3.5.5 完全一致）。
 *
 * 🔴 三条约束：
 *   · `limit` 有硬上限（20000 字符）—— 再大就该由客户端自己分页，而不是让一次回包撑爆窗口；
 *   · `offset` 越界直接报错，不返回空串冒充「读完了」；
 *   · `version` 只由正文内容决定，`expectedVersion` 对不上就 CONFLICT，避免把两次读取拼成混合版本。
 */
export const CHAPTER_RANGE_MAX_LIMIT = 20000

export interface ChapterRange {
  offset: number
  /** 本次实际返回的字符数 */
  returnedChars: number
  totalChars: number
  /** 下一次从哪开始读；`hasMore=false` 时等于 totalChars */
  nextOffset: number
  hasMore: boolean
  /** 正文版本（长度 + 内容哈希），跨多次调用拼接时用它核对是否同一版 */
  version: string
}

export interface ChapterRangeArgs {
  explicit: boolean
  offset: number
  limit: number
  expectedVersion?: string
}

/**
 * 正文版本号：`v1-<字符数>-<FNV-1a 32 位>`。
 *
 * 用 FNV-1a 而不是加密哈希：这里只做「有没有变」的快速核对，不做安全承诺；
 * 纯 JS 实现让渲染层与只读桥共用同一算法（只读桥是 .mjs，不能 import 本文件，算法同步锁在测试里）。
 */
export function chapterVersion(content: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `v1-${content.length}-${(hash >>> 0).toString(16)}`
}

/** 解析分段参数；未传 offset/limit 时 `explicit=false`（表示沿用旧的整章读取）。 */
export function parseChapterRange(args: Record<string, unknown>): ChapterRangeArgs | { error: string } {
  const hasOffset = args.offset !== undefined && args.offset !== null
  const hasLimit = args.limit !== undefined && args.limit !== null
  const rawVersion = args.expectedVersion
  if (rawVersion !== undefined && rawVersion !== null && typeof rawVersion !== 'string') {
    return { error: 'expectedVersion 必须是字符串。' }
  }
  if (!hasOffset && !hasLimit) {
    return {
      explicit: false, offset: 0, limit: 0,
      ...(typeof rawVersion === 'string' && rawVersion ? { expectedVersion: rawVersion } : {}),
    }
  }
  let offset = 0
  let limit = CHAPTER_RANGE_MAX_LIMIT
  if (hasOffset) {
    if (!Number.isInteger(args.offset) || (args.offset as number) < 0) {
      return { error: 'offset 必须是不小于 0 的整数（字符位置）。' }
    }
    offset = args.offset as number
  }
  if (hasLimit) {
    if (!Number.isInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > CHAPTER_RANGE_MAX_LIMIT) {
      return { error: `limit 必须是 1..${CHAPTER_RANGE_MAX_LIMIT} 的整数（字符数）。` }
    }
    limit = args.limit as number
  }
  return {
    explicit: true, offset, limit,
    ...(typeof rawVersion === 'string' && rawVersion ? { expectedVersion: rawVersion } : {}),
  }
}

/** 按字符位置切片。offset 等于长度时返回空片段（表示已读完），超过长度视为参数错误。 */
export function sliceChapter(content: string, offset: number, limit: number): { text: string; range: ChapterRange } | { error: string } {
  const total = content.length
  if (offset > total) {
    return { error: `offset ${offset} 超出正文长度（共 ${total} 字）。请从 0 开始或按上次返回的 nextOffset 继续。` }
  }
  const text = content.slice(offset, offset + limit)
  const nextOffset = offset + text.length
  return {
    text,
    range: {
      offset,
      returnedChars: text.length,
      totalChars: total,
      nextOffset,
      hasMore: nextOffset < total,
      version: chapterVersion(content),
    },
  }
}

/**
 * 一次读取的完整判定（旧整章 / 分段 / 版本冲突 / 参数错误）。
 *
 * 抽在这里是为了让页面执行器只保留「取章节 + 拼响应」，不再各写一份版本与游标逻辑；
 * 执行器文件有 1200 行硬上限，这条判定留在那里会把上限顶穿。
 */
export function readChapterRange(
  content: string,
  parsed: ChapterRangeArgs,
): { content: string; range?: ChapterRange } | { conflict: string } | { error: string } {
  if (!parsed.explicit) return { content }
  const version = chapterVersion(content)
  if (parsed.expectedVersion && parsed.expectedVersion !== version) return { conflict: version }
  const sliced = sliceChapter(content, parsed.offset, parsed.limit)
  if ('error' in sliced) return sliced
  return { content: sliced.text, range: sliced.range }
}
