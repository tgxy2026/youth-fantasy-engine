import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { chromium } from 'playwright'

const root = await mkdtemp(path.resolve('.workbuddy/tmp/community-nickname-browser-'))
const data = path.join(root, 'data'), key = path.join(root, 'key')
await mkdir(data); await writeFile(key, randomBytes(32))
const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const base = `http://127.0.0.1:${port}`
const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), YFE_DATA: data, YFE_WWW: path.resolve(process.env.YFE_TEST_WEB_BUILD || '.workbuddy/tmp/community-build-final'), YFE_REGISTER: 'open', YFE_SCHEDULER: 'off', YFE_COMMUNITY_ANON_KEY_FILE: key }
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_OPTIONS']) delete env[k]
const server = spawn(process.execPath, ['server/index.mjs'], { env, windowsHide: true, stdio: 'ignore' })
let browser
async function api(route, { method = 'GET', cookie = '', body } = {}) {
  const r = await fetch(base + route, { method, headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: r.status, json: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] }
}
try {
  let ready = false
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/api/ping')).ok) { ready = true; break } } catch {} await new Promise((r) => setTimeout(r, 100)) }
  if (!ready) throw new Error('隔离服务未启动')
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const reg = await ctx.request.post(base + '/api/auth/register', { data: { name: 'nickname-browser', password: 'Nickname352-test!' } })
  if (!reg.ok()) throw new Error('隔离账号注册失败')
  const admin = await api('/api/auth/register', { method: 'POST', body: { name: 'nickname-admin', password: 'Nickname352-test!' } })
  if (admin.status !== 200) throw new Error('隔离管理员注册失败')
  const usersPath = path.join(data, 'users.json'), users = JSON.parse(await readFile(usersPath, 'utf8'))
  for (const p of Object.values(users.users)) if (p.name === 'nickname-admin') p.role = 'admin'
  await writeFile(usersPath, JSON.stringify(users))

  const page = await ctx.newPage(); page.setDefaultTimeout(15000)
  await page.goto(base)
  await page.getByRole('button', { name: '跳过，直接进入项目管理' }).click()
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
  await page.getByRole('button', { name: '投稿广场', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '投稿广场' })

  // ① 昵称首次创建 → 七天冷却（窄屏）
  await dialog.getByRole('button', { name: '设置', exact: true }).click()
  await dialog.getByLabel('昵称', { exact: true }).fill('青灯')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await dialog.getByText('昵称已更新', { exact: false }).waitFor()
  if (!(await dialog.getByRole('button', { name: '修改', exact: true }).isDisabled())) throw new Error('首次创建后修改按钮未进入冷却')
  await dialog.getByText('7 天内不能再次修改', { exact: false }).waitFor()
  await dialog.getByText('还需等待', { exact: false }).waitFor()
  // ② 启用匿名代号后的隐私文案（密钥已配置 → anonymousHandlesEnabled）
  await dialog.getByText('同一周的匿名代号可被关联', { exact: false }).waitFor()
  await page.screenshot({ path: path.join(root, 'nickname-narrow.png') })

  // ③ 以当前账号合成匿名投稿 + 匿名评论，管理员审核通过
  const created = await ctx.request.post(base + '/api/community/posts', { data: { title: '合成匿名投稿', body: '隔离测试正文，用于网页匿名代号展示。', tags: ['短篇'], display: 'anonymous' } })
  if (!created.ok()) throw new Error('匿名投稿创建失败')
  const post = (await created.json()).post
  const approve = await api('/api/community/admin/decision', { method: 'POST', cookie: admin.cookie, body: { targetType: 'post', id: post.id, versionId: post.pendingVersionId, action: 'approve' } })
  if (approve.status !== 200) throw new Error('匿名投稿审核失败')
  const comment = await ctx.request.post(base + `/api/community/posts/${post.id}/comments`, { data: { body: '隔离匿名评论。', display: 'anonymous', clientToken: 'nickname-browser-comment' } })
  if (!comment.ok()) throw new Error('匿名评论创建失败')
  const commentName = (await comment.json()).comment.displayName
  if (!/（匿名用户）$/.test(commentName)) throw new Error('评论代号未以（匿名用户）结尾')

  // ④ 广场卡片展示匿名代号，且不泄露登录名
  await dialog.getByRole('button', { name: '广场', exact: true }).click()
  const card = dialog.getByRole('button', { name: /合成匿名投稿/ })
  await card.waitFor()
  await dialog.getByText('（匿名用户）', { exact: false }).first().waitFor()
  const feedText = await dialog.innerText()
  if (feedText.includes('nickname-browser')) throw new Error('广场泄露登录名')
  if (!feedText.includes('（匿名用户）')) throw new Error('广场未展示匿名代号')
  await page.screenshot({ path: path.join(root, 'feed-narrow.png') })

  // ⑤ 详情：评论代号与投稿一致；评论展示方式默认匿名
  await card.click()
  await dialog.getByText('隔离匿名评论。', { exact: false }).waitFor()
  const detailText = await dialog.innerText()
  if (!detailText.includes(commentName)) throw new Error('详情评论代号与投稿不一致')
  if (detailText.includes('nickname-browser')) throw new Error('详情泄露登录名')
  const selectValue = await dialog.getByLabel('评论展示方式').inputValue()
  if (selectValue !== 'anonymous') throw new Error(`评论展示方式默认应为 anonymous，实际 ${selectValue}`)

  // ⑥ 桌面宽屏跨端展示
  await dialog.getByRole('button', { name: '返回列表' }).click()
  await card.waitFor()
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.screenshot({ path: path.join(root, 'feed-desktop.png') })
  await dialog.getByRole('button', { name: '设置', exact: true }).click()
  await dialog.getByText('同一周的匿名代号可被关联', { exact: false }).waitFor()
  await page.screenshot({ path: path.join(root, 'settings-desktop.png') })
  console.log(`PASS 实际网页昵称冷却、匿名代号广场/详情展示、评论默认匿名、隐私文案及窄屏+桌面跨端：${root}`)
} finally { await browser?.close(); server.kill() }