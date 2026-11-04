// 3.4.0 · F 验证：灵感条目上的「关联章节」能打开目标，失效关联不给死链。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'

const run = await mkdtemp(path.join(process.cwd(), '.workbuddy/tmp/inspiration-open-340-'))
const server = await createServer({ cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(`http://localhost:${server.httpServer.address().port}`)
  await page.evaluate(() => { document.body.innerHTML = '<div id="fixture"></div>' })
  await page.evaluate(() => import('/tests/browser/inspiration-open-340-fixture.tsx'))

  await page.getByText('有章节的灵感').waitFor({ timeout: 15000 })
  await page.getByText(/关联章节：第一章 关联目标/).waitFor()
  await page.getByText(/关联章节：不可用/).waitFor()

  // 有真实章节的条目才给「打开」，失效关联不给死链
  const openers = page.locator('[data-open-chapter]')
  if (await openers.count() !== 1) throw new Error(`expected exactly 1 open button, got ${await openers.count()}`)
  if (await page.getByText('打开 →').count() !== 1) throw new Error('expected exactly one 「打开 →」 label')

  await openers.first().click()
  const nav = await page.evaluate(() => window.__nav ?? [])
  const first = nav[0]
  if (!first || first.tabId !== 'editor' || first.chapterId !== 'ch1') {
    throw new Error(`unexpected navigation detail: ${JSON.stringify(first)}`)
  }

  // 不带关联的条目不显示关联行
  const plainRow = page.locator('div', { hasText: '没关联的灵感' }).last()
  if (await plainRow.getByText(/关联章节/).count() !== 0) throw new Error('unlinked item showed a chapter line')

  if (errors.length) throw new Error(errors.join('\n'))
  console.log('PASS linked item opens chapter via yfe:navigate; deleted target shows 不可用 with no dead link')
} finally {
  await browser?.close()
  await server.close()
}
