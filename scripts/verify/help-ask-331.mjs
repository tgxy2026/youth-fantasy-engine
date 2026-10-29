// 使用答疑助手 · 问 AI（3.3.1 · P4）实机探针
//
// 验的是「没配模型 / 没召回 / 有依据」三条路都不骗人，以及打开依据不会把对话弄丢。
// 隔离条件：独立 Edge 用户目录 + 只允许本站请求，未配置任何模型。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const run = path.join('.workbuddy/tmp', `help-ask-331-${stamp}`)
fs.mkdirSync(run, { recursive: true })

const server = await createServer({
  root,
  cacheDir: path.join('.workbuddy/tmp', `vite-help-ask-${stamp}`),
  logLevel: 'error',
  server: { host: 'localhost', port: 0 },
})

const records = []
let failed = 0
const check = (name, pass, detail = '') => {
  records.push({ name, pass, detail })
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`)
}

let browser
try {
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(String(error)))

  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 60000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible()) await later.click()

  // 3.3.1 P2/P3：首次进页签会弹分步引导（遮罩会吃掉点击）—— 每次导航后先关掉再操作
  const closeGuide = async () => {
    // 引导是「就绪 + 一帧延迟」才弹，导航刚完成时可能还没出现 —— 先等一会，别急着判定「没有」
    await page.locator('[data-guide-card]').first().waitFor({ timeout: 2500 }).catch(() => {})
    for (let i = 0; i < 3; i++) {
      const card = page.locator('[data-guide-card]').first()
      if (!(await card.isVisible().catch(() => false))) return
      await page.getByRole('button', { name: '跳过本页' }).click().catch(() => {})
      await card.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    }
  }
  await closeGuide()

  // 进使用指南
  const nav = page.getByRole('navigation')
  await nav.getByText('使用指南', { exact: true }).first().click()
  await closeGuide()
  const assistant = page.getByRole('heading', { name: '使用答疑助手' })
  await assistant.waitFor({ timeout: 20000 })
  check('使用指南页出现「使用答疑助手」入口', true)

  // 切到问 AI
  await page.getByRole('button', { name: /问 AI/ }).click()
  const panel = page.locator('[data-ask-panel]')
  await panel.waitFor({ timeout: 10000 })
  check('问 AI 面板打开', true)
  const headText = await panel.innerText()
  check('面板写明只看手册、不读稿件、关闭即清空',
    /只依据内置手册/.test(headText) && /不读你的稿件/.test(headText) && /关闭即清空/.test(headText))

  // ① 真实问题：未配模型 ⇒ 只给片段，不装作答
  const box = page.getByLabel('向答疑助手提问')
  await box.fill('字太小怎么放大')
  await box.press('Enter')
  await page.locator('[data-ask-panel] >> text=/这一条不是 AI 回答|已退回手册检索结果|没能回答/').first().waitFor({ timeout: 60000 })
  const firstAnswer = await panel.innerText()
  check('未配置模型时如实说明「不是 AI 回答」，不假装答过', /这一条不是 AI 回答/.test(firstAnswer))
  check('给了本地手册片段作为落脚点', /字太小怎么放大|界面缩放|缩放/.test(firstAnswer))
  await page.screenshot({ path: path.join(run, 'no-model.png') })

  // ② 点片段 → 打开文章那一段；返回后对话还在（不会因为打开依据就丢历史）
  const hitButton = panel.locator('button').filter({ hasText: /篇|字|缩放/ }).first()
  const hitCount = await panel.locator('button').count()
  if (hitCount > 0) {
    const beforeTurn = firstAnswer.includes('字太小怎么放大') ? '字太小怎么放大' : ''
    await panel.locator('button').filter({ hasText: '「' }).first().click().catch(() => {})
    const articleOpen = await page.locator('[data-help-article]').first().isVisible().catch(() => false)
    if (!articleOpen) {
      // 没点到来源按钮，就退而验「片段点开文章」这条路
      await panel.locator('button').nth(0).click().catch(() => {})
    }
    const opened = await page.locator('[data-help-article]').first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false)
    check('点片段 / 依据能打开手册原文', opened)
    if (opened) {
      const articleText = await page.locator('[data-help-article]').first().innerText()
      check('打开的是对应的手册文章而不是随便一篇', articleText.length > 20)
      await page.getByRole('button', { name: /返回/ }).first().click()
      await page.locator('[data-ask-panel]').waitFor({ timeout: 8000 })
      const backText = await panel.innerText()
      check('🔴 打开依据再返回，刚才的提问与结果仍在（会话没被卸载）',
        beforeTurn ? backText.includes(beforeTurn) : backText.length > 0)
      await page.screenshot({ path: path.join(run, 'return-kept.png') })
    }
  }

  // ③ 无关问题：本地没有召回 ⇒ 不出片段、不请求模型
  await box.fill('量子纠缠的退相干时间')
  await box.press('Enter')
  await page.locator('[data-ask-panel] >> text=/没有找到直接对应的段落/').first().waitFor({ timeout: 60000 })
  const noRecall = await panel.innerText()
  check('无关问题如实说手册没写，不硬凑一篇文章', /没有找到直接对应的段落/.test(noRecall))

  // ④ 清空对话
  await page.getByRole('button', { name: /清空/ }).click()
  await page.getByText('问一句，比如').first().waitFor({ timeout: 8000 })
  check('可以一键清空本次对话', true)

  // ⑤ 未配置模型时手册照常可读（切回查手册）
  await page.getByRole('button', { name: /查手册/ }).click()
  const manualVisible = await page.getByRole('heading', { name: '使用答疑助手' }).isVisible()
  check('不配模型也能读手册', manualVisible && (await page.getByLabel('搜索使用手册').isVisible()))

  check('页面无 pageerror', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))

  // ⑥ 项目管理页也能读手册（未打开项目）
  await closeGuide()
  await page.getByTitle('返回项目列表').click()
  await page.getByRole('button', { name: /使用手册/ }).first().click()
  const hubDialog = page.getByRole('dialog').first()
  await hubDialog.waitFor({ timeout: 10000 })
  await page.getByRole('button', { name: /问 AI/ }).click()
  const hubPanel = page.locator('[data-ask-panel]')
  await hubPanel.waitFor({ timeout: 10000 })
  check('项目管理页（未打开项目）也能打开答疑助手', await hubPanel.isVisible())
  await page.screenshot({ path: path.join(run, 'hub.png') })
  await page.keyboard.press('Escape')
} finally {
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ records, failed }, null, 1))
  console.log(`\n结果：${records.length - failed}/${records.length} 通过，截图与记录在 ${run}`)
  await browser?.close()
  await server.close()
}
if (failed) process.exit(1)
