// Full web-app guest entry with a fresh isolated server and no real accounts.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { chromium } from 'playwright'

const root = await mkdtemp(path.resolve('.workbuddy/tmp/community-guest-flow-'))
const data = path.join(root, 'data')
await mkdir(data)
const port = await new Promise((resolve) => {
  const socket = net.createServer()
  socket.listen(0, '127.0.0.1', () => { const p = socket.address().port; socket.close(() => resolve(p)) })
})
const base = `http://127.0.0.1:${port}`
const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), YFE_DATA: data, YFE_WWW: path.resolve(process.env.YFE_TEST_WEB_BUILD || '.workbuddy/tmp/community-build-continuation'), YFE_REGISTER: 'open', YFE_SCHEDULER: 'off' }
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_OPTIONS']) delete env[key]
const server = spawn(process.execPath, ['server/index.mjs'], { env, windowsHide: true, stdio: 'ignore' })
let browser
try {
  let ready = false
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/api/ping`)).ok) { ready = true; break } } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!ready) throw new Error('隔离服务未启动')
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  page.setDefaultTimeout(12000)
  await page.goto(base)
  await page.getByText('免费以游客身份开始创作', { exact: true }).click()
  await page.getByRole('button', { name: '跳过，直接进入项目管理' }).click()
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
  await page.getByRole('button', { name: '投稿广场', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '投稿广场' })
  await dialog.waitFor()
  if (!(await dialog.getByText('游客浏览', { exact: false }).isVisible())) throw new Error('游客浏览提示缺失')
  await dialog.getByRole('button', { name: /给明天留一盏灯/ }).click()
  await dialog.getByText('慢一点也没关系', { exact: false }).waitFor()
  await dialog.getByRole('button', { name: '登录后参与评论' }).waitFor()
  if (await dialog.getByLabel('写评论').count()) throw new Error('游客可直接输入评论')
  await dialog.getByRole('button', { name: '返回列表' }).click()
  await dialog.getByRole('button', { name: '投稿', exact: true }).click()
  await dialog.getByText('游客数据只在本机，无法参与社区', { exact: false }).waitFor()
  if (await page.locator('#community-title').count()) throw new Error('游客进入投稿表单')
  const bounds = await dialog.boundingBox()
  if (!bounds || bounds.x < 0 || bounds.x + bounds.width > 391) throw new Error('窄屏广场弹窗超出视口')
  await page.screenshot({ path: path.join(root, 'guest.png') })
  console.log(`PASS 游客进入广场、阅读示例、评论与投稿登录限制、390px 弹窗范围：${root}`)
} finally {
  await browser?.close()
  server.kill()
}
