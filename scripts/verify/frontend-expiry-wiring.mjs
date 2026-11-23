// 3.7.0 · W2 真机探针：候选落库 → 改正文 → 候选审阅可见「已过期 / 过期原因」。
// 隔离：临时 vite + 临时浏览器上下文（独立 IDB），真 Edge，不碰真实作者数据。
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-expiry-wiring-'))
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
    const intake = await import('/src/lib/revision/candidateIntake.ts')
    const pid = db.getCurrentProjectId()
    // 造一章可应用的正文（示例书已有章节则可直接用第一章）
    let chapters = await db.getAllChapters()
    if (!chapters.length) {
      await db.saveVolume({ id: 'probe-vol', projectId: pid, order: 0, title: '探针卷', createdAt: Date.now() })
      await db.saveChapter({ id: 'probe-c1', projectId: pid, volumeId: 'probe-vol', order: 0, title: '第1章 探针', content: '这是改前的正文。', wordCount: 8, updatedAt: Date.now() })
      chapters = await db.getAllChapters()
    }
    const chapter = chapters[0]
    const r = await intake.recordRewriteCandidate({
      projectId: pid, chapterId: chapter.id, text: '这是候选改写后的正文。',
      beforeText: chapter.content ?? '', summary: '探针：整章改写',
    })
    if (!r.ok) throw new Error('候选没建出来：' + r.detail)
    // 作者随后改了正文 —— 候选基准不再成立
    await db.saveChapter({ ...chapter, content: (chapter.content ?? '') + '（作者后来又改了一句。）', updatedAt: Date.now() })
    await new Promise(resolve => setTimeout(resolve, 900))
    return { pid, chapterId: chapter.id, candidateId: r.candidateId }
  })

  const stored = await page.evaluate(async (candidateId) => {
    const store = await import('/src/lib/revision/candidateStore.ts')
    const c = await store.loadCandidate(candidateId)
    return c ? { status: c.status, reasons: c.staleReasons ?? [] } : null
  }, seeded.candidateId)
  check('候选落库为已过期', stored?.status === 'stale', stored)
  check('过期原因含「正文已变化」', (stored?.reasons ?? []).includes('正文已变化'), stored?.reasons)

  // 引导浮层会挡住侧栏点击：先关掉它（与脚本探针同一口径）
  await page.evaluate(async () => { (await import('/src/lib/settings/guidePrefs.ts')).setGuideAutoEnabled(false) })
  if (await page.locator('[data-guide-overlay]').count()) {
    const skip = page.getByRole('button', { name: /跳过本页|跳过|知道了|关闭/ }).first()
    if (await skip.isVisible().catch(() => false)) await skip.click()
    else await page.keyboard.press('Escape')
  }
  const nav = page.getByRole('navigation')
  await nav.getByRole('button', { name: '创作轨迹', exact: true }).click()
  await page.getByRole('button', { name: /候选审阅/ }).first().click()
  // 默认只列「待处理候选」；已过期属于留档历史 —— 切到「全部留档」才看得到过期原因
  await page.getByRole('button', { name: '全部留档', exact: true }).click()
  const item = page.locator(`[data-candidate-id="${seeded.candidateId}"]`)
  await item.waitFor()
  check('界面候选状态标记为 stale', await item.getAttribute('data-candidate-status') === 'stale',
    await item.getAttribute('data-candidate-status'))
  check('界面显示过期原因', await page.getByText(/过期原因：/).first().isVisible())

  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = String(error?.stack || error)
  console.error(error)
  process.exitCode = 1
} finally {
  try { await page?.screenshot({ path: path.join(run, 'shot.png') }) } catch { /* 留现场 */ }
  await browser?.close().catch(() => undefined)
  await server?.close().catch(() => undefined)
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2))
  console.log('REPORT ' + path.join(run, 'report.json'), report.status)
}