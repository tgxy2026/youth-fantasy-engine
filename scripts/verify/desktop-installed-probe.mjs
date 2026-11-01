// 3.3.3 · 桌面安装版实机验证（**测试脚手架**）
//
// 目标：验证"已安装的桌面版"能真正用起来，而不只是 --smoke-test 能启动。
//   ① 窗口加载的是打包内的 file:// 页面（不是 dev server）；
//   ② 首启界面在；**「开发预览环境」那条提示应当消失**（它只在非打包环境出现）；
//   ③ 能走完首启建书 → 进项目 → 打开图鉴页签渲染表格；
//   ④ 全程无 console.error / pageerror。
//
// 前置：桌面版已安装（默认 %LOCALAPPDATA%\Programs\YouthFantasyEngine）。
// 用法：node scripts/verify/desktop-installed-probe.mjs
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'

const EXE = process.env.YFE_EXE
  || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'YouthFantasyEngine', 'YouthFantasyEngine.exe')
const UDD = process.env.YFE_UDD || 'C:/Users/18223/AppData/Local/Temp/yfe-ui-verify'
const PORT = 9223

if (!existsSync(EXE)) {
  console.error('找不到已安装的 exe:', EXE)
  process.exit(1)
}
rmSync(UDD, { recursive: true, force: true })

const child = spawn(EXE, ['--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${UDD}`], {
  detached: false, stdio: 'ignore',
})
console.log('已启动:', EXE, '| pid', child.pid)

/** 等 CDP 端口就绪 */
async function waitCdp(timeoutMs = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return true
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

const up = await waitCdp()
console.log('CDP 就绪:', up)
if (!up) { child.kill(); process.exit(1) }

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
const ctx = browser.contexts()[0]
const page = ctx.pages()[0] ?? (await ctx.newPage())

const errors = []
page.on('pageerror', e => errors.push('pageerror: ' + e.message.slice(0, 100)))
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 100)) })

await page.waitForTimeout(4000)

const url = page.url()
const boot = await page.evaluate(() => {
  const t = (document.body.innerText || '').replace(/\s+/g, ' ')
  return {
    hasFirstBook: /写我的第一本书/.test(t),
    hasDevPreviewHint: /开发预览环境|桌面版专属功能/.test(t),
    head: t.slice(0, 120),
  }
})
console.log('页面 URL:', url)
console.log('首启界面:', JSON.stringify(boot))

// 走首启建书
const first = page.locator('button', { hasText: '写我的第一本书' }).first()
if (await first.count()) {
  await first.click()
  await page.waitForTimeout(800)
  const next = page.getByRole('button', { name: '下一步' })
  if (await next.count()) { await next.click(); await page.waitForTimeout(1200) }
  const nameInput = page.locator('input[type="text"]').first()
  if (await nameInput.count()) await nameInput.fill('安装版验证')
  const skip = page.getByRole('button', { name: /跳过，直接开始/ }).first()
  if (await skip.count()) await skip.click()
  else await page.getByRole('button', { name: /开始|创建|完成/ }).first().click().catch(() => {})
  await page.waitForTimeout(8000)
}

const afterCreate = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim())
  return { inProject: btns.includes('创意写作'), sample: btns.slice(0, 8) }
})
console.log('建书后是否进入作品:', JSON.stringify(afterCreate))

// 打开图鉴页签，确认表格/空态渲染
const raced = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === '种族生物')
  if (!b) return false
  b.click(); return true
})
await page.waitForTimeout(2500)
const tabRender = await page.evaluate(() => {
  const t = (document.body.innerText || '').replace(/\s+/g, ' ')
  return { len: t.length, hasTable: /编号|名称/.test(t), head: t.slice(0, 100) }
})
console.log('图鉴页签点击:', raced, '| 渲染:', JSON.stringify(tabRender))
await page.screenshot({ path: '.workbuddy/tmp/desktop-installed.png' })

console.log('错误累计:', errors.length, errors.slice(0, 3))

await browser.close().catch(() => {})
child.kill()
console.log('已关闭')
