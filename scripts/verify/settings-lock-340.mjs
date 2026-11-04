import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'
const dir = await mkdtemp(path.join(process.cwd(), '.workbuddy/tmp/settings-lock-340-'))
const server = await createServer({ cacheDir: path.join(dir, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
try {
  await server.listen(); browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext(); const pages = await Promise.all([context.newPage(), context.newPage()])
  const url = `http://localhost:${server.httpServer.address().port}/tests/browser/isolated-340.html`
  for (const page of pages) { await page.goto(url); await page.evaluate(async () => { (await import('/src/lib/db.ts')).setCurrentProject('lock-fixture') }) }
  for (const kind of ['sets', 'schemes']) {
    const results = await Promise.all(pages.map((page, index) => page.evaluate(async ({ kind, index }) => {
      if (kind === 'sets') {
        const api = await import('/src/lib/app/chapterSets.ts')
        return api.saveSets('lock-fixture', [api.createChapterSet(`set-${index}`)], [])
      }
      const api = await import('/src/lib/app/exportScheme.ts')
      return api.saveSchemes('lock-fixture', [api.createScheme(`scheme-${index}`, 'platform', null)], [])
    }, { kind, index })))
    if (results.filter(result => result.ok).length !== 1 || !results.some(result => !result.ok && result.error?.includes('其他窗口'))) throw Error(`${kind}: conflicting writes not rejected: ${JSON.stringify(results)}`)
    const count = await pages[0].evaluate(async kind => kind === 'sets'
      ? (await (await import('/src/lib/app/chapterSets.ts')).loadSets('lock-fixture')).length
      : (await (await import('/src/lib/app/exportScheme.ts')).loadSchemes('lock-fixture')).length, kind)
    if (count !== 1) throw Error(`${kind}: expected exactly one saved record, got ${count}`)
    console.log(`PASS ${kind}: stale concurrent write rejected; first record preserved`)
  }
  const unsupported = await context.newPage()
  await unsupported.goto(url)
  const blocked = await unsupported.evaluate(async () => {
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true })
    const db = await import('/src/lib/db.ts'); db.setCurrentProject('unsupported-fixture')
    const api = await import('/src/lib/app/chapterSets.ts')
    return api.saveSets('unsupported-fixture', [api.createChapterSet('blocked')], [])
  })
  if (blocked.ok || !blocked.error?.includes('不支持跨窗口写入保护')) throw Error('unsupported lock was not rejected')
  console.log('PASS unsupported browser refuses unsafe writes')
} finally { await browser?.close(); await server.close() }
