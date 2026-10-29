// 3.3.1 · P3 实机探针：引导 ⇄ 手册 的双向跳转
//
// 验两件「只有在跨页时才成立」的事：
//   ① 引导卡片上的「查看完整手册」→ 跳到使用指南并**直接打开那一篇**；
//   ② 手册文章里的「重看这页的引导」→ 跳回功能页并**立刻启动引导**。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const run = await mkdtemp(path.join(root, '.workbuddy/tmp/help-crosspage-331-'))
const server = await createServer({ root, cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
const checks = []
const check = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond, extra })
  if (!cond) console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`)
}
try {
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))

  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 60000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible()) await later.click()

  const card = page.locator('[data-guide-card]')
  await card.waitFor({ timeout: 20000 })
  check('写作面板引导出现（关联了手册文章）', await card.getByRole('button', { name: /查看完整手册/ }).count() === 1)

  // ① 引导 → 手册文章
  await page.getByRole('button', { name: /查看完整手册/ }).click()
  await page.locator('[data-help-article]').waitFor({ timeout: 20000 })
  const articleText = await page.locator('[data-help-article]').innerText()
  check('跳到了使用指南并打开了对应文章', articleText.includes('写作面板：一屏看清今天该干什么'), articleText.slice(0, 60))
  check('引导卡片已收起（中断不是完成）', await page.locator('[data-guide-card]').count() === 0)
  await page.screenshot({ path: path.join(run, 'article-from-guide.png') })

  // ② 手册文章 → 重看引导
  const replay = page.getByRole('button', { name: /重看这页的引导/ })
  check('文章里提供「重看这页的引导」', await replay.count() === 1)
  await replay.click()
  await card.waitFor({ timeout: 20000 })
  const backText = await card.innerText()
  check('跳回功能页并立刻启动引导', /第 1 \/ 2 步/.test(backText) && backText.includes('今天写了多少'), backText.slice(0, 60))
  check('重看时高亮锚点仍在', await page.locator('[data-guide-hole]').count() === 1)
  await page.screenshot({ path: path.join(run, 'guide-from-article.png') })

  // ③ 中断不算完成：关掉后重新进入还能自动弹（因为点手册那次是中断）
  await page.getByRole('button', { name: '跳过本页' }).click()
  await card.waitFor({ state: 'detached', timeout: 5000 })
  check('跳过会关掉卡片', await page.locator('[data-guide-card]').count() === 0)

  check('全程无 pageerror', errors.length === 0, errors.join(' ｜ '))
  const failed = checks.filter(item => !item.ok)
  const evidence = { run, total: checks.length, passed: checks.length - failed.length, failed: failed.length, pageErrors: errors, checks }
  await writeFile(path.join(run, 'result.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ ...evidence, checks: undefined }, null, 2))
  if (failed.length || errors.length) process.exitCode = 1
} finally {
  await browser?.close()
  await server.close()
}
