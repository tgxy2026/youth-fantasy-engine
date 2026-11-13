// 3.5.0 · 投稿广场规则层的最小类型声明（真源是 communityRules.mjs，纯函数）
// 🔴 只声明测试与调用方会用到的导出；新增导出时必须同步补，避免「有实现但没人知道」。

export const COMMUNITY_LIMITS: {
  titleMax: number
  bodyMax: number
  commentMax: number
  tagMax: number
  tagLenMax: number
  nicknameMin: number
  nicknameMax: number
  pageSize: number
  pageSizeMax: number
  postDailyMax: number
  commentDailyMax: number
  reportDailyMax: number
}
export const COMMUNITY_TAGS: string[]

export function charCount(text: string): number
export function isBlank(text: string): boolean

export const POST_STATUS: {
  DRAFT: 'draft'
  PENDING: 'pending'
  PUBLISHED: 'published'
  CHANGES_REQUESTED: 'changes_requested'
  REJECTED: 'rejected'
  WITHDRAWN: 'withdrawn'
  REMOVED: 'removed'
}
export const COMMENT_STATUS: { PENDING: 'pending'; VISIBLE: 'visible'; REJECTED: 'rejected'; REMOVED: 'removed' }
export const PUBLIC_POST_STATUS: string[]
export const PUBLIC_COMMENT_STATUS: string[]

export type Validated<T> = { ok: true; value: T } | { ok: false; code: string; error: string }

export function validatePostInput(input: { title?: unknown; body?: unknown; tags?: unknown }): Validated<{ title: string; body: string; tags: string[] }>
export function validateCommentInput(input: { body?: unknown }): Validated<{ body: string }>
export function validateNickname(raw: unknown): Validated<string>
export function normalizeDisplayMode(raw: unknown, fallback?: 'nickname' | 'anonymous'): 'nickname' | 'anonymous'

export interface Screening {
  level: 'low' | 'review' | 'high'
  reasons: string[]
  truncated: boolean
}
export function screenContent(text: string, kind?: 'post' | 'comment'): Screening
export function commentAutoVisible(screening: Screening | null | undefined): boolean

export function encodeCursor(cursor: { ts: number; id: string }): string
export function decodeCursor(raw: string | null | undefined): { ts: number; id: string } | null
export function clampPageSize(raw: unknown): number
export function pageRows<T extends { id: string; ts: number }>(
  rows: T[],
  opts?: { cursor?: { ts: number; id: string } | null; limit?: number },
): { items: T[]; nextCursor: string }

export function validateDecision(
  post: { status: string; pendingVersionId?: string; publishedVersionId?: string } | null,
  versionId: string,
  action: string,
): { ok: true } | { ok: false; code: string; error: string }

export const RANK_TZ_OFFSET_MIN: number
export function dateKeyToUtc(dateKey: string): number | null
export function utcToDateKey(ms: number): string
export function todayKeyCn(nowMs?: number): string
export function periodRange(period: 'day' | 'week' | 'month', dateKey: string): { start: string; end: string } | null

export function aggregateRank(
  rows: Array<{ id: string; date: string; netDelta: number }>,
  opts: { period?: 'day' | 'week' | 'month'; date?: string; today?: string },
): Array<{ id: string; raw: number; value: number; rank: number }>

export function applyRankReport(
  existing: { seq: number; netDelta: number } | null,
  incoming: { seq: number; netDelta: number },
): { accept: boolean; row: { seq: number; netDelta: number } }

export function rankHandle(uid: string, dateKey: string): string
