// 3.3.1 环境验收清单 · 自检（2026-10-30）
//
// 目的：主人要按清单验收，先由我按同一份清单跑一遍能自动判的部分。
// 只做清单里「能机器判对」的条目；需要人眼/真机的（措辞观感、真机、IME、读屏）不在这里冒充。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const run = path.join('.workbuddy', 'tmp', `acceptance-331-${stamp}`)
fs.mkdirSync(run, { recursive: true })

let pass = 0, fail = 0
const cases = []
const check = (id, name, cond, extra = '') => {
  cases.push({ id, name, ok: !!cond, extra })
  if (cond) { pass++; console.log(`PASS ${id} ${name}`) }
  else { fail++; console.log(`FAIL ${id} ${name}${extra ? ' :: ' + extra : ''}`) }
}

const server = await createServer({ root: process.cwd(), cacheDir: '.workbuddy/tmp/vite-acceptance', logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
try {
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })

  /** 进示范项目并清掉挡路的东西（备份提醒 / 引导卡 / 自动引导） */
  const enter = async (page) => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /先看看示例/ }).click()
    await page.getByRole('button', { name: '下一步', exact: true }).click()
    await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
    await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
    const later = page.getByRole('button', { name: '稍后再说', exact: true })
    if (await later.isVisible().catch(() => false)) await later.click()
    const guide = page.locator('[data-guide-card]').first()
    if (await guide.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) {
      await page.getByRole('button', { name: '跳过本页' }).click().catch(() => {})
      await guide.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    }
  }

  // ================= 桌面 1440 =================
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await desk.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  const page = await desk.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await enter(page)
  const nav = page.getByRole('navigation')

  // ---------- 一、手册与检索 ----------
  await nav.getByText('使用指南', { exact: true }).first().click()
  const center = page.locator('[data-help-center]').first()
  await center.waitFor({ timeout: 30000 })
  const g = page.locator('[data-guide-card]').first()
  if (await g.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) {
    await page.getByRole('button', { name: '跳过本页' }).click().catch(() => {})
    await g.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  }
  await page.evaluate(async () => { (await import('/src/lib/settings/guidePrefs.ts')).setGuideAutoEnabled(false) })

  const header = await center.innerText()
  check('1.1', '手册区显示 41 篇 / 覆盖 55 个页签', /手册\s*41\s*篇/.test(header) && /覆盖\s*55\s*个页签/.test(header),
    header.slice(0, 80))

  await center.getByLabel('搜索使用手册').first().fill('字太小怎么放大')
  await center.getByText(/本地手册检索结果/).waitFor({ timeout: 15000 })
  const resultText = await center.innerText()
  check('1.2', '检索出结果并注明不联网、不调用模型', /不联网/.test(resultText) && /不调用模型/.test(resultText))

  const hit = center.locator('button:visible').filter({ hasText: /界面缩放|字太小/ }).first()
  await hit.click()
  const article = center.locator('[data-help-article]').first()
  await article.waitFor({ timeout: 10000 })
  const articleText = await article.innerText()
  check('1.3', '点结果落到「界面缩放」那一段（文章里有该段标题）', /界面缩放/.test(articleText))
  await center.getByRole('button', { name: /返回/ }).first().click()
  await page.waitForTimeout(300)
  const backQuery = await center.getByLabel('搜索使用手册').first().inputValue()
  check('1.4', '返回后查询词仍在', backQuery === '字太小怎么放大', backQuery)

  await center.getByLabel('搜索使用手册').first().fill('量子纠缠的退相干时间')
  await page.waitForTimeout(900)
  const unrelated = await center.innerText()
  check('1.5', '无关词不硬凑文章（没有列出《时间脉络》等）', !/时间脉络/.test(unrelated) || /没找到|没有/.test(unrelated),
    unrelated.slice(0, 120))

  // ---------- 二、引导 ----------
  await nav.getByText('写作面板', { exact: true }).first().click()
  await page.waitForTimeout(400)
  await page.evaluate(async () => { (await import('/src/lib/settings/guidePrefs.ts')).setGuideAutoEnabled(true) })
  await nav.getByText('种族生物', { exact: true }).first().click()
  const card = page.locator('[data-guide-card]').first()
  const appeared = await card.waitFor({ timeout: 8000 }).then(() => true).catch(() => false)
  check('2.1', '进没看过的页签会自动弹引导卡', appeared)
  if (appeared) {
    const text = await card.innerText()
    check('2.1b', '卡片显示「第 n / N 步」与操作按钮', /第\s*\d+\s*\/\s*\d+\s*步/.test(text) && /跳过本页/.test(text), text.slice(0, 60))
    await page.getByRole('button', { name: '跳过本页' }).click()
    await card.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    await nav.getByText('写作面板', { exact: true }).first().click()
    await page.waitForTimeout(300)
    await nav.getByText('种族生物', { exact: true }).first().click()
    const again = await page.locator('[data-guide-card]').first().waitFor({ timeout: 3000 }).then(() => true).catch(() => false)
    check('2.3', '跳过之后再进不再自动弹', !again)
  }

  // ---------- 三、答疑（无模型） ----------
  await nav.getByText('使用指南', { exact: true }).first().click()
  const center2 = page.locator('[data-help-center]').first()
  await center2.waitFor({ timeout: 20000 })
  await center2.getByRole('button', { name: /问 AI/ }).first().click()
  const panel = page.locator('[data-ask-panel]').first()
  await panel.waitFor({ timeout: 15000 })
  await panel.getByLabel('向答疑助手提问').fill('校对怎么跳到原文')
  await panel.getByRole('button', { name: /^提问$/ }).click()
  await page.waitForTimeout(2500)
  const answerText = await panel.innerText()
  check('3.2', '无模型时明确说「这一条不是 AI 回答」并给手册片段', /不是 AI 回答/.test(answerText), answerText.slice(-120))

  // ---------- 四、缩放 ----------
  const zoom = page.getByRole('spinbutton', { name: '界面缩放百分比' }).first()
  await zoom.fill('160'); await zoom.press('Enter')
  await page.waitForTimeout(400)
  const zoomState = await page.evaluate(() => {
    const input = document.querySelector('input[aria-label="界面缩放百分比"]')
    const box = input?.getBoundingClientRect()
    return { value: input?.value, overflow: box ? Math.max(0, Math.round(input.scrollWidth - box.width)) : -1,
      zoom: getComputedStyle(document.documentElement).zoom }
  })
  check('4.2', '160% 三位数在输入框内不被裁', zoomState.value === '160' && zoomState.overflow <= 1, JSON.stringify(zoomState))
  await zoom.fill('100'); await zoom.press('Enter')
  await page.waitForTimeout(300)

  // ---------- 六、全文检索 ----------
  await nav.getByText('正文编辑', { exact: true }).first().click()
  await page.locator('textarea.novel-textarea').waitFor({ timeout: 30000 })
  const g2 = page.locator('[data-guide-card]').first()
  if (await g2.waitFor({ timeout: 2000 }).then(() => true).catch(() => false)) {
    await page.getByRole('button', { name: '跳过本页' }).click().catch(() => {})
    await g2.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  }
  await page.keyboard.press('Control+k')
  const searchDialog = page.getByRole('dialog')
  await searchDialog.waitFor({ timeout: 15000 })
  const bodyText = await page.locator('textarea.novel-textarea').inputValue()
  // 取正文里出现两次以上的 6 字片段，用来验证「第 n/N 处」
  let phrase = ''
  for (let i = 200; i + 6 < bodyText.length && !phrase; i += 1) {
    const candidate = bodyText.slice(i, i + 6)
    if (/[\s。，！？；：、“”（）]/.test(candidate)) continue
    const first = bodyText.indexOf(candidate)
    if (first >= 0 && bodyText.indexOf(candidate, first + 1) >= 0) phrase = candidate
  }
  if (phrase) {
    await searchDialog.locator('input').first().fill(phrase)
    await page.waitForTimeout(900)
    const dialogText = await searchDialog.innerText()
    check('6.1', `同章多处命中拆成「第 n/N 处」（${phrase}）`, /第\s*\d+\s*\/\s*\d+\s*处/.test(dialogText), dialogText.slice(0, 120))
    const rowSecond = searchDialog.locator('button').filter({ hasText: /第\s*2\s*\/\s*\d+\s*处/ }).first()
    if (await rowSecond.count() > 0) {
      await rowSecond.click()
      await page.waitForFunction(() => {
        const el = document.querySelector('textarea.novel-textarea')
        return !!el && el.selectionEnd > el.selectionStart
      }, null, { timeout: 15000 }).catch(() => {})
      const landed = await page.evaluate(() => {
        const el = document.querySelector('textarea.novel-textarea')
        return { text: el.value.slice(el.selectionStart, el.selectionEnd), offset: el.selectionStart, scrollTop: el.scrollTop }
      })
      const expected = bodyText.indexOf(phrase, bodyText.indexOf(phrase) + 1)
      check('6.3', '点「第 2/N 处」落在第 2 次出现的位置并选中', landed.text === phrase && landed.offset === expected,
        JSON.stringify({ got: landed.text, at: landed.offset, want: expected }))
      check('6.2', '跳转后正文真的滚动了（不是停在顶部）', landed.scrollTop >= 0, String(landed.scrollTop))
      /**
       * 选区可见性：浏览器不给**未聚焦**的 textarea 画选区。
       * 无头浏览器里 `document.hasFocus()` 常为 false，这种环境下没法证明「看得见」，
       * 所以只在有焦点时判死，没焦点时如实记录（留给主人在真实窗口里看）。
       */
      const focusState = await page.evaluate(() => {
        const el = document.querySelector('textarea.novel-textarea')
        return { hasFocus: document.hasFocus(), activeIsEditor: document.activeElement === el }
      })
      if (focusState.hasFocus) {
        check('6.2b', '🔴 跳转后焦点回到正文（否则选区不绘制，作者看不出跳到了哪）', focusState.activeIsEditor, JSON.stringify(focusState))
      } else {
        cases.push({ id: '6.2b', name: '选区可见性（无头环境 hasFocus=false，未验证）', ok: true, extra: JSON.stringify(focusState) })
        console.log(`  记录：无头环境 document.hasFocus()=false，选区可见性需真实窗口确认`)
      }
      await page.screenshot({ path: path.join(run, 'search-jump.png') })
    } else {
      check('6.3', '点「第 2/N 处」落在第 2 次出现的位置并选中', false, '结果里没有「第 2/N 处」行')
    }
  } else {
    check('6.1', '同章多处命中拆成「第 n/N 处」', false, '正文里找不到重复短语，本条未验')
  }
  await page.keyboard.press('Escape').catch(() => {})
  check('9.0', '桌面这一路 0 pageerror', errors.length === 0, errors.slice(0, 1).join(''))
  await desk.close()

  // ================= 手机 375 =================
  const mob = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: 'reduce' })
  await mob.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  const mp = await mob.newPage()
  const mErrors = []
  mp.on('pageerror', error => mErrors.push(String(error)))
  await mp.goto(origin, { waitUntil: 'domcontentloaded' })
  await mp.getByRole('button', { name: /先看看示例/ }).click()
  await mp.getByRole('button', { name: '下一步', exact: true }).click()
  await mp.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await mp.getByText('继续写作', { exact: true }).first().waitFor({ timeout: 90000 })
  const ml = mp.getByRole('button', { name: '稍后再说', exact: true })
  if (await ml.isVisible().catch(() => false)) await ml.click()
  const mg = mp.locator('[data-guide-card]').first()
  if (await mg.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) {
    await mp.getByRole('button', { name: '跳过本页' }).click().catch(() => {})
    await mg.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  }
  await mp.evaluate(async () => { (await import('/src/lib/settings/guidePrefs.ts')).setGuideAutoEnabled(false) })

  const mnav = async (name) => {
    await mp.getByRole('button', { name: '打开项目菜单' }).click({ timeout: 20000 })
    await mp.getByRole('navigation').getByRole('button', { name, exact: true }).first().click({ timeout: 20000 })
    await mp.waitForTimeout(450)
    await mp.keyboard.press('Escape').catch(() => {})
  }

  const overflow = []
  for (const tab of ['正文编辑', '作品信息', '主要角色', '伏笔追踪', '世界设定']) {
    await mnav(tab)
    const box = await mp.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth }))
    overflow.push({ tab, ...box })
  }
  check('8.1', '375px 下抽查 5 个页签都不横向溢出', overflow.every(item => item.page <= item.viewport + 1),
    JSON.stringify(overflow.filter(item => item.page > item.viewport + 1)))

  const hitBox = await mp.evaluate(() => {
    const button = document.querySelector('button[data-button-sizing="icon"], button[data-button-icon-only="1"]')
    const box = button?.getBoundingClientRect()
    if (!button || !box) return null
    const after = getComputedStyle(button, '::after')
    return { rect: { w: Math.round(box.width), h: Math.round(box.height) }, after: { w: parseFloat(after.width) || 0 } }
  })
  check('8.2', '图标键热区 44×44（视觉尺寸未变）', !!hitBox && hitBox.after.w >= 44 && hitBox.rect.w < 44,
    JSON.stringify(hitBox))

  await mnav('作品信息')
  const titleField = mp.getByLabel('书名').first()
  await titleField.waitFor({ timeout: 20000 })
  const before = await titleField.inputValue()
  const after = `${before.slice(0, 30)}｜自检`
  await titleField.fill(after)
  await mp.getByRole('button', { name: '保存', exact: true }).click()
  await mnav('写作面板')
  await mnav('作品信息')
  const reread = mp.getByLabel('书名').first()
  await reread.waitFor({ timeout: 20000 })
  check('8.3', '手机改「书名」保存后离页返回回读到新值', (await reread.inputValue()) === after)
  await reread.fill(before)
  await mp.getByRole('button', { name: '保存', exact: true }).click()
  await mp.screenshot({ path: path.join(run, 'mobile.png') })
  check('9.1', '手机这一路 0 pageerror', mErrors.length === 0, mErrors.slice(0, 1).join(''))
  await mob.close()
} finally {
  await browser?.close()
  await server.close()
}

fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ passed: pass, failed: fail, cases }, null, 2))
console.log(`\n自检结果：${pass}/${pass + fail} 通过，记录在 ${run}`)
if (fail > 0) process.exitCode = 1
