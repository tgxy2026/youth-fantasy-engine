// 3.3.1 · P10：图标键的触摸热区（规划 §14.2「至少 44×44，可通过外层加热区、不强迫图标变大」）。
//
// 判据只有两条，都用「这个点到底点到谁」——比几何相交可信：
//   ① 触点设备上，图标键**边缘外 5px** 处命中它自己（热区生效）；
//   ② 桌面（hover:hover / pointer:fine）上，同一个点**不**命中它（不给鼠标塞隐形热区）。
// 另外核对视觉尺寸没变（32×32 仍是 32×32）——热区不该把界面撑大。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const run = path.join('.workbuddy', 'tmp', `mobile-hit-target-331-${stamp}`)
fs.mkdirSync(run, { recursive: true })

let pass = 0, fail = 0
const cases = []
const check = (name, cond, extra = '') => {
  cases.push({ name, ok: !!cond, extra })
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/**
 * 找一个图标键并量四件事：
 *   · 伪元素热区的计算尺寸（最直接：44×44 就是热区，不存在就是 auto/0）；
 *   · 四个方向「边缘外 5px」的命中归属（哪个方向空出来就用它做证明）；
 *   · 视觉尺寸（热区不该把界面撑大）；
 *   · 媒体查询状态（确认上下文真的是触点设备 / 桌面鼠标）。
 */
const probeIcon = (page) => page.evaluate(() => {
  const isTarget = (node, button) => !!node && (node === button || button.contains(node))
  const candidates = [...document.querySelectorAll('button[data-button-sizing="icon"], button[data-button-icon-only="1"]')]
    .filter(button => {
      const box = button.getBoundingClientRect()
      return box.width > 0 && box.height > 0
    })
  for (const button of candidates) {
    const box = button.getBoundingClientRect()
    const centerX = box.left + box.width / 2
    const centerY = box.top + box.height / 2
    const after = getComputedStyle(button, '::after')
    const afterW = Math.round(parseFloat(after.width) || 0)
    const afterH = Math.round(parseFloat(after.height) || 0)
    // 四向各取 5px 外的点，记录命中归属（有些方向被邻居占着，属正常）
    const dirs = {
      above: document.elementFromPoint(centerX, box.top - 5),
      below: document.elementFromPoint(centerX, box.bottom + 5),
      left: document.elementFromPoint(box.left - 5, centerY),
      right: document.elementFromPoint(box.right + 5, centerY),
    }
    const hits = Object.fromEntries(Object.entries(dirs).map(([key, node]) => [key, isTarget(node, button)]))
    // 优先挑一个「至少一个方向命中自己」的按钮 —— 那正是热区在起作用的样子
    return {
      label: button.getAttribute('aria-label') || button.innerText.trim().slice(0, 8),
      variant: button.getAttribute('data-button-variant'),
      marked: button.hasAttribute('data-button-icon-only') ? 'icon-only' : button.getAttribute('data-button-sizing'),
      size: { w: Math.round(box.width), h: Math.round(box.height) },
      after: { content: after.content, w: afterW, h: afterH },
      hits,
      hitCount: Object.values(hits).filter(Boolean).length,
      coarse: matchMedia('(pointer: coarse)').matches,
      hoverNone: matchMedia('(hover: none)').matches,
    }
  }
  return null
})

const server = await createServer({ root: process.cwd(), cacheDir: '.workbuddy/tmp/vite-hit-target', logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
try {
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })

  const enter = async (page) => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /先看看示例/ }).click()
    await page.getByRole('button', { name: '下一步', exact: true }).click()
    await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
    await page.getByText('继续写作', { exact: true }).first().waitFor({ timeout: 90000 })
    const later = page.getByRole('button', { name: '稍后再说', exact: true })
    if (await later.isVisible().catch(() => false)) await later.click()
    const guide = page.locator('[data-guide-card]').first()
    if (await guide.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) {
      await page.getByRole('button', { name: '跳过本页' }).click().catch(() => {})
      await guide.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    }
  }

  // ---------- ① 触点设备 ----------
  const touch = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: 'reduce' })
  await touch.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  const touchPage = await touch.newPage()
  const touchErrors = []
  touchPage.on('pageerror', error => touchErrors.push(String(error)))
  await enter(touchPage)

  const onTouch = await probeIcon(touchPage)
  check('触点设备上能找到可测的图标键', !!onTouch, JSON.stringify(onTouch))
  if (onTouch) {
    check('上下文真的是触点设备（pointer:coarse + hover:none）', onTouch.coarse && onTouch.hoverNone,
      `coarse=${onTouch.coarse} hoverNone=${onTouch.hoverNone}`)
    check('图标键视觉尺寸没被撑大（仍是原来的小尺寸）', onTouch.size.w <= 36 && onTouch.size.h <= 36,
      JSON.stringify(onTouch.size))
    check('🔴 伪元素热区按 44×44 生效（视觉尺寸不变，只扩命中）',
      onTouch.after.w >= 44 && onTouch.after.h >= 44, JSON.stringify(onTouch.after))
    check('🔴 边缘外 5px 至少有一个方向命中该按钮（热区真的吃到了点击）',
      onTouch.hitCount > 0, `${onTouch.label} ${JSON.stringify(onTouch.hits)}`)
  }
  await touchPage.screenshot({ path: path.join(run, 'touch.png') })
  check('触点设备下没有页面脚本错误', touchErrors.length === 0, touchErrors.slice(0, 2).join(' | '))
  await touch.close()

  // ---------- ② 桌面：同一套界面不能有隐形热区 ----------
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await desktop.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  const deskPage = await desktop.newPage()
  await enter(deskPage)
  const onDesk = await probeIcon(deskPage)
  check('桌面上下文能找到同一个图标键', !!onDesk, JSON.stringify(onDesk))
  if (onDesk) {
    check('桌面不是触点设备（pointer:fine / hover:hover）', !onDesk.coarse && !onDesk.hoverNone,
      `coarse=${onDesk.coarse} hoverNone=${onDesk.hoverNone}`)
    check('🔴 桌面鼠标在边缘外 5px 处一个方向都**不**命中该按钮（没有隐形热区）',
      onDesk.hitCount === 0, `${onDesk.label} ${JSON.stringify(onDesk.hits)}`)
    check('桌面上没有 44×44 伪元素热区（媒体查询未匹配）', onDesk.after.w < 44, JSON.stringify(onDesk.after))
    // 「热区不影响布局」已由触摸侧证明（rect 仍是 32×32，而伪元素是 44×44）。
    // 不比较两侧 rect 是否相等：手机与桌面选中的本来就不是同一个按钮（布局不同），比它只会误报。
    check('桌面图标键保持原尺寸（没有被热区撑大）', onDesk.size.w <= 40 && onDesk.size.h <= 40,
      JSON.stringify(onDesk.size))
  }
  await deskPage.screenshot({ path: path.join(run, 'desktop.png') })
  await desktop.close()
} finally {
  await browser?.close()
  await server.close()
}

fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ passed: pass, failed: fail, cases }, null, 2))
console.log(`\n结果：${pass}/${pass + fail} 通过，记录在 ${run}`)
if (fail > 0) process.exitCode = 1
