import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

const root = await mkdtemp(path.resolve('.workbuddy/tmp/community-anon-live-'))
const data = path.join(root, 'data'), key = path.join(root, 'key')
await mkdir(data); await writeFile(key, randomBytes(32))
const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const base = `http://127.0.0.1:${port}`
const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), YFE_DATA: data, YFE_REGISTER: 'open', YFE_SCHEDULER: 'off', YFE_COMMUNITY_ANON_KEY_FILE: key }
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_OPTIONS']) delete env[k]
let server
async function start() {
  server = spawn(process.execPath, ['server/index.mjs'], { env, windowsHide: true, stdio: 'ignore' })
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/api/ping')).ok) return } catch {} await new Promise((r) => setTimeout(r, 100)) }
  throw new Error('隔离服务未启动')
}
async function stop() { if (!server || server.exitCode !== null) return; const done = new Promise((r) => server.once('exit', r)); server.kill(); await done }
async function call(route, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(base + route, { method, headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, json: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }
}
try {
  await start()
  const a = await call('/api/auth/register', { method: 'POST', body: { name: 'anon-live-author', password: 'AnonLive352!' } })
  const admin = await call('/api/auth/register', { method: 'POST', body: { name: 'anon-live-admin', password: 'AnonLive352!' } })
  assert.equal(a.status, 200); assert.equal(admin.status, 200)
  const userPath = path.join(data, 'users.json'), users = JSON.parse(await readFile(userPath, 'utf8'))
  for (const p of Object.values(users.users)) if (p.name === 'anon-live-admin') p.role = 'admin'
  await writeFile(userPath, JSON.stringify(users))
  const created = await call('/api/community/posts', { method: 'POST', cookie: a.cookie, body: { title: '合成投稿', body: '隔离测试正文。', tags: ['短篇'], display: 'anonymous' } })
  assert.equal(created.status, 200)
  const id = created.json.post.id
  assert.equal((await call('/api/community/admin/decision', { method: 'POST', cookie: admin.cookie, body: { targetType: 'post', id, versionId: created.json.post.pendingVersionId, action: 'approve' } })).status, 200)
  const comment = await call(`/api/community/posts/${id}/comments`, { method: 'POST', cookie: a.cookie, body: { body: '隔离评论。', display: 'anonymous', clientToken: 'anon-live' } })
  assert.equal(comment.status, 200)
  const post = await call(`/api/community/posts/${id}`)
  assert.match(post.json.post.displayName, /（匿名用户）$/)
  assert.equal(comment.json.comment.displayName, post.json.post.displayName)
  assert.equal(JSON.stringify(post.json).includes('anon-live-author'), false)
  const profile = await call('/api/community/profile', { method: 'PUT', cookie: a.cookie, body: { rankOptIn: true } })
  assert.equal(profile.status, 200)
  const firstName = await call('/api/community/profile', { method: 'PUT', cookie: a.cookie, body: { nickname: '青灯' } })
  assert.equal(firstName.status, 200)
  assert.ok(firstName.json.profile.nicknameNextChangeAt > firstName.json.profile.serverNow)
  const duplicateName = await call('/api/community/profile', { method: 'PUT', cookie: a.cookie, body: { nickname: '青灯' } })
  assert.equal(duplicateName.status, 200)
  assert.equal(duplicateName.json.profile.nicknameNextChangeAt, firstName.json.profile.nicknameNextChangeAt)
  const cooldown = await call('/api/community/profile', { method: 'PUT', cookie: a.cookie, body: { nickname: '白露' } })
  assert.equal(cooldown.status, 409)
  assert.equal(cooldown.json.code, 'NICKNAME_COOLDOWN')
  const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
  const report = await call('/api/community/rank/report', { method: 'POST', cookie: a.cookie, body: { deviceId: 'dev-anon-test', entries: [{ projectId: 'test-project', date: day, netDelta: 500, seq: 1 }] } })
  assert.equal(report.status, 200)
  const rank = await call('/api/community/rank?period=day')
  assert.equal(rank.json.entries[0].displayName, post.json.post.displayName)
  const mixed = await call('/api/community/profile', { method: 'PUT', cookie: a.cookie, body: { nickname: '白露', rankOptIn: false } })
  assert.equal(mixed.status, 400)
  assert.equal((await call('/api/community/rank?period=day')).json.entries.length, 1)
  const profileFile = path.join(data, 'community', 'profiles.json')
  const hash = async () => createHash('sha256').update(await readFile(profileFile)).digest('hex')
  const before = await hash()
  await call(`/api/community/posts/${id}`); await call(`/api/community/posts/${id}/comments`); await call('/api/community/rank?period=day')
  assert.equal(await hash(), before, '公开读取不得分配映射')
  await stop(); await start()
  assert.equal((await call(`/api/community/posts/${id}`)).json.post.displayName, post.json.post.displayName)
  console.log(`PASS 真实隔离服务的投稿、评论、排行代号一致及重启保留：${root}`)
} finally { await stop() }
