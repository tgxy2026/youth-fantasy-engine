// 3.5.2 · 匿名周代号纯分配的最小类型声明（真源是 communityAnon.mjs）

export const BEAST_DICTIONARY_VERSION: number
export const BEAST_DICTIONARY_SHA256: string
export const BEAST_NAMES: readonly string[]

/** 匿名代号映射：{ [周标识]: { [账号id]: 代号 } } */
export type AnonymousMapping = Record<string, Record<string, string>>

export function validAnonymousWeek(week: unknown): boolean
export function validAnonymousHandle(handle: unknown): boolean
/** 内容创建时间 -> 归属周（北京周一 00:00）；坏时间抛 code=COMMUNITY_ANON_UNAVAILABLE */
export function anonymousWeekKey(timestamp: number): string
/** 排行日期 -> 需预分配的周（报告日所在周 + 月首所在周，去重） */
export function anonymousRankWeeks(date: string): string[]

export function allocateAnonymousHandle(
  map: AnonymousMapping | null | undefined,
  uid: string,
  weekKey: string,
  secret: Buffer,
  names?: readonly string[],
): { mapping: AnonymousMapping; handle: string; created: boolean }

export function allocateAnonymousHandlesBatch(
  existing: AnonymousMapping | null | undefined,
  pairs: Array<[string, string]>,
  secret: Buffer,
  names?: readonly string[],
): { mapping: AnonymousMapping; created: Array<{ uid: string; week: string; handle: string }> }