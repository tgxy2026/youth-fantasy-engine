import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'
const dir = await mkdtemp(path.join(process.cwd(), '.workbuddy/tmp/idea-lock-340-'))
const server = await createServer({ cacheDir: path.join(dir, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
try {
  await server.listen(); browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext(); const pages = await Promise.all([context.newPage(), context.newPage()])
  const url = `http://localhost:${server.httpServer.address().port}/tests/browser/isolated-340.html`
  for (const page of pages) {
    await page.goto(url)
    await page.evaluate(async () => { (await import('/src/lib/db.ts')).setCurrentProject('lock-fixture') })
  }
  if (!await pages[0].evaluate(() => !!navigator.locks)) throw Error('Web Locks unavailable in test browser')
  await Promise.all(pages.map((page, index) => page.evaluate(async index => {
    const { addItem } = await import('/src/lib/creative/inspirationBox.ts')
    for (let i = 0; i < 20; i++) await addItem(`page-${index}-${i}`)
  }, index)))
  const items = await pages[0].evaluate(async () => (await import('/src/lib/creative/inspirationBox.ts')).loadBox())
  if (items.length !== 40 || new Set(items.map(item => item.text)).size !== 40) throw Error(`expected 40 distinct ideas, got ${items.length}`)
  console.log('PASS two same-origin windows concurrently save 40 distinct ideas')
} finally { await browser?.close(); await server.close() }
