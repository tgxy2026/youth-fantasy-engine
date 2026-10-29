// 使用答疑助手 · 宽屏侧边面板（3.3.1 · P4）实机验证
//
// 规划 §5.1：宽窗口为侧边面板，小窗口为对话框/抽屉，复用现有弹层机制。
// 验四件事：
//   ① 宽窗开的是**非模态侧板**（没有遮罩、背景不被 aria-hidden、正文可继续编辑）；
//   ② 正文 DOM 不卸载：打开前后 textarea 是同一个节点、值与选区都在；
//   ③ 面板内能查手册、能问 AI；来源/文章在面板里打开，不跳页；
//   ④ 布局变窄不换壳（形态在打开时决定）—— 否则「问了一半」的对话会被卸载。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const run = path.join('.workbuddy/tmp', `assistant-dock-331-${stamp}`)
fs.mkdirSync(run, { recursive: true })

const server = await createServer({
  root,
  cacheDir: path.join(run, 'vite'),
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

  const dismissExtras = async () => {
    const later = page.getByRole('button', { name: '稍后再说', exact: true })
    if (await later.isVisible().catch(() => false)) await later.click()
    const card = page.locator('[data-guide-card]').first()
    if (await card.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) {
      await page.getByRole('button', { name: '跳过本页' }).click().catch(() => {})
      await card.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    }
  }

  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 60000 })
  await dismissExtras()

  // 进正文编辑：面板不能把正文挤掉或重挂
  await page.getByRole('navigation').getByText('正文编辑', { exact: true }).first().click()
  await dismissExtras()
  const editor = page.locator('textarea.novel-textarea')
  await editor.waitFor({ timeout: 30000 })
  const before = await editor.inputValue()
  await editor.evaluate(el => { window.__dockEditorNode = el; el.focus(); el.setSelectionRange(12, 20) })

  // 从精灵打开答疑
  const sprite = page.getByRole('button', { name: '选择颉文姬助手' })
  await sprite.focus()
  await page.keyboard.press('Enter')
  const choices = page.getByRole('group', { name: '选择颉文姬助手' })
  await choices.waitFor({ timeout: 10000 })
  await choices.getByRole('button', { name: '使用答疑助手' }).click()

  const dock = page.locator('[data-assistant-dock]')
  await dock.waitFor({ timeout: 15000 })
  check('🔴 宽窗（1440）打开的是侧边面板', await dock.isVisible())
  check('侧边面板不是模态对话框（没有 role=dialog）', await page.getByRole('dialog').count() === 0)

  const geometry = await page.evaluate(() => {
    const panel = document.querySelector('[data-assistant-dock]')
    const rect = panel.getBoundingClientRect()
    const main = document.querySelector('main')?.getBoundingClientRect()
    return {
      width: Math.round(rect.width),
      right: Math.round(window.innerWidth - rect.right),
      height: Math.round(rect.height),
      zoom: getComputedStyle(document.documentElement).zoom,
      mainWidth: main ? Math.round(main.width) : null,
      masks: document.querySelectorAll('[data-guide-mask]').length,
      bodyAriaHidden: document.body.getAttribute('aria-hidden'),
    }
  })
  check('面板贴右缘、占满高度且宽度合理（300~520 CSS px）',
    geometry.right <= 2 && geometry.width >= 300 && geometry.width <= 520 && geometry.height >= 700, JSON.stringify(geometry))
  check('🔴 非模态：没有遮罩、body 也没有 aria-hidden', geometry.masks === 0 && geometry.bodyAriaHidden === null)

  // 正文没被卸载，值与选区都在
  const after = await page.evaluate(() => {
    const el = document.querySelector('textarea.novel-textarea')
    return { same: el === window.__dockEditorNode, value: el.value, start: el.selectionStart, end: el.selectionEnd }
  })
  check('🔴 打开面板不重挂正文（还是同一个 textarea 节点）', after.same)
  check('正文内容一字未变', after.value === before)
  check('正文选区仍在（12~20）', after.start === 12 && after.end === 20, `${after.start}~${after.end}`)

  // 面板内查手册
  await dock.getByLabel('搜索使用手册').fill('字太小怎么放大')
  await dock.getByText(/本地手册检索结果/).waitFor({ timeout: 15000 })
  check('面板内可直接查手册（不需要模型）', true)

  // 面板内问 AI：无模型时给片段
  await dock.getByRole('button', { name: /问 AI/ }).click()
  const question = '换电脑怎么带走数据'
  await dock.getByLabel('向答疑助手提问').fill(question)
  await dock.getByRole('button', { name: '提问', exact: true }).click()
  await dock.getByText(/这一条不是 AI 回答|已退回手册检索结果/).first().waitFor({ timeout: 40000 })
  check('面板内可提问，未配模型时如实说「不是 AI 回答」', true)
  await page.screenshot({ path: path.join(run, 'dock.png') })

  // 打开一篇文章：应在面板内部打开，不跳页签（无模型时没有「依据」按钮，走查手册路径）
  await dock.getByRole('button', { name: /查手册/ }).click()
  await dock.getByLabel('搜索使用手册').fill('界面缩放怎么调')
  await dock.getByText(/本地手册检索结果/).waitFor({ timeout: 15000 })
  const firstHit = dock.locator('button').filter({ hasText: /界面缩放|字太小/ }).first()
  await firstHit.click()
  const openedInDock = await dock.locator('[data-help-article]').first()
    .waitFor({ timeout: 10000 }).then(() => true).catch(() => false)
  check('文章在面板内部打开（没有跳走页签）', openedInDock)
  check('打开文章时正文仍在原位可见', await editor.isVisible())

  // 回到问 AI 那一栏再看对话（文章视图会盖住对话面板，但对话仍在内存里）
  if (openedInDock) await dock.getByRole('button', { name: /返回/ }).first().click()
  await dock.getByRole('button', { name: /问 AI/ }).click()

  // 🔴 变窄不换壳：对话与面板形态都保持
  await page.setViewportSize({ width: 1000, height: 800 })
  await page.waitForTimeout(400)
  const afterResize = {
    dock: await dock.isVisible(),
    dialog: await page.getByRole('dialog').count(),
    keepsQuestion: await dock.getByText(question).first().isVisible().catch(() => false),
  }
  check('🔴 窗口变窄后仍是同一个侧板（打开时定形态，不换壳丢对话）',
    afterResize.dock && afterResize.dialog === 0, JSON.stringify(afterResize))
  check('变窄后刚才的提问还在（面板没有被重建）', afterResize.keepsQuestion)

  // 关闭：正文依旧，且不残留
  await dock.getByRole('button', { name: '收起答疑助手' }).click()
  await dock.waitFor({ state: 'detached', timeout: 8000 }).catch(() => {})
  check('「收起」后面板消失', await page.locator('[data-assistant-dock]').count() === 0)
  const afterClose = await page.evaluate(() => {
    const el = document.querySelector('textarea.novel-textarea')
    return { same: el === window.__dockEditorNode, value: el.value }
  })
  check('🔴 关闭面板后正文还是同一个节点、内容未变', afterClose.same && afterClose.value === before)

  // 窄窗再开：这次应该是对话框
  await page.setViewportSize({ width: 1000, height: 800 })
  await page.waitForTimeout(300)
  await sprite.focus()
  await page.keyboard.press('Enter')
  await choices.waitFor({ timeout: 10000 })
  await choices.getByRole('button', { name: '使用答疑助手' }).click()
  const dialog = page.getByRole('dialog', { name: '使用答疑助手' })
  await dialog.waitFor({ timeout: 15000 })
  check('🔴 窄窗（1000，布局宽 < 1180）打开的是对话框', await dialog.isVisible())
  check('窄窗形态下不出现侧板', await page.locator('[data-assistant-dock]').count() === 0)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached', timeout: 8000 }).catch(() => {})

  check('页面无 pageerror', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))

  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ records, failed, geometry, afterResize }, null, 2))
  console.log(`\n结果：${records.length - failed}/${records.length} 通过，记录在 ${run}`)
} finally {
  await browser?.close()
  await server.close()
}
if (failed) process.exit(1)
