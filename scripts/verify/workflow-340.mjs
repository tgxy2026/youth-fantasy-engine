import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'
const run = await mkdtemp(path.join(process.cwd(), '.workbuddy/tmp/workflow-340-'))
const server = await createServer({ cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
try {
  await server.listen(); browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []; page.on('pageerror', e => errors.push(String(e)))
  await page.addInitScript(() => localStorage.setItem('yfe-ui:guide-auto', '0'))
  await page.goto(`http://localhost:${server.httpServer.address().port}`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
  const sets = page.getByRole('button', { name: /章节收藏集/ })
  await sets.waitFor({ timeout: 30000 }); await sets.click()
  await page.getByRole('button', { name: '新建', exact: true }).click()
  await page.getByPlaceholder(/收藏集名称/).fill('应用测试集')
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await page.getByRole('button', { name: /应用测试集/ }).waitFor()
  const idea = page.getByRole('textbox', { name: '灵感内容' })
  await idea.fill('应用测试灵感')
  await page.getByRole('button', { name: '保存到灵感夹' }).click()
  await page.getByText('已保存到本作品的灵感夹。').waitFor()
  if (errors.length) throw Error(errors.join('\n'))
  console.log('PASS demo project: open collection, create collection, save idea')
} finally { await browser?.close(); await server.close() }
