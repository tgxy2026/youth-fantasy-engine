// 投稿广场 · 隔离端到端流程取证（3.5.0）
//
// 起一个真实 server/index.mjs（临时 YFE_DATA，不碰真实数据），用 HTTP 走完：
//   注册 → 投稿（待审）→ 管理员通过 → 互动（赞/踩/评论）→ 评论分流 → 举报 → 下架
//   → 排行（开启/上报/查询/撤回）→ 未授予同步资格的账号被拒绝。
//
// 🔴 这是**本地隔离服务**的流程证据，不等于部署验收：没有反代/TLS/多实例/真实客户端。
// 🔴 管理员身份通过直接改 users 表授予（等价于 `admin.mjs role <用户名> admin`）。
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const PASSWORD = 'CommunityFlow123!'
const root = await fs.mkdtemp(path.resolve('.workbuddy/tmp/community-flow-'))
const data = path.join(root, 'data')
const www = path.join(root, 'www')
await fs.mkdir(data); await fs.mkdir(www)
await fs.writeFile(path.join(www, 'index.html'), '<html><head></head><body>fixture</body></html>')

// 取一个空闲端口
const net = await import('node:net')
const port = await new Promise((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
})
const origin = `http://127.0.0.1:${port}`
const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), YFE_DATA: data, YFE_WWW: www, YFE_REGISTER: 'open', YFE_SCHEDULER: 'off' }
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_OPTIONS']) delete env[key]

let server
let pass = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { failures.push(name); console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
async function until(test, timeout = 30000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await test()) return; await new Promise((r) => setTimeout(r, 40)) }
  throw new Error('server did not start')
}

async function call(p, opts = {}) {
  const headers = { ...(opts.headers || {}) }
  if (opts.cookie) headers.Cookie = opts.cookie
  let body
  if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body) }
  const res = await fetch(origin + p, { method: opts.method || 'GET', headers, body })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json, text, setCookie: res.headers.get('set-cookie') || '' }
}
const cookieOf = (r) => r.setCookie.split(';')[0]

async function register(name) {
  const r = await call('/api/auth/register', { method: 'POST', body: { name, password: PASSWORD } })
  if (r.status !== 200) throw new Error(`register ${name} failed: ${r.status} ${r.text}`)
  return cookieOf(r)
}

/** 直接改用户表授予角色/同步资格（等价运维命令），服务端按 mtime 立即读到 */
async function patchUser(name, patch) {
  const file = path.join(data, 'users.json')
  const db = JSON.parse(await fs.readFile(file, 'utf8'))
  for (const u of Object.values(db.users)) if (u.name === name) Object.assign(u, patch)
  await fs.writeFile(file, JSON.stringify(db, null, 2))
}

try {
  server = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  server.stdout.on('data', (b) => { log += b }); server.stderr.on('data', (b) => { log += b })
  await until(async () => { try { return (await fetch(origin + '/api/ping')).ok } catch { return false } })

  const alice = await register('flow-alice')
  const bob = await register('flow-bob')
  const admin = await register('flow-admin')
  await patchUser('flow-admin', { role: 'admin' })

  // ---- 注册与资格分离 ----
  const me = await call('/api/auth/me', { cookie: alice })
  ok('开放注册成功且默认无云同步资格', me.status === 200 && me.json.user.cloudSync === false)
  const denied = await call('/api/data', { cookie: alice })
  ok('未授予资格：/api/data 被服务端拒绝', denied.status === 403 && denied.json.code === 'SYNC_NOT_GRANTED')
  const publicSquare = await call('/api/community/square')
  ok('未登录可读广场状态', publicSquare.status === 200 && publicSquare.json.open === true)
  const cannotPost = await call('/api/community/posts', { method: 'POST', body: { title: 'x', body: '内容内容内容' } })
  ok('未登录不能投稿', cannotPost.status === 401)

  // ---- 投稿 → 待审 → 发布 ----
  const created = await call('/api/community/posts', { method: 'POST', cookie: alice, body: { title: '隔离流程投稿', body: '雨落在旧城墙上。', tags: ['短篇'], display: 'anonymous' } })
  ok('投稿进入待审', created.status === 200 && created.json.post.status === 'pending')
  const pid = created.json.post.id
  const vid = created.json.post.pendingVersionId
  const listBefore = await call('/api/community/posts')
  ok('待审内容不在公开列表', listBefore.json.items.length === 0)
  const byBob = await call('/api/community/posts', { method: 'POST', cookie: bob, body: { title: 'bob', body: '内容' } })
  ok('普通用户可投稿', byBob.status === 200)
  const queue = await call('/api/community/admin/queue?type=post', { cookie: admin })
  ok('管理员队列可见待审', queue.status === 200 && queue.json.items.some((x) => x.id === pid))
  const approve = await call('/api/community/admin/decision', { method: 'POST', cookie: admin, body: { targetType: 'post', id: pid, versionId: vid, action: 'approve' } })
  ok('管理员确认后才发布', approve.status === 200 && approve.json.status === 'published')
  const detail = await call(`/api/community/posts/${pid}`)
  ok('发布后公开可读且全文正确', detail.status === 200 && detail.json.post.body === '雨落在旧城墙上。')
  ok('匿名公开响应不含账号名', !detail.text.includes('flow-alice') && detail.json.post.displayName === '匿名用户')

  // ---- 互动 ----
  const up = await call(`/api/community/posts/${pid}/vote`, { method: 'POST', cookie: bob, body: { value: 1 } })
  ok('点赞计数生效', up.status === 200 && up.json.counts.up === 1)
  const switched = await call(`/api/community/posts/${pid}/vote`, { method: 'POST', cookie: bob, body: { value: -1 } })
  ok('切换点踩后只保留一个', switched.json.counts.up === 0 && switched.json.counts.down === 1)
  const selfVote = await call(`/api/community/posts/${pid}/vote`, { method: 'POST', cookie: alice, body: { value: 1 } })
  ok('不能自投', selfVote.status === 400)

  const goodComment = await call(`/api/community/posts/${pid}/comments`, { method: 'POST', cookie: bob, body: { body: '这段写得很有画面感。', clientToken: 'flow-1' } })
  ok('低风险评论直接显示', goodComment.status === 200 && goodComment.json.comment.status === 'visible')
  const riskyComment = await call(`/api/community/posts/${pid}/comments`, { method: 'POST', cookie: bob, body: { body: '加我 QQ 123456789 一起刷单' } })
  ok('可疑评论进入待审', riskyComment.status === 200 && riskyComment.json.comment.status === 'pending')
  const comments = await call(`/api/community/posts/${pid}/comments`)
  ok('待审评论对读者不可见', comments.json.items.length === 1)
  const approveComment = await call('/api/community/admin/decision', { method: 'POST', cookie: admin, body: { targetType: 'comment', id: riskyComment.json.comment.id, action: 'approve' } })
  ok('管理员可通过评论', approveComment.status === 200)

  // ---- 举报 → 下架 ----
  const report = await call('/api/community/reports', { method: 'POST', cookie: bob, body: { targetType: 'post', targetId: pid, reason: '不当内容' } })
  ok('举报进入队列', report.status === 200 && report.json.status === 'open')
  const reportQueue = await call('/api/community/admin/queue?type=report', { cookie: admin })
  ok('举报出现在管理队列', reportQueue.json.items.some((x) => x.id === report.json.id))
  const takedown = await call('/api/community/admin/report', { method: 'POST', cookie: admin, body: { id: report.json.id, action: 'takedown', outcome: '违规下架' } })
  ok('举报成立并下架', takedown.status === 200)
  const gone = await call(`/api/community/posts/${pid}`)
  ok('下架后详情不可见', gone.status === 404 || gone.json?.post === undefined)
  ok('下架后退出公开列表', (await call('/api/community/posts')).json.items.every((x) => x.id !== pid))
  const lateApprove = await call('/api/community/admin/decision', { method: 'POST', cookie: admin, body: { targetType: 'post', id: pid, versionId: vid, action: 'approve' } })
  ok('下架后的迟到回执不能恢复公开', lateApprove.status === 409 && (await call(`/api/community/posts/${pid}`)).json?.post === undefined)

  // ---- 申诉 ----
  const appeal = await call('/api/community/appeals', { method: 'POST', cookie: alice, body: { postId: pid, versionId: vid, reason: '请求复核' } })
  ok('作者可提交申诉（绑定版本）', appeal.status === 200 && appeal.json.status === 'open')
  const appealQueue = await call('/api/community/admin/queue?type=appeal', { cookie: admin })
  ok('申诉进入独立队列', appealQueue.json.items.some((x) => x.id === appeal.json.id && x.versionId === vid))
  const reopen = await call('/api/community/admin/report', { method: 'POST', cookie: admin, body: { id: appeal.json.id, action: 'reopen', outcome: '申诉成立' } })
  ok('申诉成立后重新进入待审（不会直接公开）', reopen.status === 200 && (await call(`/api/community/posts/${pid}`)).json?.post === undefined)

  // ---- 排行 ----
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
  const noRank = await call('/api/community/rank/report', { method: 'POST', cookie: alice, body: { deviceId: 'dev-flow-01', entries: [] } })
  ok('未开启排行不能上报', noRank.status === 403)
  const optIn = await call('/api/community/profile', { method: 'PUT', cookie: alice, body: { rankOptIn: true, rankDisplay: 'nickname', nickname: '雨声' } })
  ok('可开启排行并设置昵称', optIn.status === 200 && optIn.json.profile.rankOptIn === true)
  const rp = await call('/api/community/rank/report', { method: 'POST', cookie: alice, body: { deviceId: 'dev-flow-01', entries: [{ projectId: 'p1', date: today, netDelta: 5000, seq: 1, issuedAt: Date.now() }] } })
  ok('开启后上报成功', rp.status === 200 && rp.json.accepted.length === 1)
  const board = await call('/api/community/rank?period=day')
  ok('日榜按净增量展示', board.json.entries.length === 1 && board.json.entries[0].value === 5000 && board.json.entries[0].displayName === '雨声')
  ok('榜单响应不含账号标识', !board.text.includes('flow-alice'))
  const revoke = await call('/api/community/profile', { method: 'PUT', cookie: alice, body: { rankOptIn: false } })
  ok('撤回授权立即清空', revoke.status === 200 && (await call('/api/community/rank?period=day')).json.entries.length === 0)

  // ---- 昵称与展示 ----
  const badNick = await call('/api/community/profile', { method: 'PUT', cookie: alice, body: { nickname: '官方客服' } })
  ok('官方身份字样昵称被拒', badNick.status === 400 && badNick.json.code === 'NICKNAME_IMPERSONATION')

  console.log(`\ncommunityFlow: ${pass} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log('日志尾部：\n' + log.slice(-1200))
    process.exitCode = 1
  }
} finally {
  if (server && server.exitCode === null) {
    const closed = new Promise((resolve) => server.once('close', resolve))
    server.kill(); await closed
  }
  const target = await fs.realpath(root)
  const parent = await fs.realpath(path.resolve('.workbuddy/tmp'))
  if (!target.startsWith(parent + path.sep) || !path.basename(target).startsWith('community-flow-')) {
    throw new Error('拒绝清理不安全的测试目录')
  }
  await fs.rm(target, { recursive: true, force: true })
}