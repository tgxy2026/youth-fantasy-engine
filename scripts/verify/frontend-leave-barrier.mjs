// UX06 样板：离页屏障的真实取证（真实浏览器 + 真实 IDB + 真实写入失败注入）。
//
// 守的缺口：「正文写盘失败 → 仍然切页签 / 退出项目 → 界面看起来正常 → 重启少一章」。
// 取证方式与 `draft-failure.mjs` 同口径：只给 `IDBObjectStore.put` 加一层
// 「只拦 chapters 仓库」的失败注入，不碰产品代码、不改保存结果；示范项目在临时上下文里，
// 不读写真实书库、不发任何模型请求。
//
// 覆盖两条离页路径 × 两种脏数据：
//   · 换页签（navigate）＋ 正文脏 → 必须留在原页；
//   · 换页签 ＋ 标题/摘要脏 → 必须留在原页（scope=meta 的文案）；
//   · 退出项目（切换项目）＋ 脏 → 必须不退出；
//   · 干净时离页 → 不得触发屏障、不得弹「已留在当前页面」。
// 恢复写入后必须**真的落库**（回读 IDB 内容），否则「留在原页」只是假绿。
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-leave-barrier-'))
const fingerprint = snapshot(root).fingerprint
const report = { kind: 'frontend-leave-barrier', at: new Date().toISOString(), run, fingerprint, checks: [], errors: [], modelRequests: [], status: 'running' }
const check = (name, passed, details) => {
  report.checks.push({ name, passed: !!passed, details })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  if (!passed) throw new Error(name + ': ' + JSON.stringify(details))
}
const TYPED_CONTENT = '离页屏障探针：这段要么落库，要么就留在原地（不许悄悄丢）'
const TYPED_TITLE = '·离页屏障'

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
  // 🔴 进项目后真实备份提醒会盖住导航（截图确认过：failure.png「导出一份备份吧」）——
  //    必须先关它再等 navigation，否则会白等满超时（与 frontend-editor 同口径）。
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  await later.waitFor({ timeout: 60000 })
  await later.click()
  await page.getByRole('navigation').waitFor()
  page.setDefaultTimeout(15000)

  const nav = name => page.getByRole('navigation').getByRole('button', { name, exact: true })
  const editor = page.locator('textarea.novel-textarea')
  const openEditor = async () => { await nav('正文编辑').click(); await editor.waitFor() }
  const bodyText = () => page.evaluate(() => document.body.innerText)
  const typeAt = async (locator, text) => {
    await locator.click()
    await locator.evaluate(el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length) })
    await locator.pressSequentially(text, { delay: 8 })
  }
  /** 只拦 chapters 仓库的 put；`fail=false` 时仅计数，用来证明「干净时根本没写」 */
  const installProbe = () => page.evaluate(() => {
    const proto = IDBObjectStore.prototype
    if (!window.__leaveProbeOriginal) window.__leaveProbeOriginal = proto.put
    window.__leaveProbeOriginal && (proto.put = window.__leaveProbeOriginal)
    window.__leaveProbe = { hit: 0, fail: true }
    const original = proto.put
    proto.put = function (value, key) {
      if (this.name === 'chapters') {
        if (window.__leaveProbe.fail) { window.__leaveProbe.hit += 1; throw new DOMException('probe injected chapter write failure', 'UnknownError') }
        window.__leaveProbe.hit += 1
      }
      return key === undefined ? original.call(this, value) : original.call(this, value, key)
    }
  })
  const setFail = fail => page.evaluate(v => { window.__leaveProbe.fail = v }, fail)
  const probeHit = () => page.evaluate(() => window.__leaveProbe?.hit ?? 0)
  const restorePut = () => page.evaluate(() => { if (window.__leaveProbeOriginal) IDBObjectStore.prototype.put = window.__leaveProbeOriginal })
  const readChapters = () => page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('youth-fantasy-engine'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const rows = await new Promise((res, rej) => { const tx = db.transaction('chapters'); const q = tx.objectStore('chapters').getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error) })
    return rows.map(r => ({ id: r.id, title: r.title, content: r.content || '' }))
  })

  // ================= ① 脏正文 + 写盘失败：不许换页签 =================
  await openEditor()
  // 🔴 注入必须在**输入之前**装好：否则 2 秒自动保存先成功，草稿就干净了，
  //    离页时自然没有东西要存（会得到一个「看起来通过」的空验证）。
  await installProbe()
  await typeAt(editor, TYPED_CONTENT)
  await page.waitForTimeout(1400)

  await nav('写作面板').click()
  await page.waitForTimeout(1500)
  const hitAfterNav = await probeHit()
  const stillOnEditor = await editor.isVisible().catch(() => false)
  const typedKept = stillOnEditor && (await editor.inputValue()).includes(TYPED_CONTENT)
  const stayToast = (await bodyText()).includes('已留在当前页面')

  check('① 离页时确实尝试了写盘（注入命中）', hitAfterNav >= 1, { hit: hitAfterNav })
  check('🔴 ① 写盘失败时不换页签（仍停在正文编辑）', stillOnEditor === true)
  check('🔴 ① 原草稿完整保留在输入框里', typedKept === true)
  check('🔴 ① 明确告知「已留在当前页面」', stayToast === true)
  check('① 写失败时不假装已保存（状态行不显示「已保存」）', !(await bodyText()).includes('已保存'))

  // ================= ② 恢复写入后：真的落库、然后才放行 =================
  await setFail(false)
  await page.waitForTimeout(200)
  await nav('写作面板').click()
  await page.waitForTimeout(1800)
  const leftEditor = !(await editor.isVisible().catch(() => false))
  const rows = await readChapters()
  const persisted = rows.some(r => (r.content || '').includes(TYPED_CONTENT))
  check('② 恢复写入后可以正常换页签', leftEditor === true)
  check('🔴 ② 放行前那一段正文已经真的写进 IDB（回读命中）', persisted === true, { chapters: rows.length })

  // ================= ③ 干净时离页：不触发屏障、不加等待 =================
  await page.waitForTimeout(3000) // 等旧 toast 自然消失，避免误判
  await openEditor()
  await page.evaluate(() => { window.__leaveProbe.hit = 0 })
  await nav('写作面板').click()
  await page.waitForTimeout(900)
  const cleanLeft = !(await editor.isVisible().catch(() => false))
  const cleanToast = (await bodyText()).includes('已留在当前页面')
  check('🔴 ③ 没有脏稿时照常离页', cleanLeft === true)
  check('🔴 ③ 没有脏稿时不弹「已留在当前页面」', cleanToast === false)
  check('🔴 ③ 没有脏稿时不额外写盘（屏障不介入）', (await probeHit()) === 0, { hit: await probeHit() })

  // 导航事件的目标行必须跟页签一起提交，失败不能遗留给下一次普通导航。
  await page.evaluate(async () => {
    const db = await import('/src/lib/db.ts'), projectId = db.getCurrentProjectId()
    for (const [index, name] of ['导航首卡', '导航目标卡'].entries()) {
      await db.saveCardRecord({ id: 'nav-gate-card-' + index, projectId, tabId: 'char-main', name, data: {}, order: -10000 + index })
    }
  })
  await openEditor(); await setFail(true)
  await typeAt(editor, '导航目标事务正文')
  const locateCard = () => page.evaluate(() => window.dispatchEvent(new CustomEvent('yfe:navigate', { detail: { tabId: 'char-main', rowId: 'nav-gate-card-1' } })))
  await locateCard()
  await page.waitForFunction(() => document.body.innerText.includes('已留在当前页面'))
  check('导航目标事务：真实保存失败后仍保留正文页面', await editor.isVisible())
  await setFail(false)
  if (!await nav('主要角色').isVisible()) await nav('角色管理').click()
  await nav('主要角色').click()
  await page.getByRole('button', { name: '修改名称：导航首卡', exact: true }).waitFor()
  check('导航目标事务：失败目标不污染随后普通导航', await page.getByRole('button', { name: '修改名称：导航首卡', exact: true }).isVisible())
  await locateCard()
  await page.getByRole('button', { name: '修改名称：导航目标卡', exact: true }).waitFor()
  check('导航目标事务：同页显式事件正确提交目标卡', await page.getByRole('button', { name: '修改名称：导航目标卡', exact: true }).isVisible())

  // ================= ④ 标题/摘要脏：也要拦住，且文案说清是哪一块 =================
  await openEditor()
  await setFail(true)
  const titleBox = page.getByRole('textbox', { name: '章节标题', exact: true })
  await typeAt(titleBox, TYPED_TITLE)
  await page.waitForTimeout(1200) // 让 600ms 防抖那笔先失败入队
  await nav('写作面板').click()
  await page.waitForTimeout(1500)
  const metaStill = await editor.isVisible().catch(() => false)
  const metaText = await bodyText()
  check('🔴 ④ 标题没存上时同样不换页签', metaStill === true)
  check('🔴 ④ 文案指明是标题/摘要（不是笼统一句「保存失败」）', metaText.includes('标题或摘要'), { sample: metaText.slice(0, 200) })
  check('④ 标题内容仍留在输入框里', (await titleBox.inputValue()).includes(TYPED_TITLE))

  // ================= ⑤ 退出项目：同样先过屏障 =================
  // 此时仍在编辑器（上一步被拦住），标题那笔还在待冲刷队列里
  await page.getByRole('button', { name: '切换项目', exact: true }).click()
  await page.waitForTimeout(1500)
  const exitBlocked = await editor.isVisible().catch(() => false)
  const exitText = await bodyText()
  check('🔴 ⑤ 有脏稿时不退出项目（仍留在编辑器）', exitBlocked === true)
  check('🔴 ⑤ 文案说清「还没退出项目」', exitText.includes('还没退出项目'), { sample: exitText.slice(0, 200) })

  // 恢复后退出应成功
  await setFail(false)
  await page.waitForTimeout(200)
  await page.getByRole('button', { name: '切换项目', exact: true }).click()
  await page.waitForTimeout(2000)
  const exited = !(await editor.isVisible().catch(() => false)) && !(await page.getByRole('button', { name: '切换项目', exact: true }).isVisible().catch(() => false))
  check('🔴 ⑤ 存干净后可以正常退出项目', exited === true)

  await page.screenshot({ path: path.join(run, 'leave-barrier.png'), animations: 'disabled' })
  check('全程没有模型请求', report.modelRequests.length === 0, report.modelRequests)
  check('全程没有浏览器运行错误', report.errors.length === 0, report.errors)
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error.stack || String(error)
  await page?.screenshot({ path: path.join(run, 'failure.png'), fullPage: true, animations: 'disabled' }).catch(() => {})
} finally {
  await browser?.close()
  await server?.close()
  report.stale = fingerprint !== snapshot(root).fingerprint
  if (report.stale) report.status = 'failed'
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ status: report.status, run, passed: report.checks.filter(c => c.passed).length, total: report.checks.length, error: report.error, stale: report.stale }))
  if (report.status !== 'passed') process.exitCode = 1
}
