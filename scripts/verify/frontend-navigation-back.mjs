// UX05 关联跳转与返回来源：真实浏览器取证。
// 场景：角色页「查看提及」→ 点某章 → 正文里出现「返回：<角色>」→ 点它回到同一张卡；
// 另外证明普通侧栏切换**不会**冒出返回入口。全程隔离示例项目、0 模型请求。
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-navigation-back-'))
const fingerprint = snapshot(root).fingerprint
const report = { kind: 'frontend-navigation-back', at: new Date().toISOString(), run, fingerprint, checks: [], errors: [], modelRequests: [], status: 'running' }
const check = (name, passed, details) => {
  report.checks.push({ name, passed: !!passed, details })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  if (!passed) throw new Error(name + ': ' + JSON.stringify(details))
}
const CARD = '返程甲'
const MARKER = '返程取证标记：这一句里提到了'

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
  // 备份提醒是异步挂的：先等导航进 DOM，再循环关提醒到真的可见
  await page.locator('nav').waitFor({ state: 'attached', timeout: 60000 })
  const dismiss = async () => {
    for (const name of ['稍后再说', '知道了', '跳过，直接开始']) {
      await page.getByRole('button', { name, exact: true }).click({ timeout: 1200 }).catch(() => {})
    }
  }
  const navRole = page.getByRole('navigation')
  const deadline = Date.now() + 45000
  while (Date.now() < deadline && !(await navRole.isVisible().catch(() => false))) {
    await dismiss()
    await page.waitForTimeout(200)
  }
  await navRole.waitFor({ timeout: 10000 })
  page.setDefaultTimeout(20000)

  // ---------- 播种：一张卡 + 一段提到它的正文 ----------
  const seeded = await page.evaluate(async ({ card, marker }) => {
    const db = await import('/src/lib/db.ts')
    const { TABS } = await import('/src/lib/schema.ts')
    const projectId = db.getCurrentProjectId()
    const tab = TABS.find(row => row.group === '角色管理')
    await db.saveCardRecord({ id: 'nav-back-card', name: card, data: { '基础信息::姓名': card }, tabId: tab.id, projectId, order: 800 })
    const chapters = await db.getAllChapters()
    const target = chapters[0]
    // 命中放在**正文中段**：偏移不为 0，才能验证「真的落到那一段」而不是碰巧在第一行
    const head = '开篇雨声未歇，守门人仍站在原地。'.repeat(900)
    const content = `${head}${marker}${card}。\n\n${target.content ?? ''}`
    await db.patchChapter(target.id, { content })
    return { chapterId: target.id, chapterTitle: target.title ?? '',
      expectedOffset: head.length + marker.length, expectedLength: card.length, contentLength: content.length }
  }, { card: CARD, marker: MARKER })
  if (!seeded.chapterId) throw new Error('示例项目没有章节，无法验证跳章返回')

  const nav = navRole
  // 🔴 分组可能是默认展开的：无条件点「角色管理」反而会**收起**它，导致「主要角色」消失
  if (!(await nav.getByRole('button', { name: '主要角色', exact: true }).isVisible().catch(() => false))) {
    await nav.getByRole('button', { name: '角色管理', exact: true }).click()
  }
  await nav.getByRole('button', { name: '主要角色', exact: true }).click()
  const cardButton = page.getByRole('button', { name: '选择角色：' + CARD, exact: true })
  await cardButton.click()
  await page.getByRole('button', { name: '修改名称：' + CARD, exact: true }).waitFor()

  // ---------- ① 提及 → 跳正文章节，出现「返回」入口 ----------
  await page.getByTitle(`查看「${CARD}」在正文中的提及`).click()
  // 用标记文本定位那一行（只有我们改过的那一章含它），不靠章节标题猜
  const row = page.getByRole('button').filter({ hasText: MARKER }).first()
  await row.click()
  // 点完先抓 2 秒时间线：有没有 toast、面板是否关闭、正文有没有出现（判断是"被拦"还是"没触发"）
  const timeline = []
  for (let i = 0; i < 10; i += 1) {
    timeline.push(await page.evaluate(() => ({
      t: Date.now() % 100000,
      alerts: [...document.querySelectorAll('[role="alert"],[role="status"]')].map(n => (n.textContent || '').trim()).filter(Boolean).slice(0, 3),
      panel: !!document.querySelector('[role="dialog"]'),
      textarea: !!document.querySelector('textarea.novel-textarea'),
    })))
    await page.waitForTimeout(200)
  }
  report.timeline = timeline
  const editor = page.locator('textarea.novel-textarea')
  try {
    await editor.waitFor({ timeout: 15000 })
  } catch (error) {
    const diag = await page.evaluate(() => ({
      hasTextarea: !!document.querySelector('textarea.novel-textarea'),
      activeNav: [...document.querySelectorAll('nav button')].filter(b => b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-current')).map(b => (b.textContent || '').trim()).slice(0, 6),
      messages: [...document.querySelectorAll('[role="alert"],[role="status"]')].map(n => (n.textContent || '').trim()).filter(Boolean).slice(0, 4),
      head: (document.body.innerText || '').slice(0, 160),
    }))
    throw new Error('点提及后没进正文：' + JSON.stringify({ diag, timeline }))
  }
  const chip = page.getByRole('button', { name: new RegExp(`返回：${CARD}`) })
  await chip.waitFor({ timeout: 15000 })
  check('🔴 ① 从「提及」跳章后出现明确的返回入口', await chip.isVisible())
  check('🔴 ① 跳过去的正文确实是那一章（内容含标记）', (await editor.inputValue()).includes(MARKER))
  // 段落级定位：光标应落在命中处，且把命中词选中
  const caret = await editor.evaluate(el => ({ start: el.selectionStart, end: el.selectionEnd, top: el.scrollTop, len: el.value.length }))
  check('🔴 ① 落在命中那一段（光标 ＝ 正文内偏移）', caret.start === seeded.expectedOffset, { caret, seeded })
  check('🔴 ① 命中词被选中（一眼看到落在哪）', caret.end === seeded.expectedOffset + seeded.expectedLength, { caret, seeded })
  check('① 定位后滚动位置是有限值（不越界）', Number.isFinite(caret.top) && caret.top >= 0, caret)
  check('长段落软换行的命中确实滚入正文视口', caret.top > 1000, caret)
  await editor.press('ArrowRight')
  const native = await editor.evaluate(el => ({ top: el.scrollTop, line: Number.parseFloat(getComputedStyle(el).lineHeight) }))
  check('原生光标移动无需大幅补滚（命中已经可见）', Math.abs(native.top - caret.top) < native.line * 3, { caret, native })
  check('① 返回入口带来源标签（不是笼统的「返回」）', (await chip.innerText()).includes(CARD))
  report.returnGeometry = []
  for (const density of ['compact','comfortable']) for (const layout of [{width:1366,height:900,zoom:100},{width:1000,height:640,zoom:160},{width:800,height:640,zoom:100}]) {
    await page.setViewportSize({width:layout.width,height:layout.height})
    await page.evaluate(async ({density,zoom}) => {
      (await import('/src/lib/settings/density.ts')).applyDensity(density)
      ;(await import('/src/lib/settings/theme.ts')).applyZoom(zoom,{manual:true})
    }, {...layout,density})
    await page.waitForTimeout(180)
    const geometry = await page.evaluate(() => {
      const chip = [...document.querySelectorAll('button[aria-label^="返回："]')].find(el=>el.offsetParent!==null)
      const a=chip?.getBoundingClientRect(), save=document.querySelector('button[aria-label="保存正文"]'), b=save?.getBoundingClientRect()
      const hit=b&&document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)
      const overlaps=a?[...document.querySelectorAll('main button,main input')].filter(el=>{
        const r=el.getBoundingClientRect()
        return Math.max(a.left,r.left)<Math.min(a.right,r.right)&&Math.max(a.top,r.top)<Math.min(a.bottom,r.bottom)
      }).map(el=>el.getAttribute('title')||el.getAttribute('aria-label')||el.textContent):['missing return']
      return {overlaps,saveReachable:!!save&&(hit===save||save.contains(hit)),bodyHeight:document.querySelector('textarea.novel-textarea')?.clientHeight,
        returnName:chip?.getAttribute('aria-label')}
    })
    report.returnGeometry.push({...layout,density,...geometry})
    check(`返回入口不遮挡控件且保存可点，正文不少于80px：${density}/${layout.width}/${layout.zoom}%`,
      geometry.overlaps.length===0&&geometry.saveReachable&&geometry.bodyHeight>=80&&geometry.returnName===`返回：${CARD}`, geometry)
  }
  await page.setViewportSize({width:1366,height:900})
  await page.evaluate(async()=>{
    (await import('/src/lib/settings/density.ts')).applyDensity('compact')
    ;(await import('/src/lib/settings/theme.ts')).applyZoom(100,{manual:true})
  })
  await page.waitForTimeout(200)

  // Real IDB failure: a failed back request must keep its retry entry and the original DOM/draft.
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    window.__navRestorePut = () => { IDBObjectStore.prototype.put = original }
    window.__navFailedPuts = 0
    IDBObjectStore.prototype.put = function(value, ...args) {
      if (this.name === 'chapters') { window.__navFailedPuts++; throw new DOMException('navigation fixture', 'QuotaExceededError') }
      return original.call(this, value, ...args)
    }
  })
  const edited = (await editor.inputValue()) + '\n导航返回失败后仍保留草稿'
  await editor.fill(edited); await chip.click()
  await page.waitForFunction(() => document.body.innerText.includes('已留在当前页面'))
  check('真实写入失败已命中且返回入口仍保留', await page.evaluate(() => window.__navFailedPuts > 0) && await chip.isVisible())
  check('返回失败保留当前正文和原草稿', await editor.isVisible() && await editor.inputValue() === edited)
  await page.evaluate(() => window.__navRestorePut())
  // ---------- ② 点返回：回到同一张卡 ----------
  await chip.click()
  await page.getByRole('button', { name: '修改名称：' + CARD, exact: true }).waitFor({ timeout: 15000 })
  const pressed = await cardButton.getAttribute('aria-pressed')
  check('🔴 ② 返回后回到角色页并选中同一张卡', pressed === 'true', { pressed })
  check('🔴 ② 返回入口用过即消失（不留悬空入口）', (await chip.count()) === 0)

  // ---------- ③ 普通侧栏切换不产生返回入口 ----------
  await nav.getByRole('button', { name: '写作面板', exact: true }).click()
  await page.waitForTimeout(400)
  await nav.getByRole('button', { name: '正文编辑', exact: true }).click()
  await editor.waitFor()
  await page.waitForTimeout(600)
  check('🔴 ③ 普通侧栏导航不产生返回入口（不进历史栈）', (await chip.count()) === 0)

  const revision = await page.evaluate(async id => {
    const db = await import('/src/lib/db.ts'), {contentRevision} = await import('/src/lib/editor/editorViewMath.ts')
    return contentRevision((await db.getAllChapters()).find(c => c.id === id).content)
  }, seeded.chapterId)
  const locate = () => page.evaluate(data => window.dispatchEvent(new CustomEvent('yfe:navigate', {
    detail: { tabId: 'editor', chapterId: data.chapterId, offset: data.offset, matchLength: data.length, revision: data.revision },
  })), { chapterId: seeded.chapterId, offset: seeded.expectedOffset, length: seeded.expectedLength, revision })
  await locate()
  await page.waitForFunction(start => document.querySelector('textarea.novel-textarea')?.selectionStart === start, seeded.expectedOffset)
  await page.getByTitle('下一章', {exact: true}).click()
  await page.waitForFunction(marker => !document.querySelector('textarea.novel-textarea')?.value.includes(marker), MARKER)
  await locate()
  await page.waitForFunction(data => {
    const ta = document.querySelector('textarea.novel-textarea')
    return ta?.value.includes(data.marker) && ta.selectionStart === data.start && ta.selectionEnd === data.start + data.length
  }, {marker: MARKER, start: seeded.expectedOffset, length: seeded.expectedLength})
  check('同ID同偏移重复请求在手动切章后仍准确定位', true)
  await editor.press('ArrowRight'); await page.waitForTimeout(400)
  const afterInteraction = await editor.evaluate(el => ({ start: el.selectionStart, end: el.selectionEnd }))
  check('作者移动光标后不被旧显式请求拉回', afterInteraction.start === afterInteraction.end && afterInteraction.start !== seeded.expectedOffset, afterInteraction)

  // Mentioning a non-selected card must return to that card, not the unrelated active draft.
  await nav.getByRole('button', {name: '主要角色', exact: true}).click()
  const otherCard = page.getByRole('button', {name: /^选择角色：/}).filter({hasNotText: CARD}).first()
  await otherCard.click()
  await page.getByTitle(`查看「${CARD}」在正文中的提及`).click()
  await page.getByRole('button').filter({hasText: MARKER}).first().click()
  await chip.waitFor(); await editor.waitFor()
  check('查看非当前选中卡的提及时仍保留准确来源', (await chip.innerText()).includes(CARD))
  await page.setViewportSize({width:800,height:640})
  await page.waitForTimeout(180)
  await chip.focus(); await page.keyboard.press('Enter')
  await page.getByRole('button', {name: '修改名称：'+CARD, exact:true}).waitFor()
  check('返回的是提及来源卡而非原先选中卡', await cardButton.getAttribute('aria-pressed') === 'true')
  await page.setViewportSize({width:1366,height:900})
  await page.waitForTimeout(180)

  // Identity protocol change in this fake profile: only ephemeral navigation metadata is cleared.
  await page.getByTitle(`查看「${CARD}」在正文中的提及`).click()
  await page.getByRole('button').filter({hasText: MARKER}).first().click(); await chip.waitFor()
  await page.evaluate(() => { window.__YFE_USER__ = {id:'isolated-new-owner'}; window.dispatchEvent(new StorageEvent('storage', {key:'navigation-owner-probe'})) })
  await chip.waitFor({state:'hidden'})
  check('账户身份协议变化立即清理旧来源入口', true)

  // A search-time offset must not be applied to a changed body, even if the length is unchanged.
  const replacement = await page.evaluate(async id => {
    const db = await import('/src/lib/db.ts'), {contentRevision} = await import('/src/lib/editor/editorViewMath.ts')
    const chapter = (await db.getAllChapters()).find(c => c.id === id)
    const previousRevision = contentRevision(chapter.content), text = '新稿' + chapter.content.slice(2)
    await db.patchChapter(id, {content: text})
    return {previousRevision, text}
  }, seeded.chapterId)
  await nav.getByRole('button', {name:'写作面板',exact:true}).click()
  await nav.getByRole('button', {name:'正文编辑',exact:true}).click(); await editor.waitFor()
  await page.waitForFunction(text => document.querySelector('textarea.novel-textarea')?.value === text, replacement.text)
  await editor.evaluate(el => { el.setSelectionRange(1,1); el.scrollTop = 0 })
  await page.evaluate(data => window.dispatchEvent(new CustomEvent('yfe:navigate', {detail:{tabId:'editor', chapterId:data.id,
    offset:data.offset, matchLength:data.length, revision:data.revision}})),
  {id:seeded.chapterId, offset:seeded.expectedOffset, length:seeded.expectedLength, revision:replacement.previousRevision})
  await page.getByText('章节内容已更新，已打开章节；请重新检索定位',{exact:true}).waitFor()
  check('同长度改稿也拒绝旧偏移并保留当前光标', await editor.evaluate(el => el.selectionStart === 1 && el.selectionEnd === 1))
  check('过期定位不覆盖当前权威正文', await editor.inputValue() === replacement.text)

  // Delayed font readiness is a controlled protocol fixture, not a physical-font/device claim.
  await page.evaluate(() => {
    const fonts=document.fonts, status=Object.getOwnPropertyDescriptor(fonts,'status'), ready=Object.getOwnPropertyDescriptor(fonts,'ready')
    Object.defineProperty(fonts,'status',{configurable:true,get:()=> 'loading'})
    Object.defineProperty(fonts,'ready',{configurable:true,value:new Promise(()=>{})})
    window.__restoreFontReadiness=()=>{
      if(status)Object.defineProperty(fonts,'status',status);else delete fonts.status
      if(ready)Object.defineProperty(fonts,'ready',ready);else delete fonts.ready
    }
  })
  const currentRevision = await page.evaluate(async text => (await import('/src/lib/editor/editorViewMath.ts')).contentRevision(text), replacement.text)
  const locateFresh = () => page.evaluate(data => window.dispatchEvent(new CustomEvent('yfe:navigate',{detail:{tabId:'editor',chapterId:data.id,
    offset:data.offset,matchLength:data.length,revision:data.revision}})),
  {id:seeded.chapterId,offset:seeded.expectedOffset,length:seeded.expectedLength,revision:currentRevision})
  await locateFresh();await page.waitForTimeout(80)
  const typed = replacement.text + 'X'
  await editor.fill(typed);await page.keyboard.press('Control+s')
  await page.evaluate(()=>window.__restoreFontReadiness())
  await page.waitForFunction(async data => (await (await import('/src/lib/db.ts')).getAllChapters()).find(c=>c.id===data.id)?.content===data.text,
    {id:seeded.chapterId,text:typed})
  await page.waitForTimeout(700)
  check('字体延迟期间用户输入取消定位，保存后旧请求不复活', await editor.evaluate(el=>el.selectionStart===el.value.length&&el.selectionEnd===el.value.length))
  const latestRevision = await page.evaluate(async text => (await import('/src/lib/editor/editorViewMath.ts')).contentRevision(text), typed)
  await page.evaluate(data=>window.dispatchEvent(new CustomEvent('yfe:navigate',{detail:{tabId:'editor',chapterId:data.id,
    offset:data.offset,matchLength:data.length,revision:data.revision}})),
  {id:seeded.chapterId,offset:seeded.expectedOffset,length:seeded.expectedLength,revision:latestRevision})
  await page.waitForFunction(data=>{
    const ta=document.querySelector('textarea.novel-textarea')
    return ta.selectionStart===data.start&&ta.selectionEnd===data.start+data.length
  },{start:seeded.expectedOffset,length:seeded.expectedLength})
  check('取消后新的有效定位请求仍可正常选中命中词', true)

  // Destination checks are real isolated-library reads; errors must not masquerade as deletion.
  await nav.getByRole('button', {name: '主要角色', exact: true}).click()
  await page.getByTitle(`查看「${CARD}」在正文中的提及`).click()
  await page.getByRole('button').filter({hasText: MARKER}).first().click()
  await chip.waitFor(); await editor.waitFor()
  const bodyBeforeReadFailure = await editor.inputValue()
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.getAll
    window.__navRestoreRead = () => { IDBObjectStore.prototype.getAll = original }
    window.__navFailedReads = 0
    IDBObjectStore.prototype.getAll = function(...args) {
      if (this.name === 'cardRecords') { window.__navFailedReads++; throw new DOMException('navigation read fixture', 'UnknownError') }
      return original.apply(this, args)
    }
  })
  await chip.click()
  await page.waitForFunction(() => document.body.innerText.includes('暂时无法读取目标'))
  check('真实读取失败留在正文且保留返回入口，不假报记录删除', await page.evaluate(() => window.__navFailedReads > 0)
    && await chip.isVisible() && await editor.inputValue() === bodyBeforeReadFailure)
  await page.evaluate(async () => {
    window.__navRestoreRead()
    await (await import('/src/lib/db.ts')).deleteCardRecord('nav-back-card')
  })
  await chip.click()
  await page.waitForFunction(() => document.body.innerText.includes('目标记录已不存在'))
  await editor.waitFor({state:'hidden'})
  check('已删除的返回来源退回有效写作面板，成功后消费返回入口', await chip.count() === 0
    && await nav.getByRole('button', {name:'写作面板', exact:true}).getAttribute('aria-current') === 'page')
  const deletedCardAbsent = await page.evaluate(async () => {
    const db = await import('/src/lib/db.ts'), {TABS} = await import('/src/lib/schema.ts')
    const tab = TABS.find(row => row.group === '角色管理')
    return !(await db.getCardRecords(tab.id)).some(row => row.id === 'nav-back-card')
  })
  check('失效返回不重建已删除角色', deletedCardAbsent)
  await page.evaluate(async id => {
    const db = await import('/src/lib/db.ts')
    await db.deleteChapter(id)
    window.dispatchEvent(new CustomEvent('yfe:navigate', {detail:{tabId:'editor',chapterId:id,offset:12}}))
  }, seeded.chapterId)
  await page.waitForFunction(() => document.body.innerText.includes('目标章节已不存在'))
  check('已删除章节放弃旧偏移并留在有效面板，不打开缓存旧稿', await editor.count() === 0
    && await page.evaluate(async id => !(await (await import('/src/lib/db.ts')).getAllChapters()).some(c=>c.id===id), seeded.chapterId))
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('yfe:navigate', {detail:'removed-unknown-tab'})))
  await page.waitForFunction(() => document.body.innerText.includes('目标页面已隐藏或不可用'))
  check('不可用页面有明确说明并回到写作面板', !(await page.locator('main').innerText()).includes('页签不存在'))

  await page.screenshot({ path: path.join(run, 'navigation-back.png'), animations: 'disabled' })
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
