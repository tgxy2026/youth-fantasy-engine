import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'
const run = await mkdtemp(path.join(process.cwd(), '.workbuddy/tmp/chapter-sets-340-'))
const server = await createServer({ cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  const errors = []; page.on('pageerror', e => errors.push(String(e)))
  await page.goto(`http://localhost:${server.httpServer.address().port}`)
  await page.evaluate(() => { document.body.innerHTML = '<div id="fixture"></div>' })
  await page.evaluate(() => import('/tests/browser/chapter-sets-340-fixture.tsx'))
  await page.getByRole('button', { name: '新建', exact: false }).click()
  await page.getByPlaceholder(/收藏集名称/).fill('主线')
  await page.evaluate(() => window.failWrites(true))
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await page.getByText('injected failure').waitFor()
  if (await page.getByPlaceholder(/收藏集名称/).inputValue() !== '主线') throw Error('failed save lost input')
  await page.evaluate(() => window.failWrites(false))
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await page.getByRole('button', { name: /主线/ }).click()
  await page.getByRole('button', { name: /添加章节/ }).click()
  await page.getByRole('button', { name: '章节1', exact: true }).click()
  await page.getByRole('button', { name: '项目 B' }).click()
  await page.getByText('暂无收藏集').waitFor()
  await page.getByRole('button', { name: '项目 A' }).click()
  await page.getByRole('button', { name: /主线/ }).click()
  await page.getByRole('button', { name: '章节1', exact: true }).waitFor()
  if (errors.length) throw Error(errors.join('\n'))
  console.log('PASS failed save preserves input; create, add chapter, switch projects and reopen')
} finally { await browser?.close(); await server.close() }
