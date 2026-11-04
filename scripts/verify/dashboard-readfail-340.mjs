// 3.4.0 · 写作面板读库失败：如实报错 + 重试恢复（整页）
//
// 注入点：底层 `ops.getAll('chapters')` 抛错（Dashboard 的 getAllChapters 会 reject）。
// 判据：不再永久停在「加载中…」；显示失败原因与「重新读取」；恢复后重试成功。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'

const run = await mkdtemp(path.join(process.cwd(), '.workbuddy/tmp/dashboard-readfail-340-'))
const server = await createServer({ cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
const checks = []
const check = (id, ok, detail = '') => {
  checks.push({ id, ok: !!ok })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (ok || !detail ? '' : ` :: ${detail}`))
  if (!ok) throw new Error(`${id}${detail ? ' :: ' + detail : ''}`)
}

try {
  await server.listen()
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.addInitScript(() => localStorage.setItem('yfe-ui:guide-auto', '0'))
  await page.goto(`http://localhost:${server.httpServer.address().port}`, { waitUntil: 'domcontentloaded' })

  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
  const nav = page.getByRole('navigation')
  await nav.getByRole('button', { name: '写作面板', exact: true }).click()
  await page.getByRole('button', { name: /章节规划板/ }).waitFor({ timeout: 30000 })

  // ---- 注入读库失败 ----
  await page.evaluate(async () => {
    const { ops } = await import('/src/lib/db/core.ts')
    const original = ops.getAll.bind(ops)
    window.__restoreGetAll = () => { ops.getAll = original }
    ops.getAll = async (...args) => {
      if (args[0] === 'chapters') throw new Error('injected read failure')
      return original(...args)
    }
  })

  // 切走再回来 → Dashboard 重新挂载并读库（切到不依赖章节列表的页签）
  await nav.getByRole('button', { name: '灵感启发', exact: true }).click()
  await page.waitForTimeout(800)
  await nav.getByRole('button', { name: '写作面板', exact: true }).click()
  await page.getByText('写作面板数据读取失败').waitFor({ timeout: 30000 })
  check('读库失败不再停在「加载中…」，而是明确报错', true)
  check('失败页说明不会把读取失败当成空项目', await page.getByText(/不会显示任何数字/).isVisible())
  check('失败原因可见', await page.getByText(/injected read failure/).isVisible())

  // ---- 恢复后重试 ----
  await page.evaluate(() => window.__restoreGetAll())
  await page.getByRole('button', { name: '重新读取' }).click()
  await page.getByRole('button', { name: /章节规划板/ }).waitFor({ timeout: 30000 })
  check('恢复读取后点「重新读取」能回到正常写作面板', true)
  await page.getByRole('button', { name: /章节规划板/ }).click()
  await page.locator('[data-board-card]').first().waitFor({ timeout: 15000 })
  check('重试成功后可正常渲染规划板卡片', true)

  if (errors.length) throw new Error(errors.join('\n'))
  console.log(`\nPASS ${checks.length} checks · dashboard-readfail-340`)
} finally {
  await browser?.close().catch(() => {})
  await server.close().catch(() => {})
}