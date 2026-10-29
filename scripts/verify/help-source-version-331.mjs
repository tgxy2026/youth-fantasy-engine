// 模拟模型响应，验证已显示回答的来源变更后不会跳到不同原文。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const run = path.join('.workbuddy/tmp', `help-source-version-331-${stamp}`)
fs.mkdirSync(run, { recursive: true })
const server = await createServer({ root: process.cwd(), cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
const records = []
const check = (name, pass, detail = '') => { records.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`) }
let browser
try {
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  let modelCalls = 0
  await context.route('**/*', async route => {
    const req = route.request(), url = req.url()
    if (url.startsWith(origin + '/')) return route.continue()
    if (url === 'http://mock-model.test/api/chat') {
      const headers = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' }
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
      modelCalls++
      const body = req.postDataJSON()
      const prompt = body.messages.find(message => message.role === 'user')?.content ?? ''
      const quote = /【片段 1】[^\n]*\n([^\n]+)/.exec(prompt)?.[1]?.slice(0, 24) ?? ''
      return route.fulfill({ status: 200, headers, body: JSON.stringify({ message: { content: JSON.stringify({ answer: '请参考这段手册。', quotes: [quote] }) }, done: true }) })
    }
    return route.abort()
  })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /跳过，直接进入项目管理/ }).waitFor({ timeout: 60000 })
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('youth-fantasy-engine')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const tx = db.transaction('meta', 'readwrite')
    const provider = { id: 'mock-help', name: '模拟模型', type: 'ollama', baseUrl: 'http://mock-model.test', apiKey: '', model: 'mock', contextWindow: 32768 }
    tx.objectStore('meta').put({ key: 'aiProviders', value: [provider] })
    tx.objectStore('meta').put({ key: 'aiActiveProviderId', value: provider.id })
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error) })
    db.close()
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /跳过，直接进入项目管理/ }).click()
  await page.getByRole('button', { name: /使用手册/ }).first().click()
  const dialog = page.getByRole('dialog').first()
  await dialog.getByRole('button', { name: '问 AI' }).click()
  await dialog.getByLabel('向答疑助手提问').fill('字太小怎么放大')
  await dialog.getByRole('button', { name: '提问', exact: true }).click()
  const source = dialog.locator('[data-ask-panel] button').filter({ hasText: '《' }).first()
  await source.waitFor({ timeout: 30000 })
  check('模拟模型产生有依据的回答', modelCalls === 1)
  const label = (await source.innerText()).split('\n')[0]
  const match = /^《([^》]+)》·\s*(.+)$/.exec(label)
  if (!match) throw new Error('未识别来源标题')
  const changed = await page.evaluate(async ([title, heading]) => {
    const help = await import('/src/lib/help/index.ts')
    const article = help.HELP_ARTICLES.find(item => item.title === title)
    const section = article?.sections.find(item => item.heading === heading)
    if (!section) return false
    section.body = [...section.body, '测试中的手册内容变更']
    return true
  }, [match[1], match[2]])
  check('在隔离页面内模拟来源内容更新', changed)
  await source.click()
  check('旧来源不跳到新原文并提示重新提问', await dialog.getByText(/依据的手册内容已变化/).isVisible() && !(await dialog.locator('[data-help-article]').isVisible()))
  check('页面无脚本错误', errors.length === 0, errors.join(' | '))
} finally {
  const failed = records.filter(record => !record.pass).length
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ records, failed }, null, 2))
  console.log(`结果：${records.length - failed}/${records.length}，${run}`)
  await browser?.close()
  await server.close()
  if (failed) process.exitCode = 1
}
