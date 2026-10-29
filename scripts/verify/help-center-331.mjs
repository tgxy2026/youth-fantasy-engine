// 3.3.1 · P1 实机探针：使用指南页里的内置手册
//
// 验的是「作者真能查到」：搜索出片段、点进文章、落到那一段、返回保留查询、
// 「前往功能」真的跳页签、覆盖度如实写、未配置模型也照常可读（示范项目没有模型）。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const run = await mkdtemp(path.join(root, '.workbuddy/tmp/help-center-331-'))
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

  // ① 进使用指南
  await page.getByRole('navigation').getByText('使用指南', { exact: true }).first().click()
  await page.getByText('内置使用手册', { exact: true }).waitFor({ timeout: 20000 })
  const headerText = await page.locator('section', { hasText: '内置使用手册' }).first().innerText()
  check('手册区块渲染出来了', headerText.includes('内置使用手册'))
  const coverage = headerText.match(/已收录 (\d+) 篇 · 覆盖 (\d+) 个页签/)
  check('如实显示收录篇数与覆盖页签数', !!coverage, headerText.slice(0, 80))
  check('未配置模型也能读手册（没有任何模型提示挡住）', !/需先接入 AI 模型/.test(headerText))
  await page.screenshot({ path: path.join(run, 'catalog.png') })

  // ② 搜索：同义表达（字太小 → 界面缩放）
  const search = page.getByRole('textbox', { name: '搜索使用手册' })
  await search.fill('字太小了怎么放大')
  await page.getByText(/本地手册检索结果/).waitFor({ timeout: 10000 })
  const resultText = await page.locator('section', { hasText: '内置使用手册' }).first().innerText()
  check('本地检索给出了片段（并注明不联网、不调用模型）', /本地手册检索结果（\d+ 段）/.test(resultText) && /不联网、不调用模型/.test(resultText))
  check('「字太小」命中了界面缩放那篇', resultText.includes('字太小 / 太大怎么调'), resultText.slice(0, 200))
  await page.screenshot({ path: path.join(run, 'search.png') })

  // ③ 点结果 → 打开文章并落到那一段
  await page.getByRole('button', { name: /字太小 \/ 太大怎么调/ }).first().click()
  await page.locator('[data-help-article]').waitFor({ timeout: 10000 })
  const articleText = await page.locator('[data-help-article]').innerText()
  check('打开的文章就是命中的那篇', articleText.includes('界面缩放'))
  const sections = await page.locator('[data-help-article] [data-help-section]').count()
  check('文章按段落渲染（不是一整坨长文本）', sections >= 1, `段落 ${sections}`)
  check('文章标了核对版本日期', /核对于 \d{4}-\d{2}-\d{2}/.test(articleText))
  await page.screenshot({ path: path.join(run, 'article.png') })

  // ④ 返回：查询词与结果还在
  await page.getByRole('button', { name: /返回/ }).first().click()
  const backValue = await page.getByRole('textbox', { name: '搜索使用手册' }).inputValue()
  check('返回后查询词保留（不用重新输入）', backValue === '字太小了怎么放大', backValue)

  // ⑤ 按功能查阅 + 覆盖度缺口
  await search.fill('')
  await page.getByRole('button', { name: /按功能查阅/ }).click()
  const byTab = await page.locator('section', { hasText: '内置使用手册' }).first().innerText()
  check('按功能查阅按栏目分组', byTab.includes('角色与世界') && byTab.includes('工作面板与正文'))
  check('🔴 覆盖缺口如实写出来（不假装完整手册）', /个页签暂无手册/.test(byTab), byTab.slice(-200))
  await page.screenshot({ path: path.join(run, 'by-tab.png') })

  // ⑥ 「前往功能」真的跳页签
  await search.fill('新建章节写正文')
  await page.getByRole('button', { name: /写第一章：建章、写正文、确认保存/ }).first().click()
  await page.locator('[data-help-article]').waitFor({ timeout: 10000 })
  await page.getByRole('button', { name: '去正文编辑' }).click()
  await page.locator('textarea.novel-textarea').first().waitFor({ timeout: 20000 })
  check('文章里的「前往功能」跳到了正文编辑', await page.locator('textarea.novel-textarea').first().isVisible())

  check('全程无 pageerror', errors.length === 0, errors.join(' ｜ '))
  const failed = checks.filter(item => !item.ok)
  const evidence = {
    run,
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
    coverage: coverage ? { articles: Number(coverage[1]), tabs: Number(coverage[2]) } : null,
    pageErrors: errors,
    note: '示范项目、无模型：手册检索全程本地，不调用任何模型或网络。',
    checks,
  }
  await writeFile(path.join(run, 'result.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ ...evidence, checks: undefined }, null, 2))
  if (failed.length || errors.length) process.exitCode = 1
} finally {
  await browser?.close()
  await server.close()
}
