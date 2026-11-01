// 已安装桌面版的 UI 验证（连到已在运行的调试端口，不自己 spawn）
// 用法：先启动安装版并开 --remote-debugging-port=9225，再 node scripts/verify/desktop-ui-check.mjs
import { chromium } from 'playwright'

const PORT = process.env.YFE_CDP_PORT || 9225
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
const ctx = browser.contexts()[0]
const page = ctx.pages()[0]
console.log('连接页面:', page.url())

const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message.slice(0, 100)))
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 100)) })

await page.waitForTimeout(2500)

const boot = await page.evaluate(() => {
  const t = (document.body.innerText || '').replace(/\s+/g, ' ')
  return {
    hasFirstBook: /写我的第一本书/.test(t),
    hasDevPreviewHint: /开发预览环境|桌面版专属功能需在打包版/.test(t),
    head: t.slice(0, 100),
  }
})
console.log('① 首启界面:', JSON.stringify(boot))

// 走完首启建书
const first = page.locator('button', { hasText: '写我的第一本书' }).first()
if (await first.count()) {
  await first.click(); await page.waitForTimeout(800)
  const next = page.getByRole('button', { name: '下一步' })
  if (await next.count()) { await next.click(); await page.waitForTimeout(1200) }
  const nameInput = page.locator('input[type="text"]').first()
  if (await nameInput.count()) await nameInput.fill('安装版验证')
  const skip = page.getByRole('button', { name: /跳过，直接开始/ }).first()
  if (await skip.count()) await skip.click()
  else await page.getByRole('button', { name: /开始|创建|完成/ }).first().click().catch(() => {})
  await page.waitForTimeout(8000)
}
const inProject = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim())
  return { inProject: btns.includes('创意写作'), hasDevHint: /开发预览环境/.test(document.body.innerText || '') }
})
console.log('② 建书后:', JSON.stringify(inProject))

// 打开图鉴页签
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === '种族生物')
  b?.click()
})
await page.waitForTimeout(2500)
const tab = await page.evaluate(() => {
  const t = (document.body.innerText || '').replace(/\s+/g, ' ')
  return { len: t.length, hasColumns: /编号/.test(t) && /名称/.test(t), head: t.slice(0, 90) }
})
console.log('③ 图鉴页签:', JSON.stringify(tab))

// 打开「模型设置」看桌面专属能力是否可用（开发态会提示需打包版）
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === '模型设置')
  b?.click()
})
await page.waitForTimeout(2000)
const settings = await page.evaluate(() => {
  const t = (document.body.innerText || '').replace(/\s+/g, ' ')
  return { hasDevHint: /开发预览环境|需在打包版中使用/.test(t), head: t.slice(0, 110) }
})
console.log('④ 模型设置:', JSON.stringify(settings))

await page.screenshot({ path: '.workbuddy/tmp/desktop-installed-ui.png' })
console.log('错误累计:', errors.length, errors.slice(0, 3))
await browser.close().catch(() => {})
