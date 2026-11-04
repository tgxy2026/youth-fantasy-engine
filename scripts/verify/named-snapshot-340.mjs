import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'
const dir = await mkdtemp(path.join(process.cwd(), '.workbuddy/tmp/named-snapshot-340-'))
const server = await createServer({ cacheDir: path.join(dir, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
try {
  await server.listen(); browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []; page.on('pageerror', e => errors.push(String(e)))
  await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/isolated-340.html`)
  await page.evaluate(() => { document.body.innerHTML = '<div id="fixture"></div>' })
  await page.evaluate(() => import('/tests/browser/named-snapshot-340-fixture.tsx'))
  await page.getByRole('textbox', { name: '快照名称' }).fill('修改之前')
  await page.getByRole('textbox', { name: '快照备注' }).fill('保存关键段落')
  await page.evaluate(() => window.failWrites(true))
  await page.getByRole('button', { name: '保存命名快照' }).click()
  await page.getByRole('alert').getByText(/injected failure/).waitFor()
  if (await page.getByRole('textbox', { name: '快照名称' }).inputValue() !== '修改之前') throw Error('failed snapshot lost input')
  await page.evaluate(() => window.failWrites(false))
  await page.getByRole('button', { name: '保存命名快照' }).click()
  await page.getByText('命名快照已保存。').waitFor()
  await page.getByText('备注：保存关键段落').waitFor()
  const snapshots = await page.evaluate(async () => (await import('/src/lib/db.ts')).getSnapshots('chapter'))
  if (snapshots.length !== 1 || snapshots[0].content !== '尚未保存的草稿' || snapshots[0].label !== '修改之前' || snapshots[0].note !== '保存关键段落') throw Error('snapshot data mismatch')
  if (errors.length) throw Error(errors.join('\n'))
  console.log('PASS snapshot failure preserves fields; retry saves visible unsaved draft and note')
} finally { await browser?.close(); await server.close() }
