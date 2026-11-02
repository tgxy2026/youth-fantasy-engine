// Isolated demo, real navigation and save/readback; never uses an author library or model.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = process.cwd()
const run = path.join(root, '.workbuddy/tmp', `table-matrix-334-${new Date().toISOString().replace(/[:.]/g, '-')}`)
await fs.mkdir(run, { recursive: true })
const report = { fingerprint: snapshot(root).fingerprint, cases: [], errors: [], status: 'running' }
let server, browser
try {
  server = await createServer({ root, cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  for (const width of [320, 375, 430]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
    await context.addInitScript(() => { try { localStorage.setItem('yfe-ui:guide-auto', '0') } catch { /* non-origin document */ } })
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
    const page = await context.newPage()
    page.on('pageerror', error => report.errors.push(`${width}: ${error.message}`))
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /先看看示例/ }).click()
    await page.getByRole('button', { name: '下一步', exact: true }).click()
    await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
    await page.getByText('继续写作', { exact: true }).first().waitFor({ timeout: 90000 })
    const later = page.getByRole('button', { name: '稍后再说', exact: true })
    if (await later.isVisible()) await later.click()
    const tabs = await page.evaluate(async () => {
      const s = await import('/src/lib/schema.ts')
      return s.TABS.filter(t => t.type === 'table' && s.tabVisible(t.id, { type: 'full', features: [] })).map(t => ({ id: t.id, name: t.name }))
    })
    const go = async name => {
      const open = page.getByRole('button', { name: '打开项目菜单' })
      await open.click({ timeout: 10000 })
      await page.getByRole('navigation').getByRole('button', { name, exact: true }).first().click({ timeout: 10000 })
      await page.keyboard.press('Escape').catch(() => {})
    }
    for (const tab of tabs) {
      const record = { width, ...tab, status: 'running' }
      report.cases.push(record)
      try {
        await go(tab.name)
        if (tab.id === 'relations') {
          const openRelation = async () => {
            const group = page.getByRole('button', { name: /\d+\s*条关系/ }).first()
            await group.click()
            const rowGroup = group.locator('xpath=..').locator('div.group').first()
            await rowGroup.getByRole('button').first().click()
            return rowGroup
          }
          const relation = await openRelation()
          const field = relation.locator('input[type="text"]').first()
          await field.waitFor({ timeout: 10000 })
          const placeholder = await field.getAttribute('placeholder')
          const value = (await field.inputValue()) + `测试${width}`
          await field.fill(value)
          await page.keyboard.press('Control+s')
          await go('写作面板'); await go(tab.name)
          const restored = await openRelation()
          const found = restored.locator(`input[placeholder=${JSON.stringify(placeholder)}]`).first()
          if (await found.inputValue() !== value) throw Error(`关系字段 ${placeholder} 回读不一致`)
          record.status = 'passed'; record.detail = `展开关系并保存回读 ${placeholder}`
          console.log('PASS', width, tab.id); continue
        }
        if (tab.id === 'chapter-master') {
          const openChapter = page.getByTitle('打开本章正文编辑').first()
          await openChapter.waitFor({ timeout: 10000 }); await openChapter.click()
          await page.locator('textarea.novel-textarea').waitFor({ timeout: 10000 })
          record.status = 'passed'; record.detail = '只读章节总表跳转正文'
          console.log('PASS', width, tab.id); continue
        }
        const row = page.locator('tr[data-workspace-record]').first()
        await row.waitFor({ timeout: 10000 })
        const id = await row.getAttribute('data-workspace-record')
        const inputs = row.locator('textarea:not([readonly]):not([disabled])')
        if (await inputs.count() === 0) throw Error('首行没有可编辑文本框，需另建适用夹具')
        const field = inputs.first()
        await field.scrollIntoViewIfNeeded()
        const original = await field.inputValue()
        const marker = `测试${width}`
        const value = original + marker
        await field.fill(value)
        await page.keyboard.press('Control+s')
        await go('写作面板')
        await go(tab.name)
        const restored = page.locator(`tr[data-workspace-record=${JSON.stringify(id)}]`).locator('textarea:not([readonly]):not([disabled])').first()
        await restored.waitFor({ timeout: 10000 })
        const actual = await restored.inputValue()
        if (actual !== value) throw Error(`回读不一致 expected suffix=${marker} actual suffix=${actual.slice(-20)}`)
        record.status = 'passed'
        record.rowId = id
        console.log('PASS', width, tab.id)
      } catch (error) {
        record.status = 'failed'; record.error = String(error?.message || error).slice(0, 600)
        console.log('FAIL', width, tab.id, record.error.slice(0, 180))
        await page.keyboard.press('Escape').catch(() => {})
      }
    }
    await context.close()
  }
  report.status = report.cases.every(c => c.status === 'passed') && report.errors.length === 0 ? 'passed' : 'failed'
  if (report.status !== 'passed') process.exitCode = 1
} catch (error) { report.status = 'failed'; report.failure = String(error?.stack || error); process.exitCode = 1 }
finally { await fs.writeFile(path.join(run, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ run, status: report.status, passed: report.cases.filter(c => c.status === 'passed').length, total: report.cases.length, errors: report.errors, failure: report.failure })); await browser?.close(); await server?.close() }
