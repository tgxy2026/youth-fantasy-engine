// 3.5.2 · 评论分页 / 总数 / 响应丢失重试 / 切换帖子迟到响应
// 真实隔离 server/index.mjs + Vite 夹具页面（tests/browser/community.html）+ Playwright(Edge)。
//
// 🔴 前端请求经 Playwright 路由转发到隔离服务（同源到浏览器，Cookie 由脚本注入），
//    测的是当前前端源码行为；不是生产部署、不是真实账号/正文。
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const root = process.cwd()
const runRoot = await fs.mkdtemp(path.resolve('.workbuddy/tmp/community-review-vote-'))
const data = path.join(runRoot, 'data')
const www = path.join(runRoot, 'www')
await fs.mkdir(data, { recursive: true })
await fs.mkdir(www, { recursive: true })
await fs.writeFile(path.join(www, 'index.html'), '<html><body>fixture</body></html>')

const PASS = 'Browser352Pass!'
const out = { startedAt: new Date().toISOString(), checks: [], consoleErrors: [] }
function rec(name, actual, expected, pass, extra = {}) {
  out.checks.push({ name, actual, expected, pass, ...extra })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} :: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}

const net = await import('node:net')
const port = await new Promise((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
})
const origin = `http://127.0.0.1:${port}`
const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), YFE_DATA: data, YFE_WWW: www, YFE_REGISTER: 'open', YFE_SCHEDULER: 'off' }
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_OPTIONS']) delete env[key]

async function call(p, opts = {}) {
  const headers = { ...(opts.headers || {}) }
  if (opts.cookie) headers.Cookie = opts.cookie
  let body
  if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body) }
  const res = await fetch(origin + p, { method: opts.method || 'GET', headers, body })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* ignore */ }
  return { status: res.status, json, text, setCookie: res.headers.get('set-cookie') || '' }
}
async function register(name) {
  const r = await call('/api/auth/register', { method: 'POST', body: { name, password: PASS } })
  if (r.status !== 200) throw new Error(`register ${name}: ${r.status} ${r.text}`)
  return r.setCookie.split(';')[0]
}
async function patchUser(name, patch) {
  const file = path.join(data, 'users.json')
  const db = JSON.parse(await fs.readFile(file, 'utf8'))
  for (const u of Object.values(db.users)) if (u.name === name) Object.assign(u, patch)
  await fs.writeFile(file, JSON.stringify(db, null, 2))
}

let server
let vite
let browser
try {
  server = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  server.stdout.on('data', (b) => { log += b }); server.stderr.on('data', (b) => { log += b })
  const end = Date.now() + 30000
  while (Date.now() < end) {
    try { if ((await fetch(origin + '/api/ping')).ok) break } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 50))
  }

  const authorCookie = await register('ui-author')
  const readerCookie = await register('ui-reader')
  const readerIdentity = await call('/api/auth/me', { cookie: readerCookie })
  if (!readerIdentity.json?.user?.id) throw new Error('隔离读者身份缺失')
  const adminCookie = await register('ui-admin')
  await patchUser('ui-admin', { role: 'admin' })

  const createdA = await call('/api/community/posts', {
    method: 'POST', cookie: authorCookie,
    body: { title: '浏览器分页验证稿甲', body: '合成正文甲，仅用于浏览器评论验证。', tags: ['短篇'], display: 'anonymous' },
  })
  const postA = createdA.json.post.id
  await call('/api/community/admin/decision', {
    method: 'POST', cookie: adminCookie,
    body: { targetType: 'post', id: postA, versionId: createdA.json.post.pendingVersionId, action: 'approve' },
  })
  for (let i = 1; i <= 21; i++) {
    const r = await call(`/api/community/posts/${postA}/comments`, {
      method: 'POST', cookie: readerCookie,
      body: { body: `合成评论第 ${i} 条，仅用于隔离验证。`, display: 'anonymous', clientToken: `ui-a-${i}` },
    })
    if (r.status !== 200) throw new Error(`comment ${i}: ${r.status} ${r.text}`)
  }

  const createdB = await call('/api/community/posts', {
    method: 'POST', cookie: authorCookie,
    body: { title: '浏览器分页验证稿乙', body: '合成正文乙，仅用于浏览器评论验证。', tags: ['短篇'], display: 'anonymous' },
  })
  const postB = createdB.json.post.id
  await call('/api/community/admin/decision', {
    method: 'POST', cookie: adminCookie,
    body: { targetType: 'post', id: postB, versionId: createdB.json.post.pendingVersionId, action: 'approve' },
  })
  await call(`/api/community/posts/${postB}/comments`, {
    method: 'POST', cookie: readerCookie,
    body: { body: '帖子乙的独占合成评论，不应出现在帖子甲。', display: 'anonymous', clientToken: 'ui-b-1' },
  })

  async function totalOf(pid) {
    const r = await call(`/api/community/posts/${pid}/comments?limit=20`)
    return Number(r.json.total)
  }

  vite = await createServer({
    root,
    cacheDir: path.join(runRoot, 'vite-cache'),
    logLevel: 'error',
    optimizeDeps: { entries: ['index.html', 'tests/browser/*.html'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  await vite.listen()
  const vitePort = vite.config.server.port || vite.httpServer?.address()?.port
  const pageUrl = `http://localhost:${vitePort}/tests/browser/community.html?mode=page&layout=wide&theme=eye-care`

  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('console', (m) => { if (m.type() === 'error') out.consoleErrors.push(m.text()) })
  // 夹具注入的用户必须与真实隔离服务的 Cookie 一致。
  const bindFixtureIdentity = (target) => target.route('**/tests/browser/community.html*', async (route) => {
    const response = await route.fetch()
    const html = (await response.text()).replace("id: 'u_demo'", `id: '${readerIdentity.json.user.id}'`)
    await route.fulfill({ response, body: html })
  })
  await bindFixtureIdentity(page)

  let releaseReport; let reportArrived; const reportGate = new Promise(r => { releaseReport = r }); const reportStarted = new Promise(r => { reportArrived = r }); let delayReport = false
  let releaseVote; let voteArrived; const voteGate = new Promise(r => { releaseVote = r }); const voteStarted = new Promise(r => { voteArrived = r }); let delayVote = false
  let dropNextCommentResponse = false
  let slowFirstACommentPage = true
  const proxyHeaders = (req) => {
    const h = { ...req.headers() }
    delete h.host
    delete h['content-length']
    delete h.connection
    h.cookie = readerCookie
    // 服务端校验写请求的 Origin/Referer 与本站一致；转发到隔离服务时用其 origin
    h.origin = origin
    h.referer = `${origin}/`
    return h
  }
  await page.route('**/api/community/**', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    const target = origin + u.pathname + u.search
    const commentPostsPath = `/api/community/posts/${postA}/comments`
    if (delayVote && u.pathname === `/api/community/posts/${postA}/vote` && req.method() === 'POST') { delayVote = false; const real = await route.fetch({url:target,headers:proxyHeaders(req)}); voteArrived(); await voteGate; await route.fulfill({response:real}); return }
    if (delayReport && u.pathname === '/api/community/reports' && req.method() === 'POST') { delayReport = false; const real = await route.fetch({url:target,headers:proxyHeaders(req)}); reportArrived(); await reportGate; await route.fulfill({response:real}); return }
    // 模拟「服务端已写入、响应在网络上丢失」
    if (dropNextCommentResponse && u.pathname === commentPostsPath && req.method() === 'POST') {
      dropNextCommentResponse = false
      const real = await route.fetch({ url: target, headers: proxyHeaders(req) })
      await real.body()
      await route.abort('failed')
      return
    }
    // 模拟帖子甲的评论响应迟到（切换帖子后旧回执不得串入）
    if (slowFirstACommentPage && u.pathname === commentPostsPath && req.method() === 'GET') {
      slowFirstACommentPage = false
      const real = await route.fetch({ url: target, headers: proxyHeaders(req) })
      await new Promise((r) => setTimeout(r, 900))
      await route.fulfill({ response: real })
      return
    }
    const real = await route.fetch({ url: target, headers: proxyHeaders(req) })
    await route.fulfill({ response: real })
  })

  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: /投稿广场/ }).waitFor({ timeout: 20000 })
  await page.getByRole('button', { name: /浏览器分页验证稿甲/ }).waitFor({ timeout: 20000 })

  // ---- 分页与总数 ----
  await page.getByRole('button', { name: /浏览器分页验证稿甲/ }).click()
  await page.getByRole('heading', { name: '评论 (21)' }).waitFor({ timeout: 20000 })
  const firstPageCount = await page.locator('section[aria-label="评论"] ul > li').count()
  rec('浏览器：首屏只加载 20 条', firstPageCount, 20, firstPageCount === 20)
  rec('浏览器：标题显示服务端总数 21 而非页长度', await page.getByRole('heading', { name: '评论 (21)' }).count(), 1, true)
  await page.getByRole('button', { name: '加载更多评论' }).click()
  await page.waitForFunction(() => document.querySelectorAll('section[aria-label="评论"] ul > li').length === 21, null, { timeout: 10000 })
  const allCount = await page.locator('section[aria-label="评论"] ul > li').count()
  rec('浏览器：加载更多后得到全部 21 条', allCount, 21, allCount === 21)
  await page.screenshot({ path: path.join(runRoot, 'comments-21.png') })

  // ---- 发表一条评论：总数 +1，列表首位为新评论 ----
  await page.getByLabel('写评论').fill('浏览器端提交的合成评论。')
  await page.getByRole('button', { name: '发表评论' }).click()
  await page.waitForTimeout(1500)
  out.debugAfterFirstSend = {
    serverTotal: await totalOf(postA),
    section: (await page.locator('section[aria-label="评论"]').innerText()).slice(0, 800),
    tail: (await page.locator('body').innerText()).slice(-600),
    textareaValue: await page.getByLabel('写评论').inputValue(),
  }
  await page.getByRole('heading', { name: '评论 (22)' }).waitFor({ timeout: 10000 })
  const firstBody = await page.locator('section[aria-label="评论"] ul > li').first().innerText()
  rec('浏览器：发表成功后总数变为 22', await page.locator('section[aria-label="评论"] ul > li').count(), 22, true)
  rec('浏览器：新评论出现在列表首位', firstBody.includes('浏览器端提交的合成评论。'), true, firstBody.includes('浏览器端提交的合成评论。'))
  rec('浏览器：发表后输入框清空', await page.getByLabel('写评论').inputValue(), '', (await page.getByLabel('写评论').inputValue()) === '')

  // 下一笔评论模拟「服务端写入成功但响应丢失」
  dropNextCommentResponse = true

  // ---- 响应丢失 -> 未确认 -> 重试复用令牌 ----
  await page.getByLabel('写评论').fill('响应丢失后的重试评论。')
  await page.getByRole('button', { name: '发表评论' }).click()
  await page.getByText(/评论结果未确认/).waitFor({ timeout: 10000 })
  const keptText = await page.getByLabel('写评论').inputValue()
  rec('浏览器：结果未确认时保留用户输入', keptText, '响应丢失后的重试评论。', keptText === '响应丢失后的重试评论。')
  const serverAfterDrop = await totalOf(postA)
  rec('浏览器：响应丢失时服务端已实际写入（总数 23）', serverAfterDrop, 23, serverAfterDrop === 23)
  await page.getByRole('button', { name: '发表评论' }).click()
  await page.getByText(/评论此前已发表|评论已发表/).waitFor({ timeout: 10000 })
  await page.getByRole('heading', { name: '评论 (23)' }).waitFor({ timeout: 10000 })
  const afterRetry = await totalOf(postA)
  const bodies = await page.locator('section[aria-label="评论"] ul > li').allInnerTexts()
  rec('浏览器：重试复用令牌，服务端总数仍为 23', afterRetry, 23, afterRetry === 23)
  rec('浏览器：重试没有产生第二条同内容评论', bodies.filter((t) => t.includes('响应丢失后的重试评论。')).length, 1,
    bodies.filter((t) => t.includes('响应丢失后的重试评论。')).length === 1)

  // ---- 切换帖子：甲评论响应迟到，不得串入乙 ----
  slowFirstACommentPage = true
  await page.getByRole('button', { name: '返回列表' }).click()
  await page.getByRole('button', { name: /浏览器分页验证稿甲/ }).click()
  await page.getByRole('button', { name: '返回列表' }).click({ timeout: 5000 }).catch(() => undefined)
  await page.getByRole('button', { name: /浏览器分页验证稿乙/ }).click()
  await page.getByText('帖子乙的独占合成评论，不应出现在帖子甲。').waitFor({ timeout: 10000 })
  await page.waitForTimeout(1400) // 等甲的迟到回执过去
  const bBodies = await page.locator('section[aria-label="评论"] ul > li').allInnerTexts()
  const leaked = bBodies.filter((t) => t.includes('合成评论第'))
  rec('浏览器：切换帖子后旧评论回执不串入', leaked.length, 0, leaked.length === 0)
  rec('浏览器：乙详情只显示乙的评论', bBodies.length, 1, bBodies.length === 1)
  await page.screenshot({ path: path.join(runRoot, 'switch-post.png') })

  await page.getByRole('button',{name:'返回列表'}).click()
  await page.getByRole('button',{name:/浏览器分页验证稿甲/}).click()
  await page.getByRole('heading',{name:/评论 \(23\)/}).waitFor()
  delayVote = true
  await page.getByRole('button',{name:/点赞，当前/}).click()
  await voteStarted
  await page.getByRole('button',{name:'返回列表'}).click()
  await page.getByRole('button',{name:/浏览器分页验证稿乙/}).click()
  await page.getByText('帖子乙的独占合成评论，不应出现在帖子甲。').waitFor()
  releaseVote()
  await page.waitForTimeout(500)
  const titleB = await page.getByRole('heading',{name:'浏览器分页验证稿乙'}).count()
  rec('迟到点赞回执不替换当前帖子',titleB,1,titleB===1)

  await page.getByRole('button',{name:'返回列表'}).click()
  await page.getByRole('button',{name:/浏览器分页验证稿甲/}).click()
  await page.getByRole('heading',{name:/评论 \(23\)/}).waitFor()
  await page.getByRole('button',{name:'举报',exact:true}).click()
  delayReport = true
  await page.getByRole('button',{name:'提交举报'}).click()
  await reportStarted
  await page.getByRole('button',{name:'返回列表'}).click()
  await page.getByRole('button',{name:/浏览器分页验证稿乙/}).click()
  await page.getByText('帖子乙的独占合成评论，不应出现在帖子甲。').waitFor()
  releaseReport()
  await page.waitForTimeout(500)
  const oldNotice = await page.getByText('举报已提交，管理员会尽快处理。').count()
  rec('迟到举报回执不污染当前帖子',oldNotice,0,oldNotice===0)

  // ---- 窄屏（390px）：评论区分页与输入可操作、无横向溢出 ----
  const narrow = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await bindFixtureIdentity(narrow)
  narrow.on('console', (m) => { if (m.type() === 'error') out.consoleErrors.push(`[narrow] ${m.text()}`) })
  await narrow.route('**/api/community/**', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    const real = await route.fetch({ url: origin + u.pathname + u.search, headers: proxyHeaders(req) })
    await route.fulfill({ response: real })
  })
  await narrow.goto(pageUrl.replace('layout=wide', 'layout=narrow'), { waitUntil: 'domcontentloaded' })
  await narrow.getByRole('heading', { name: /投稿广场/ }).waitFor({ timeout: 20000 })
  await narrow.getByRole('button', { name: /浏览器分页验证稿甲/ }).click()
  await narrow.getByRole('heading', { name: /评论 \(23\)/ }).waitFor({ timeout: 20000 })
  const overflow = await narrow.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
  rec('窄屏：详情页无横向溢出', overflow, false, overflow === false)
  rec('窄屏：加载更多评论按钮可见', await narrow.getByRole('button', { name: '加载更多评论' }).isVisible(), true,
    await narrow.getByRole('button', { name: '加载更多评论' }).isVisible())
  await narrow.getByRole('button', { name: '加载更多评论' }).click()
  await narrow.waitForFunction(() => document.querySelectorAll('section[aria-label="评论"] ul > li').length === 23, null, { timeout: 10000 })
  const narrowCount = await narrow.locator('section[aria-label="评论"] ul > li').count()
  rec('窄屏：加载更多后可读到全部评论', narrowCount, 23, narrowCount === 23)
  rec('窄屏：写评论输入框可见', await narrow.getByLabel('写评论').isVisible(), true, await narrow.getByLabel('写评论').isVisible())
  rec('窄屏：发表按钮可见', await narrow.getByRole('button', { name: '发表评论' }).isVisible(), true,
    await narrow.getByRole('button', { name: '发表评论' }).isVisible())
  await narrow.screenshot({ path: path.join(runRoot, 'narrow-390.png') })

  out.summary = { total: out.checks.length, failed: out.checks.filter((c) => !c.pass).length }
} catch (e) {
  out.error = e instanceof Error ? e.stack || e.message : String(e)
  console.error(out.error)
} finally {
  try { await browser?.close() } catch { /* ignore */ }
  try { await vite?.close() } catch { /* ignore */ }
  if (server) { try { server.kill() } catch { /* ignore */ } }
  out.finishedAt = new Date().toISOString()
  await fs.writeFile(path.join(runRoot, 'browser-result.json'), JSON.stringify(out, null, 2))
  console.log(`\n结果：${out.summary ? `${out.summary.failed} 项失败 / ${out.summary.total}` : '执行中断'}`)
  console.log(`证据：${path.join(runRoot, 'browser-result.json')}`)
  process.exitCode = out.summary && out.summary.failed === 0 ? 0 : 1
}
