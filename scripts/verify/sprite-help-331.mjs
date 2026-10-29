// 精灵双助手入口：隔离示例项目，不调用外部模型或网络。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const run = path.join('.workbuddy/tmp', `sprite-help-331-${stamp}`)
fs.mkdirSync(run, { recursive: true })
const server = await createServer({ root: process.cwd(), cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
const records = []
const check = (name, pass, detail = '') => { records.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`) }
let browser
try {
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 60000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible()) await later.click()
  const guide = page.locator('[data-guide-card]').first()
  if (await guide.waitFor({ timeout: 3000 }).then(() => true).catch(() => false)) await page.getByRole('button', { name: '跳过本页' }).click()
  await page.evaluate(async () => { (await import('/src/lib/settings/guidePrefs.ts')).setGuideAutoEnabled(false) })
  const sprite = page.getByRole('button', { name: '选择颉文姬助手' })
  await sprite.focus()
  await page.keyboard.press('Enter')
  const choices = page.getByRole('group', { name: '选择颉文姬助手' })
  await choices.waitFor()
  check('非编辑页精灵支持键盘打开双入口', await choices.getByRole('button', { name: '前往正文编辑器' }).isVisible() && await choices.getByRole('button', { name: '使用答疑助手' }).isVisible())
  check('打开选择后焦点进入首个入口', await choices.getByRole('button', { name: '前往正文编辑器' }).evaluate(el => document.activeElement === el))
  await page.keyboard.press('Tab')
  check('可用 Tab 到达使用答疑入口', await choices.getByRole('button', { name: '使用答疑助手' }).evaluate(el => document.activeElement === el))
  await page.keyboard.press('Escape')
  check('Escape 关闭选择并返回精灵焦点', !(await choices.isVisible()) && await sprite.evaluate(el => document.activeElement === el))
  await sprite.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })))
  check('模拟输入法组合期间 Enter 不打开选择', !(await choices.isVisible()))
  await page.keyboard.press('Enter')
  await choices.waitFor()
  await choices.getByRole('button', { name: '使用答疑助手' }).click()
  const dialog = page.getByRole('dialog', { name: '使用答疑助手' })
  await dialog.waitFor()
  await dialog.getByLabel('搜索使用手册').fill('字太小怎么放大')
  check('非编辑页可直接查手册，无需打开正文', await dialog.getByText(/本地手册检索结果/).isVisible())
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()

  await page.getByRole('navigation').getByText('正文编辑', { exact: true }).first().click()
  const editor = page.locator('textarea.novel-textarea')
  await editor.waitFor({ timeout: 30000 })
  const before = await editor.inputValue()
  await editor.fill(before + '\n精灵答疑隔离测试')
  await editor.evaluate(el => { window.__helpEditorNode = el; el.setSelectionRange(4, 9) })
  await sprite.focus()
  await page.keyboard.press('Space')
  await choices.getByRole('button', { name: '打开 AI 编辑助手' }).click()
  await page.getByText('颉文姬 · AI 编辑', { exact: true }).first().waitFor()
  check('编辑页选择可打开原有 AI 编辑助手', true)
  await sprite.focus()
  await page.keyboard.press('Enter')
  await choices.getByRole('button', { name: '使用答疑助手' }).click()
  await dialog.waitFor()
  await dialog.getByRole('button', { name: '问 AI' }).click()
  await dialog.getByLabel('向答疑助手提问').fill('字太小怎么放大')
  await dialog.getByRole('button', { name: '提问', exact: true }).click()
  await dialog.getByText(/这一条不是 AI 回答/).waitFor({ timeout: 30000 })
  check('未配模型也可从精灵入口查到手册片段', true)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  const preserved = await editor.evaluate(el => ({ same: el === window.__helpEditorNode, value: el.value, start: el.selectionStart, end: el.selectionEnd }))
  check('打开关闭答疑不卸载正文且保留输入与选区', preserved.same && preserved.value === before + '\n精灵答疑隔离测试' && preserved.start === 4 && preserved.end === 9, JSON.stringify({ same: preserved.same, start: preserved.start, end: preserved.end }))
  check('无页面脚本错误', errors.length === 0, errors.join(' | '))
} finally {
  const failed = records.filter(record => !record.pass).length
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ records, failed }, null, 2))
  console.log(`结果：${records.length - failed}/${records.length}，${run}`)
  await browser?.close()
  await server.close()
  if (failed) process.exitCode = 1
}
