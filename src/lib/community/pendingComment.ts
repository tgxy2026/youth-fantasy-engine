// ============ 投稿广场 · 评论待确认意图（3.5.2）============
//
// 【为什么需要】服务端按 `clientToken` 去重，但前端每次点「发表评论」都生成新令牌时，
//   「服务端已写入、响应在网络上丢失」后的重试会产生第二条同内容评论。
//   这里把令牌绑定到「帖子 + 正文 + 展示方式」这一份意图上：同一份内容重试复用同一令牌，
//   用户改了正文/换了帖子就是新意图，绝不复用旧令牌。
//
// 🔴 令牌只在当前页面会话内有效（内存 Map）：刷新页面或换设备后不保证去重，
//    所以界面文案不能承诺「刷新后仍然只发一条」。安全优先于跨会话便利。
// 🔴 结果不确定（网络中断 / 超时 / 5xx）才保留令牌；服务端明确的 4xx 拒绝不保留。

import { CommunityError } from './api'
import type { DisplayMode } from './types'

export interface CommentIntent {
  postId: string
  body: string
  display: DisplayMode
}

/** 'failed' = 确认未写入；'unconfirmed' = 可能已写入，重试必须复用原令牌 */
export type CommentFailureKind = 'failed' | 'unconfirmed'

const MAX_PENDING = 50

export function commentIntentKey(intent: CommentIntent): string {
  // 用 JSON 编码，避免正文里出现分隔符时两份不同意图共用 key
  return JSON.stringify([intent.postId, intent.display, intent.body])
}

export function makeCommentToken(now = Date.now(), rand = Math.random): string {
  return `ct-${now}-${rand().toString(36).slice(2, 10)}`
}

/**
 * 取（或生成）该意图的令牌。
 * @param pending 页面会话内的「意图 → 令牌」映射；调用方负责在账号/页面切换时丢弃
 */
export function tokenForIntent(
  pending: Map<string, string>,
  intent: CommentIntent,
  make: () => string = makeCommentToken,
): { token: string; reused: boolean } {
  const key = commentIntentKey(intent)
  const existing = pending.get(key)
  if (existing) return { token: existing, reused: true }
  const token = make()
  pending.set(key, token)
  // 只保留最近 50 条意图，避免长时间停留在详情页时无限增长
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next().value
    if (oldest === undefined) break
    pending.delete(oldest)
  }
  return { token, reused: false }
}

export function forgetIntent(pending: Map<string, string>, intent: CommentIntent): void {
  pending.delete(commentIntentKey(intent))
}

export function classifyCommentFailure(error: unknown): CommentFailureKind {
  if (error instanceof CommunityError) {
    // 明确没发出去：本地就知道没有云端通道
    if (error.code === 'NO_ENDPOINT') return 'failed'
    // 网络异常 / 超时 / 5xx：无法确认是否已落盘，必须保留令牌以便安全重试
    if (error.status === 0 || error.status >= 500) return 'unconfirmed'
    // 400/401/403/404/409/429/503 都是服务端明确拒绝，未写入
    return 'failed'
  }
  // 未预期异常：保守按「结果未确认」处理
  return 'unconfirmed'
}