// 3.3.1 · P10：手机多视口的全页基础布局与触摸命中区域抽样。
//
// 规划 §14.6 要求「自动化覆盖 320/360/375/390/430 竖屏及 667×375、844×390 横屏」，
// 「全页覆盖基础布局」「常用触摸操作命中区域拟定至少 44×44 CSS px」。
//
// 这份探针只做**能自动判对**的事：
//   · 主框架没有意外横向溢出（document.scrollWidth ≤ 视口宽 + 1）；
//   · 每个入口都能切到、主区域非空、没有停在加载态；
//   · 抽样的图标按钮里有多少小于 44×44（记录为发现，不当作失败 —— 是否补热区是产品决定）。
// 不做、也不假装做过：真机、软键盘、中文 IME、安全区域、文件选择、后台回收。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const run = path.join('.workbuddy', 'tmp', `mobile-viewports-331-${stamp}`)
fs.mkdirSync(run, { recursive: true })

/** 规划 §14.6 的视口集合；`full` 表示逐页走 55 个入口，否则只走代表页 */
const VIEWPORTS = [
  { id: '320x568', width: 320, height: 568, full: true, note: '规划最小目标宽度' },
  { id: '360x800', width: 360, height: 800, full: false, note: 'Android 主流' },
  { id: '375x812', width: 375, height: 812, full: true, note: 'iPhone 主流（前一轮只测了它）' },
  { id: '390x844', width: 390, height: 844, full: false, note: 'iPhone 14/15' },
  { id: '430x932', width: 430, height: 932, full: false, note: 'iPhone Plus/Max' },
  { id: '667x375', width: 667, height: 375, full: true, note: '横屏（不等于桌面）' },
  { id: '844x390', width: 844, height: 390, full: true, note: '横屏' },
]

/** 只走代表页时用的入口：表单 / 表格 / 主从卡片 / 图鉴 / 专用页各取一个 */
const SAMPLE_TABS = ['editor', 'char-main', 'org-main', 'item-main', 'foreshadow', 'plot-canvas']

const server = await createServer({ root: process.cwd(), cacheDir: '.workbuddy/tmp/vite-mobile-viewports', logLevel: 'error', server: { host: 'localhost', port: 0 } })
const result = { viewports: [], findings: [], scope: '隔离示范项目；自动判定仅覆盖布局与入口，不含真机/软键盘/IME/文件' }
let browser
try {
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: 'reduce',
    })
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))

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
    // 关掉自动引导，否则每进一个新页签都会被遮罩挡住点击（这是探针便利，不是产品行为）
    await page.evaluate(async () => { (await import('/src/lib/settings/guidePrefs.ts')).setGuideAutoEnabled(false) })

    const allTabs = await page.evaluate(async () => {
      const schema = await import('/src/lib/schema.ts')
      return [schema.EDITOR_TAB, ...schema.TABS.filter(tab => schema.tabVisible(tab.id, { type: 'full', features: [] }))]
        .map(tab => ({ id: tab.id, name: tab.name }))
    })
    const tabs = viewport.full ? allTabs : allTabs.filter(tab => SAMPLE_TABS.includes(tab.id))
    const records = []

    for (const tab of tabs) {
      try {
        await page.getByRole('button', { name: '打开项目菜单' }).click({ timeout: 8000 })
        const nav = page.getByRole('navigation')
        await nav.getByRole('button', { name: tab.name, exact: true }).first().click({ timeout: 8000 })
        await page.waitForTimeout(320)
        // 抽屉关掉后才量几何：抽屉本身占宽，开着量会把「抽屉」当成溢出
        await page.keyboard.press('Escape').catch(() => {})
        await page.waitForTimeout(120)

        const geometry = await page.evaluate(() => {
          const main = document.querySelector('main')
          const rect = main?.getBoundingClientRect()
          const root = document.documentElement
          /**
           * 触摸命中区域抽样，分两类（规划 §14.2「至少 44×44，可通过外层加热区实现，不强迫图标变大」）：
           *   · iconSmall：**纯图标键**（没有可见文字）—— 这是真正需要单独加热区的一类；
           *   · textSmall：有文字的按钮，只是高度偏小（28～32）。文字按钮的可读性优先，
           *     高度问题属同类但不同因，单独计数、不混进图标结论。
           */
          const iconSmall = []
          const textSmall = []
          for (const node of document.querySelectorAll('button')) {
            const box = node.getBoundingClientRect()
            if (box.width === 0 || box.height === 0) continue
            const label = (node.getAttribute('aria-label') || '').trim()
            const text = (node.innerText || '').trim()
            if (!label && !text) continue
            const item = { label: label || text.slice(0, 8), w: Math.round(box.width), h: Math.round(box.height) }
            if (!text && label) {
              if (box.width < 44 || box.height < 44) iconSmall.push(item)
            } else if (box.height < 44) {
              textSmall.push(item)
            }
          }
          return {
            viewport: innerWidth,
            documentWidth: root.scrollWidth,
            overflowX: root.scrollWidth - innerWidth,
            mainWidth: rect ? Math.round(rect.width) : 0,
            mainHeight: rect ? Math.round(rect.height) : 0,
            text: main?.innerText.slice(0, 80) ?? '',
            iconSmallExamples: iconSmall.slice(0, 6),
            iconSmallCount: iconSmall.length,
            textSmallCount: textSmall.length,
          }
        })

        const loading = /正在加载|页面加载失败/.test(geometry.text)
        const ok = geometry.overflowX <= 1 && geometry.mainWidth >= 150 && geometry.mainHeight >= 100
          && !!geometry.text.trim() && !loading
        records.push({ ...tab, ok, ...geometry })
        console.log(`${ok ? 'OK  ' : 'BAD '} ${viewport.id} ${tab.id} ${tab.name} overflow=${geometry.overflowX} main=${geometry.mainWidth}x${geometry.mainHeight}`)
      } catch (error) {
        records.push({ ...tab, ok: false, reason: String(error).slice(0, 220) })
        console.log(`FAIL ${viewport.id} ${tab.id} ${tab.name}`)
        await page.keyboard.press('Escape').catch(() => {})
      }
    }

    const bad = records.filter(record => !record.ok)
    const worstOverflow = records.reduce((max, record) => Math.max(max, record.overflowX ?? 0), 0)
    const iconTotals = records.map(record => record.iconSmallCount ?? 0)
    result.viewports.push({
      ...viewport,
      checked: records.length,
      ok: records.length - bad.length,
      bad: bad.map(record => ({ id: record.id, name: record.name, overflowX: record.overflowX, reason: record.reason })),
      worstOverflow,
      maxIconSmall: Math.max(0, ...iconTotals),
      maxTextSmall: Math.max(0, ...records.map(record => record.textSmallCount ?? 0)),
      iconSmallExamples: records.flatMap(record => (record.iconSmallExamples ?? []).map(item => ({ tab: record.id, ...item }))).slice(0, 15),
      errors: errors.slice(0, 3),
      records,
    })
    if (viewport.id === '320x568') await page.screenshot({ path: path.join(run, '320-editor.png') })
    if (viewport.id === '667x375') await page.screenshot({ path: path.join(run, '667-landscape.png') })
    console.log(`—— ${viewport.id}: ${records.length - bad.length}/${records.length} OK，最大横向溢出 ${worstOverflow}px，纯图标键 <44px 最多 ${Math.max(0, ...iconTotals)} 个/页`)
    await context.close()
  }

  const summary = {
    total: result.viewports.reduce((sum, item) => sum + item.checked, 0),
    ok: result.viewports.reduce((sum, item) => sum + item.ok, 0),
    badViewports: result.viewports.filter(item => item.bad.length > 0).map(item => ({ id: item.id, bad: item.bad.length })),
    worstOverflow: Math.max(0, ...result.viewports.map(item => item.worstOverflow)),
    scope: result.scope,
  }
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ ...result, summary }, null, 2))
  console.log(JSON.stringify({ run, ...summary }))
  if (summary.badViewports.length > 0) process.exitCode = 2
} finally {
  await browser?.close()
  await server.close()
}
