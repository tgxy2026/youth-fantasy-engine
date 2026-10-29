// 使用答疑助手 · 真实模型端到端（3.3.1 · P4）
//
// 这是**手动验证**用的探针，不进常规闸：它要求本机 Ollama 正在跑、且装有可用模型。
// 验的是「接上真模型之后」这条链：检索 → 全局归属调用 → 校验来源 → 显示依据 → 点开原文。
//
// 用法：node scripts/verify/help-ask-model-331.mjs [模型名]
//   · 默认取 OLLAMA_MODEL 环境变量，再退到 dongfangshuo-novel:latest
//   · 模型配置直接写进 IndexedDB（与界面保存同一处），不靠点表单，避免探针被表单细节绑死
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const MODEL = process.argv[2] || process.env.OLLAMA_MODEL || 'dongfangshuo-novel:latest'
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434'
const root = process.cwd()
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const run = path.join('.workbuddy/tmp', `help-ask-model-331-${stamp}`)
fs.mkdirSync(run, { recursive: true })

const server = await createServer({
  root,
  cacheDir: path.join('.workbuddy/tmp', `vite-help-ask-model-${stamp}`),
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  // 只放行本站与本地 Ollama，其余一律拦掉 —— 证明这条链没有偷偷访问别的服务
  await context.route('**/*', route => {
    const url = route.request().url()
    if (url.startsWith(origin + '/') || url.startsWith(OLLAMA)) return route.continue()
    return route.abort()
  })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(String(error)))

  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  // 首启停在向导页：先确认它渲染完，再写配置（写配置要等 DB 建好）
  await page.getByRole('button', { name: /跳过，直接进入项目管理/ }).waitFor({ timeout: 60000 })

  // 写入模型配置（与界面 saveProviders 同一个 meta 键）
  const seeded = await page.evaluate(async ({ model, base }) => {
    const open = () => new Promise((resolve, reject) => {
      const request = indexedDB.open('youth-fantasy-engine')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const db = await open()
    if (!db.objectStoreNames.contains('meta')) { db.close(); return 'no-meta' }
    const provider = {
      id: 'probe-ollama', name: `探针 · ${model}`, type: 'ollama',
      baseUrl: base, apiKey: '', model, contextWindow: 32768,
    }
    const tx = db.transaction('meta', 'readwrite')
    tx.objectStore('meta').put({ key: 'aiProviders', value: [provider] })
    tx.objectStore('meta').put({ key: 'aiActiveProviderId', value: 'probe-ollama' })
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error) })
    db.close()
    return 'ok'
  }, { model: MODEL, base: OLLAMA })
  check('模型配置写入成功（走界面同一个 meta 键）', seeded === 'ok', String(seeded))

  await page.reload({ waitUntil: 'domcontentloaded' })
  // 重载后仍停在首启向导（首启标记未写）—— 跳过它进项目管理页，那里有手册入口
  const skipWizard = page.getByRole('button', { name: /跳过，直接进入项目管理/ })
  if (await skipWizard.waitFor({ timeout: 20000 }).then(() => true).catch(() => false)) await skipWizard.click()
  await page.getByRole('button', { name: /使用手册/ }).first().waitFor({ timeout: 60000 })
  await page.getByRole('button', { name: /使用手册/ }).first().click()
  await page.getByRole('dialog').first().waitFor({ timeout: 20000 })
  await page.getByRole('button', { name: /问 AI/ }).click()
  const panel = page.locator('[data-ask-panel]')
  await panel.waitFor({ timeout: 15000 })
  const headText = await panel.innerText()
  check('配好模型后不再提示「未配置模型」', !/未配置模型时只能给手册片段/.test(headText))

  // 真提问：本地模型首次调用要加载权重，给足时间
  const box = page.getByLabel('向答疑助手提问')
  await box.fill('字太小怎么放大')
  const started = Date.now()
  await box.press('Enter')
  const answered = await page.locator('[data-ask-panel] >> text=/依据（点开看原文那一段）/')
    .first().waitFor({ timeout: 420000 }).then(() => true).catch(() => false)
  const elapsed = Math.round((Date.now() - started) / 1000)
  const text = await panel.innerText()
  check('真实模型给出了带依据的回答', answered, `${elapsed}s`)
  if (!answered) {
    fs.writeFileSync(path.join(run, 'panel.txt'), text)
    console.log('--- 面板文本 ---\n' + text.slice(0, 900))
  } else {
    check('回答里出现了与缩放相关的说法（不是敷衍一句「请查阅手册」）',
      /缩放|界面|放大|百分比/.test(text), text.slice(0, 160).replace(/\n/g, ' '))
    await page.screenshot({ path: path.join(run, 'answer.png') })

    // 点依据 → 打开原文那一段，且那一段标题与依据标注一致
    const source = panel.locator('button').filter({ hasText: '《' }).first()
    const sourceLabel = (await source.innerText()).split('\n')[0]
    await source.click()
    const article = page.locator('[data-help-article]').first()
    const opened = await article.waitFor({ timeout: 15000 }).then(() => true).catch(() => false)
    check('点依据能打开手册原文', opened)
    if (opened) {
      const articleText = await article.innerText()
      const heading = sourceLabel.replace(/^《[^》]+》·\s*/, '').trim()
      check('打开的就是依据标的那一段', heading.length > 0 && articleText.includes(heading), heading)
      await page.screenshot({ path: path.join(run, 'source.png') })
    }
  }

  check('页面无 pageerror', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
} finally {
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ model: MODEL, records, failed }, null, 1))
  console.log(`\n结果：${records.length - failed}/${records.length} 通过，记录在 ${run}`)
  await browser?.close()
  await server.close()
}
if (failed) process.exit(1)
