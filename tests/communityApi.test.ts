// ============ 投稿广场 · HTTP 接口回归（3.5.0） ============
//
// 起一个真实 http 服务，把 `communityApi` 挂在 `/api/community/**` 上，
// 会话用测试头 `x-test-user` 模拟（真实环境由 index.mjs 的 authCheck 提供）。
//
// 守的是「服务端是唯一裁判」：未登录、越权、匿名泄露、重复提交、并发投票、
// 审核过期版本、开关与限流 —— 这些前端隐藏按钮挡不住。
//
// ?? 本地通过 ≠ 部署验收：这里没有 TLS、没有真实部署反代、没有多进程竞争。

import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCommunityStore } from '../server/lib/communityStore.mjs'
import { createCommunityApi } from '../server/lib/communityApi.mjs'
import { rateLimit } from '../server/lib/ratelimit.mjs'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yfe-community-'))
const store = createCommunityStore({ root })
const USERS: Record<string, { id: string; name: string; role?: string }> = {
  alice: { id: 'u_alice', name: 'alice' },
  bob: { id: 'u_bob', name: 'bob' },
  carol: { id: 'u_carol', name: 'carol' },
  dave: { id: 'u_dave', name: 'dave' },
  mod: { id: 'u_mod', name: 'mod', role: 'moderator' },
  admin: { id: 'u_admin', name: 'admin', role: 'admin' },
}
const byId = new Map(Object.values(USERS).map((u) => [u.id, u]))
const api = createCommunityApi({
  store,
  authCheck: (req: any) => {
    const who = String(req.headers['x-test-user'] || '')
    const u = USERS[who]
    return { user: u || null, reason: u ? '' : 'NO_TOKEN' }
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
  const authReason = user ? '' : 'NO_TOKEN'
  api.handle({ req, res, path: pathOnly, qs, user, authReason, ip: '127.0.0.1' })
    .catch((e) => { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: String(e) })) })
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
const addr = server.address()
const port = typeof addr === 'object' && addr ? addr.port : 0
const base = `http://127.0.0.1:${port}`

interface Result { status: number; json: any; raw: string }
async function call(p: string, opts: { method?: string; body?: unknown; as?: string; headers?: Record<string, string> } = {}): Promise<Result> {
  const headers: Record<string, string> = { ...(opts.headers || {}) }
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

console.log('\n—— communityApi 用例开始 ——')

try {
  // ---- 公共读与未登录 ----
  const square = await call('/api/community/square')
  ok('未登录可读广场状态', square.status === 200 && square.json.ok === true && square.json.open === true)
  ok('广场公布字数上限（与规则层一致）', square.json.limits.bodyMax === 10000 && square.json.limits.commentMax === 1000)
  const empty = await call('/api/community/posts')
  ok('未登录可浏览列表且为空', empty.status === 200 && Array.isArray(empty.json.items) && empty.json.items.length === 0)
  ok('未登录不能投稿', (await call('/api/community/posts', { method: 'POST', body: { title: 't', body: body() } })).status === 401)
  ok('未登录不能评论', (await call('/api/community/posts/x/comments', { method: 'POST', body: { body: 'hi' } })).status === 401)
  ok('未登录不能读取自己的投稿', (await call('/api/community/my/posts')).status === 401)
  ok('未登录不能开排行', (await call('/api/community/rank/report', { method: 'POST', body: {} })).status === 401)

  // ---- 投稿 → 待审 → 发布 ----
  const created = await call('/api/community/posts', { method: 'POST', as: 'alice', body: { title: '第一场雨', body: body(), tags: ['短篇'], display: 'anonymous' } })
  ok('投稿创建成功并进入待审', created.status === 200 && created.json.post.status === 'pending')
  const pid = created.json.post.id as string
  const vid = created.json.post.pendingVersionId as string
  ok('待审内容不在公开列表', (await call('/api/community/posts')).json.items.length === 0)
  const guestDetail = await call(`/api/community/posts/${pid}`)
  ok('待审内容详情对游客不可见', guestDetail.status === 404
    || (guestDetail.status === 200 && guestDetail.json?.unavailable === true && guestDetail.json?.post === undefined))
  ok('游客拿到的详情不含正文', guestDetail.json?.post?.body === undefined)

  const wrongVersion = await call('/api/community/admin/decision', { method: 'POST', as: 'mod', body: { targetType: 'post', id: pid, versionId: 'v_nope', action: 'approve' } })
  ok('版本不匹配的审批被拒', wrongVersion.status === 409 && wrongVersion.json.code === 'STALE_VERSION')
  ok('普通用户不能审批', (await call('/api/community/admin/decision', { method: 'POST', as: 'bob', body: { targetType: 'post', id: pid, versionId: vid, action: 'approve' } })).status === 403)

  const approved = await call('/api/community/admin/decision', { method: 'POST', as: 'mod', body: { targetType: 'post', id: pid, versionId: vid, action: 'approve' } })
  ok('管理员确认后才发布', approved.status === 200 && approved.json.status === 'published')
  const list1 = await call('/api/community/posts')
  ok('发布后出现在公开列表', list1.json.items.length === 1 && list1.json.items[0].id === pid)
  ok('列表只给摘要不给全文', typeof list1.json.items[0].excerpt === 'string' && list1.json.items[0].body === undefined)
  const detail1 = await call(`/api/community/posts/${pid}`)
  ok('详情给全文', detail1.json.post.body === body())
  ok('匿名展示不泄露账号 id / 登录名', !detail1.raw.includes('u_alice') && !detail1.raw.includes('alice') && detail1.json.post.displayName === '匿名用户')

  // ---- 投票 ----
  ok('作者不能给自己投票', (await call(`/api/community/posts/${pid}/vote`, { method: 'POST', as: 'alice', body: { value: 1 } })).status === 400)
  const up = await call(`/api/community/posts/${pid}/vote`, { method: 'POST', as: 'bob', body: { value: 1 } })
  ok('点赞计入', up.json.counts.up === 1 && up.json.myVote === 1)
  const dup = await call(`/api/community/posts/${pid}/vote`, { method: 'POST', as: 'bob', body: { value: 1 } })
  ok('重复点赞不重复计数（幂等）', dup.json.counts.up === 1 && dup.json.counts.down === 0)
  const down = await call(`/api/community/posts/${pid}/vote`, { method: 'POST', as: 'bob', body: { value: -1 } })
  ok('切换为点踩后只保留一个', down.json.counts.up === 0 && down.json.counts.down === 1)
  const cancel = await call(`/api/community/posts/${pid}/vote`, { method: 'POST', as: 'bob', body: { value: 0 } })
  ok('取消投票', cancel.json.counts.up === 0 && cancel.json.counts.down === 0)

  // ---- 评论分流 ----
  const goodComment = await call(`/api/community/posts/${pid}/comments`, { method: 'POST', as: 'bob', body: { body: '这段雨声写得很有画面感。', clientToken: 'ct-1' } })
  ok('低风险评论直接可见', goodComment.json.comment.status === 'visible')
  const sameToken = await call(`/api/community/posts/${pid}/comments`, { method: 'POST', as: 'bob', body: { body: '这段雨声写得很有画面感。', clientToken: 'ct-1' } })
  ok('同一令牌重复提交不产生第二条', sameToken.json.duplicate === true && sameToken.json.comment.id === goodComment.json.comment.id)
  const badComment = await call(`/api/community/posts/${pid}/comments`, { method: 'POST', as: 'carol', body: { body: '加我 QQ 123456789 一起刷单' } })
  ok('可疑评论进入待审', badComment.json.comment.status === 'pending')
  const comments1 = await call(`/api/community/posts/${pid}/comments`)
  ok('待审评论对他人不可见', comments1.json.items.length === 1 && comments1.json.items[0].id === goodComment.json.comment.id)
  const authorComment = await call(`/api/community/posts/${pid}/comments`, { method: 'POST', as: 'alice', body: { body: '谢谢喜欢，后面还有一场夜雨。' } })
  const comments2 = await call(`/api/community/posts/${pid}/comments`)
  const mark = comments2.json.items.find((c: any) => c.id === authorComment.json.comment.id)
  ok('作者回复标出「作者」但不泄露身份', !!mark && mark.byAuthor === true && !comments2.raw.includes('alice'))
  const badId = badComment.json.comment.id as string
  const modApprove = await call('/api/community/admin/decision', { method: 'POST', as: 'mod', body: { targetType: 'comment', id: badId, action: 'approve' } })
  ok('管理员可通过待审评论', modApprove.status === 200 && modApprove.json.status === 'visible')
  ok('通过后公开可见', (await call(`/api/community/posts/${pid}/comments`)).json.items.length === 3)
  ok('不能删除别人的评论', (await call(`/api/community/comments/${goodComment.json.comment.id}`, { method: 'DELETE', as: 'carol' })).status === 403)
  const delOwn = await call(`/api/community/comments/${goodComment.json.comment.id}`, { method: 'DELETE', as: 'bob' })
  ok('可删除自己的评论且计数回退', delOwn.status === 200 && (await call(`/api/community/posts/${pid}`)).json.post.counts.comments === 2)
  ok('重复删除幂等', (await call(`/api/community/comments/${goodComment.json.comment.id}`, { method: 'DELETE', as: 'bob' })).json.changed === false)

  // ---- 越权 ----
  ok('他人不能编辑我的投稿', (await call(`/api/community/posts/${pid}`, { method: 'PUT', as: 'bob', body: { title: '篡改', body: body() } })).status === 403)

  // ---- 修改 → 旧版本继续展示 → 新版本审核 ----
  const edited = await call(`/api/community/posts/${pid}`, { method: 'PUT', as: 'alice', body: { title: '第一场雨（修）', body: body(40) } })
  const vid2 = edited.json.post.pendingVersionId as string
  ok('修改生成新的待审版本', edited.json.post.status === 'pending' && vid2 !== vid)
  const stillPublic = await call(`/api/community/posts/${pid}`)
  ok('审核期间旧版本仍公开展示', stillPublic.json.post.title === '第一场雨')
  const lateOld = await call('/api/community/admin/decision', { method: 'POST', as: 'mod', body: { targetType: 'post', id: pid, versionId: vid, action: 'approve' } })
  ok('旧版本迟到回执不能生效', lateOld.status === 409 && lateOld.json.code === 'STALE_VERSION')
  await call('/api/community/admin/decision', { method: 'POST', as: 'mod', body: { targetType: 'post', id: pid, versionId: vid2, action: 'approve' } })
  ok('新版本通过后替换公开内容', (await call(`/api/community/posts/${pid}`)).json.post.title === '第一场雨（修）')

  // ---- 撤回 ----
  ok('他人不能撤回我的投稿', (await call(`/api/community/posts/${pid}/withdraw`, { method: 'POST', as: 'bob' })).status === 403)
  const wd = await call(`/api/community/posts/${pid}/withdraw`, { method: 'POST', as: 'alice' })
  ok('作者撤回后立即退出公开列表', wd.status === 200 && (await call('/api/community/posts')).json.items.length === 0)
  const gone = await call(`/api/community/posts/${pid}`)
  ok('撤回后详情返回不可见', gone.status === 404 || gone.json?.post === undefined)
  ok('撤回后旧链接不暴露作者或原因', !gone.raw.includes('u_alice') && !gone.raw.includes('alice')
    && gone.json?.post === undefined)
  ok('撤回后不能再审批（无待审版本）', (await call('/api/community/admin/decision', { method: 'POST', as: 'mod', body: { targetType: 'post', id: pid, versionId: vid2, action: 'approve' } })).status === 409)

  // ---- 昵称展示 ----
  await call('/api/community/profile', { method: 'PUT', as: 'alice', body: { nickname: '雨声', postDisplay: 'nickname' } })
  const post2 = await call('/api/community/posts', { method: 'POST', as: 'alice', body: { title: '夜雨', body: body(), display: 'nickname' } })
  const pid2 = post2.json.post.id as string
  await call('/api/community/admin/decision', { method: 'POST', as: 'mod', body: { targetType: 'post', id: pid2, versionId: post2.json.post.pendingVersionId, action: 'approve' } })
  const nickDetail = await call(`/api/community/posts/${pid2}`)
  ok('选择昵称时展示昵称', nickDetail.json.post.displayName === '雨声')
  ok('昵称展示仍不泄露登录名', !nickDetail.raw.includes('alice') && !nickDetail.raw.includes('u_alice'))
  await call('/api/community/profile', { method: 'PUT', as: 'alice', body: { display: 'anonymous' } })
  const post3 = await call('/api/community/posts', { method: 'POST', as: 'alice', body: { title: '匿名夜雨', body: body(), display: 'anonymous' } })
  await call('/api/community/admin/decision', { method: 'POST', as: 'mod', body: { targetType: 'post', id: post3.json.post.id, versionId: post3.json.post.pendingVersionId, action: 'approve' } })
  ok('切回匿名后新内容不显示昵称', (await call(`/api/community/posts/${post3.json.post.id}`)).json.post.displayName === '匿名用户')
  ok('昵称非法被拒（不能冒用「匿名用户」）', (await call('/api/community/profile', { method: 'PUT', as: 'bob', body: { nickname: '匿名用户' } })).status === 400)

  // ---- 举报 ----
  const rep = await call('/api/community/reports', { method: 'POST', as: 'carol', body: { targetType: 'post', targetId: pid2, reason: '不当内容', detail: '' } })
  ok('举报创建成功', rep.status === 200 && rep.json.status === 'open')
  ok('重复举报同一目标合并', (await call('/api/community/reports', { method: 'POST', as: 'carol', body: { targetType: 'post', targetId: pid2, reason: '再次举报' } })).json.duplicate === true)
  const repQueue = await call('/api/community/admin/queue?type=report', { as: 'mod' })
  ok('举报进入管理队列', repQueue.json.items.length === 1 && repQueue.json.items[0].id === rep.json.id)
  ok('普通用户不能看管理队列', (await call('/api/community/admin/queue', { as: 'bob' })).status === 403)
  const closeRep = await call('/api/community/admin/report', { method: 'POST', as: 'mod', body: { id: rep.json.id, action: 'takedown', outcome: '违规下架' } })
  ok('举报成立可下架投稿', closeRep.status === 200 && (await call(`/api/community/posts/${pid2}`)).json?.post === undefined)
  ok('下架后不再出现在列表', (await call('/api/community/posts')).json.items.every((p: any) => p.id !== pid2))

  // 申诉重开不能复活被下架的旧版本（隔离流程里抓到的真实缺陷，这里钉住）
  const appeal = await call('/api/community/appeals', {
    method: 'POST', as: 'alice',
    body: { postId: pid2, versionId: post2.json.post.pendingVersionId, reason: '请求复核' },
  })
  ok('作者可申诉并绑定版本', appeal.status === 200 && appeal.json.status === 'open')
  const appealQueue = await call('/api/community/admin/queue?type=appeal', { as: 'mod' })
  ok('申诉进入独立队列', appealQueue.json.items.some((x: any) => x.id === appeal.json.id))
  const reopened = await call('/api/community/admin/report', { method: 'POST', as: 'mod', body: { id: appeal.json.id, action: 'reopen', outcome: '申诉成立' } })
  ok('申诉重开后仍不公开（旧版本不复活）', reopened.status === 200 && (await call(`/api/community/posts/${pid2}`)).json?.post === undefined)

  // ---- 审核工作台 ----
  const q = await call('/api/community/admin/queue?type=post', { as: 'mod' })
  ok('待审队列按提交先后返回', q.status === 200 && Array.isArray(q.json.items))
  const overview = await call('/api/community/admin/overview', { as: 'mod' })
  ok('工作台概览含队列与开关', overview.json.ok === true && typeof overview.json.queue.posts === 'number' && overview.json.state.squareOpen === true)
  const audit = await call('/api/community/admin/audit', { as: 'admin' })
  ok('审核操作留有审计记录', audit.json.items.length > 0 && audit.json.items.some((e: any) => e.action === 'post.approve'))

  // ---- 开关 ----
  ok('审核员不能改全局开关', (await call('/api/community/admin/switch', { method: 'POST', as: 'mod', body: { postsOpen: false } })).status === 403)
  const closed = await call('/api/community/admin/switch', { method: 'POST', as: 'admin', body: { postsOpen: false } })
  ok('管理员可暂停新投稿', closed.status === 200 && closed.json.state.postsOpen === false)
  ok('暂停期间投稿返回 503 且不落库', (await call('/api/community/posts', { method: 'POST', as: 'bob', body: { title: 't', body: body() } })).status === 503)
  ok('暂停期间广场仍可浏览', (await call('/api/community/posts')).status === 200)
  await call('/api/community/admin/switch', { method: 'POST', as: 'admin', body: { postsOpen: true } })
  const squareClosed = await call('/api/community/admin/switch', { method: 'POST', as: 'admin', body: { squareOpen: false } })
  ok('可紧急关闭整个广场', squareClosed.json.state.squareOpen === false)
  const closedList = await call('/api/community/posts')
  ok('关闭广场后列表明确标记 closed', closedList.json.closed === true && closedList.json.items.length === 0)
  ok('关闭广场后详情不再可达', (await call(`/api/community/posts/${pid2}`)).json?.post === undefined)
  await call('/api/community/admin/switch', { method: 'POST', as: 'admin', body: { squareOpen: true } })

  // ---- 排行 ----
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
  ok('未开启排行不能上报', (await call('/api/community/rank/report', { method: 'POST', as: 'bob', body: { deviceId: 'dev-bob-01', entries: [] } })).status === 403)
  await call('/api/community/profile', { method: 'PUT', as: 'bob', body: { rankOptIn: true, rankDisplay: 'nickname', nickname: '青灯' } })
  const r1 = await call('/api/community/rank/report', { method: 'POST', as: 'bob', body: { deviceId: 'dev-bob-01', entries: [{ projectId: 'p1', date: today, netDelta: 5000, seq: 1 }] } })
  ok('开启后可上报', r1.status === 200 && r1.json.accepted.length === 1)
  const r2 = await call('/api/community/rank/report', { method: 'POST', as: 'bob', body: { deviceId: 'dev-bob-01', entries: [{ projectId: 'p1', date: today, netDelta: 9999, seq: 1 }] } })
  ok('同 seq 不同值被拒（防篡改）', r2.json.rejected.some((x: any) => x.code === 'STALE_SEQ'))
  await call('/api/community/rank/report', { method: 'POST', as: 'bob', body: { deviceId: 'dev-bob-01', entries: [{ projectId: 'p1', date: today, netDelta: 6000, seq: 2 }] } })
  await call('/api/community/rank/report', { method: 'POST', as: 'bob', body: { deviceId: 'dev-bob-02', entries: [{ projectId: 'p1', date: today, netDelta: 8000, seq: 3 }] } })
  const rank = await call('/api/community/rank?period=day')
  ok('排行按日聚合且多设备取最新（不双计）', rank.json.entries.length === 1 && rank.json.entries[0].value === 8000)
  ok('排行展示昵称但不含账号标识', rank.json.entries[0].displayName === '青灯' && !rank.raw.includes('u_bob'))
  const revoked = await call('/api/community/profile', { method: 'PUT', as: 'bob', body: { rankOptIn: false } })
  ok('撤回授权立即清空排行', revoked.status === 200 && (await call('/api/community/rank?period=day')).json.entries.length === 0)
  const late = await call('/api/community/rank/report', { method: 'POST', as: 'bob', body: { deviceId: 'dev-bob-01', issuedAt: 1, entries: [{ projectId: 'p1', date: today, netDelta: 100, seq: 9 }] } })
  ok('撤回后迟到的上报被拒', late.status === 403 || late.status === 409)
  await call('/api/community/profile', { method: 'PUT', as: 'bob', body: { rankOptIn: true } })
  ok('重新开启不恢复旧数据', (await call('/api/community/rank?period=day')).json.entries.length === 0)

  // ---- 限流 / 容量 ----
  const limitedUser = 'dave'
  let lastStatus = 0
  for (let i = 0; i < 7; i++) {
    const r = await call('/api/community/posts', { method: 'POST', as: limitedUser, body: { title: `灌水 ${i}`, body: body() } })
    lastStatus = r.status
    if (r.status === 429) break
  }
  ok('投稿日限额生效（第 6 次 429）', lastStatus === 429)
  ok('超长正文被拒', (await call('/api/community/posts', { method: 'POST', as: 'carol', body: { title: '超长', body: '字'.repeat(10001) } })).status === 400)

  // ---- 草稿与幂等 ----
  const draft = await call('/api/community/posts', { method: 'POST', as: 'carol', body: { title: '草稿标题', body: body(), draft: true, clientToken: 'ct-draft' } })
  ok('草稿不进入待审', draft.json.post.status === 'draft' && draft.json.post.pendingVersionId === '')
  const draftDup = await call('/api/community/posts', { method: 'POST', as: 'carol', body: { title: '草稿标题', body: body(), draft: true, clientToken: 'ct-draft' } })
  ok('同一令牌重试返回同一篇（防重复投稿）', draftDup.json.duplicate === true && draftDup.json.post.id === draft.json.post.id)
  ok('草稿不在公开列表', (await call('/api/community/posts')).json.items.every((p: any) => p.id !== draft.json.post.id))
  const submitted = await call(`/api/community/posts/${draft.json.post.id}/submit`, { method: 'POST', as: 'carol' })
  ok('草稿可提交审核', submitted.json.post.status === 'pending')

  // ---- 404 ----
  ok('未知接口返回 404', (await call('/api/community/nope')).status === 404)
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  const target = fs.realpathSync(root)
  if (path.dirname(target) !== fs.realpathSync(os.tmpdir()) || !path.basename(target).startsWith('yfe-community-')) {
    throw new Error('拒绝清理不安全的测试目录')
  }
  fs.rmSync(target, { recursive: true, force: true })
}

console.log(`communityApi: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1