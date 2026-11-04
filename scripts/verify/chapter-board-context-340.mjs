// 3.4.0 · A.3 浏览器验证：规划板卡片显示「可验证的细纲绑定 / 固定条数」三态。
// 断言的是真实 DOM 文案，不是源码字符串。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'

const run = await mkdtemp(path.join(process.cwd(), '.workbuddy/tmp/chapter-board-context-340-'))
const server = await createServer({ cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(`http://localhost:${server.httpServer.address().port}`)
  await page.evaluate(() => { document.body.innerHTML = '<div id="fixture"></div>' })
  await page.evaluate(() => import('/tests/browser/chapter-board-context-340-fixture.tsx'))

  // 展开规划板（默认收起，偏好存在本机）
  await page.getByRole('button', { name: /章节规划板/ }).click()

  // ① 已绑定：卡名 + 固定条数
  await page.getByText('细纲：第一章细纲 · 固定资料 1 条', { exact: true }).waitFor({ timeout: 15000 })
  // ② 绑定的卡已被删：说「已失效」，不能说「未绑定」
  await page.getByText(/绑定的细纲卡已失效/).waitFor()
  // ③ 没写过设置：照实说未绑定
  await page.getByText('未绑定细纲', { exact: true }).waitFor()

  // 不能按名称猜关系：全文只应出现一次「细纲：」（只有 c1 有真实绑定）
  // ⚠️ 不能用 /^细纲：/：卡片里图标在前，规范化后的文本以空格开头。
  const boundLines = await page.getByText(/细纲：/).count()
  if (boundLines !== 1) throw new Error(`expected exactly 1 bound outline line, got ${boundLines}`)
  // 未绑定只应出现在 c3 一张卡上（c2 是失效，不是未绑定）
  const unboundLines = await page.getByText('未绑定细纲', { exact: true }).count()
  if (unboundLines !== 1) throw new Error(`expected exactly 1 unbound line, got ${unboundLines}`)
  // 已删除章节的旧设置不得显示到任何卡上
  const deletedLeak = await page.getByText(/deleted-chapter/).count()
  if (deletedLeak !== 0) throw new Error('deleted chapter context leaked into the board')

  if (errors.length) throw new Error(errors.join('\n'))
  console.log('PASS bound shows outline name + pinned count; stale says invalid; unbound says unbound; no name guessing')
} finally {
  await browser?.close()
  await server.close()
}
