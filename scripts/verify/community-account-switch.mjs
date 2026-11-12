// Same-browser tabs share the auth cookie; stale tab must not write as new user.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { chromium } from 'playwright'

const root = await mkdtemp(path.resolve('.workbuddy/tmp/community-account-switch-'))
const data = path.join(root, 'data')
await mkdir(data)
const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const base = `http://127.0.0.1:${port}`
const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), YFE_DATA: data, YFE_WWW: path.resolve(process.env.YFE_TEST_WEB_BUILD || '.workbuddy/tmp/community-build-continuation'), YFE_REGISTER: 'open', YFE_SCHEDULER: 'off' }
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_OPTIONS']) delete env[key]
const server = spawn(process.execPath, ['server/index.mjs'], { env, windowsHide: true, stdio: 'ignore' })
let browser
try {
  let ready = false
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/api/ping')).ok) { ready = true; break } } catch {} await new Promise((r) => setTimeout(r, 100)) }
  if (!ready) throw new Error('隔离服务未启动')
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  const auth = async (operation, name) => context.request.post(`${base}/api/auth/${operation}`, { data: { name, password: 'AccountSwitch352!' } })
  if (!(await auth('register', 'switch-a-352')).ok()) throw new Error('A 注册失败')
  const page = await context.newPage(); page.setDefaultTimeout(12000)
  await page.goto(base)
  await page.getByRole('button', { name: '跳过，直接进入项目管理' }).click()
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
  await page.getByRole('button', { name: '投稿广场', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '投稿广场' })
  await dialog.getByRole('button', { name: /给明天留一盏灯/ }).click()
  await dialog.getByLabel('写评论').fill('账号切换期间的隔离评论。')
  const oldId = await page.evaluate(() => window.__YFE_USER__.id)
  const secondTab = await context.newPage()
  await secondTab.goto(base)
  const switched = await secondTab.evaluate(async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    const response = await fetch('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'switch-b-352', password: 'AccountSwitch352!' }) })
    return response.ok
  })
  if (!switched) throw new Error('第二标签页切换 B 失败')
  const response = page.waitForResponse((r) => r.url().includes('/comments') && r.request().method() === 'POST')
  await dialog.getByRole('button', { name: '发表评论' }).click()
  const submitted = await response
  const db = JSON.parse(await readFile(path.join(data, 'community', 'comments.json'), 'utf8').catch(() => '{"items":{}}'))
  const inserted = Object.values(db.items).find((c) => c.body === '账号切换期间的隔离评论。')
  console.log(JSON.stringify({ oldId, status: submitted.status(), inserted: Boolean(inserted), ownerMatchesOriginal: inserted?.uid === oldId }))
  if (inserted && inserted.uid !== oldId) throw new Error('旧页面的评论被写到新账号')
  if (!inserted && await dialog.getByLabel('写评论').inputValue() !== '账号切换期间的隔离评论。') throw new Error('账号切换后评论草稿丢失')
  if (submitted.status() !== 409) throw new Error('账号变更未返回明确的冲突状态')
  await dialog.getByText('账号已在其他页面切换', { exact: false }).waitFor()
  await context.request.post(`${base}/api/auth/logout`)
  if (!(await auth('login', 'switch-a-352')).ok()) throw new Error('A 重新登录失败')
  const retryResponse = page.waitForResponse((r) => r.url().includes('/comments') && r.request().method() === 'POST')
  await dialog.getByRole('button', { name: '发表评论' }).click()
  if ((await retryResponse).status() !== 200) throw new Error('原账号恢复后无法重新提交')
  const restored = JSON.parse(await readFile(path.join(data, 'community', 'comments.json'), 'utf8'))
  if (!Object.values(restored.items).some((c) => c.body === '账号切换期间的隔离评论。' && c.uid === oldId)) throw new Error('原账号重试未落盘')
  await dialog.getByRole('button', { name: '设置', exact: true }).click()
  await dialog.getByLabel('云端同步邀请码').fill('ISOLATED-CODE')
  await context.request.post(`${base}/api/auth/logout`)
  if (!(await auth('login', 'switch-b-352')).ok()) throw new Error('B 重新登录失败')
  const activation = page.waitForResponse((r) => r.url().endsWith('/api/auth/activate'))
  await dialog.getByRole('button', { name: '开通', exact: true }).click()
  if ((await activation).status() !== 409) throw new Error('同步资格开通未阻止账号串写')
  if (await dialog.getByLabel('云端同步邀请码').inputValue() !== 'ISOLATED-CODE') throw new Error('账号切换后邀请码输入丢失')
  await dialog.getByText('邀请码未使用', { exact: false }).waitFor()
  await secondTab.close()
  const guestContext = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  const guestPage = await guestContext.newPage(); guestPage.setDefaultTimeout(12000)
  await guestPage.goto(base)
  await guestPage.getByText('免费以游客身份开始创作', { exact: true }).click()
  await guestPage.getByRole('button', { name: '跳过，直接进入项目管理' }).click()
  const guestLater = guestPage.getByRole('button', { name: '稍后再说', exact: true })
  if (await guestLater.isVisible().catch(() => false)) await guestLater.click()
  await guestPage.getByRole('button', { name: '投稿广场', exact: true }).click()
  const guestDialog = guestPage.getByRole('dialog', { name: '投稿广场' })
  await guestDialog.getByRole('button', { name: /给明天留一盏灯/ }).click()
  if (!(await guestContext.request.post(`${base}/api/auth/register`, { data: { name: 'switch-c-352', password: 'AccountSwitch352!' } })).ok()) throw new Error('游客切换账号失败')
  const guestResponse = guestPage.waitForResponse((r) => r.url().includes('/comments') && r.request().method() === 'GET')
  await guestDialog.getByRole('button', { name: '刷新评论' }).click()
  if ((await guestResponse).status() !== 409) throw new Error('游客旧页面读取了切换后的账号会话')
  await guestContext.close()
  console.log(`PASS 旧页面未以新账号提交且未丢失草稿：${root}`)
} finally { await browser?.close(); server.kill() }
