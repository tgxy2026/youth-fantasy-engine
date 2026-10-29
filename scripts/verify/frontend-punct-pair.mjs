// 中文标点自动配对 · 真实浏览器取证（2026-10-27 用户反馈：搜狗打完逗号后引号只出右半边）
//
// 真实 textarea + 真实 React onChange；用 CDP 的 insertText 模拟「输入法上屏一个字符」
// （insertText 会派发 isComposing=false、data=该字符的 input 事件，正是提交后的形态）。
// 不碰真实书库：示例项目里的临时编辑，不保存、不发模型请求。
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-punct-pair-'))
const fingerprint = snapshot(root).fingerprint
const report = { kind: 'frontend-punct-pair', at: new Date().toISOString(), run, fingerprint, checks: [], errors: [], modelRequests: [], status: 'running' }
const check = (name, passed, details) => {
  report.checks.push({ name, passed: !!passed, details })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  if (!passed) throw new Error(name + ': ' + JSON.stringify(details))
}

let server, browser, page
try {
  server = await createServer({ root, cacheDir: path.join(run, 'vite-cache'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => {
    const url = route.request().url()
    if (/\/chat\/completions|\/api\/ai(?:\/|$)/.test(url)) report.modelRequests.push({ method: route.request().method(), origin: new URL(url).origin })
    return url.startsWith(origin + '/') ? route.continue() : route.abort()
  })
  page = await context.newPage()
  page.setDefaultTimeout(120000)
  page.on('pageerror', error => report.errors.push(error.message))
  await page.goto(origin, { waitUntil: 'commit' })
  await page.waitForFunction(() => (document.querySelector('#root')?.childElementCount ?? 0) > 0, null, { timeout: 180000 })
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.locator('nav').waitFor({ state: 'attached', timeout: 60000 })
  const dismiss = async () => {
    for (const name of ['稍后再说', '知道了', '跳过，直接开始']) {
      await page.getByRole('button', { name, exact: true }).click({ timeout: 1000 }).catch(() => {})
    }
  }
  const nav = page.getByRole('navigation')
  const deadline = Date.now() + 45000
  while (Date.now() < deadline && !(await nav.isVisible().catch(() => false))) {
    await dismiss()
    await page.waitForTimeout(200)
  }
  await nav.waitFor({ timeout: 10000 })
  page.setDefaultTimeout(20000)

  await nav.getByRole('button', { name: '正文编辑', exact: true }).click()
  const ta = page.locator('textarea.novel-textarea')
  await ta.waitFor()

  /** 把正文换成给定内容，光标放到末尾（fill 派发的 input 没有 data，不会触发配对） */
  const reset = async (text) => {
    await ta.fill(text)
    await ta.evaluate(el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length) })
    await page.waitForTimeout(120)
  }
  const typeChar = async (ch) => { await page.keyboard.insertText(ch); await page.waitForTimeout(220) }
  const read = () => ta.evaluate(el => ({ value: el.value, caret: el.selectionStart }))

  // ---------- ① 用户报的那条：逗号之后按引号，只出右引号 ----------
  await reset('他说，')
  await typeChar('”')
  const afterComma = await read()
  check('🔴 逗号后的右引号被补成一对（不再只有半边）', afterComma.value === '他说，“”', afterComma)
  check('🔴 补完之后光标落在两个引号中间', afterComma.caret === afterComma.value.length - 1, afterComma)

  // ---------- ② 真收尾不能被改：已有未闭合左引号 ----------
  await reset('他说“你好')
  await typeChar('”')
  const closing = await read()
  check('🔴 已有未闭合 “ 时，右引号保持原样（正常收尾不被破坏）', closing.value === '他说“你好”', closing)

  // ---------- ③ 行首孤立右引号也兜底 ----------
  await reset('')
  await typeChar('”')
  const atStart = await read()
  check('🔴 行首孤立右引号补成一对', atStart.value === '“”' && atStart.caret === 1, atStart)

  // ---------- ④ 书名号同一口径 ----------
  await reset('见，')
  await typeChar('》')
  const bookA = await read()
  check('🔴 逗号后的 》 补成《》', bookA.value === '见，《》', bookA)
  await reset('读《三体')
  await typeChar('》')
  const bookB = await read()
  check('🔴 已有未闭合《 时，》保持原样', bookB.value === '读《三体》', bookB)

  // ---------- ⑤ 正常左引号仍然按老规矩配对 ----------
  await reset('他说，')
  await typeChar('“')
  const leftPath = await read()
  check('⑤ 左引号仍自动补右半边（老行为不回归）', leftPath.value === '他说，“”' && leftPath.caret === leftPath.value.length - 1, leftPath)

  // ---------- ⑥ 英文半角引号一律不碰 ----------
  await reset('a,')
  await typeChar('"')
  const ascii = await read()
  check('🔴 英文半角引号不插手（不污染代码/英文）', ascii.value === 'a,"', ascii)

  // ---------- ⑦ 全标点族普查：不只逗号（用户要求） ----------
  // 从应用里取配对表，避免探针自己抄一份导致漂移
  const pairs = await page.evaluate(async () => Object.entries((await import('/src/lib/editor/punctPair.ts')).CN_PUNCT_PAIRS))
  for (const [left, right] of pairs) {
    await reset('测试，')
    await typeChar(right)
    const got = await read()
    check(`🔴 全族普查：${right} 在「，」之后补成 ${left}${right}`, got.value === `测试，${left}${right}` && got.caret === got.value.length - 1, got)
  }
  // 句号之后再来一对（验证不是只对逗号生效）
  await reset('落笔。')
  await typeChar('”')
  const afterPeriod = await read()
  check('🔴 句号之后同样补成一对', afterPeriod.value === '落笔。“”', afterPeriod)
  // 汉字之后（没有未闭合开引号）也兜底
  await reset('他说')
  await typeChar('”')
  const afterWord = await read()
  check('🔴 汉字之后同样补成一对', afterWord.value === '他说“”', afterWord)

  await page.screenshot({ path: path.join(run, 'punct-pair.png'), animations: 'disabled' })
  check('全程没有模型请求', report.modelRequests.length === 0, report.modelRequests.length)
  check('全程没有页面异常', report.errors.length === 0, report.errors.slice(0, 3))
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.failure = String(error.stack || error)
  if (page) await page.screenshot({ path: path.join(run, 'failure.png'), fullPage: true, animations: 'disabled' }).catch(() => {})
} finally {
  report.stale = snapshot(root).fingerprint !== fingerprint
  if (report.stale) report.status = 'failed'
  report.passed = report.checks.filter(item => item.passed).length
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2))
  await browser?.close()
  await server?.close()
  console.log(JSON.stringify({ run, status: report.status, passed: report.passed, total: report.checks.length, stale: report.stale, failure: report.failure }))
  if (report.status !== 'passed') process.exitCode = 1
}
