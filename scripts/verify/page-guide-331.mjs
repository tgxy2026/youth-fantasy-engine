// 3.3.1 · P2 实机探针：页签聚焦引导
//
// 验的是作者真会遇到的那条路：第一次进「作品信息」自动出现 → 逐步走 → 跳过 → 不再自动弹
// → 「本页指引」重看 → Esc 关闭 → 改界面缩放后高亮框仍贴合目标 → 使用指南里能关能重开。
// 🔴 只看 DOM 结构（卡片 / 遮罩 / 高亮框 / 步骤徽章），不靠固定延时判断动画是否结束。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const run = await mkdtemp(path.join(root, '.workbuddy/tmp/page-guide-331-'))
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

  const nav = page.getByRole('navigation')
  const card = page.locator('[data-guide-card]')
  // 3.3.1 P3：写作面板自己的引导（App 层托管）会先弹，遮罩会挡住侧栏点击 —— 先关掉
  {
    const dashboardGuide = page.locator('[data-guide-card]')
    if (await dashboardGuide.waitFor({ timeout: 3000 }).then(() => true).catch(() => false)) {
      await page.getByRole('button', { name: '跳过本页' }).click()
      await dashboardGuide.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    }
  }
  const badge = async () => (await card.innerText()).match(/第 (\d+) \/ (\d+) 步/)

  // ① 首次进入「作品信息」自动出现
  await nav.getByText('作品信息', { exact: true }).first().click()
  await card.waitFor({ timeout: 20000 })
  const firstText = await card.innerText()
  check('首次进入页签自动出现分步引导', firstText.includes('开书前的商业档案'), firstText.slice(0, 60))
  check('显示第几步 / 共几步', /第 1 \/ 3 步/.test(firstText), firstText.slice(0, 20))
  check('背景被遮罩挡住（四块，中间留孔）', await page.locator('[data-guide-mask]').count() === 4)
  check('高亮框存在', await page.locator('[data-guide-hole]').count() === 1)
  await page.screenshot({ path: path.join(run, 'step1.png') })

  // ② 高亮框真的套住目标（边缘被夹到视口是正确行为，只要求覆盖目标可见部分）
  const fit = await page.evaluate(() => {
    const target = document.querySelector('[data-guide="form-header"]').getBoundingClientRect()
    const hole = document.querySelector('[data-guide-hole]').getBoundingClientRect()
    return {
      coversTop: hole.top <= Math.max(0, target.top - 8) + 2,
      coversLeft: hole.left <= Math.max(0, target.left - 8) + 2,
      coversBottom: hole.bottom >= Math.min(window.innerHeight, target.bottom + 8) - 2,
      coversRight: hole.right >= Math.min(window.innerWidth, target.right + 8) - 2,
      target: { top: Math.round(target.top), left: Math.round(target.left), w: Math.round(target.width) },
      hole: { top: Math.round(hole.top), left: Math.round(hole.left), w: Math.round(hole.width) },
    }
  })
  check('高亮框覆盖目标（含外扩，边缘按视口夹紧）',
    fit.coversTop && fit.coversLeft && fit.coversBottom && fit.coversRight, JSON.stringify(fit))

  // ③ 逐步走：下一步 → 第 2 步，上一步 → 回第 1 步
  await page.getByRole('button', { name: '下一步' }).click()
  check('下一步能前进', (await badge())?.[1] === '2', await card.innerText())
  await page.getByRole('button', { name: '上一步' }).click()
  check('上一步能后退', (await badge())?.[1] === '1')

  // ④ 焦点落在卡片里（Tab 不会跑进被遮住的页面）
  // 🔴 产品侧在同步 + 一帧 + 60ms 各试一次（缩放与入场动画会把焦点打回 body），这里等它稳定再断言
  await page.waitForTimeout(150)
  const focusInfo = await page.evaluate(() => {
    const el = document.activeElement
    return { tag: el?.tagName ?? '', inCard: !!el?.closest('[data-guide-card]'), html: (el?.outerHTML ?? '').slice(0, 90) }
  })
  check('打开后焦点在卡片内', focusInfo.inCard, JSON.stringify(focusInfo))
  await page.keyboard.press('Tab')
  const stillInCard = await page.evaluate(() => !!document.activeElement?.closest('[data-guide-card]'))
  check('Tab 仍在卡片内（焦点被锁住）', stillInCard)

  // ⑤ 跳过 → 消失；再进来不再自动弹
  await page.getByRole('button', { name: '跳过本页' }).click()
  await card.waitFor({ state: 'detached', timeout: 5000 })
  check('跳过会关掉卡片', await page.locator('[data-guide-card]').count() === 0)
  await nav.getByText('写作面板', { exact: true }).first().click()
  await nav.getByText('作品信息', { exact: true }).first().click()
  await page.waitForTimeout(1200)
  check('🔴 跳过之后不再自动弹', await page.locator('[data-guide-card]').count() === 0)

  // ⑥ 本页指引：主动重看
  await page.getByRole('button', { name: '本页指引' }).click()
  await card.waitFor({ timeout: 5000 })
  check('「本页指引」可以随时重看', (await badge())?.[1] === '1')

  // ⑦ 改缩放后高亮仍贴合（应用缩放不等于 CSS 假缩放：不能重复乘系数）
  await page.evaluate(async () => { (await import('/src/lib/settings/theme.ts')).applyZoom(130, { manual: true }) })
  await page.waitForTimeout(300)
  const zoomFit = await page.evaluate(() => {
    const target = document.querySelector('[data-guide="form-header"]').getBoundingClientRect()
    const hole = document.querySelector('[data-guide-hole]')?.getBoundingClientRect()
    if (!hole) return null
    return {
      coversTop: hole.top <= Math.max(0, target.top - 8) + 2,
      coversBottom: hole.bottom >= Math.min(window.innerHeight, target.bottom + 8) - 2,
      target: { top: Math.round(target.top), h: Math.round(target.height) },
      hole: { top: Math.round(hole.top), h: Math.round(hole.height) },
    }
  })
  check('130% 缩放下高亮框仍覆盖目标', !!zoomFit && zoomFit.coversTop && zoomFit.coversBottom, JSON.stringify(zoomFit))
  await page.screenshot({ path: path.join(run, 'zoom130.png') })

  // ⑧ Escape 关闭
  await page.keyboard.press('Escape')
  await card.waitFor({ state: 'detached', timeout: 5000 })
  check('Escape 等同跳过', await page.locator('[data-guide-card]').count() === 0)
  await page.evaluate(async () => { (await import('/src/lib/settings/theme.ts')).applyZoom(100, { manual: true }) })

  // ⑨ 使用指南里的开关与重置
  await nav.getByText('使用指南', { exact: true }).first().click()
  await page.getByText('分步引导', { exact: true }).waitFor({ timeout: 15000 })
  const settingsText = await page.locator('[data-guide-settings]').innerText()
  check('使用指南里能看到引导开关与记录数', /自动分步引导|已开启|已关闭/.test(settingsText) && /已记录 \d+ 个页签/.test(settingsText), settingsText.slice(0, 120))
  check('提供重置入口', /重置引导记录/.test(settingsText))

  const failed = checks.filter(item => !item.ok)
  const evidence = { run, total: checks.length, passed: checks.length - failed.length, failed: failed.length, pageErrors: errors, checks }
  await writeFile(path.join(run, 'result.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ ...evidence, checks: undefined }, null, 2))
  if (failed.length || errors.length) process.exitCode = 1
} finally {
  await browser?.close()
  await server.close()
}
