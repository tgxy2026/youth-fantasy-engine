import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = process.cwd()
const run = path.join(root, '.workbuddy/tmp', `offline-editor-334-${new Date().toISOString().replace(/[:.]/g, '-')}`)
await fs.mkdir(run, { recursive: true })
const report = { fingerprint: snapshot(root).fingerprint, checks: [], errors: [], status: 'running' }
const check = (name, ok) => { report.checks.push({ name, ok: !!ok }); if (!ok) throw Error(name); console.log('PASS', name) }
let server, browser
try {
  server = await createServer({ root, cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  const page = await context.newPage()
  page.on('pageerror', e => report.errors.push(e.message))
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByText('继续写作', { exact: true }).first().waitFor({ timeout: 90000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible()) await later.click()
  const guide = page.locator('[data-guide-card]').first()
  if (await guide.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) await page.getByRole('button', { name: '跳过本页' }).click()
  await page.evaluate(async () => { (await import('/src/lib/settings/guidePrefs.ts')).setGuideAutoEnabled(false) })
  await page.getByText('继续写作', { exact: true }).first().click()
  const editor = page.locator('textarea.novel-textarea')
  await editor.waitFor()
  const before = await editor.inputValue()
  const value = before + '\n断网隔离回读：云散月明。'
  await context.setOffline(true)
  await editor.fill(value)
  const save = page.getByRole('button', { name: '保存正文' })
  if (await save.isEnabled()) await save.click()
  await page.waitForTimeout(2000)
  check('断网时正文保留', await editor.inputValue() === value)
  const next = page.getByTitle('下一章', { exact: true })
  const prev = page.getByTitle('上一章', { exact: true })
  if (await next.isEnabled()) { await next.click(); await prev.click() }
  else if (await prev.isEnabled()) { await prev.click(); await next.click() }
  else throw Error('夹具缺少可切换章节')
  await page.waitForFunction(expected => document.querySelector('textarea.novel-textarea')?.value === expected, value, { timeout: 15000 })
  check('断网切章返回后回读一致', await editor.inputValue() === value)
  await context.setOffline(false)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  await page.screenshot({ path: path.join(run, 'after-reload.png') })
  const openProject = page.getByTitle('打开项目').first()
  if (await openProject.isVisible()) await openProject.click()
  const resume = page.getByText('继续写作', { exact: true }).first()
  await resume.waitFor({ timeout: 30000 })
  await resume.click()
  await editor.waitFor({ timeout: 15000 })
  await page.waitForFunction(expected => document.querySelector('textarea.novel-textarea')?.value === expected, value, { timeout: 30000 })
  check('网络恢复并重载后回读一致', await editor.inputValue() === value)
  check('无页面脚本错误', report.errors.length === 0)
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.failure = String(error?.stack || error); process.exitCode = 1 }
finally {
  await fs.writeFile(path.join(run, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ run, ...report }))
  await browser?.close(); await server?.close()
}
