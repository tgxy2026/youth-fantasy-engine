// 左下角页面缩放布局 · P5 实机验证（3.3.1）
//
// 规划 §6 / Z01 / Z02 的验收口径：
//   · 第一行只有标题（+帮助），第二行「自动」与「− 数字 % +」同排，三位数完整显示；
//   · 80 / 100 / 130 / 160% × 侧栏最窄/最宽都不折行、不重叠；
//   · 高 DPI 系统缩放（deviceScaleFactor）下契约不变；
//   · 窄屏导航抽屉里同样能改缩放；
//   · 辅助技术能读到「跟随窗口自动调整」、选中态、百分比与增减操作名称；
//   · 重启（重载）沿用缩放偏好与模式。
//
// 🔴 明确不覆盖：浏览器自身缩放（Ctrl+±，Playwright 无法驱动，CDP 的 pageScaleFactor 是捏合缩放、
//    语义不同，不能当同一件事记录）、真实读屏软件、手机真机、系统显示设置里的真实 DPI。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const run = path.join('.workbuddy/tmp', `sidebar-zoom-p5-331-${new Date().toISOString().replace(/[:.]/g, '-')}`)
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

  /** 进示范项目并关掉首启引导，回到可操作的工作台 */
  const enterWorkspace = async (page) => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /先看看示例/ }).click()
    await page.getByRole('button', { name: '下一步', exact: true }).click()
    await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
    await page.getByTitle('返回项目列表').waitFor({ timeout: 60000 })
    await dismissExtras(page)
  }

  /**
   * 关掉挡住界面的两件事：备份提醒弹窗（会让背景 aria-hidden，role 直接查不到）与首次进页签的引导。
   * 🔴 不关掉它们，后面所有 getByRole 都会超时 —— 这不是布局问题，别误判成缩放坏了。
   */
  async function dismissExtras(page) {
    const later = page.getByRole('button', { name: '稍后再说', exact: true })
    if (await later.isVisible().catch(() => false)) await later.click()
    const card = page.locator('[data-guide-card]').first()
    if (await card.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) {
      await page.getByRole('button', { name: '跳过本页' }).click().catch(() => {})
      await card.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    }
  }

  /**
   * 重载后不一定回到工作台：停在项目列表时**用鼠标**点第一张卡片的「打开项目」。
   *
   * 🔴 这里刻意用鼠标而不是键盘：3.3.1 之前 130% 缩放下这块按钮会被左下角数据坞压住、鼠标点不到，
   *    所以只能靠键盘绕。现在项目列表按数据坞实测高度留了底部空间（主人 2026-10-30 定「留底部空间」），
   *    鼠标点击本身就是那条修复的验收 —— 改成键盘反而验不到。
   */
  const reopenAfterReload = async (page) => {
    const back = page.getByTitle('返回项目列表')
    if (await back.waitFor({ timeout: 8000 }).then(() => true).catch(() => false)) return
    await scrollHubToBottom(page)
    await page.getByRole('button', { name: '打开项目' }).first().click()
    await back.waitFor({ timeout: 60000 })
    await dismissExtras(page)
  }

  /** 项目列表是**内部滚动容器**（根节点 overflow-y-auto），不能只滚 document */
  const scrollHubToBottom = (page) => page.evaluate(() => {
    const hub = document.querySelector('[data-project-hub]')
    const scroller = hub && hub.scrollHeight > hub.clientHeight + 2 ? hub : (document.scrollingElement || document.documentElement)
    scroller.scrollTop = scroller.scrollHeight
    return { scrollTop: Math.round(scroller.scrollTop), scrollHeight: Math.round(scroller.scrollHeight), clientHeight: Math.round(scroller.clientHeight) }
  })

  /**
   * 滚到内容底部后，量「左下角数据坞」是否还压着卡片的「打开项目」按钮。
   * 🔴 命中测试比几何相交更可信：它问的是「这个点到底点到谁」。
   */
  const dockOverlap = async (page) => {
    const scrolled = await scrollHubToBottom(page)
    await page.waitForTimeout(120)
    const probe = await page.evaluate(() => {
      const open = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '打开项目')
      const dockHandle = document.querySelector('[aria-label="收起左下角工具栏"]')
      if (!open || !dockHandle) return { measured: false }
      const dock = dockHandle.closest('div').getBoundingClientRect()
      const btn = open.getBoundingClientRect()
      const hit = document.elementFromPoint(btn.x + btn.width / 2, btn.y + btn.height / 2)
      const inDock = !!hit?.closest('[aria-label="收起左下角工具栏"]')
      return {
        measured: true,
        covered: inDock,
        hitLabel: hit?.getAttribute('aria-label') || hit?.tagName || '',
        button: { x: Math.round(btn.x), y: Math.round(btn.y) },
        dock: { x: Math.round(dock.x), y: Math.round(dock.y), w: Math.round(dock.width), h: Math.round(dock.height) },
        zoom: getComputedStyle(document.documentElement).zoom,
      }
    })
    return { ...probe, scrolled }
  }
  const findings = []

  /** 量一次缩放面板的几何与状态 */
  const measure = (page, scope = 'body') => page.evaluate((scopeSel) => {
    const panel = document.querySelector(`${scopeSel} [data-zoom-panel]`)
    if (!panel) return null
    const input = panel.querySelector('input[aria-label="界面缩放百分比"]')
    const auto = [...panel.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '跟随窗口自动调整')
    const title = [...panel.querySelectorAll('span')].find(s => s.textContent.trim() === '界面缩放')
    const rect = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height } }
    return {
      value: input.value,
      // 三位数是否被输入框裁掉：滚动宽度超过可视宽度就是裁了
      inputOverflow: input.scrollWidth - input.clientWidth,
      inputBox: rect(input),
      autoBox: rect(auto),
      titleBox: title ? rect(title) : null,
      autoPressed: auto.getAttribute('aria-pressed'),
      autoSelectedClass: /(?:^|\s)(?:bg-|border-)/.test(auto.className) ? 'has-style' : 'plain',
      rootZoom: getComputedStyle(document.documentElement).zoom,
      dpr: window.devicePixelRatio,
      panelWidth: panel.getBoundingClientRect().width,
    }
  }, scope)

  // ---------- ① 桌面：侧栏最窄/最宽 × 四档缩放 ----------
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(String(error)))
  await enterWorkspace(page)

  const resize = page.getByRole('separator', { name: '侧栏宽度' })
  const input = page.getByRole('spinbutton', { name: '界面缩放百分比' })
  const auto = page.getByRole('button', { name: '跟随窗口自动调整' })
  const cases = []
  for (const side of ['Home', 'End']) {
    for (const zoom of [80, 100, 130, 160]) {
      await resize.focus()
      await page.keyboard.press(side)   // Home = 最窄，End = 最宽
      await input.fill(String(zoom))
      await input.press('Enter')
      await page.waitForTimeout(160)
      const m = await measure(page)
      const sameRow = Math.abs(m.inputBox.top - m.autoBox.top) <= 5
      const titleAbove = m.titleBox ? m.titleBox.bottom <= m.autoBox.top + 1 : false
      const threeDigits = m.inputOverflow <= 1
      const applied = m.value === String(zoom) && Math.abs(Number(m.rootZoom) - zoom / 100) < 0.03
      if (!sameRow || !titleAbove || !threeDigits || !applied || m.autoPressed !== 'false') {
        check(`布局契约 ${side}/${zoom}%`, false, JSON.stringify(m))
        continue
      }
      cases.push({ side, zoom, ...m })
    }
  }
  check('四档缩放 × 侧栏最窄/最宽：标题在上、自动与数值同排、值真的生效', cases.length === 8, `${cases.length}/8 通过`)
  check('🔴 三位数（160%）在输入框内完整显示，不被裁切',
    cases.filter(c => c.zoom === 160).every(c => c.inputOverflow <= 1),
    cases.filter(c => c.zoom === 160).map(c => `溢出 ${c.inputOverflow}px`).join(' / '))
  check('手动模式不再显示为「跟随窗口」（aria-pressed=false）', cases.every(c => c.autoPressed === 'false'))

  // ---------- ② 辅助技术：aria 快照里读得到名字、状态与操作 ----------
  await auto.click()
  await page.waitForTimeout(120)
  let aria = ''
  try {
    aria = await page.locator('[data-zoom-panel]').ariaSnapshot()
  } catch (error) {
    aria = `ariaSnapshot 不可用：${String(error).slice(0, 60)}`
  }
  check('读得到「跟随窗口自动调整」按钮', /button "跟随窗口自动调整"/.test(aria), aria.split('\n').slice(0, 2).join(' '))
  check('读得到当前是自动模式的选中态', /跟随窗口自动调整.*\[pressed\]/.test(aria), '')
  check('读得到百分比输入框', /spinbutton "界面缩放百分比"/.test(aria))
  check('读得到增减操作名称（缩小/放大）', /button "缩小界面"/.test(aria) && /button "放大界面"/.test(aria))
  check('读得到标题「界面缩放」', /界面缩放/.test(aria))

  // ---------- ③ 重启沿用偏好（重载 = 重开一次） ----------
  await input.fill('130')
  await input.press('Enter')
  await page.waitForTimeout(150)
  await page.reload({ waitUntil: 'domcontentloaded' })
  // 🔴 130% 缩放下「留底部空间」是否真的解决问题：滚到底后按钮中心必须点得到按钮自己
  await page.getByRole('button', { name: '打开项目' }).first().waitFor({ timeout: 20000 }).catch(() => {})
  const overlap = await dockOverlap(page)
  check('🔴 130% 下滚到内容底部后，卡片「打开项目」不再被数据坞压住',
    !!overlap.measured && overlap.covered === false, JSON.stringify(overlap))
  check('底部留白确实来自数据坞实测高度（--dock-height 已发布）',
    (await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dock-height')) || 0)) > 40,
    await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dock-height')))
  if (overlap.measured) findings.push({ where: '项目管理页 · 手动 130% 重开后（已修）', ...overlap })
  await reopenAfterReload(page)
  const afterReload = await measure(page)
  check('🔴 手动 130% 重开后沿用（比例与「手动」模式都记住）',
    afterReload.value === '130' && Math.abs(Number(afterReload.rootZoom) - 1.3) < 0.03 && afterReload.autoPressed === 'false',
    JSON.stringify({ value: afterReload.value, zoom: afterReload.rootZoom }))
  await page.getByRole('button', { name: '跟随窗口自动调整' }).click()
  await page.waitForTimeout(150)
  const autoValue = (await measure(page)).value
  await page.reload({ waitUntil: 'domcontentloaded' })
  await reopenAfterReload(page)
  const autoAfterReload = await measure(page)
  check('🔴 切回「跟随窗口」后重开仍是自动模式',
    autoAfterReload.autoPressed === 'true' && autoAfterReload.value === autoValue,
    JSON.stringify({ autoValue, now: autoAfterReload.value, pressed: autoAfterReload.autoPressed }))

  // ---------- ④ 窄屏导航抽屉里改缩放 ----------
  await page.setViewportSize({ width: 880, height: 900 })
  await page.waitForTimeout(250)
  const settingsButton = page.getByRole('button', { name: '界面与数据设置' })
  await settingsButton.waitFor({ timeout: 15000 })
  check('窄屏（880px）切到抽屉形态，出现「界面与数据设置」入口', true)
  await settingsButton.click()
  const drawer = page.getByRole('dialog').first()
  await drawer.waitFor({ timeout: 10000 })
  const drawerPanel = page.locator('[role="dialog"] [data-zoom-panel]').first()
  await drawerPanel.waitFor({ timeout: 10000 })
  const drawerInput = drawer.getByRole('spinbutton', { name: '界面缩放百分比' })
  await drawerInput.fill('160')
  await drawerInput.press('Enter')
  await page.waitForTimeout(250)
  // 🔴 抽屉只有 300px：同样要求「标题在上、自动与数值同排、三位数完整」，不能只在宽侧栏成立
  const inDrawer = await measure(page, '[role="dialog"]')
  const drawerSameRow = !!inDrawer && Math.abs(inDrawer.inputBox.top - inDrawer.autoBox.top) <= 5
  const drawerTitleAbove = !!inDrawer?.titleBox && inDrawer.titleBox.bottom <= inDrawer.autoBox.top + 1
  check('🔴 抽屉（300px）里 160% 仍标题在上、自动与数值同排、三位数完整',
    !!inDrawer && drawerSameRow && drawerTitleAbove && inDrawer.inputOverflow <= 1
      && inDrawer.value === '160' && Math.abs(Number(inDrawer.rootZoom) - 1.6) < 0.03,
    JSON.stringify(inDrawer))
  await page.locator('[role="dialog"] [data-zoom-panel]').first().scrollIntoViewIfNeeded().catch(() => {})
  await page.screenshot({ path: path.join(run, 'drawer.png') })
  await page.keyboard.press('Escape')
  await drawer.waitFor({ state: 'detached', timeout: 8000 }).catch(() => {})
  const compactStill = await page.getByRole('button', { name: '打开项目菜单' }).isVisible()
  check('关掉抽屉后仍是窄屏形态（没有被缩放改回桌面布局）', compactStill)

  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.waitForTimeout(200)
  await page.screenshot({ path: path.join(run, 'desktop.png') })
  check('页面无 pageerror', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
  await context.close()

  // ---------- ⑤ 高 DPI 系统缩放 ----------
  const dpiResults = []
  for (const dsf of [1.25, 1.5, 2]) {
    const hi = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dsf, reducedMotion: 'reduce' })
    await hi.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
    const hiPage = await hi.newPage()
    const errors = []
    hiPage.on('pageerror', error => errors.push(String(error)))
    try {
      await enterWorkspace(hiPage)
      const hiInput = hiPage.getByRole('spinbutton', { name: '界面缩放百分比' })
      await hiInput.fill('160')
      await hiInput.press('Enter')
      await hiPage.waitForTimeout(180)
      const m = await measure(hiPage)
      const sameRow = Math.abs(m.inputBox.top - m.autoBox.top) <= 5
      const titleAbove = m.titleBox ? m.titleBox.bottom <= m.autoBox.top + 1 : false
      const ok = !!m && m.dpr === dsf && sameRow && titleAbove && m.inputOverflow <= 1 && Math.abs(Number(m.rootZoom) - 1.6) < 0.03
      dpiResults.push({ dsf, ok, dpr: m?.dpr, overflow: m?.inputOverflow, zoom: m?.rootZoom, errors: errors.length })
    } catch (error) {
      dpiResults.push({ dsf, ok: false, error: String(error).slice(0, 120) })
    } finally {
      await hi.close()
    }
  }
  check('🔴 高 DPI（1.25 / 1.5 / 2 倍）下 160% 仍同排、标题在上、三位数完整',
    dpiResults.every(r => r.ok), JSON.stringify(dpiResults))

  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({
    records, failed, cases, dpiResults, findings,
    aria: aria.split('\n').slice(0, 12),
    notCovered: ['浏览器自身缩放（Ctrl+±）', '真实读屏软件', '手机真机', '系统显示设置里的真实 DPI'],
  }, null, 2))
  console.log(`\n结果：${records.length - failed}/${records.length} 通过，记录在 ${run}`)
} finally {
  await browser?.close()
  await server.close()
}
if (failed) process.exit(1)
