// 3.4.0 · README 界面截图（真实应用 + 示例项目）
// 用法：node scripts/verify/capture-readme-shots-340.mjs [--only writing-panel]
// 产物直接覆盖 docs/screenshots/*.png；先跑一张看效果可加 --only。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const outDir = path.join(root, 'docs/screenshots')
const only = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? process.argv[i + 1] : '' })()
const run = await mkdtemp(path.join(root, '.workbuddy/tmp/readme-shots-'))
const server = await createServer({ root, cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
const done = []

try {
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
  await context.route('**/*', r => r.request().url().startsWith(origin + '/') ? r.continue() : r.abort())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))

  // 🔴 引导遮罩会把背景变 inert 并拦截点击（项目已知测试坑）
  await page.addInitScript(() => localStorage.setItem('yfe-ui:guide-auto', '0'))
  await page.goto(origin, { waitUntil: 'domcontentloaded' })

  // ---- 进示例项目 ----
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()

  const nav = page.getByRole('navigation')
  const go = async (name) => {
    await nav.getByRole('button', { name, exact: true }).first().click({ timeout: 20000 })
    await page.waitForTimeout(1100)
  }
  const shot = async (name) => {
    if (only && only !== name) return
    const file = path.join(outDir, `${name}.png`)
    await page.screenshot({ path: file, animations: 'disabled' })
    done.push(name)
    console.log('SHOT', name, file)
  }

  // ① 写作面板：展开规划板 + 随手记，收起空的收藏集（避免大片空白），再滚回顶部
  await nav.getByRole('button', { name: '写作面板', exact: true }).click()
  await page.waitForTimeout(1000)
  const toggle = async (label, want) => {
    const btn = page.getByRole('button', { name: new RegExp(label) }).first()
    if (!(await btn.isVisible().catch(() => false))) return
    const expanded = await btn.getAttribute('aria-expanded')
    if (expanded === null) return
    if (want === 'open' && expanded === 'false') await btn.click().catch(() => {})
    if (want === 'closed' && expanded === 'true') await btn.click().catch(() => {})
    await page.waitForTimeout(250)
  }
  await toggle('章节规划板', 'open')
  await toggle('章节收藏集', 'closed')
  await toggle('随手记灵感', 'open')
  await toggle('项目起步清单', 'open')
  await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('main')?.scrollTo?.(0, 0) })
  await page.waitForTimeout(800)
  await shot('writing-panel')

  // ② 正文编辑
  await go('正文编辑')
  await page.getByPlaceholder(/自动保存已开启/).waitFor({ timeout: 30000 }).catch(() => {})
  await shot('editor')

  // ③ 主要角色 / ④ 人物关系 / ⑤ 章节细纲 / ⑥ 酒馆控制面板
  for (const [tab, name] of [
    ['主要角色', 'characters'],
    ['人物关系', 'relations'],
    ['章节细纲', 'outline'],
    ['控制面板', 'tavern'],
  ]) {
    await go(tab)
    await shot(name)
  }

  // ⑦ 项目中心（返回项目列表）
  await page.getByTitle('返回项目列表').click()
  await page.locator('[data-project-card]').first().waitFor({ timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(900)
  // vite dev 环境左下角有 DataDock 的「开发预览环境」提示（打包版没有），
  // 对外 README 截图不该带着它 —— 只隐藏这一个挂件。
  await page.evaluate(() => {
    const dock = document.querySelector('[data-data-dock]')
    if (dock) dock.style.display = 'none'
  })
  await page.waitForTimeout(300)
  await shot('project-center')

  console.log('DONE', JSON.stringify({ done, errors }))
  if (errors.length) console.log('PAGE_ERRORS', errors.slice(0, 3))
} finally {
  await browser?.close()
  await server.close()
}
