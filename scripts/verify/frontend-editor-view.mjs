// UX06 正文工作现场：真实浏览器取证（真实 IDB、真实编辑器、真实离页/切章）。
// 不碰作者书库（临时上下文里的示例项目）、不发任何模型请求。
//
// 守的是这条体验缺口：「写完一段去面板看一眼，回来时光标和位置全没了」。
// 覆盖：
//   ① 离开再回来 ⇒ 滚动与选区真的回到原处（同章）
//   ② 视图记录里**没有正文片段**，且单条记录不超过存储上限
//   ③ 内容被外部改过 ⇒ 只回章首，绝不把旧选区套上去
//   ④ 同页切章（下一章→上一章）⇒ 各章的现场各自记住
//   ⑤ 回来的一瞬间又切走 ⇒ A 的位置不能漏到 B 上
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-editor-view-'))
const fingerprint = snapshot(root).fingerprint
const report = { kind: 'frontend-editor-view', at: new Date().toISOString(), run, fingerprint, checks: [], errors: [], modelRequests: [], status: 'running' }
const check = (name, passed, details) => {
  report.checks.push({ name, passed: !!passed, details })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  if (!passed) throw new Error(name + ': ' + JSON.stringify(details))
}
const MARKER = '文章现场取证标记'
const LONG = Array.from({ length: 90 }, (_, i) => `${MARKER}第${i + 1}段：城门外雨声未歇，守门人仍站在原地，衣角被风掀起又落下。`).join('\n\n')
const OTHER = `${MARKER}外部改写版：这一段来自别处，位置与旧稿无关。`

let server, browser, page
try {
  server = await createServer({ root, cacheDir: path.join(run, 'vite-cache'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' })
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
  await page.getByRole('button', { name: '稍后再说', exact: true }).click()
  await page.getByRole('navigation').waitFor()
  page.setDefaultTimeout(15000)

  const nav = name => page.getByRole('navigation').getByRole('button', { name, exact: true })
  const editor = page.locator('textarea.novel-textarea')
  /** 备份提醒等浮层会把背景置 inert/aria-hidden ⇒ 导航既「点不到」也「看不见」，先关掉再走 */
  const dismissReminders = async () => {
    for (const name of ['稍后再说', '知道了', '跳过，直接开始']) {
      await page.getByRole('button', { name, exact: true }).click({ timeout: 1500 }).catch(() => {})
    }
  }
  const openEditor = async () => {
    await dismissReminders()
    await nav('正文编辑').click()
    await editor.waitFor()
  }
  const leaveToDashboard = async () => { await nav('写作面板').click(); await page.getByRole('navigation').waitFor() }

  // 准备：把第一章写成足够长的稿子并真落库
  await openEditor()
  await editor.fill(LONG)
  await page.keyboard.press('Control+s')
  await page.waitForFunction(async marker => {
    const db = await import('/src/lib/db.ts')
    const chapters = await db.getAllChapters()
    return chapters.some(chapter => (chapter.content ?? '').includes(marker))
  }, MARKER, { timeout: 30000 })
  // 🔴 必须按**内容**反查当前章：示例项目有多章，编辑器打开的是「上次编辑的那一章」，
  //    直接拿 chapters[0] 会改到另一章去（第一轮就这么假红了一次）。
  const activeChapterId = await page.evaluate(async text => {
    const db = await import('/src/lib/db.ts')
    const rows = await db.getAllChapters()
    return rows.find(row => row.content === text)?.id ?? null
  }, LONG)
  if (!activeChapterId) throw new Error('找不到刚写入的当前章（内容反查失败）')

  /**
   * 设好滚动与选区，**返回实测值**。
   * 🔴 不能返回「我设的值」：应用在设置之后仍可能重排/重设光标，从而把滚动挪走
   *    （实测切章前实测值会与设定值不同）。恢复要对齐的是作者离开时的**真实**位置。
   */
  const placeCursor = async () => {
    await editor.evaluate(el => {
      const max = Math.max(0, el.scrollHeight - el.clientHeight)
      el.scrollTop = Math.round(max * 0.45)
      el.focus()
      el.setSelectionRange(120, 168, 'backward')
    })
    await page.waitForTimeout(150)
    return readCursor()
  }
  const readCursor = () => editor.evaluate(el => ({
    top: el.scrollTop,
    max: Math.max(0, el.scrollHeight - el.clientHeight),
    start: el.selectionStart,
    end: el.selectionEnd,
  }))
  const waitRestored = async (want, tolerance = 40) => {
    const deadline = Date.now() + 8000
    let last = null
    while (Date.now() < deadline) {
      last = await readCursor()
      if (Math.abs(last.top - want.top) <= tolerance && last.start === want.start && last.end === want.end) return last
      await page.waitForTimeout(120)
    }
    return last
  }

  // ---------- ① 离开再回来：滚动与选区复原 ----------
  await placeCursor()
  await page.waitForTimeout(200)
  const placed = await readCursor()   // 真正离开前的实测现场
  await leaveToDashboard()
  await openEditor()
  const restored = await waitRestored(placed)
  check('🔴 ① 回到同一章时滚动位置复原', !!restored && Math.abs(restored.top - placed.top) <= 40, { placed, restored })
  check('🔴 ① 回到同一章时选区与方向复原', !!restored && restored.start === placed.start && restored.end === placed.end, { placed, restored })

  // ---------- ② 记录卫生：不含正文片段、单条不超上限 ----------
  const store = await page.evaluate(async () => {
    const { workspaceViews } = await import('/src/lib/settings/workspaceViewState.ts')
    const runtime = await import('/src/lib/settings/workspaceRuntime.ts')
    const db = await import('/src/lib/db.ts')
    await runtime.resolveWorkspaceIdentity()
    const projectId = db.getCurrentProjectId()
    const scope = runtime.currentWorkspaceScope(projectId, 'editor')
    const chapters = await db.getAllChapters()
    const records = chapters.map(chapter => workspaceViews.get(scope, chapter.id)).filter(Boolean)
    return { stats: workspaceViews.stats(), json: JSON.stringify(records), count: records.length }
  })
  check('🔴 ② 视图记录里不含任何正文片段（只有数字与摘要）', !store.json.includes(MARKER), { count: store.count })
  check('② 单条记录远小于 16KiB 上限', store.json.length / Math.max(1, store.count) < 16 * 1024, { bytes: store.json.length, count: store.count })

  // ---------- ③ 内容被外部改过：只回章首，不套旧选区 ----------
  await leaveToDashboard()
  const patched = await page.evaluate(async ({ id, text }) => {
    const db = await import('/src/lib/db.ts')
    await db.patchChapter(id, { content: text })
    return (await db.getAllChapters()).find(row => row.id === id)?.content === text
  }, { id: activeChapterId, text: OTHER })
  if (!patched) throw new Error('外部改写没有落库，无法验证内容变化后的降级')
  await openEditor()
  // 等编辑器真的装载改后的正文，再断言「不沿用旧位置」
  await page.waitForFunction(text => document.querySelector('textarea.novel-textarea')?.value === text, OTHER, { timeout: 15000 })
  await page.waitForTimeout(500)
  const degraded = await readCursor()
  check('🔴 ③ 内容变了 ⇒ 回到章首（不沿用旧滚动）', degraded.top === 0, degraded)
  check('🔴 ③ 内容变了 ⇒ 不套旧选区', !(degraded.start === placed.start && degraded.end === placed.end), { placed, degraded })

  // 还原成长稿，供后续用例
  await page.evaluate(async ({ id, text }) => {
    const db = await import('/src/lib/db.ts')
    await db.patchChapter(id, { content: text })
  }, { id: activeChapterId, text: LONG })
  await page.reload({ waitUntil: 'commit' })
  await page.waitForFunction(() => (document.querySelector('#root')?.childElementCount ?? 0) > 0, null, { timeout: 120000 })
  // 重载后不一定停在项目里（实测回到「我的作品」列表），先把项目打开再进正文。
  // 🔴 用 CSS 定位等 DOM：提醒挂着时 `<nav>` 在可访问性树里根本不存在，role 定位等不到 attached。
  const navAttached = await page.locator('nav').waitFor({ state: 'attached', timeout: 8000 }).then(() => true).catch(() => false)
  if (!navAttached) {
    await page.getByRole('button', { name: '打开项目', exact: true }).first().click()
    await page.locator('nav').waitFor({ state: 'attached', timeout: 60000 })
  }
  await openEditor()

  // ---------- ④ 同页切章：各章现场各自记住 ----------
  await placeCursor()
  await page.waitForTimeout(200)
  const beforeSwitch = await readCursor()   // 切章前的实测现场
  await page.getByTitle('下一章', { exact: true }).click()   // 切章路径（先捕获离开章）
  await page.waitForTimeout(600)
  const onNext = await readCursor()
  const nextDiag = await page.evaluate(async () => {
    const db = await import('/src/lib/db.ts')
    const { workspaceViews } = await import('/src/lib/settings/workspaceViewState.ts')
    const runtime = await import('/src/lib/settings/workspaceRuntime.ts')
    const chapters = await db.getAllChapters()
    const ta = document.querySelector('textarea.novel-textarea')
    const value = ta?.value ?? ''
    const active = chapters.find(chapter => chapter.content === value)
    const scope = runtime.currentWorkspaceScope(db.getCurrentProjectId(), 'editor')
    return { records: chapters.map(chapter => ({ id: chapter.id, has: !!workspaceViews.get(scope, chapter.id) })).filter(row => row.has),
      activeId: active?.id ?? null, valueLength: value.length, focused: document.activeElement === ta }
  })
  // 🔴 判据只能落在**记录归属**上：同一 textarea 节点切章时浏览器会保留像素级 scrollTop
  //    （实测新章开在相同偏移、光标在末尾），所以「像素不同」既不是产品要求也证不了串档；
  //    真正要证的是「上一章的记录没有被套到新章身上」——新章没有记录、只有离开章有。
  check('🔴 ④ 新章没有视图记录，上一章的位置不会落成新章的现场',
    nextDiag.records.length === 1 && nextDiag.activeId !== nextDiag.records[0].id, { beforeSwitch, onNext, nextDiag })
  await page.getByTitle('上一章', { exact: true }).click()   // 回到原章：应恢复刚才的现场
  const timeline = []
  for (let i = 0; i < 12; i += 1) {
    timeline.push(await editor.evaluate(el => ({
      t: Math.round(el.scrollTop), len: el.value.length, sel: el.selectionStart,
      max: Math.max(0, el.scrollHeight - el.clientHeight), active: document.activeElement === el,
    })))
    await page.waitForTimeout(120)
  }
  const backAgain = await readCursor()
  check('🔴 ④ 同页切回原章时现场复原', !!backAgain && Math.abs(backAgain.top - beforeSwitch.top) <= 40 && backAgain.start === beforeSwitch.start, { beforeSwitch, backAgain, timeline })

  // ---------- ⑤ 回来的一瞬间又切走：A 的位置不能漏到 B ----------
  await placeCursor()
  await page.waitForTimeout(200)
  const forLeak = await readCursor()
  await leaveToDashboard()
  await openEditor()
  await page.getByTitle('下一章', { exact: true }).click()   // 恢复在途时切走
  await page.waitForTimeout(1200)
  const leakDiag = await page.evaluate(async ({ id }) => {
    const db = await import('/src/lib/db.ts')
    const { workspaceViews } = await import('/src/lib/settings/workspaceViewState.ts')
    const runtime = await import('/src/lib/settings/workspaceRuntime.ts')
    const chapters = await db.getAllChapters()
    const scope = runtime.currentWorkspaceScope(db.getCurrentProjectId(), 'editor')
    const own = workspaceViews.get(scope, id)
    const others = chapters.filter(chapter => chapter.id !== id && workspaceViews.get(scope, chapter.id)).map(chapter => chapter.id)
    const ta = document.querySelector('textarea.novel-textarea')
    const active = chapters.find(chapter => chapter.content === (ta?.value ?? ''))
    return { ownTop: own && own.kind === 'editor' ? own.scroll.top : null, ownStart: own && own.kind === 'editor' ? own.selection.start : null,
      others, activeId: active?.id ?? null }
  }, { id: activeChapterId })
  // 🔴 真正要保的是：在途恢复**没有改写**原章的记录，且人确实切到了新章。
  //    新章之后自己也有记录是正常行为（它也会被记住），不构成「串档」。
  check('🔴 ⑤ 恢复在途时切走：原章记录仍是离开时的现场，且已切到新章',
    leakDiag.activeId !== activeChapterId
      && Math.abs((leakDiag.ownTop ?? -1) - forLeak.top) <= 40 && leakDiag.ownStart === forLeak.start,
    { forLeak, leakDiag })

  await page.screenshot({ path: path.join(run, 'editor-view.png'), animations: 'disabled' })
  check('全程没有模型请求', report.modelRequests.length === 0, report.modelRequests)
  check('全程没有浏览器运行错误', report.errors.length === 0, report.errors)
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
