// 3.3.4 · P0 基线探针（规划 §3.1 / §3.3 / §10.4）
//
// 一次跑完 P0 的四件事，产物可复现、可对比：
//   ① 页面清单：从**运行期** schema 取全部页签（含自定义项目才有的），列出 id / 名称 / 分组 / 类型，
//      不写死表 —— 3.3.1 的清单已经过期，本版必须以实际生成结果为准（规划 §2 末段）。
//   ② 三宽度全页几何：320×568 / 375×667 / 430×932 逐页，量根横向溢出（判据 ≤1px）、主区几何、
//      是否停在加载态，并给每页留截图。
//   ③ 触摸命中盒：粗指针环境下逐页量**真实可点击元素**的矩形，列出 <44×44 的清单（规划 §3.2/§3.3）。
//      不做交互点击验证 —— 那是 S-05 的事，这里只出盘点，避免把「几何达标」说成「点得中」。
//   ④ 阈值边界：519/520/521 与 899/900/901 连续三档量导航形态，防阈值振荡与重复折算（规划 §3.1-3）。
//
// 明确不做：真机、软键盘、中文 IME、旋转、后台回收、UI 缩放档位（另列 S-06/S-07/S-09 待验）。
// 只读：不填数据、不保存、不发模型请求；所有外部请求一律 abort。
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const run = path.join(root, '.workbuddy/tmp', `mobile-p0-334-${stamp}`)
await fs.mkdir(run, { recursive: true })

/** 规划 §3.3 的三个验收宽度；320 是布局最小测试宽度，不绑定机型 */
const VIEWPORTS = [
  { id: '320x568', width: 320, height: 568 },
  { id: '375x667', width: 375, height: 667 },
  { id: '430x932', width: 430, height: 932 },
]

/** 导航 compact 口径 <900 的边界（规划 §3.1-2 保留现有口径） */
const NAV_EDGES = [519, 520, 521, 899, 900, 901]

const report = {
  kind: 'mobile-p0-334',
  at: new Date().toISOString(),
  fingerprint: snapshot(root).fingerprint,
  tabs: [],
  viewports: [],
  edges: [],
  errors: [],
  status: 'running',
}

const measurePage = (page) => page.evaluate(() => {
  const rootEl = document.documentElement
  const main = document.querySelector('main')
  const rect = main?.getBoundingClientRect()

  /**
   * 溢出元凶只留「最外层」那一个：父元素没溢出、自己溢出，才是真正把页面撑宽的节点。
   * 这样一份清单能直接当修复清单用，不必逐层看几十个子孙。
   */
  const offenders = []
  for (const el of document.querySelectorAll('body *')) {
    const box = el.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) continue
    if (box.right <= innerWidth + 1) continue
    const parentBox = el.parentElement?.getBoundingClientRect()
    if (parentBox && parentBox.right > innerWidth + 1) continue
    offenders.push({
      tag: el.tagName.toLowerCase(),
      selector: (el.className && typeof el.className === 'string' ? el.className : '').slice(0, 70) || el.getAttribute('data-testid') || '',
      right: Math.round(box.right),
      width: Math.round(box.width),
      text: (el.textContent || '').trim().slice(0, 30),
    })
  }

  /**
   * 命中盒盘点。只收「实际可点」的元素：可见、未禁用、有可访问名。
   * · native checkbox/radio 允许靠关联 label 扩大点击区（规划 §10.2-2）⇒ 单独归类，不计入按钮判据但列出。
   * · 装饰图标、非交互正文不纳入 ⇒ 只查 button / [role=button] / a[href] / 表单控件 / summary。
   *
   * 🔴 必须分层：规划 §3.3 的 44×44 硬判据只针对「主要写作 / 保存 / 同步 / 关闭 / 导航 / 行操作」。
   *   把表格行内单元格输入（每页几百个）与上面这些放进同一个数，就会得出「1223 个不达标」
   *   这种既吓人又没法排期的结论 —— 而实际要分三档处理（关键交互立即达标 / 表格内靠行高 /
   *   次要工具栏可留小尺寸但加热区）。
   */
  const CRITICAL = /保存|同步|关闭|取消|确认|确定|删除|新增|打开项目菜单|界面与数据设置|撤销|恢复|编辑工具|专注模式|继续写作|登录|退出|返回|上一章|下一章|行操作/
  const SELECTOR = 'button, [role="button"], a[href], input, select, textarea, summary'
  const targets = []
  for (const el of document.querySelectorAll(SELECTOR)) {
    const box = el.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) continue
    if (el.closest('[aria-hidden="true"]')) continue
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') continue
    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true'
    if (disabled) continue
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim()
    if (!label && !el.getAttribute('placeholder')) continue
    const tag = el.tagName.toLowerCase()
    const type = (el.getAttribute('type') || '').toLowerCase()
    const kind = tag === 'input' && (type === 'checkbox' || type === 'radio')
      ? 'check'
      : tag === 'button' || el.getAttribute('role') === 'button'
        ? (label ? 'button' : 'button-blank')
        : tag === 'a' ? 'link'
          : tag === 'textarea' ? 'textarea'
            : tag === 'select' ? 'select'
              : tag === 'input' ? 'input'
                : 'other'
    // 分档：表格内（含行内编辑框、下拉）→ table；关键动作 → critical；其余 → chrome
    const bucket = el.closest('table') ? 'table'
      : CRITICAL.test(label) ? 'critical'
        : 'chrome'
    /**
     * 🔴 视觉盒 ≠ 命中盒。项目从 3.3.1 起给图标键加了 `::after` 热区
     *    （`index.css` 的 `@media (hover:none) and (pointer:coarse)`，宽高 `max(100%,44px)`），
     *    视觉仍是 32×32。这里必须取「生效命中盒」再判 44，否则会把已经达标的图标键
     *    全算成缺陷（首轮就是这样误报了 94%）。
     */
    const after = getComputedStyle(el, '::after')
    const hasAfter = !!after && after.content !== 'none' && after.content !== 'normal' && after.position !== 'static'
    const afterW = hasAfter ? (parseFloat(after.width) || 0) : 0
    const afterH = hasAfter ? (parseFloat(after.height) || 0) : 0
    const hitW = Math.max(box.width, afterW)
    const hitH = Math.max(box.height, afterH)
    targets.push({
      kind,
      bucket,
      tag,
      w: Math.round(box.width * 10) / 10,
      h: Math.round(box.height * 10) / 10,
      hitW: Math.round(hitW * 10) / 10,
      hitH: Math.round(hitH * 10) / 10,
      viaAfter: hasAfter,
      label: label.slice(0, 24),
    })
  }
  const measurable = targets.filter(t => t.kind !== 'check')
  const isSmall = (t) => t.hitW < 44 || t.hitH < 44
  const small = measurable.filter(isSmall)
  const tally = (list) => ({
    total: list.length,
    small: list.filter(isSmall).length,
    // 视觉小于 44 但命中达标（靠 ::after 热区）—— 单独记账，别混进缺陷
    visualSmallButHitOk: list.filter(t => (t.w < 44 || t.h < 44) && !isSmall(t)).length,
  })

  return {
    viewportWidth: innerWidth,
    zoom: (() => {
      // UI 缩放写在 body/根上的 CSS zoom；布局坐标已含它，不再二次折算（规划 §3.1-3）
      const z = getComputedStyle(document.body).zoom
      return z === 'normal' ? 1 : Number(z) || 1
    })(),
    documentWidth: rootEl.scrollWidth,
    overflowX: rootEl.scrollWidth - innerWidth,
    main: rect ? { width: Math.round(rect.width), height: Math.round(rect.height), left: Math.round(rect.left) } : null,
    text: (main?.innerText || '').slice(0, 120),
    offenders: offenders.slice(0, 8),
    // 确认上下文真的是触点设备：热区只在 hover:none + pointer:coarse 下生效，
    // 这条不真，下面的「命中达标」就是假的
    coarse: matchMedia('(pointer: coarse)').matches,
    hoverNone: matchMedia('(hover: none)').matches,
    hitTotal: measurable.length,
    hitBuckets: {
      critical: tally(measurable.filter(t => t.bucket === 'critical')),
      table: tally(measurable.filter(t => t.bucket === 'table')),
      chrome: tally(measurable.filter(t => t.bucket === 'chrome')),
    },
    // 关键动作不达标要**逐条**留证（可排期）；表格内与次要工具栏只需计数 + 样本
    hitCriticalSmall: small.filter(t => t.bucket === 'critical'),
    hitSmall: small.filter(t => t.bucket !== 'critical').slice(0, 12),
    hitSmallCount: small.length,
  }
})

let server, browser
try {
  server = await createServer({ root, cacheDir: path.join(run, 'vite-cache'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })

  /** 进示例项目并关掉自动引导（探针便利，不代表产品行为） */
  const enterDemo = async (page) => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /先看看示例/ }).click({ timeout: 60000 })
    await page.getByRole('button', { name: '下一步', exact: true }).click({ timeout: 30000 })
    await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click({ timeout: 30000 })
    await page.getByText('继续写作', { exact: true }).first().waitFor({ timeout: 120000 })
    const later = page.getByRole('button', { name: '稍后再说', exact: true })
    if (await later.isVisible().catch(() => false)) await later.click()
    const guide = page.locator('[data-guide-card]').first()
    if (await guide.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) {
      await page.getByRole('button', { name: '跳过本页' }).click().catch(() => {})
      await guide.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    }
    await page.evaluate(async () => { (await import('/src/lib/settings/guidePrefs.ts')).setGuideAutoEnabled(false) })
  }

  const openTab = async (page, tab) => {
    await page.getByRole('button', { name: '打开项目菜单' }).click({ timeout: 10000 })
    const nav = page.getByRole('navigation')
    await nav.getByRole('button', { name: tab.name, exact: true }).first().click({ timeout: 10000 })
    await page.waitForTimeout(320)
    // 抽屉占宽，开着量会把抽屉本身当溢出 ⇒ 先关再量
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(120)
  }

  // ——— ① 页签清单（只取一次，各视口共用）———
  const firstContext = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: 'reduce' })
  await firstContext.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  const firstPage = await firstContext.newPage()
  firstPage.on('pageerror', error => report.errors.push(String(error)))
  await enterDemo(firstPage)
  report.tabs = await firstPage.evaluate(async () => {
    const schema = await import('/src/lib/schema.ts')
    const visible = schema.TABS.filter(tab => schema.tabVisible(tab.id, { type: 'full', features: [] }))
    return [schema.EDITOR_TAB, ...visible].map(tab => ({
      id: tab.id,
      name: tab.name,
      group: tab.group,
      type: tab.type,
      description: (tab.description || '').slice(0, 60),
    }))
  })
  report.tabCount = { editor: 1, staticTabs: report.tabs.length - 1, total: report.tabs.length }
  console.log(`页签清单：${report.tabs.length} 个（正文编辑 1 + 静态 ${report.tabs.length - 1}）`)
  await firstContext.close()

  // ——— ②③ 三宽度全页：溢出 + 命中盒 + 截图 ———
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: 'reduce',
    })
    await context.route('**/*', route => {
      const url = route.request().url()
      if (!url.startsWith(origin + '/')) return route.abort()
      if (/\/chat\/completions|\/api\/ai(?:\/|$)/.test(url)) report.errors.push(`意外模型请求：${url}`)
      return route.continue()
    })
    const page = await context.newPage()
    page.on('pageerror', error => report.errors.push(`${viewport.id}: ${error.message}`))
    await enterDemo(page)
    const shotDir = path.join(run, viewport.id)
    await fs.mkdir(shotDir, { recursive: true })

    const records = []
    for (const tab of report.tabs) {
      try {
        await openTab(page, tab)
        const geometry = await measurePage(page)
        await page.screenshot({ path: path.join(shotDir, `${tab.id}.png`) })
        const loading = /正在加载|页面加载失败/.test(geometry.text)
        const ok = geometry.overflowX <= 1 && !!geometry.text.trim() && !loading
          && (geometry.main?.width ?? 0) >= 150 && (geometry.main?.height ?? 0) >= 100
        records.push({ ...tab, ok, loading, ...geometry })
        const flag = ok ? 'OK  ' : 'BAD '
        console.log(`${flag} ${viewport.id} ${tab.id} 溢出=${geometry.overflowX} 主区=${geometry.main?.width}x${geometry.main?.height} 小目标=${geometry.hitSmallCount}/${geometry.hitTotal}`)
      } catch (error) {
        records.push({ ...tab, ok: false, reason: String(error).slice(0, 200) })
        console.log(`FAIL ${viewport.id} ${tab.id} ${String(error).slice(0, 120)}`)
        await page.keyboard.press('Escape').catch(() => {})
      }
    }

    report.viewports.push({
      ...viewport,
      checked: records.length,
      ok: records.filter(record => record.ok).length,
      bad: records.filter(record => !record.ok).map(record => ({ id: record.id, name: record.name, overflowX: record.overflowX, loading: record.loading, reason: record.reason })),
      worstOverflow: Math.max(0, ...records.map(record => record.overflowX ?? 0)),
      overflowPages: records.filter(record => (record.overflowX ?? 0) > 1).map(record => ({ id: record.id, name: record.name, overflowX: record.overflowX, offenders: record.offenders })),
      hit: (() => {
        const sum = (bucket) => records.reduce((acc, record) => {
          const item = record.hitBuckets?.[bucket]
          return { total: acc.total + (item?.total ?? 0), small: acc.small + (item?.small ?? 0) }
        }, { total: 0, small: 0 })
        const critical = records.flatMap(record => (record.hitCriticalSmall ?? []).map(item => ({ tab: record.id, ...item })))
        return {
          buckets: { critical: sum('critical'), table: sum('table'), chrome: sum('chrome') },
          criticalSmallTotal: critical.length,
          criticalSmallByLabel: [...new Set(critical.map(item => item.label))].slice(0, 40),
          criticalSmall: critical,
          pages: records
            .map(record => ({ id: record.id, critical: record.hitBuckets?.critical, table: record.hitBuckets?.table, chrome: record.hitBuckets?.chrome }))
            .filter(page => (page.critical?.small ?? 0) > 0),
          samples: records.flatMap(record => (record.hitSmall ?? []).map(item => ({ tab: record.id, ...item }))).slice(0, 30),
        }
      })(),
      records,
    })
    console.log(`—— ${viewport.id}: ${records.filter(record => record.ok).length}/${records.length} 通过，最大溢出 ${Math.max(0, ...records.map(record => record.overflowX ?? 0))}px`)
    await context.close()
  }

  // ——— ④ 阈值边界：导航形态 + 内容断点，防阈值振荡与重复折算（规划 §3.1-3）———
  for (const width of NAV_EDGES) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: 'reduce' })
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
    const page = await context.newPage()
    page.on('pageerror', error => report.errors.push(`edge${width}: ${error.message}`))
    await enterDemo(page)
    const shape = await page.evaluate(() => {
      const nav = document.querySelector('nav')
      const box = nav?.getBoundingClientRect()
      const toggle = [...document.querySelectorAll('button')].find(node => (node.getAttribute('aria-label') || '') === '打开项目菜单')
      return {
        innerWidth,
        bodyZoom: getComputedStyle(document.body).zoom,
        inlineNavWidth: nav ? Math.round(box.width) : 0,
        navVisible: !!nav && (box?.width ?? 0) > 0,
        drawerToggle: !!toggle && (toggle.getBoundingClientRect().width > 0),
        mainWidth: Math.round(document.querySelector('main')?.getBoundingClientRect().width ?? 0),
        documentWidth: document.documentElement.scrollWidth,
      }
    })

    /**
     * 内容断点：打开《作品信息》，量字段网格「标签与值是并排还是上下」。
     * 这条断点来自容器查询（`@min-[32rem]/fields`），不是 window 宽度 —— 所以
     * 519/520/521 三档**理应完全一致**；若不一致，就是有人在别处又按 window 算了一次。
     */
    let fieldShape = null
    try {
      if (shape.drawerToggle) {
        await page.getByRole('button', { name: '打开项目菜单' }).click({ timeout: 8000 })
        await page.getByRole('navigation').getByRole('button', { name: '作品信息', exact: true }).first().click({ timeout: 8000 })
        await page.keyboard.press('Escape').catch(() => {})
      } else {
        await page.getByRole('navigation').getByRole('button', { name: '作品信息', exact: true }).first().click({ timeout: 8000 })
      }
      await page.waitForTimeout(400)
      fieldShape = await page.evaluate(() => {
        const grid = document.querySelector('[class*="@container/fields"]')
        if (!grid) return null
        const row = grid.querySelector('section div > div')
        const rowTemplate = row ? getComputedStyle(row).gridTemplateColumns : ''
        return {
          containerWidth: Math.round(grid.getBoundingClientRect().width),
          gridColumns: (getComputedStyle(grid).gridTemplateColumns || '').split(' ').filter(Boolean).length,
          fieldRowColumns: (rowTemplate || '').split(' ').filter(Boolean).length,
          fieldRowTemplate: rowTemplate.slice(0, 60),
          overflowX: document.documentElement.scrollWidth - innerWidth,
        }
      })
    } catch (error) {
      fieldShape = { error: String(error).slice(0, 120) }
    }

    report.edges.push({ width, ...shape, fields: fieldShape })
    console.log(`边界 ${width}: nav=${shape.navVisible ? shape.inlineNavWidth : '抽屉'}(${shape.drawerToggle ? '有切换键' : '无切换键'}) 主区=${shape.mainWidth} 文档宽=${shape.documentWidth} 字段列=${fieldShape?.fieldRowColumns ?? '?'} 容器=${fieldShape?.containerWidth ?? '?'}`)
    await context.close()
  }

  report.status = 'complete'
  await fs.writeFile(path.join(run, 'result.json'), JSON.stringify(report, null, 2))
  await fs.writeFile(path.join(run, 'inventory.json'), JSON.stringify({ fingerprint: report.fingerprint, tabs: report.tabs }, null, 2))
  console.log(JSON.stringify({
    run,
    fingerprint: report.fingerprint,
    tabs: report.tabCount,
    viewports: report.viewports.map(item => ({ id: item.id, ok: item.ok, checked: item.checked, worstOverflow: item.worstOverflow, bad: item.bad.length, smallTargets: item.hit.smallTotal })),
    edges: report.edges,
  }, null, 2))
} catch (error) {
  report.status = 'failed'
  report.failure = String(error?.stack || error)
  await fs.writeFile(path.join(run, 'result.json'), JSON.stringify(report, null, 2)).catch(() => {})
  console.error('FAILED', error)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  await server?.close().catch(() => {})
}
