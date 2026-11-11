// 3.4.0 · 时光机恢复后重开核验（整页、示例项目）
//
// 流程：改稿 → 建命名快照 → 再改稿 → 恢复到命名快照 → **刷新重开** → 正文必须仍是快照内容。
// 同时确认恢复动作产生了「恢复前留档」，而不是把改后的内容丢掉。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'

const run = await mkdtemp(path.join(process.cwd(), '.workbuddy/tmp/restore-reopen-340-'))
const server = await createServer({ cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
const checks = []
const check = (id, ok, detail = '') => {
  checks.push({ id, ok: !!ok })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (ok || !detail ? '' : ` :: ${detail}`))
  if (!ok) throw new Error(`${id}${detail ? ' :: ' + detail : ''}`)
}

try {
  await server.listen()
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.addInitScript(() => localStorage.setItem('yfe-ui:guide-auto', '0'))
  await page.goto(`http://localhost:${server.httpServer.address().port}`, { waitUntil: 'domcontentloaded' })

  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
  await page.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).click()
  const editor = page.getByPlaceholder(/自动保存已开启/)
  await editor.waitFor({ timeout: 30000 })

  const chapterTitle = (await page.locator('span[title^="双击改章名"]').first().innerText()).trim()
  // 🔴 进入正文时默认打开的是「最近打开 / 最近更新」的章，不一定是章节树第一项；
  //    先显式点第一项，保证后面建快照、恢复、重开核对的是同一章。
  await page.locator('span[title^="双击改章名"]').filter({ hasText: chapterTitle }).first().click()
  await page.waitForTimeout(800)
  const MARK_SAVE = '【恢复验证标记-应保留】'
  const MARK_DROP = '【恢复后应消失】'

  // ---- 1. 改稿并建命名快照 ----
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(MARK_SAVE)
  await page.waitForTimeout(500) // 等 React 的 draftContent 同步，再让时光机拿当前草稿建快照
  await page.getByRole('button', { name: '编辑工具', exact: true }).click()
  await page.getByRole('button', { name: /时光机 · 版本历史/ }).click()
  await page.getByLabel('快照名称').fill('恢复目标')
  await page.getByLabel('快照备注').fill('应保留标记')
  await page.getByRole('button', { name: '保存命名快照' }).click()
  await page.getByText('命名快照已保存。').waitFor({ timeout: 15000 })
  await page.keyboard.press('Escape')

  // ---- 2. 再改稿（恢复后这段应消失） ----
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(MARK_DROP)
  await page.waitForTimeout(2500) // 让自动保存落库

  // ---- 3. 恢复到命名快照 ----
  await page.getByRole('button', { name: '编辑工具', exact: true }).click()
  await page.getByRole('button', { name: /时光机 · 版本历史/ }).click()
  await page.getByText('恢复目标').first().click()
  await page.getByRole('button', { name: /恢复到此版本/ }).click()
  await page.getByText(/已恢复/).first().waitFor({ timeout: 20000 })

  const afterRestore = await editor.inputValue()
  check('恢复后当前编辑器已回到快照内容', afterRestore.includes(MARK_SAVE) && !afterRestore.includes(MARK_DROP))
  const diag = await page.evaluate(async title => {
    const db = await import('/src/lib/db.ts')
    const ch = (await db.getAllChapters()).find(c => c.title === title)
    const snaps = ch ? await db.getSnapshots(ch.id) : []
    return {
      chapter: { len: ch?.content.length, save: ch?.content.includes('【恢复验证标记-应保留】'), drop: ch?.content.includes('【恢复后应消失】') },
      snapshots: snaps.map(s => ({ label: s.label ?? '', source: s.source ?? '', len: s.content.length, save: s.content.includes('【恢复验证标记-应保留】'), drop: s.content.includes('【恢复后应消失】') })),
    }
  }, chapterTitle)
  console.log('DEBUG 恢复后立即读库:', JSON.stringify(diag))

  // ---- 4. 刷新重开 ----
  await page.waitForTimeout(2500)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-project-hub]').waitFor({ timeout: 60000 })
  await page.locator('[data-project-card]').filter({ hasText: '吞天神脉' }).getByRole('button', { name: /继续写作|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
  const dbCheck = await page.evaluate(async title => {
    const db = await import('/src/lib/db.ts')
    const list = await db.getAllChapters()
    return list.filter(c => c.title === title).map(c => ({
      id: c.id,
      len: c.content.length,
      containsSave: c.content.includes('【恢复验证标记-应保留】'),
      containsDrop: c.content.includes('【恢复后应消失】'),
      updatedAt: c.updatedAt,
    }))
  }, chapterTitle)
  console.log('DEBUG 刷新后库里同标题章节:', JSON.stringify(dbCheck))
  await page.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).click()
  await editor.waitFor({ timeout: 30000 })
  await page.locator('span[title^="双击改章名"]').filter({ hasText: chapterTitle }).first().click()
  await page.waitForTimeout(2000)
  const reopened = await editor.inputValue()
  console.log('DEBUG 重开正文尾部:', reopened.slice(-80))
  check('刷新重开后正文仍是快照内容', reopened.includes(MARK_SAVE), `len=${reopened.length}`)
  check('刷新重开后「恢复后应消失」标记没回来', !reopened.includes(MARK_DROP))

  // ---- 5. 恢复前留档存在 ----
  await page.getByRole('button', { name: '编辑工具', exact: true }).click()
  await page.getByRole('button', { name: /时光机 · 版本历史/ }).click()
  await page.getByText(/恢复前/).first().waitFor({ timeout: 15000 })
  check('恢复动作留下了「恢复前留档」', true)
  await page.keyboard.press('Escape')

  if (errors.length) throw new Error(errors.join('\n'))
  console.log(`\nPASS ${checks.length} checks · restore-reopen-340`)
} finally {
  await browser?.close().catch(() => {})
  await server.close().catch(() => {})
}