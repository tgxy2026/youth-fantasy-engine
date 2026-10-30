// 使用答疑 · 连续追问端到端（3.3.1 · §5.5）
//
// 用**假模型**（浏览器层拦截，不起真实端点、不花额度）验证五件事：
//   ① 追问被识别后**重新检索**，不是把上次回答塞给模型；
//   ② 发给模型的提示词里出现「上一轮作者问过…只用于理解指代 / 不能当作事实」，并带上一轮的文章标题；
//   ③ 界面上出现「接着上一问：《…》」—— 规划 §5.5 要求显示当前参考主题；
//   ④ 上一轮的原句若不在本轮片段里，拿它当依据必须判「对不上」，不许显示成答案；
//   ⑤ 清空对话后再问含糊的「它在哪里」⇒ 本地澄清（给候选主题），且**一次模型请求都不发**。
//
// 🔴 假模型只证明「给这种响应，客户端怎么呈现」；真实模型下的措辞与观感仍须人工验收。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const run = path.join('.workbuddy/tmp', `help-thread-331-${stamp}`)
fs.mkdirSync(run, { recursive: true })

const report = { kind: 'help-thread-331', at: new Date().toISOString(), run, checks: [], errors: [] }
let failed = 0
const check = (name, pass, detail = '') => {
  report.checks.push({ name, pass: !!pass, detail })
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const MOCK = 'http://mock.local/v1'
/** 假模型模式：answer = 照本轮片段摘一句；foreign = 摘一句**与本题无关**的手册原文 */
let mockMode = 'answer'
let foreignQuote = ''
const prompts = []

/** 从请求里取出第一段片段正文，摘 30 字当 quote（必是本轮片段内的连续原文） */
function quoteFromPrompt(bodyText) {
  const at = bodyText.indexOf('【片段 1】')
  if (at < 0) return ''
  const lineEnd = bodyText.indexOf('\n', at)
  if (lineEnd < 0) return ''
  return bodyText.slice(lineEnd + 1, lineEnd + 31)
}

const server = await createServer({
  root,
  cacheDir: path.join('.workbuddy/tmp', `vite-help-thread-${stamp}`),
  logLevel: 'error',
  server: { host: 'localhost', port: 0 },
})

let browser
try {
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })

  await context.route('**/*', async route => {
    const request = route.request()
    const url = request.url()
    if (url.startsWith(origin + '/')) return route.continue()
    if (!url.startsWith('http://mock.local/')) return route.abort()

    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': '*',
    }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (url.includes('/models')) {
      return route.fulfill({
        status: 200, headers: { ...cors, 'content-type': 'application/json' },
        body: JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model', owned_by: 'probe' }] }),
      })
    }

    let payload = {}
    try { payload = request.postDataJSON() ?? {} } catch { payload = {} }
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const userText = String([...messages].reverse().find(m => m.role === 'user')?.content ?? '')
    prompts.push(userText)

    const quote = mockMode === 'foreign' ? foreignQuote : quoteFromPrompt(userText)
    const content = JSON.stringify({ answer: '按手册：这一项在设置里调，改完立即生效。', quotes: [quote] })
    const body = JSON.stringify({
      id: 'mock-1', object: 'chat.completion', model: 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    })
    if (payload.stream === true) {
      const chunk = `data: ${JSON.stringify({
        id: 'mock-1', object: 'chat.completion.chunk', model: 'mock-model',
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })}\n\ndata: [DONE]\n\n`
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream; charset=utf-8' }, body: chunk })
    }
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body })
  })

  const page = await context.newPage()
  page.setDefaultTimeout(120000)
  page.on('pageerror', error => report.errors.push(String(error)))

  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  // 首启向导：用「先看看示例」建一个隔离的示范项目（与验收清单同一条路）
  await page.getByRole('button', { name: /先看看示例/ }).click({ timeout: 60000 })
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })

  // 写入模型配置（与界面同一个 meta 键），指向假模型
  const seeded = await page.evaluate(async base => {
    const open = () => new Promise((resolve, reject) => {
      const request = indexedDB.open('youth-fantasy-engine')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const db = await open()
    if (!db.objectStoreNames.contains('meta')) { db.close(); return 'no-meta' }
    const provider = {
      id: 'probe-mock', name: '探针 · 假模型', type: 'openai',
      // 🔴 apiKey 必须非空：`precheck` 对非 ollama 的联网类型强制要求密钥，
      //    填空的配置会被判「没填全」⇒ 界面显示未配置模型（踩过：第一版探针就是这么白跑的）
      baseUrl: base, apiKey: 'probe-key', model: 'mock-model', contextWindow: 32768,
    }
    const tx = db.transaction('meta', 'readwrite')
    tx.objectStore('meta').put({ key: 'aiProviders', value: [provider] })
    tx.objectStore('meta').put({ key: 'aiActiveProviderId', value: 'probe-mock' })
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error) })
    db.close()
    return 'ok'
  }, MOCK)
  check('假模型配置写入成功', seeded === 'ok', String(seeded))

  await page.reload({ waitUntil: 'domcontentloaded' })
  // 重载后可能在项目里，也可能回到项目列表：两种都接住
  if (!(await page.getByTitle('返回项目列表').waitFor({ timeout: 20000 }).then(() => true).catch(() => false))) {
    await page.getByRole('button', { name: /打开项目/ }).first().click({ timeout: 60000 })
    await page.getByTitle('返回项目列表').waitFor({ timeout: 60000 })
  }
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()

  // 进手册 → 问 AI
  const nav = page.getByRole('navigation')
  await nav.getByText('使用指南', { exact: true }).first().click()
  const center = page.locator('[data-help-center]').first()
  await center.waitFor({ timeout: 30000 })
  const guide = page.locator('[data-guide-card]').first()
  if (await guide.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) {
    await page.getByRole('button', { name: '跳过本页' }).click().catch(() => {})
    await guide.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  }
  await page.evaluate(async () => { (await import('/src/lib/settings/guidePrefs.ts')).setGuideAutoEnabled(false) }).catch(() => {})

  await center.getByRole('button', { name: /问 AI/ }).first().click()
  const panel = page.locator('[data-ask-panel]').first()
  await panel.waitFor({ timeout: 15000 })

  const answerBlocks = () => panel.getByText('依据（点开看原文那一段）').count()
  const topicChips = () => panel.locator('[data-help-topic]').count()
  const clarifyBlocks = () => panel.locator('[data-help-clarify]').count()
  const waitUntil = async (fn, ms = 90000) => {
    const start = Date.now()
    while (Date.now() - start < ms) {
      if (await fn()) return true
      await sleep(250)
    }
    return false
  }
  const ask = async text => {
    await panel.getByLabel('向答疑助手提问').fill(text)
    await panel.getByRole('button', { name: /^提问$/ }).click()
  }
  const askAndWait = async (text, counter) => {
    const before = await counter()
    await ask(text)
    return waitUntil(async () => (await counter()) > before)
  }

  // ---------- ① 第一问：正常回答，没有「接着上一问」 ----------
  const firstOk = await askAndWait('字太小怎么放大', answerBlocks)
  if (!firstOk) {
    console.log('DEBUG 面板：', (await panel.innerText()).slice(-300))
    console.log('DEBUG 面板数量：', await page.locator('[data-ask-panel]').count(),
      '可见：', await page.locator('[data-ask-panel]:visible').count(),
      '提问框：', await page.getByLabel('向答疑助手提问').count())
    await page.screenshot({ path: path.join(run, 'debug.png') })
  }
  check('第一问得到带依据的回答', firstOk)
  check('第一问没有「接着上一问」（此前没有主题），也没有澄清块',
    (await topicChips()) === 0 && (await clarifyBlocks()) === 0)
  check('第一问的提示词里没有「上一轮」', !/上一轮作者问过/.test(prompts[0] ?? ''), (prompts[0] ?? '').slice(0, 40))

  // ---------- ② 追问：重新检索 + 提示词带上文 + 界面显示参考主题 ----------
  const askBefore = prompts.length
  check('追问得到回答', await askAndWait('那还需要模型吗', answerBlocks))
  check('追问后出现「接着上一问」', await waitUntil(async () => (await topicChips()) > 0))
  const chipText = await panel.locator('[data-help-topic]').last().innerText()
  check('参考主题带上一轮的文章标题', /接着上一问/.test(chipText) && /字太小|缩放/.test(chipText), chipText)
  const followPrompt = prompts[askBefore] ?? ''
  check('🔴 追问的提示词带上「上一轮作者问过」', /上一轮作者问过/.test(followPrompt))
  check('🔴 提示词写明上一轮只用于理解指代、不能当事实',
    /只用于理解/.test(followPrompt) && /不能当作事实/.test(followPrompt))
  check('🔴 追问**重新检索**了上一问的文章（片段里出现「字太小/缩放」）', /字太小|缩放/.test(followPrompt))
  check('提示词里仍是本轮问题原文', /那还需要模型吗/.test(followPrompt))

  // ---------- ③ 上一轮原文不在本轮片段里 ⇒ 必须判「对不上」 ----------
  foreignQuote = await page.evaluate(async () => {
    const mod = await import('/src/lib/help/index.ts')
    const article = mod.HELP_ARTICLES.find(item => item.title.includes('酒馆'))
    return article?.sections[0]?.body.join('').slice(0, 26) ?? ''
  })
  check('取到一段与本题无关的手册原文（冒充「上一轮的旧依据」）', foreignQuote.length >= 12, foreignQuote)
  mockMode = 'foreign'
  const blocksBeforeForeign = await answerBlocks()
  await ask('那快捷键呢')
  const sawForeignNotice = await waitUntil(async () => /无法核对|对不上/.test(await panel.innerText()))
  check('🔴 拿上一轮（不在本轮片段里）的原文当依据 ⇒ 明确说无法核对', sawForeignNotice)
  check('这一轮没有多出「依据」答案块（不能显示成答案）', (await answerBlocks()) === blocksBeforeForeign,
    `${await answerBlocks()} / ${blocksBeforeForeign}`)
  mockMode = 'answer'

  // ---------- ④ 清空后问含糊指代 ⇒ 本地澄清，不发模型 ----------
  await panel.getByRole('button', { name: /清空/ }).click()
  await waitUntil(async () => (await panel.locator('[data-help-topic]').count()) === 0, 5000)
  const callsBeforeClarify = prompts.length
  check('清空后含糊指代 ⇒ 出澄清块', await askAndWait('它在哪里', clarifyBlocks))
  const clarifyText = await panel.locator('[data-help-clarify]').last().innerText()
  check('澄清说明「还没有可参考的主题」并请作者指定功能', /还没有可参考的主题/.test(clarifyText), clarifyText.slice(0, 60))
  check('🔴 澄清时一次模型请求都没发', prompts.length === callsBeforeClarify, `${prompts.length - callsBeforeClarify}`)
  const optionButtons = panel.locator('[data-help-clarify] button')
  const optionCount = await optionButtons.count()
  check('澄清给出候选主题（当前页的文章）', optionCount > 0, String(optionCount))
  if (optionCount > 0) {
    await optionButtons.first().click()
    check('点候选后按那篇继续提问（不卡在澄清里）',
      await waitUntil(async () => prompts.length > callsBeforeClarify))
  }

  check('全程 0 页面脚本错误', report.errors.length === 0, report.errors.join(' | ').slice(0, 200))
  await panel.screenshot({ path: path.join(run, 'ask-thread.png') }).catch(() => {})
} catch (error) {
  // 🔴 探针自己出错也必须算失败：否则「跑到一半崩了」会被 finally 报成 HELP_THREAD_OK
  failed++
  check('探针执行未中断', false, String(error?.message ?? error).slice(0, 200))
} finally {
  report.failed = failed
  report.status = failed === 0 ? 'pass' : 'fail'
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify(report, null, 2))
  await browser?.close().catch(() => {})
  await server.close().catch(() => {})
  console.log(`\n报告：${path.join(run, 'result.json')}`)
  console.log(failed === 0 ? 'HELP_THREAD_OK' : `HELP_THREAD_FAIL ${failed}`)
  if (failed > 0) process.exitCode = 1
}
