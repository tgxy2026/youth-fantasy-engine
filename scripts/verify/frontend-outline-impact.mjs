// 3.7.0 · W1 真机探针：改一处卷纲 → 颉文姬「整理」页可见「未来计划待重审」与已写章建议复核。
//
// 隔离：临时 vite 实例 + 临时浏览器上下文（独立 IDB），不碰真实作者数据；真 Edge（channel: 'msedge'）。
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-outline-impact-'))
const report = { run, checks: [], errors: [], status: 'running' }
const check = (name, passed, details) => {
  report.checks.push({ name, passed: !!passed, details })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${passed ? '' : ' :: ' + JSON.stringify(details)}`)
  if (!passed) throw new Error(name)
}
let server, browser, page
try {
  server = await createServer({
    root, cacheDir: path.join(run, 'vite-cache'), logLevel: 'error',
    server: { host: 'localhost', port: 0, watch: { ignored: ['**/.workbuddy/**', '**/release/**', '**/dist/**'] } },
  })
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => (route.request().url().startsWith(origin + '/') ? route.continue() : route.abort()))
  page = await context.newPage()
  page.setDefaultTimeout(60000)
  page.on('pageerror', e => report.errors.push(e.message))

  await page.goto(origin, { waitUntil: 'commit' })
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
  const guide = page.locator('[data-guide-card]').first()
  if (await guide.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) await page.getByRole('button', { name: '跳过本页' }).click()

  const seeded = await page.evaluate(async () => {
    const db = await import('/src/lib/db.ts')
    const pid = db.getCurrentProjectId()
    // 清掉示例书自带章节/大纲，保证「已写 1/2 章、未开写 3-5 章」的判据可复现
    for (const c of await db.getAllChapters()) await db.deleteChapter(c.id)
    for (const v of await db.getAllVolumes()) await db.deleteVolume(v.id)
    for (const r of await db.getCardRecords('chapter-outline')) await db.deleteCardRecord(r.id)
    for (const r of await db.getCardRecords('volume-outline')) await db.deleteCardRecord(r.id)
    await db.saveVolume({ id: 'probe-vol', projectId: pid, order: 0, title: '探针卷', createdAt: Date.now() })
    for (const no of [1, 2]) {
      await db.saveChapter({
        id: `probe-c${no}`, projectId: pid, volumeId: 'probe-vol', order: no - 1,
        title: `第${no}章 探针`, content: `第${no}章正文`, wordCount: 6, updatedAt: Date.now(),
      })
    }
    for (let no = 1; no <= 5; no++) {
      await db.saveCardRecord({
        id: `probe-o${no}`, projectId: pid, tabId: 'chapter-outline', name: `第${no}章 探针`,
        data: { '一、本章定位::章节号/标题': `第${no}章 探针`, '一、本章定位::本章一句话事件': `旧事件${no}` },
        order: no - 1,
      })
    }
    const volCard = {
      id: 'probe-vol-card', projectId: pid, tabId: 'volume-outline', name: '探针卷',
      data: { '本卷章号范围': '第1-5章', '二、起止与节奏::第一大高潮': '旧高潮' }, order: 0,
    }
    await db.saveCardRecord(volCard)
    await db.saveCardRecord({ ...volCard, data: { ...volCard.data, '二、起止与节奏::第一大高潮': '新高潮' } })
    return { pid }
  })

  // 300ms 防抖 + 落库
  await page.waitForTimeout(900)
  const stored = await page.evaluate(async () => {
    const { readImpact, readReviewSuggestions } = await import('/src/lib/outline/futureImpact.ts')
    return { marks: await readImpact(), suggests: await readReviewSuggestions() }
  })
  check('卷纲变更后落库标记 3/4/5', stored.marks.map(m => m.chapterNo).join(',') === '3,4,5', stored.marks)
  check('标记原因「卷纲变更」且带证据', stored.marks.every(m => m.reason === '卷纲变更' && !!m.evidence), stored.marks)
  check('已写章 1/2 进建议复核清单', stored.suggests.map(s => s.chapterNo).join(',') === '1,2', stored.suggests)

  // 真机界面：正文编辑 → 颉文姬 → 整理
  const nav = page.getByRole('navigation')
  if (!await nav.getByRole('button', { name: '正文编辑', exact: true }).isVisible()) {
    await nav.getByRole('button', { name: '正文写作', exact: true }).click()
  }
  await nav.getByRole('button', { name: '正文编辑', exact: true }).click()
  await page.locator('[data-guide="jiewenji-entry"]').click()
  await page.getByRole('button', { name: '整理', exact: true }).click()
  const impactTitle = page.getByText('未来计划待重审', { exact: true })
  await impactTitle.waitFor()
  check('界面可见「未来计划待重审」', await impactTitle.isVisible())
  check('界面可见「已写章节建议复核」', await page.getByText('已写章节建议复核', { exact: true }).isVisible())
  check('界面列出第 3 章与卷纲来源', await page.getByText(/第 3 章/).first().isVisible()
    && await page.getByText(/《探针卷》·卷纲变更/).first().isVisible())

  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = String(error?.stack || error)
  console.error(error)
  process.exitCode = 1
} finally {
  try { await page?.screenshot({ path: path.join(run, 'shot.png') }) } catch { /* 失败时也留一张现场 */ }
  await browser?.close().catch(() => undefined)
  await server?.close().catch(() => undefined)
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2))
  console.log('REPORT ' + path.join(run, 'report.json'), report.status)
}