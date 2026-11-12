// ============ 投稿广场 · 评论待确认意图（3.5.2）============
//
// 守四件事：
//   ① 同一帖子 + 同一正文 + 同一展示方式 -> 复用同一令牌；
//   ② 正文 / 展示方式 / 帖子任一变化 -> 新令牌（旧回执不能套到新意图上）；
//   ③ 只有「结果未确认」才保留令牌；服务端明确 4xx 拒绝不保留；
//   ④ 长时间停留不会无限增长（有界 Map）。
//
// ?? 纯函数测试：不启 HTTP，不访问真实社区数据。浏览器里的实际重试流程另见隔离验证脚本。

import assert from 'node:assert/strict'
import { CommunityError } from '../src/lib/community/api'
import {
  commentIntentKey, classifyCommentFailure, forgetIntent, makeCommentToken, tokenForIntent,
  type CommentIntent,
} from '../src/lib/community/pendingComment'

let pass = 0
function ok(name: string, cond: boolean, extra = '') {
  assert.ok(cond, `${name}${extra ? ' :: ' + extra : ''}`)
  pass++
  console.log('PASS ' + name)
}

function intent(patch: Partial<CommentIntent> = {}): CommentIntent {
  return { postId: 'p_1', body: '这条评论用于验证重试去重。', display: 'anonymous', ...patch }
}

// ---- 令牌复用与上下文隔离 ----
{
  const pending = new Map<string, string>()
  const a = intent()
  const first = tokenForIntent(pending, a, () => 'tok-1')
  const retry = tokenForIntent(pending, intent(), () => 'tok-2')
  ok('同一意图重试复用同一令牌', first.token === 'tok-1' && retry.token === 'tok-1' && retry.reused === true)
  ok('同内容不同展示方式视为新意图', tokenForIntent(pending, intent({ display: 'nickname' }), () => 'tok-3').token === 'tok-3')
  ok('同内容换帖子视为新意图', tokenForIntent(pending, intent({ postId: 'p_2' }), () => 'tok-4').token === 'tok-4')
  ok('正文变化视为新意图', tokenForIntent(pending, intent({ body: '另一条不同的评论。' }), () => 'tok-5').token === 'tok-5')
  ok('意图键对分隔符不串味', commentIntentKey(intent({ body: 'a\u0000b' })) !== commentIntentKey(intent({ body: 'a', postId: 'b' })))
  forgetIntent(pending, a)
  ok('确认成功后可丢弃意图', tokenForIntent(pending, a, () => 'tok-6').token === 'tok-6')
}

// ---- 有界增长 ----
{
  const pending = new Map<string, string>()
  for (let i = 0; i < 60; i++) tokenForIntent(pending, intent({ body: `第 ${i} 条` }), () => `tok-${i}`)
  ok('待确认映射有界（最多 50 条）', pending.size === 50, `actual=${pending.size}`)
}

// ---- 失败分类 ----
ok('网络异常按「未确认」处理', classifyCommentFailure(new CommunityError('网络不通', 'NETWORK', 0)) === 'unconfirmed')
ok('5xx 按「未确认」处理', classifyCommentFailure(new CommunityError('服务端错误', 'SERVER', 500)) === 'unconfirmed')
ok('未知异常保守按「未确认」处理', classifyCommentFailure(new Error('boom')) === 'unconfirmed')
ok('参数错误是确定失败', classifyCommentFailure(new CommunityError('格式错误', 'BAD_REQUEST', 400)) === 'failed')
ok('限流是确定失败', classifyCommentFailure(new CommunityError('太频繁', 'RATE_LIMITED', 429)) === 'failed')
ok('令牌冲突是确定失败', classifyCommentFailure(new CommunityError('内容不一致', 'TOKEN_CONFLICT', 409)) === 'failed')
ok('本地无云端通道是确定失败', classifyCommentFailure(new CommunityError('不可用', 'NO_ENDPOINT', 0)) === 'failed')
ok('会话过期是确定失败', classifyCommentFailure(new CommunityError('登录过期', 'UNAUTHORIZED', 401)) === 'failed')

const t1 = makeCommentToken(1000, () => 0.5)
const t2 = makeCommentToken(1000, () => 0.5)
ok('令牌带前缀且可重复生成相同值（纯函数）', t1.startsWith('ct-') && t1 === t2)

console.log(`communityCommentPending: ${pass} passed, 0 failed`)