// 3.3.1 · P7 实机回归：示范项目里打开「校对（本章）」与颉文姬诊室
//
// 这一条只验「改动没把两个入口弄坏」：弹窗与诊室能正常渲染、没有 pageerror、
// 关掉之后正文一个字没变、没有校对结果时不显示「定位原文」。
// 🔴 它**不能**证明真实模型返回后的逐条定位 —— 那需要真实模型额度，本次不做；
//    选区与跳转行为由 proof-locate-331.mjs 的隔离探针覆盖。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const run = await mkdtemp(path.join(root, '.workbuddy/tmp/proof-locate-demo-331-'))
const server = await createServer({ root, cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
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

  // 进正文：写作面板的「继续写作」直达本章
  const write = page.getByText('继续写作', { exact: true }).first()
  if (await write.isVisible()) await write.click()
  else await page.getByRole('navigation').getByText('正文编辑', { exact: true }).first().click()
  const body = page.locator('textarea.novel-textarea[aria-label]').first()
  await page.locator('textarea').first().waitFor({ timeout: 30000 })
  const original = await page.locator('textarea').first().inputValue()

  // ① 校对弹窗（工具菜单的无障碍名是「编辑工具」；用 /工具/ 会先命中导航里的「灵感工具」）
  await page.getByRole('button', { name: '编辑工具', exact: true }).click()
  await page.getByRole('button', { name: '校对（本章）' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor({ timeout: 15000 })
  const dialogText = await dialog.innerText()
  const aiButtons = await dialog.getByRole('button', { name: /查错别字与语病|查逻辑与设定矛盾/ }).count()
  const locateButtons = await dialog.getByRole('button', { name: '定位原文' }).count()
  await page.screenshot({ path: path.join(run, 'proofread-modal.png') })

  // ② 关掉弹窗后正文不变
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden', timeout: 10000 })
  const afterClose = await page.locator('textarea').first().inputValue()

  // ③ 颉文姬诊室渲染
  await page.getByRole('button', { name: '颉文姬' }).click()
  const panel = page.getByText('颉文姬 · AI 编辑', { exact: true })
  await panel.waitFor({ timeout: 15000 })
  const clinicText = await page.locator('body').innerText()
  await page.screenshot({ path: path.join(run, 'clinic.png') })
  await page.getByRole('button', { name: '收起', exact: true }).click()
  await panel.waitFor({ state: 'hidden', timeout: 10000 })

  const evidence = {
    run,
    run_summary: {
      dialogOpened: true,
      hasLocalTypoSection: dialogText.includes('本地错别字词库'),
      hasAiSection: dialogText.includes('AI 校对'),
      aiScopeButtons: aiButtons,
      locateButtonsWithoutResults: locateButtons,
      aiSectionExplainsMissingModel: dialogText.includes('未接入 AI 模型'),
      clinicOpened: clinicText.includes('校对范围'),
      bodyUnchangedAfterClose: afterClose === original,
      pageErrors: errors,
    },
    note: '示范项目、无模型额度：不发起真实校对，也不覆盖真实模型返回后的逐条定位。',
  }
  await writeFile(path.join(run, 'result.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
  if (errors.length) process.exitCode = 1
  if (locateButtons !== 0) process.exitCode = 1
} finally {
  await browser?.close()
  await server.close()
}
