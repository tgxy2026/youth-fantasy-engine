import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp, readFile } from 'node:fs/promises'
import path from 'node:path'
const run = await mkdtemp(path.join(process.cwd(), '.workbuddy/tmp/export-scheme-340-'))
const server = await createServer({ cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
  const errors = []; page.on('pageerror', e => errors.push(String(e)))
  await page.goto(`http://localhost:${server.httpServer.address().port}`)
  await page.evaluate(() => { document.body.innerHTML = '<div id="fixture"></div>' })
  await page.evaluate(() => import('/tests/browser/export-scheme-340-fixture.tsx'))
  await page.getByRole('button', { name: '单换行' }).click()
  await page.getByRole('button', { name: '选定章节' }).click()
  await page.getByRole('button', { name: /具名导出方案/ }).click()
  await page.getByPlaceholder(/新方案名称/).fill('格式甲')
  await page.getByRole('button', { name: /保存当前/ }).click()
  await page.getByRole('button', { name: /格式甲/ }).waitFor()
  await page.getByRole('button', { name: '段间空行' }).click()
  await page.getByRole('button', { name: /格式甲/ }).click()
  const selected = await page.getByRole('button', { name: '单换行' }).getAttribute('class')
  if (!selected?.includes('bg-amber')) throw Error('scheme did not restore paragraph spacing')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出粘贴版' }).click()
  const download = await downloadPromise
  const body = await readFile(await download.path(), 'utf8')
  if (!body.includes('第一章') || !body.includes('正文')) throw Error('downloaded file missing selected chapter')
  await page.evaluate(() => window.removeChapter())
  await page.getByText(/选定范围中有/).waitFor()
  if (!await page.getByRole('button', { name: '导出粘贴版' }).isDisabled()) throw Error('missing chapter allowed export')
  await page.getByRole('button', { name: '移除不可用项' }).first().click()
  if (errors.length) throw Error(errors.join('\n'))
  console.log('PASS save scheme and restore formatting')
} finally { await browser?.close(); await server.close() }
