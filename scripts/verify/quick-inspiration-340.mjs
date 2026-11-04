import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'
const run = await mkdtemp(path.join(process.cwd(), '.workbuddy/tmp/quick-idea-340-'))
const server = await createServer({ cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
try {
  await server.listen(); browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage()
  await page.goto(`http://localhost:${server.httpServer.address().port}`)
  await page.evaluate(() => { document.body.innerHTML = '<div id="fixture"></div>' })
  await page.evaluate(() => import('/tests/browser/quick-inspiration-340-fixture.tsx'))
  const input = page.getByRole('textbox', { name: '灵感内容' })
  await input.fill('一座会移动的城')
  await page.getByRole('combobox', { name: '关联章节' }).selectOption('fixture-chapter')
  await page.evaluate(() => window.failWrites(true))
  if (await page.evaluate(() => window.tryLeave())) throw Error('failed save allowed navigation')
  if (await input.inputValue() !== '一座会移动的城') throw Error('failed save lost input')
  await page.evaluate(() => window.failWrites(false))
  if (!await page.evaluate(() => window.tryLeave())) throw Error('successful save blocked navigation')
  await page.getByText('已保存到本作品的灵感夹。').waitFor()
  const linked = await page.evaluate(async () => (await (await import('/src/lib/db')).getSettingFor('fixture-idea', 'inspirationBox', []))[0]?.chapterId)
  if (linked !== 'fixture-chapter') throw Error('chapter association not saved')
  console.log('PASS failure preserves draft and blocks leave; retry saves and allows leave')
} finally { await browser?.close(); await server.close() }
