import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = process.cwd()
const run = path.join(root, '.workbuddy/tmp', `creative-resume-334-${new Date().toISOString().replace(/[:.]/g, '-')}`)
await fs.mkdir(run, { recursive: true })
const report = { fingerprint: snapshot(root).fingerprint, checks: [], errors: [], status: 'running' }
let context
const check = (name, ok, detail = '') => { report.checks.push({ name, ok: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name); if (!ok) throw Error(name + ': ' + detail) }
try {
  for (const scenario of ['changed', 'missing', 'unchanged']) {
    const profile = path.join(root, '.workbuddy/tmp', `edge-b04-334-case-${scenario}-v3`)
    context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, viewport: { width: 1440, height: 900 } })
    const page = context.pages()[0] || await context.newPage()
    page.on('pageerror', e => report.errors.push(e.message))
    const open = async () => {
      await page.goto('http://127.0.0.1:5199/', { waitUntil: 'domcontentloaded' })
      await page.getByTitle('打开项目').first().click()
      await page.getByRole('navigation').waitFor()
      const guide = page.locator('[data-guide-card]').first()
      if (await guide.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) await page.getByRole('button', { name: '跳过本页' }).click()
      await page.evaluate(async () => { (await import('/src/lib/settings/guidePrefs.ts')).setGuideAutoEnabled(false) })
    }
    await open()
    const original = await page.evaluate(async () => { const d = await import('/src/lib/db.ts'); const rows = await d.getAllChapters(); return rows.map(r => ({ id: r.id, content: r.content })) })
    check(`${scenario}: 强杀后章数据在位`, original.length === 1 && !!original[0].content)
    if (scenario !== 'unchanged') {
      await page.evaluate(async ({ scenario, original }) => { const d = await import('/src/lib/db.ts'); if (scenario === 'changed') await d.patchChapter(original[0].id, { content: original[0].content + '\n隔离修改' }); else await d.deleteChapter(original[0].id) }, { scenario, original })
      await open()
    }
    await page.getByRole('navigation').getByRole('button', { name: '创意写作', exact: true }).click()
    const main = page.locator('main')
    await main.getByRole('button', { name: '继续写作', exact: true }).waitFor({ timeout: 30000 })
    if (scenario === 'unchanged') {
      await main.getByText(/上次中止在/).waitFor({ timeout: 30000 })
      const resume = main.getByRole('button', { name: '继续写作', exact: true })
      check('unchanged: 断点可继续', await resume.isEnabled())
      await resume.click()
      let rows = []
      const deadline = Date.now() + 120000
      while (Date.now() < deadline) {
        rows = await page.evaluate(async () => (await (await import('/src/lib/db.ts')).getAllChapters()).map(r => ({ id: r.id, content: r.content })))
        if (rows.length >= 3) break
        await page.waitForTimeout(1000)
      }
      check('unchanged: 原章未重写且补齐三章', rows.length === 3 && rows.some(r => r.id === original[0].id && r.content === original[0].content), `count=${rows.length}`)
    } else {
      const text = await main.innerText()
      const disabled = await main.getByRole('button', { name: '继续写作', exact: true }).isDisabled()
      check(`${scenario}: 阻止续跑并说明原因`, disabled && (scenario === 'changed' ? /正文已改|正文.*改/.test(text) : /缺章|缺失|找不到|章已被删除/.test(text)), text.slice(0, 1200))
    }
    await context.close(); context = undefined
  }
  check('无浏览器脚本错误', report.errors.length === 0, report.errors.join('; '))
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.failure = String(error?.stack || error); process.exitCode = 1 }
finally { await context?.close().catch(() => {}); await fs.writeFile(path.join(run, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ run, ...report })) }
