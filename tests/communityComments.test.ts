// ============ 投稿广场 · 评论分页 / 计数 / 重试去重（3.5.2）============
//
// 起真实 http 服务挂 `communityApi`，用测试头模拟会话（真实环境由 index.mjs 的 authCheck 提供）。
//
// 守的是 3.5.2 P0-1 / P0-2 的**服务端契约**：
//   ① 评论列表返回权威 `total`（公开可见口径），分页 0/1/20/21 与稳定排序；
//   ② 待审 / 被拒 / 已删除评论不计入 total；
//   ③ 同一令牌 + 同一内容重试幂等，限流用尽后仍能取回已确认结果；
//   ④ 同一令牌 + 不同内容返回 409，绝不静默返回旧评论；
//   ⑤ 令牌按「账号 + 帖子」归属，不跨用户/跨帖子误命中。
//
// ?? 本地 http + 内存限流；不等于部署环境（TLS / 反代 / 多进程 / 断电）。

import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCommunityStore } from '../server/lib/communityStore.mjs'
import { createCommunityApi } from '../server/lib/communityApi.mjs'
import { rateLimit } from '../server/lib/ratelimit.mjs'
import { acquireCommunityLock, releaseCommunityLock } from '../server/lib/communityLock.mjs'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yfe-community-comments-'))
const store = createCommunityStore({ root })
const USERS: Record<string, { id: string; name: string; role?: string }> = {
  alice: { id: 'u_alice', name: 'alice' },
  bob: { id: 'u_bob', name: 'bob' },
  carol: { id: 'u_carol', name: 'carol' },
  dave: { id: 'u_dave', name: 'dave' },
  mod: { id: 'u_mod', name: 'mod', role: 'moderator' },
}
const byId = new Map(Object.values(USERS).map((u) => [u.id, u]))
const api = createCommunityApi({
  store,
  authCheck: (req: any) => {
    const who = String(req.headers['x-test-user'] || '')
    return { user: USERS[who] || null, reason: USERS[who] ? '' : 'NO_TOKEN' }
  },
  rateLimit,
})

const server = createServer((req, res) => {
  const url = req.url || '/'
  const pathOnly = url.split('?')[0]
  const qs = new URLSearchParams(url.split('?')[1] || '')
  if (!pathOnly.startsWith('/api/community')) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{"ok":false}')
    return
  }
  const who = String(req.headers['x-test-user'] || '')
  const user = USERS[who] ? byId.get(USERS[who].id)! : null
  api.handle({ req, res, path: pathOnly, qs, user, authReason: user ? '' : 'NO_TOKEN', ip: '127.0.0.1' })
    .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: String(e) })) })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
const addr = server.address()
const port = typeof addr === 'object' && addr ? addr.port : 0
const base = `http://127.0.0.1:${port}`

interface Result { status: number; json: any; raw: string }
async function call(p: string, opts: { method?: string; body?: unknown; as?: string } = {}): Promise<Result> {
  const headers: Record<string, string> = {}
  if (opts.as) headers['x-test-user'] = opts.as
  let body: string | undefined
  if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body) }
  const res = await fetch(base + p, { method: opts.method || 'GET', headers, body })
  const raw = await res.text()
  let json: any = null
  try { json = JSON.parse(raw) } catch { json = null }
  return { status: res.status, json, raw }
}

const body = (n = 30) => '字'.repeat(n) + '，雨落在城墙上。'
const commentOf = (i: number, postId: string) => `合成评论第 ${i} 条，仅用于隔离验证 ${postId}。`
async function commentsPage(pid: string, cursor = '', limit = 20) {
  return call(`/api/community/posts/${pid}/comments?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
}
/** 遍历全部分页，返回 { items, pages }；同时校验 total 稳定 */
async function walkComments(pid: string, limit = 20) {
  const items: any[] = []
  const totals: number[] = []
  let cursor = ''
  let pages = 0
  do {
    const p = await commentsPage(pid, cursor, limit)
    if (p.status !== 200) throw new Error(`comments page failed: ${p.status} ${p.raw}`)
    items.push(...p.json.items)
    totals.push(p.json.total)
    pages++
    cursor = p.json.nextCursor || ''
  } while (cursor)
  return { items, totals, pages }
}
async function postDetail(pid: string) { return call(`/api/community/posts/${pid}`) }
async function commentTotal(pid: string) {
  const p = await commentsPage(pid)
  return Number(p.json?.total)
}

console.log('\n—— 评论分页 / 计数 / 重试去重 用例开始 ——')

try {
  const created = await call('/api/community/posts', {
    method: 'POST', as: 'alice',
    body: { title: '评论分页验证稿', body: body(), tags: ['短篇'], display: 'anonymous' },
  })
  const pid = created.json.post.id as string
  await call('/api/community/admin/decision', {
    method: 'POST', as: 'mod',
    body: { targetType: 'post', id: pid, versionId: created.json.post.pendingVersionId, action: 'approve' },
  })

  // ---- 0 条 ----
  const zero = await commentsPage(pid)
  ok('0 条评论：total=0 且无下一页', zero.json.total === 0 && zero.json.items.length === 0 && zero.json.nextCursor === '')
  ok('0 条评论：详情计数为 0', (await postDetail(pid)).json.post.counts.comments === 0)

  // ---- 1 条 / 20 条 / 21 条：每条都核对服务端 total 与详情计数 ----
  let allConsistent = true
  for (let i = 1; i <= 21; i++) {
    const r = await call(`/api/community/posts/${pid}/comments`, {
      method: 'POST', as: 'bob',
      body: { body: commentOf(i, pid), display: 'anonymous', clientToken: `page-${i}` },
    })
    if (r.status !== 200 || r.json.comment.status !== 'visible') { allConsistent = false; break }
    const total = await commentTotal(pid)
    const detailCount = (await postDetail(pid)).json.post.counts.comments
    if (total !== i || detailCount !== i || r.json.total !== i) { allConsistent = false; break }
  }
  ok('0/1/20/21 条：total 与详情计数逐条一致', allConsistent)

  const page1 = await commentsPage(pid)
  const page2 = await commentsPage(pid, page1.json.nextCursor)
  ok('21 条：第一页 20 条 + 游标', page1.json.items.length === 20 && !!page1.json.nextCursor && page1.json.total === 21)
  ok('21 条：第二页 1 条且到底', page2.json.items.length === 1 && page2.json.nextCursor === '')
  const walked = await walkComments(pid)
  ok('21 条：分页遍历无重复、无遗漏', walked.items.length === 21 && new Set(walked.items.map((c) => c.id)).size === 21)
  ok('分页过程中 total 始终是权威总数', walked.totals.every((n) => n === 21))
  ok('游标只用于排序，不因页数变化改口径', walked.pages === 2)

  // ---- 同一时间戳：稳定排序 ----
  const created2 = await call('/api/community/posts', {
    method: 'POST', as: 'alice',
    body: { title: '同时间戳排序验证稿', body: body(), tags: ['短篇'], display: 'anonymous' },
  })
  const pid2 = created2.json.post.id as string
  await call('/api/community/admin/decision', {
    method: 'POST', as: 'mod',
    body: { targetType: 'post', id: pid2, versionId: created2.json.post.pendingVersionId, action: 'approve' },
  })
  const fixedTs = 1700000000000
  for (const id of ['c_fix_a', 'c_fix_b', 'c_fix_c']) {
    store.putComment({
      id, postId: pid2, uid: 'u_alice', body: `同时间戳 ${id}`, display: 'anonymous',
      status: 'visible', screening: { level: 'low', reasons: [] }, clientToken: '', createdAt: fixedTs,
    })
  }
  const p2 = store.getPost(pid2)
  if (!p2) throw new Error('second post missing')
  p2.counts = { ...(p2.counts || {}), comments: 3 }
  store.putPost(p2)
  const stable1 = await walkComments(pid2, 1)
  const stable2 = await walkComments(pid2, 1)
  const order = stable1.items.map((c) => c.id)
  ok('同时间戳按 id 倒序稳定排列', JSON.stringify(order) === JSON.stringify(['c_fix_c', 'c_fix_b', 'c_fix_a']), JSON.stringify(order))
  ok('同时间戳两次分页结果一致', JSON.stringify(stable1.items.map((c) => c.id)) === JSON.stringify(stable2.items.map((c) => c.id)))
  ok('同时间戳分页不重复不丢失', new Set(order).size === 3 && order.length === 3 && stable1.totals.every((n) => n === 3))

  // ---- 待审 / 被拒 / 已删除不计入 total ----
  const bad = await call(`/api/community/posts/${pid}/comments`, {
    method: 'POST', as: 'carol',
    body: { body: '加我 QQ 123456789 一起刷单', display: 'anonymous', clientToken: 'pending-1' },
  })
  ok('命中规则的评论进入待审', bad.status === 200 && bad.json.comment.status === 'pending')
  ok('待审评论不计入 total', (await commentTotal(pid)) === 21)
  const rejectedQueue = await call('/api/community/admin/queue?type=comment', { as: 'mod' })
  ok('待审评论进入管理队列', rejectedQueue.json.items.some((c: any) => c.id === bad.json.comment.id))
  await call('/api/community/admin/decision', {
    method: 'POST', as: 'mod', body: { targetType: 'comment', id: bad.json.comment.id, action: 'reject' },
  })
  ok('被拒评论不计入 total', (await commentTotal(pid)) === 21)

  const firstId = page1.json.items[0].id as string
  ok('作者可删除自己的可见评论', (await call(`/api/community/comments/${firstId}`, { method: 'DELETE', as: 'bob' })).json.changed === true)
  ok('删除后 total 立即回退', (await commentTotal(pid)) === 20)
  ok('删除后详情计数同步', (await postDetail(pid)).json.post.counts.comments === 20)

  const approvedComment = await call(`/api/community/posts/${pid}/comments`, {
    method: 'POST', as: 'carol',
    body: { body: '加我 QQ 987654321 一起刷单做任务', display: 'anonymous', clientToken: 'pending-2' },
  })
  await call('/api/community/admin/decision', {
    method: 'POST', as: 'mod', body: { targetType: 'comment', id: approvedComment.json.comment.id, action: 'approve' },
  })
  ok('管理员通过待审评论后 total 增加', (await commentTotal(pid)) === 21)
  ok('通过后详情计数同步', (await postDetail(pid)).json.post.counts.comments === 21)

  // ---- 同一令牌 + 同一内容：幂等 ----
  const retryIntent = { body: '同一条未确认评论，用于验证重试去重。', display: 'anonymous' }
  const r1 = await call(`/api/community/posts/${pid}/comments`, { method: 'POST', as: 'bob', body: { ...retryIntent, clientToken: 'retry-1' } })
  const r2 = await call(`/api/community/posts/${pid}/comments`, { method: 'POST', as: 'bob', body: { ...retryIntent, clientToken: 'retry-1' } })
  ok('同令牌同内容重试不产生第二条', r2.json.duplicate === true && r2.json.comment.id === r1.json.comment.id && r2.json.total === r1.json.total)
  ok('重试返回已确认评论正文而非空回执', r2.json.comment.body === retryIntent.body)
  ok('重试后 total 不重复增加', (await commentTotal(pid)) === 22)

  // ---- 同一令牌 + 不同内容：冲突 ----
  const conflict = await call(`/api/community/posts/${pid}/comments`, {
    method: 'POST', as: 'bob',
    body: { body: '完全不同的新内容，不能静默复用旧评论。', display: 'anonymous', clientToken: 'retry-1' },
  })
  ok('同令牌不同内容返回 409 TOKEN_CONFLICT', conflict.status === 409 && conflict.json.code === 'TOKEN_CONFLICT')
  ok('冲突响应不回传旧评论正文', !conflict.raw.includes(retryIntent.body) && conflict.json.comment === undefined)
  ok('冲突不写入新评论', (await commentTotal(pid)) === 22)

  // ---- 令牌归属：同令牌换帖子 / 换账号 ----
  const otherPost = await call(`/api/community/posts/${pid2}/comments`, {
    method: 'POST', as: 'bob', body: { ...retryIntent, clientToken: 'retry-1' },
  })
  ok('同一令牌在另一帖子下是新评论（作用域=帖子）', otherPost.status === 200 && otherPost.json.duplicate !== true)
  const otherUser = await call(`/api/community/posts/${pid}/comments`, {
    method: 'POST', as: 'carol', body: { ...retryIntent, clientToken: 'retry-1' },
  })
  ok('同一令牌在另一账号下是新评论（作用域=账号）', otherUser.status === 200 && otherUser.json.duplicate !== true)

  // ---- 限流先于去重的边界：配额用尽后合法重试仍能取回结果 ----
  const daveToken = 'dave-retry-1'
  const daveIntent = { body: '配额用尽后的重试必须仍然幂等。', display: 'anonymous' }
  const daveFirst = await call(`/api/community/posts/${pid}/comments`, { method: 'POST', as: 'dave', body: { ...daveIntent, clientToken: daveToken } })
  ok('dave 第一条评论成功', daveFirst.status === 200)
  let fillStatus = 0
  for (let i = 0; i < 60; i++) {
    const r = await call(`/api/community/posts/${pid}/comments`, {
      method: 'POST', as: 'dave',
      body: { body: `配额填充评论 ${i}，仅用于隔离验证。`, display: 'anonymous', clientToken: `dave-fill-${i}` },
    })
    fillStatus = r.status
    if (r.status === 429) break
  }
  ok('dave 达到每日评论上限（429）', fillStatus === 429)
  const retryAtCap = await call(`/api/community/posts/${pid}/comments`, { method: 'POST', as: 'dave', body: { ...daveIntent, clientToken: daveToken } })
  ok('配额用尽后同一令牌重试仍返回已确认结果', retryAtCap.status === 200 && retryAtCap.json.duplicate === true && retryAtCap.json.comment.id === daveFirst.json.comment.id)
  const newAtCap = await call(`/api/community/posts/${pid}/comments`, {
    method: 'POST', as: 'dave', body: { body: '配额用尽后的新内容必须被拒。', display: 'anonymous', clientToken: 'dave-new-after-cap' },
  })
  ok('配额用尽后新内容仍被限流拒绝', newAtCap.status === 429)

  // ---- 最终一致性：分页遍历 == total == 详情计数 ----
  const finalWalk = await walkComments(pid)
  const finalTotal = await commentTotal(pid)
  const finalDetail = (await postDetail(pid)).json.post.counts.comments
  ok('最终分页遍历数量 == total', finalWalk.items.length === finalTotal)
  ok('最终 total == 详情计数', finalTotal === finalDetail)
  ok('最终公开评论无重复 id', new Set(finalWalk.items.map((c) => c.id)).size === finalWalk.items.length)
  ok('最终遍历中不含待审/被拒评论', !finalWalk.items.some((c) => c.id === bad.json.comment.id))

  // ---- Unicode 码点边界（emoji 按 1 个字符计） ----
  const emoji999 = Array.from({ length: 999 }, (_, i) => String.fromCodePoint(0x1F600 + (i % 80))).join('')
  const emoji1000 = Array.from({ length: 1000 }, (_, i) => String.fromCodePoint(0x1F600 + (i % 80))).join('')
  const emojiOk = await call(`/api/community/posts/${pid}/comments`, {
    method: 'POST', as: 'carol',
    body: { body: emoji999 + '字', display: 'anonymous', clientToken: 'emoji-1000' },
  })
  ok('1000 个码点（含 emoji）可提交', emojiOk.status === 200 && emojiOk.json.comment?.status === 'visible', emojiOk.raw)
  const emojiTooLong = await call(`/api/community/posts/${pid}/comments`, {
    method: 'POST', as: 'carol',
    body: { body: emoji1000 + '字', display: 'anonymous', clientToken: 'emoji-1001' },
  })
  ok('1001 个码点被服务端拒绝', emojiTooLong.status === 400 && emojiTooLong.json.code === 'COMMENT_TOO_LONG')

  // ---- 锁存在时 API 写入 503，读取仍可用 ----
  const apiLock = acquireCommunityLock(root, { tool: 'api-test' })
  const blockedWrite = await call(`/api/community/posts/${pid}/comments`, {
    method: 'POST', as: 'bob',
    body: { body: '锁定时不应写入的合成评论。', display: 'anonymous', clientToken: 'locked-api' },
  })
  ok('R3 锁存在时 API 写入返回 503', blockedWrite.status === 503 && blockedWrite.json.code === 'BACKUP_IN_PROGRESS')
  ok('R3 锁存在时读取仍可用', (await call(`/api/community/posts/${pid}/comments?limit=20`)).status === 200)
  ok('R3 锁未写入评论', !store.listCommentsOf(pid).some((c) => c.clientToken === 'locked-api'))
  const apiLockRelease = releaseCommunityLock(root)
  ok('R3 释放锁后可写入', (await call(`/api/community/posts/${pid}/comments`, {
    method: 'POST', as: 'bob',
    body: { body: '锁释放后的合成评论。', display: 'anonymous', clientToken: 'after-lock' },
  })).status === 200)
  ok('R3 锁清理成功', apiLock.ok && apiLockRelease.released === true)

  // ---- 读取正文期间帖子被下架：写前必须重新确认 ----
  const slow = new Readable({ read() { /* push later */ } }) as Readable & { method: string }
  slow.method = 'POST'
  const slowRes = {
    statusCode: 0,
    body: '',
    writeHead(status: number) { this.statusCode = status },
    end(text: string) { this.body += String(text) },
  }
  const slowTask = api.handle({
    req: slow,
    res: slowRes,
    path: `/api/community/posts/${pid}/comments`,
    qs: new URLSearchParams(),
    user: USERS.bob,
    authReason: '',
    ip: '127.0.0.1',
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const removed = store.getPost(pid)
  removed!.status = 'removed'
  removed!.removedAt = Date.now()
  store.putPost(removed!)
  slow.push(Buffer.from(JSON.stringify({ body: '迟到后不应写入的合成评论。', display: 'anonymous', clientToken: 'late-removed' })))
  slow.push(null)
  await slowTask
  ok('等待正文期间帖子被下架 -> 404', slowRes.statusCode === 404, slowRes.body)
  ok('下架后迟到请求未写入评论', !store.listCommentsOf(pid).some((c) => c.clientToken === 'late-removed'))
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  const target = fs.realpathSync(root)
  if (path.dirname(target) !== fs.realpathSync(os.tmpdir()) || !path.basename(target).startsWith('yfe-community-comments-')) {
    throw new Error('拒绝清理不安全的测试目录')
  }
  fs.rmSync(target, { recursive: true, force: true })
}

console.log(`communityComments: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1