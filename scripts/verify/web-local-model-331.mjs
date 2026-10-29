// P9 · 网页版统一禁用本机模型（3.3.1，主人 2026-10-30 定案）实机验证
//
// 验的是「禁用真的禁住」而不是「藏了按钮」：
//   ① 网页形态（注入 __YFE_WEB__）：本机配置带徽标、设为当前/测试禁用、添加入口禁用并给说明、
//      用途下拉里没有它；
//   ② 同一份数据在**非网页形态**（开发预览不注入）：一切照旧，什么都不被禁 —— 桌面/便携不受影响。
//
// 🔴 只放行本站请求，不连任何真实模型。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const run = path.join('.workbuddy/tmp', `web-local-model-331-${new Date().toISOString().replace(/[:.]/g, '-')}`)
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

/** 本机 Ollama 配置（网页版应被禁用） */
const LOCAL_PROVIDER = {
  id: 'probe-local', name: '探针本机模型', type: 'ollama',
  baseUrl: 'http://127.0.0.1:11434', apiKey: '', model: 'probe-model:latest', contextWindow: 32768,
}
/** 联网配置（两种形态都可用）—— 设为当前的是它，本机那条才会显示可点的「设为当前」 */
const REMOTE_PROVIDER = {
  id: 'probe-remote', name: '探针联网模型', type: 'openai',
  baseUrl: 'https://api.example.com/v1', apiKey: 'sk-probe-not-used', model: 'probe-remote', contextWindow: 32768,
}

let browser
try {
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })

  /** 跑一遍：按 web 决定是否注入网页形态标志 */
  const scenario = async (web) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    if (web) {
      await context.addInitScript(() => {
        // 与服务端注入等价的两个标志（platform.ts 在模块求值时读它们）
        window.__YFE_WEB__ = true
        window.__YFE_GUEST__ = true
      })
    }
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))

    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /跳过，直接进入项目管理/ }).waitFor({ timeout: 60000 })
    // 写入本机模型配置（与界面保存同一个 meta 键）
    await page.evaluate(async (provider) => {
      const open = () => new Promise((resolve, reject) => {
        const request = indexedDB.open('youth-fantasy-engine')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const db = await open()
      const tx = db.transaction('meta', 'readwrite')
      tx.objectStore('meta').put({ key: 'aiProviders', value: provider.list })
      tx.objectStore('meta').put({ key: 'aiActiveProviderId', value: provider.activeId })
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error) })
      db.close()
    }, { list: [LOCAL_PROVIDER, REMOTE_PROVIDER], activeId: REMOTE_PROVIDER.id })

    await page.reload({ waitUntil: 'domcontentloaded' })
    /**
     * 进示范项目。两条路都要走通：
     *  · 首启向导里「先看看示例」（不弹确认）；
     *  · 已经在项目管理页时「创建示范项目」—— 这条会弹一次确认，必须点「确定」。
     */
    const wizard = page.getByRole('button', { name: /先看看示例/ })
    await wizard.waitFor({ timeout: 30000 })
    if (await wizard.isVisible().catch(() => false)) {
      await wizard.click()
      await page.getByRole('button', { name: '下一步', exact: true }).click()
      await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
    } else {
      await page.getByRole('button', { name: /创建示范项目/ }).first().click()
      await page.getByRole('dialog').getByRole('button', { name: '确定', exact: true }).click()
    }
    await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
    const later = page.getByRole('button', { name: '稍后再说', exact: true })
    if (await later.isVisible().catch(() => false)) await later.click()
    const guide = page.locator('[data-guide-card]').first()
    if (await guide.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) {
      await page.getByRole('button', { name: '跳过本页' }).click().catch(() => {})
      await guide.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    }

    await page.getByRole('navigation').getByText('模型设置', { exact: true }).first().click()
    await page.getByRole('heading', { name: /模型配置/ }).first().waitFor({ timeout: 30000 }).catch(() => {})
    await page.getByText('探针本机模型', { exact: true }).first().waitFor({ timeout: 30000 })

    const state = await page.evaluate(() => {
      const row = [...document.querySelectorAll('div')].find(node => node.textContent?.trim() === '探针本机模型')?.closest('.rounded-lg')
      const inRow = (name) => [...(row?.querySelectorAll('button') ?? [])].find(b => (b.innerText || '').trim() === name)
      const addLocal = [...document.querySelectorAll('button')].find(b => (b.innerText || '').trim().includes('添加本地模型'))
      const notice = document.querySelector('[data-local-model-notice]')
      const addHint = document.querySelector('[data-local-model-blocked]')
      const roleSelect = document.querySelector('select')
      const roleOptions = roleSelect ? [...roleSelect.options].map(o => o.textContent || '') : []
      return {
        hasRow: !!row,
        badge: /网页版不支持/.test(row?.textContent ?? ''),
        setCurrentDisabled: (() => { const b = inRow('设为当前'); return b ? b.disabled : null })(),
        testDisabled: (() => { const b = inRow('测试'); return b ? b.disabled : null })(),
        addLocalDisabled: addLocal ? addLocal.disabled : null,
        notice: notice?.textContent?.slice(0, 40) ?? '',
        addHint: addHint?.textContent?.slice(0, 30) ?? '',
        roleOptions,
      }
    })
    await page.screenshot({ path: path.join(run, web ? 'web.png' : 'desktop-preview.png'), fullPage: false })
    await context.close()
    return { state, errors }
  }

  const web = await scenario(true)
  check('网页形态：模型列表里能看到那条本机配置', web.state.hasRow)
  check('🔴 网页形态：本机配置带「网页版不支持」徽标', web.state.badge)
  check('🔴 网页形态：「设为当前」被禁用', web.state.setCurrentDisabled === true, String(web.state.setCurrentDisabled))
  check('🔴 网页形态：「测试」被禁用', web.state.testDisabled === true, String(web.state.testDisabled))
  check('🔴 网页形态：「添加本地模型」入口被禁用', web.state.addLocalDisabled === true, String(web.state.addLocalDisabled))
  check('网页形态：列表上方给出统一说明（讲原因）', /网页版不支持/.test(web.state.notice), web.state.notice)
  check('网页形态：添加入口下方也有可读说明', /网页版不支持/.test(web.state.addHint), web.state.addHint)
  check('🔴 网页形态：用途下拉里没有这条本机配置',
    web.state.roleOptions.length > 0 && !web.state.roleOptions.some(text => text.includes('探针本机模型')),
    web.state.roleOptions.slice(0, 3).join(' | '))

  const desktop = await scenario(false)
  check('非网页形态（开发预览）：不加徽标', desktop.state.hasRow && !desktop.state.badge)
  check('🔴 非网页形态：「设为当前」仍可用（桌面/便携不受影响）', desktop.state.setCurrentDisabled === false, String(desktop.state.setCurrentDisabled))
  check('🔴 非网页形态：「测试」仍可用', desktop.state.testDisabled === false, String(desktop.state.testDisabled))
  check('🔴 非网页形态：「添加本地模型」仍可用', desktop.state.addLocalDisabled === false, String(desktop.state.addLocalDisabled))
  check('非网页形态：没有那条禁用说明', !desktop.state.notice && !desktop.state.addHint)
  check('非网页形态：用途下拉里能看到这条配置',
    desktop.state.roleOptions.some(text => text.includes('探针本机模型')),
    desktop.state.roleOptions.slice(0, 3).join(' | '))

  // ---------- ③ 运行时：网页形态 + 只有本机配置 ⇒ AI 入口应报「网页版不支持」，而不是「未配置」 ----------
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    await context.addInitScript(() => { window.__YFE_WEB__ = true; window.__YFE_GUEST__ = true })
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /跳过，直接进入项目管理/ }).waitFor({ timeout: 60000 })
    await page.evaluate(async (provider) => {
      const open = () => new Promise((resolve, reject) => {
        const request = indexedDB.open('youth-fantasy-engine')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const db = await open()
      const tx = db.transaction('meta', 'readwrite')
      tx.objectStore('meta').put({ key: 'aiProviders', value: [provider] })
      tx.objectStore('meta').put({ key: 'aiActiveProviderId', value: provider.id })
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error) })
      db.close()
    }, LOCAL_PROVIDER)
    await page.reload({ waitUntil: 'domcontentloaded' })
    const wizard = page.getByRole('button', { name: /先看看示例/ })
    await wizard.waitFor({ timeout: 30000 })
    await wizard.click()
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
    // 工作面板上有大量 AI 入口：只配了本机模型时，它们的提示必须指向「网页版不支持」
    const hint = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('button[title], [data-ai-disabled-hint]')]
      const hit = nodes.map(n => n.getAttribute('title') || '').find(text => text.includes('需先接入 AI 模型'))
      return hit ?? ''
    })
    check('🔴 运行时：只有本机配置时，AI 入口提示「网页版请用联网模型」', /网页版请到/.test(hint), hint.slice(0, 60))
    check('运行时：提示里明确写「网页版不支持连接本机模型」', /网页版不支持连接本机模型/.test(hint), hint.slice(0, 60))
    check('运行时：这条路径也没有页面脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '))
    await context.close()
  }

  check('两种形态都没有页面脚本错误',
    web.errors.length === 0 && desktop.errors.length === 0,
    [...web.errors, ...desktop.errors].slice(0, 2).join(' | '))

  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ records, failed, web: web.state, desktop: desktop.state }, null, 2))
  console.log(`\n结果：${records.length - failed}/${records.length} 通过，记录在 ${run}`)
} finally {
  await browser?.close()
  await server.close()
}
if (failed) process.exit(1)
