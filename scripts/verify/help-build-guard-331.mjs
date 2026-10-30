// 3.3.1 · P4：手册资源混版本时「停止据此生成 AI 回答 + 给重新加载入口」的实机验证。
//
// 怎么造「旧缓存」：页面里的 meta 由构建注入，改它的 content 就等于让外壳自称旧构建
// —— 与「浏览器留着上一版 index.html、chunk 已是新版」在运行期完全等价。
//
// 为什么要起一个假模型端点：只有数得到「请求有没有发出去」，才能证明是**停止生成**，
// 而不是恰好没配模型 / 恰好没召回。同一个问题先问一次（应发请求），篡改后再问一次（应不发）。
import { createServer as createHttp } from 'node:http'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const run = path.join('.workbuddy', 'tmp', `help-build-guard-331-${new Date().toISOString().replace(/[:.]/g, '-')}`)
fs.mkdirSync(run, { recursive: true })

let pass = 0, fail = 0
const cases = []
const check = (name, cond, extra = '') => {
  cases.push({ name, ok: !!cond, extra })
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- 假模型端点：只负责计数与返回一个「形状正确但内容肯定校验不过」的回答 ----------
const hits = { chat: 0, paths: [] }
const fake = createHttp((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    hits.chat++
    hits.paths.push(req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'probe', object: 'chat.completion', created: Date.now(), model: 'probe',
      // 故意给一个不存在的摘录：校验不过会走回退，但**请求确实发出去了**，这正是我们要数的
      choices: [{ index: 0, message: { role: 'assistant', content: '{"answer":"探针回答","quotes":["这段文字不在手册里"]}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }))
  })
})
await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve))
const fakePort = fake.address().port
const fakeOrigin = `http://127.0.0.1:${fakePort}`

const server = await createServer({
  root, cacheDir: '.workbuddy/tmp/vite-help-build-guard', logLevel: 'error',
  server: { host: 'localhost', port: 0 },
})
let browser
try {
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`

  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => {
    const url = route.request().url()
    if (url.startsWith(origin + '/') || url.startsWith(fakeOrigin)) return route.continue()
    return route.abort()
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))

  await page.goto(origin, { waitUntil: 'domcontentloaded' })

  // 首屏：构建标识真的被注入了
  const metaBuild = await page.locator('meta[name="yfe-help-build"]').getAttribute('content').catch(() => null)
  check('index.html 里有构建标识（由构建注入，不是写死）', !!metaBuild && metaBuild.length >= 3, String(metaBuild))

  // 进示范项目
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 60000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
  const guide = page.locator('[data-guide-card]').first()
  if (await guide.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) {
    await page.getByRole('button', { name: '跳过本页' }).click().catch(() => {})
    await guide.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  }

  /** 配一个可用的「联网」端点（dev 预览非网页形态，本机地址不被 P9 禁用） */
  const seedProvider = (target) => target.evaluate(async (baseUrl) => {
    const open = () => new Promise((resolve, reject) => {
      const request = indexedDB.open('youth-fantasy-engine')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const db = await open()
    const tx = db.transaction('meta', 'readwrite')
    const provider = {
      id: 'probe-fake', name: '探针模型', type: 'openai', baseUrl,
      apiKey: 'sk-probe', model: 'probe', contextWindow: 32768,
    }
    tx.objectStore('meta').put({ key: 'aiProviders', value: [provider] })
    tx.objectStore('meta').put({ key: 'aiActiveProviderId', value: provider.id })
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error) })
    db.close()
  }, `${fakeOrigin}/v1`)
  await seedProvider(page)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByTitle('返回项目列表').waitFor({ timeout: 60000 }).catch(async () => {
    await page.getByRole('button', { name: '打开项目' }).first().click()
    await page.getByTitle('返回项目列表').waitFor({ timeout: 60000 })
  })
  const laterAgain = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await laterAgain.isVisible().catch(() => false)) await laterAgain.click()

  // 打开使用指南 → 切到「问 AI」（默认停在「查手册」，面板不会挂载）
  await page.getByRole('navigation').getByText('使用指南', { exact: true }).first().click()
  const guideCard = page.locator('[data-guide-card]').first()
  if (await guideCard.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) {
    await page.getByRole('button', { name: '跳过本页' }).click().catch(() => {})
    await guideCard.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  }
  const center = page.locator('[data-help-center]').first()
  await center.waitFor({ timeout: 30000 })
  await center.getByRole('button', { name: /问 AI/ }).first().click()
  const panel = page.locator('[data-ask-panel]').first()
  await panel.waitFor({ timeout: 30000 })
  check('基线：答疑面板可见，且没有混版本横幅', await page.locator('[data-help-build-mismatch]').count() === 0)

  // ① 基线提问：应真的发出一次模型请求
  const before = hits.chat
  await panel.getByLabel('向答疑助手提问').fill('字太小怎么放大')
  await panel.getByRole('button', { name: /^提问$/ }).click()
  await panel.locator('text=/依据|不是 AI 回答|没能回答|没能回答|已退回|校验|手册/').first().waitFor({ timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(1200)
  const afterFirst = hits.chat
  check('基线：提问确实打到了模型端点（计数增加）', afterFirst > before, `${before} → ${afterFirst} ${hits.paths.slice(-1)}`)

  // ② 把外壳改成「上一版构建」——等价于网页缓存了旧 index.html
  await page.evaluate(() => {
    const meta = document.querySelector('meta[name="yfe-help-build"]')
    if (meta) meta.setAttribute('content', '3.3.1+20200101000000')
  })

  const beforeSecond = hits.chat
  await panel.getByLabel('向答疑助手提问').fill('字太小怎么放大')
  await panel.getByRole('button', { name: /^提问$/ }).click()
  await page.waitForTimeout(2500)

  check('🔴 混版本时**没有**再请求模型（停止据此生成回答）', hits.chat === beforeSecond,
    `${beforeSecond} → ${hits.chat}`)
  const mismatchBanner = page.locator('[data-help-build-mismatch]').first()
  check('🔴 出现混版本横幅（说清为什么停下）', await mismatchBanner.isVisible().catch(() => false))
  const bannerText = await mismatchBanner.innerText().catch(() => '')
  check('横幅写明「暂停 AI 回答、手册仍可阅读」', /暂停 AI 回答/.test(bannerText) && /仍可正常阅读|仍可阅读/.test(bannerText),
    bannerText.slice(0, 70))
  check('横幅里带「重新加载帮助资源」入口', /重新加载帮助资源/.test(bannerText), bannerText.slice(0, 70))

  const staleText = await panel.innerText()
  check('🔴 回答区说明的是「资源版本不一致」，不是「没配模型」或「手册没写」',
    /版本不一致/.test(staleText) && !/还没有配置可用的 AI 模型/.test(staleText), staleText.slice(-160))
  check('混版本这一轮没有产生模型回答', !/探针回答/.test(staleText))
  await page.screenshot({ path: path.join(run, 'mismatch.png') })

  // ③ 手册文章仍可读（规划：保留可读的匹配版本文章）
  //     🔴 混版本时没有「依据」按钮（根本没生成回答），所以只能走「查手册」这条路。
  await center.getByRole('button', { name: '查手册', exact: true }).first().click().catch(() => {})
  const search = center.getByLabel('搜索使用手册').first()
  await search.fill('界面缩放怎么调')
  await page.waitForTimeout(900)
  // 🔴 只能点**可见**的：切到查手册后，问 AI 面板只是 hidden 仍留在 DOM 里，
  //    里面的示例问题按钮（「字太小怎么放大」）会先被 hasText 命中，导致点到看不见的元素。
  const hit = center.locator('button:visible').filter({ hasText: /界面缩放|字太小/ }).first()
  let articleReadable = false
  if (await hit.count() > 0) {
    await hit.click()
    articleReadable = await center.locator('[data-help-article]').first()
      .waitFor({ timeout: 8000 }).then(() => true).catch(() => false)
  }
  check('🔴 混版本时手册文章仍打得开、读得到（不是把人挡在门外）', articleReadable)
  if (articleReadable) {
    const body = await center.innerText()
    check('读到的正文不是空壳（有实际段落文字）', body.length > 200, `${body.length} 字`)
  }
  await page.screenshot({ path: path.join(run, 'article.png') })

  // ④ 点「重新加载帮助资源」：整页刷新后横幅消失（标识回到同一次构建）
  await page.locator('[data-help-build-mismatch]').getByRole('button', { name: /重新加载帮助资源/ }).first().click()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  await page.getByTitle('返回项目列表').waitFor({ timeout: 60000 }).catch(() => {})
  const skipWizard = page.getByRole('button', { name: /跳过，直接进入项目管理/ })
  if (await skipWizard.isVisible().catch(() => false)) await skipWizard.click()
  await page.getByRole('navigation').getByText('使用指南', { exact: true }).first().click().catch(() => {})
  await page.waitForTimeout(1500)
  check('重新加载后不再报混版本（入口真的解决问题）',
    await page.locator('[data-help-build-mismatch]').count() === 0)
  const metaAfter = await page.locator('meta[name="yfe-help-build"]').getAttribute('content').catch(() => null)
  check('重新加载后外壳标识回到本次构建的值', metaAfter !== '3.3.1+20200101000000' && !!metaAfter, String(metaAfter))

  // ---------- ⑤ 更真实的复现：让服务器「发来旧 HTML」（外壳旧 + chunk 新） ----------
  // 上面是运行期改 meta（能验答疑闸，但组件不会重渲染，查手册页的横幅出不来）。
  // 这里在文档请求上把 meta 改写成旧值，页面**加载时**就是混版本 —— 与网页缓存旧 index.html 等价。
  {
    const staleContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    await staleContext.route('**/*', async route => {
      const url = route.request().url()
      if (url === origin + '/' || url === origin + '/index.html') {
        const response = await route.fetch()
        const body = (await response.text()).replace(
          /name="yfe-help-build" content="[^"]*"/,
          'name="yfe-help-build" content="3.3.1+20200101000000"',
        )
        return route.fulfill({ response, body, headers: { ...response.headers(), 'content-type': 'text/html; charset=utf-8' } })
      }
      if (url.startsWith(origin + '/') || url.startsWith(fakeOrigin)) return route.continue()
      return route.abort()
    })
    const stale = await staleContext.newPage()
    const staleErrors = []
    stale.on('pageerror', error => staleErrors.push(String(error)))
    await stale.goto(origin, { waitUntil: 'domcontentloaded' })

    const servedBuild = await stale.locator('meta[name="yfe-help-build"]').getAttribute('content')
    check('模拟服务器发来旧外壳（meta 是旧构建）', servedBuild === '3.3.1+20200101000000', String(servedBuild))

    await stale.getByRole('button', { name: /先看看示例/ }).click()
    await stale.getByRole('button', { name: '下一步', exact: true }).click()
    await stale.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
    await stale.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
    const laterStale = stale.getByRole('button', { name: '稍后再说', exact: true })
    if (await laterStale.isVisible().catch(() => false)) await laterStale.click()
    await stale.getByRole('navigation').getByText('使用指南', { exact: true }).first().click()
    const staleGuide = stale.locator('[data-guide-card]').first()
    if (await staleGuide.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) {
      await stale.getByRole('button', { name: '跳过本页' }).click().catch(() => {})
      await staleGuide.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    }

    const staleCenter = stale.locator('[data-help-center]').first()
    await staleCenter.waitFor({ timeout: 30000 })
    check('🔴 加载即混版本：查手册页一进来就有横幅（不用先提问才看见）',
      await staleCenter.locator('[data-help-build-mismatch]').first().isVisible().catch(() => false))
    const centerText = await staleCenter.innerText()
    check('查手册页横幅也承诺「文章仍可阅读」并给入口',
      /仍可阅读/.test(centerText) && /重新加载帮助资源/.test(centerText), centerText.slice(0, 90))
    await stale.screenshot({ path: path.join(run, 'center-mismatch.png') })

    await seedProvider(stale)
    await stale.reload({ waitUntil: 'domcontentloaded' })
    await stale.getByTitle('返回项目列表').waitFor({ timeout: 90000 }).catch(async () => {
      await stale.getByRole('button', { name: '打开项目' }).first().click()
      await stale.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
    })
    const laterStale2 = stale.getByRole('button', { name: '稍后再说', exact: true })
    if (await laterStale2.isVisible().catch(() => false)) await laterStale2.click()
    await stale.getByRole('navigation').getByText('使用指南', { exact: true }).first().click()
    const staleCenter2 = stale.locator('[data-help-center]').first()
    await staleCenter2.waitFor({ timeout: 30000 })
    await staleCenter2.getByRole('button', { name: /问 AI/ }).first().click()
    const stalePanel = stale.locator('[data-ask-panel]').first()
    await stalePanel.waitFor({ timeout: 30000 })
    const beforeStale = hits.chat
    await stalePanel.getByLabel('向答疑助手提问').fill('字太小怎么放大')
    await stalePanel.getByRole('button', { name: /^提问$/ }).click()
    await stale.waitForTimeout(2500)
    check('🔴 旧外壳下提问也不请求模型（两次独立复现，判据一致）', hits.chat === beforeStale,
      `${beforeStale} → ${hits.chat}`)
    check('旧外壳下答案区同样是「版本不一致」措辞',
      /版本不一致/.test(await stalePanel.innerText()))
    check('旧外壳这一路也没有页面脚本错误', staleErrors.length === 0, staleErrors.slice(0, 2).join(' | '))
    await staleContext.close()
  }

  check('全程没有页面脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '))
} finally {
  await browser?.close()
  await server.close()
  await new Promise(resolve => fake.close(resolve))
}

const summary = { passed: pass, failed: fail, cases, fakeChatCalls: hits.chat, run }
fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify(summary, null, 2))
console.log(`\n结果：${pass}/${pass + fail} 通过，记录在 ${run}`)
if (fail > 0) process.exitCode = 1
