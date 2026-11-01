// 3.3.3 · G-02 便携形态实机验证（**测试脚手架**）
//
// 便携版 = 本地 Node 服务（scripts/portable-server.mjs）+ 打包后的 dist。
// 验：① 页面能开；② 首启三入口在；③ 建书进项目；④ 图鉴页签渲染；⑤ 无 console/pageerror。
// 前置：先起便携服务（node scripts/portable-server.mjs --port 8765）
// 用法：YFE_PORT=8765 node scripts/verify/portable-ui-check.mjs
import { chromium } from 'playwright'

const PORT = process.env.YFE_PORT || 8765
const BASE = `http://127.0.0.1:${PORT}`
const PROFILE = 'F:/软件项目/青春幻想引擎/youth-fantasy-engine开发源码/.workbuddy/tmp/edge-profile-portable'

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'msedge', viewport: { width: 1500, height: 900 }, args: ['--no-first-run'],
})
const page = ctx.pages()[0] ?? (await ctx.newPage())
const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message.slice(0, 100)))
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 100)) })
// 404 具体是哪个资源，直接记 URL（否则只看到一句 "Failed to load resource"）
page.on('response', r => {
  const st = r.status()
  if (st >= 500) errors.push(`5xx(${st}): ` + r.url().slice(0, 120))
  else if (st === 404) errors.push('404: ' + r.url().slice(0, 120))
})

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(7000)

const boot = await page.evaluate(() => {
  const t = (document.body.innerText || '').replace(/\s+/g, ' ')
  return { hasFirstBook: /写我的第一本书/.test(t), head: t.slice(0, 90) }
})
console.log('① 便携形态首启:', JSON.stringify(boot))

const first = page.locator('button', { hasText: '写我的第一本书' }).first()
if (await first.count()) {
  await first.click(); await page.waitForTimeout(800)
  const next = page.getByRole('button', { name: '下一步' })
  if (await next.count()) { await next.click(); await page.waitForTimeout(1200) }
  const nameInput = page.locator('input[type="text"]').first()
  if (await nameInput.count()) await nameInput.fill('便携形态验证')
  const skip = page.getByRole('button', { name: /跳过，直接开始/ }).first()
  if (await skip.count()) await skip.click()
  else await page.getByRole('button', { name: /开始|创建|完成/ }).first().click().catch(() => {})
  await page.waitForTimeout(8000)
}
const inProject = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim())
  return { inProject: btns.includes('创意写作') }
})
console.log('② 建书后:', JSON.stringify(inProject))

await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === '种族生物')
  b?.click()
})
await page.waitForTimeout(2500)
const tab = await page.evaluate(() => {
  const t = (document.body.innerText || '').replace(/\s+/g, ' ')
  return { len: t.length, hasColumns: /编号/.test(t) && /名称/.test(t) }
})
console.log('③ 图鉴页签:', JSON.stringify(tab))
console.log('④ 错误累计:', errors.length, errors.slice(0, 3))

await page.screenshot({ path: '.workbuddy/tmp/portable-form.png' })
await ctx.close()
