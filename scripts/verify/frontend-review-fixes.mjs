// 3.7.0 复核补真机探针：① 开篇结论落库 → 投稿体检引用；② 角色卡详情「状态演变」可见。
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-review-fixes-'))
const report = { run, checks: [], errors: [], console: [], status: 'running' }
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
  page.on('console', m => { if (m.type() === 'error') report.console.push(m.text().slice(0, 400)) })

  await page.goto(origin, { waitUntil: 'commit' })
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
  await page.evaluate(async () => { (await import('/src/lib/settings/guidePrefs.ts')).setGuideAutoEnabled(false) })
  if (await page.locator('[data-guide-overlay]').count()) {
    const skip = page.getByRole('button', { name: /跳过本页|跳过|知道了|关闭/ }).first()
    if (await skip.isVisible().catch(() => false)) await skip.click()
    else await page.keyboard.press('Escape')
  }

  const seeded = await page.evaluate(async () => {
    const db = await import('/src/lib/db.ts')
    const snap = await import('/src/lib/audit/openingSnapshot.ts')
    const st = await import('/src/lib/settings/stateTrack.ts')
    // 入场动画/项目初始化可能稍晚于首屏：等项目 id 就绪再写（避免写进空项目 id）
    let pid = ''
    for (let i = 0; i < 50 && !pid; i++) { pid = db.getCurrentProjectId(); if (!pid) await new Promise(r => setTimeout(r, 100)) }
    await snap.saveOpeningSnapshot(pid, '一句话定调：能签\n\n## 黄金三章四查\n…')
    const cards = await db.getCardRecords('char-main')
    if (!cards.length) return { pid, cardId: '', cardName: '' }
    const card = cards[0]
    await st.appendStateRecords([st.buildStateRecord({
      ref: { kind: 'card', tabId: 'char-main', id: card.id, projectId: pid },
      chapterId: '', chapterNo: 3, state: '重伤', previous: '健在', trigger: '手动补登',
    })])
    return { pid, cardId: card.id, cardName: card.name }
  })


  const snapBack = await page.evaluate(async (pid) => {
    const snap = await import('/src/lib/audit/openingSnapshot.ts')
    const db = await import('/src/lib/db.ts')
    return { pid, now: db.getCurrentProjectId(), snap: await snap.readOpeningSnapshot(pid) }
  }, seeded.pid)
  check('探针：结论快照已落库', !!snapBack.snap && snapBack.snap.conclusion === '能签', snapBack)

  const nav = page.getByRole('navigation')
  await nav.getByRole('button', { name: '检查工具', exact: true }).click()
  // 先跑一次分平台预检（纯本地），让 platform 区有可引用结果
  await page.getByRole('button', { name: '预检全书', exact: true }).click()
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: '投稿体检', exact: true }).click()
  const opening = page.locator('[data-report-section="opening"]')
  await opening.waitFor()
  check('体检页开篇区已引用结论（不再是未跑）', await opening.getAttribute('data-report-state') === 'ran',
    await opening.getAttribute('data-report-state'))
  check('体检页显示落库时的原话', await opening.getByText(/能签/).first().isVisible())
  check('仍注明仅供参考', await opening.getByText(/仅供参考/).first().isVisible())
  const platform = page.locator('[data-report-section="platform"]')
  check('体检页平台区已引用预检观察', await platform.getAttribute('data-report-state') === 'ran', await platform.getAttribute('data-report-state'))
  check('平台区保留观察句（不只一句结论）', (await platform.innerText()).length > 10)
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.locator('[data-submission-report]').waitFor({ state: 'detached' }).catch(() => undefined)

  if (seeded.cardId) {
    await nav.getByRole('button', { name: '主要角色', exact: true }).click()
    await page.locator('[data-character-workspace]').waitFor()
    // 选中左侧列表里的那张角色卡（按名字点）
    if (!await page.locator('[data-state-evolution]').first().isVisible().catch(() => false)) {
      await page.getByText(seeded.cardName, { exact: true }).first().click()
    }
    const evolution = page.locator('[data-state-evolution]').first()
    await evolution.waitFor()
    check('角色卡详情出现「状态演变」', await evolution.isVisible())
    check('按章记录可见（第3章 · 重伤）', await evolution.getByText(/第3章/).first().isVisible()
      && await evolution.getByText(/重伤/).first().isVisible())
    check('旧值一并留痕', await evolution.getByText(/健在/).first().isVisible())
  } else {
    check('示例项目有角色卡可供验证（否则本项无法验证）', false, 'no char card')
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = String(error?.stack || error)
  try { report.pageText = (await page?.locator('main, [role="main"], body').first().innerText()).slice(0, 1500) } catch { /* ignore */ }
  console.error(error)
  process.exitCode = 1
} finally {
  try { await page?.screenshot({ path: path.join(run, 'shot.png') }) } catch { /* 现场 */ }
  await browser?.close().catch(() => undefined)
  await server?.close().catch(() => undefined)
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2))
  console.log('REPORT ' + path.join(run, 'report.json'), report.status)
}