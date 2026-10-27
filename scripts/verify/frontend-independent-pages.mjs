// Real temporary web service for auth; actual native notice modules in an isolated Vite browser.
// Credentials, cookies, invite codes, request payloads and server stdout never enter reports/screenshots.
import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'
import { renderAuthPage, renderResetPage } from '../../server/lib/authPage.mjs'
import { GUEST_BANNER } from '../../server/lib/guestNotice.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-independent-pages-')), fingerprint = snapshot(root).fingerprint
const fixtureHash = async () => createHash('sha256').update(await fs.readFile(path.join(root, 'tests/browser/runtime-notices.ts'))).digest('hex')
const fixtureFingerprint = await fixtureHash()
const report = { run, fingerprint, fixtureFingerprint, checks: [], errors: [], modelRequests: [], guestDataRequests: [], assetFailures: [], status: 'running' }
const check = (name, ok, details) => { report.checks.push({ name, passed: !!ok, details }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) throw Error(name) }
let server, browser, page, child
const port = () => new Promise((resolve, reject) => { const socket = net.createServer(); socket.once('error', reject); socket.listen(0, '127.0.0.1', () => { const p = socket.address().port; socket.close(() => resolve(p)) }) })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const stop = async () => { if (!child) return; const owned = child; child = null; if (owned.exitCode === null) { owned.kill(); await Promise.race([new Promise(resolve => owned.once('exit', resolve)), pause(5000)]) } }
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  for (const mode of ['invite', 'open', 'closed']) {
    const base = path.join(run, mode), www = path.join(base, 'www'); await fs.mkdir(www, { recursive: true })
    await fs.writeFile(path.join(www, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"><main id="isolated-hub">独立服务测试入口</main></div></body></html>')
    const servicePort = await port(), origin = `http://127.0.0.1:${servicePort}`
    child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(servicePort), YFE_DATA: path.join(base, 'data'), YFE_WWW: www, YFE_REGISTER: mode, YFE_BOOTSTRAP_INVITE: 'ABCD3300' } })
    let ready = false
    for (let n = 0; n < 80; n++) { try { ready = (await fetch(origin + '/')).status === 200; if (ready) break } catch { /* Service is still starting. */ } await pause(100) }
    if (!ready) throw Error('isolated service did not become ready')
    const context = await browser.newContext({ viewport: { width: 390, height: 680 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] })
    await context.route('**/*', route => {
      const url = route.request().url(); if (/\/chat\/completions|\/api\/ai(?:\/|$)/.test(url)) report.modelRequests.push('blocked')
      return url.startsWith(origin + '/') ? route.continue() : route.abort()
    })
    page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', e => report.errors.push(e.message))
    await page.goto(origin + '/'); const pwd = () => page.locator('#pwd'), name = () => page.locator('#name'), msg = () => page.locator('#msg')
    check(mode + ' identity page works without any main application bundle', await page.getByRole('button', { name: '登录', exact: true }).last().isVisible() && await pwd().getAttribute('autocomplete') === 'current-password')
    check(mode + ' narrow layout and touch inputs remain readable', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('input')].every(input => getComputedStyle(input).fontSize === '16px')))
    await page.screenshot({ path: path.join(run, mode + '-empty.png'), animations: 'disabled' })
    await page.setViewportSize({ width: 320, height: 600 }); await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' })
    check(mode + ' identity forms reflow at 320px in forced colors', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && getComputedStyle(document.getElementById('btn')).borderTopStyle !== 'none'))
    await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'reduce' }); await page.setViewportSize({ width: 390, height: 680 })
    await page.evaluate(() => navigator.clipboard.writeText('粘贴验收用户名')); await name().focus(); await name().press('Control+v')
    check(mode + ' normal clipboard paste remains available', await name().inputValue() === '粘贴验收用户名')
    check(mode + ' registration UI follows its actual server policy', await page.getByRole('button', { name: '注册', exact: true }).count() === (mode === 'closed' ? 0 : 1))
    await name().fill('不存在的验收用户'); await pwd().fill('isolated-secret')
    await page.locator('#btn').click(); await msg().filter({ hasText: '用户名或密码不正确' }).waitFor()
    check(mode + ' real server errors retain inputs, restore submit and focus the error', await name().inputValue() === '不存在的验收用户' && await pwd().inputValue() === 'isolated-secret' && !await page.locator('#btn').isDisabled() && await msg().evaluate(el => el === document.activeElement))
    if (mode !== 'closed') {
      await page.getByRole('button', { name: '注册', exact: true }).click()
      check(mode + ' registration uses password-manager semantics and the correct invite requirement', await pwd().getAttribute('autocomplete') === 'new-password' && await page.locator('#invite').evaluate(el => el.required) === (mode === 'invite'))
      await name().fill('独立验收用户'); await pwd().fill('isolated-secret')
      if (mode === 'invite') await page.locator('#invite').fill('ABCD3300')
      await page.locator('#btn').click(); await page.locator('#isolated-hub').waitFor()
      check(mode + ' real registration creates a session and enters the independent service', true)
      if (mode === 'invite') {
        const old = await browser.newContext({ storageState: await context.storageState() })
        const resetContext = await browser.newContext(), reset = await resetContext.newPage(); await reset.goto(origin + '/reset')
        await reset.locator('#name').fill('独立验收用户'); await reset.locator('#invite').fill('abcd3300'); await reset.locator('#pwd').fill('replacement-secret')
        await reset.locator('#btn').click(); await reset.locator('#msg').filter({ hasText: '重置成功' }).waitFor()
        check('real reset accepts the legacy invite normalization and invalidates old sessions', (await old.request.get(origin + '/api/auth/me')).status() === 401)
        await reset.waitForURL(origin + '/'); await reset.locator('#name').fill('独立验收用户'); await reset.locator('#pwd').fill('replacement-secret'); await reset.locator('#btn').click(); await reset.locator('#isolated-hub').waitFor()
        check('reset password can log in through the original real endpoint', true); await old.close(); await resetContext.close()
      }
    } else check('closed registration remains rejected by the real API', (await context.request.post(origin + '/api/auth/register', { data: { name: '不可创建用户', password: 'isolated-secret' } })).status() === 403)
    await page.goto(origin + '/login'); await name().fill('不存在的验收用户'); await pwd().fill('isolated-secret')
    let release, hits = 0; const gate = new Promise(resolve => { release = resolve })
    const delayed = async route => { hits++; const response = await route.fetch(); await gate; await route.fulfill({ response }).catch(() => {}) }
    await page.route('**/api/auth/login', delayed); await page.locator('#btn').click(); await page.getByRole('button', { name: '停止等待', exact: true }).waitFor()
    await page.locator('#form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    check(mode + ' pending requests prevent duplicate submits and mode/input changes', hits === 1 && await name().isDisabled() && await page.locator('#btn').isDisabled())
    await page.getByRole('button', { name: '停止等待', exact: true }).click(); release(); await page.unroute('**/api/auth/login', delayed)
    check(mode + ' cancelled waits recover without claiming server rollback', !await name().isDisabled() && (await msg().innerText()).includes('服务端可能已处理'))
    await page.locator('#btn').click(); await msg().filter({ hasText: '用户名或密码不正确' }).waitFor()
    check(mode + ' a real retry remains usable after cancel', !await page.locator('#btn').isDisabled())
    const offline = route => route.abort('internetdisconnected')
    await page.route('**/api/auth/login', offline); await page.locator('#btn').click(); await msg().filter({ hasText: '网络异常' }).waitFor()
    check(mode + ' transport failure restores the form and focuses its error', !await page.locator('#btn').isDisabled() && await msg().evaluate(el => el === document.activeElement))
    await page.unroute('**/api/auth/login', offline)
    if (mode === 'invite') {
      await page.clock.install(); let finishTimeout
      const timeoutGate = new Promise(resolve => { finishTimeout = resolve })
      const slow = async route => { const response = await route.fetch(); await timeoutGate; await route.fulfill({ response }).catch(() => {}) }
      await page.route('**/api/auth/login', slow); await page.locator('#btn').click(); await page.clock.fastForward(31000)
      await msg().filter({ hasText: '等待响应超时' }).waitFor(); finishTimeout(); await page.unroute('**/api/auth/login', slow)
      check('auth request timeout recovers without automatically replaying a mutation', !await page.locator('#btn').isDisabled() && !await name().isDisabled())
    }
    for (let n = 0; n < 13; n++) await context.request.post(origin + '/api/auth/login', { data: { name: '不存在的验收用户', password: 'isolated-secret' } })
    await page.locator('#btn').click(); await msg().filter({ hasText: '尝试次数过多' }).waitFor()
    check(mode + ' rate limiting is preserved and leaves a recoverable form', !await page.locator('#btn').isDisabled())
    await page.goto(origin + '/guest'); await page.locator('#yfe-guest-tip').waitFor()
    check(mode + ' guest notice survives with no main bundle and describes manual migration', (await page.locator('#yfe-guest-tip').innerText()).includes('不会自动迁移') && await page.locator('#root').isVisible())
    await page.getByRole('button', { name: '关闭游客提示', exact: true }).click(); await page.reload()
    check(mode + ' guest dismissal preserves the existing preference', await page.locator('#yfe-guest-tip').count() === 0)
    await context.close(); page = null; await stop()
  }
  // Rendering fallback also escapes error/notice/name when the application scripts are absent.
  const escapeContext = await browser.newContext(); page = await escapeContext.newPage()
  const hostile = '<script>window.__identityInjected=true</script>'
  await page.setContent(renderAuthPage({ error: hostile })); check('identity error text is escaped by the server template', await page.locator('#msg').innerText() === hostile && !await page.evaluate(() => window.__identityInjected))
  await page.setContent(renderResetPage({ name: hostile })); check('reset success names are escaped by the server template', !await page.evaluate(() => window.__identityInjected) && await page.locator('strong').innerText() === hostile)
  await escapeContext.close(); page = null

  server = await createServer({ root, cacheDir: path.join(run, 'vite-cache'), logLevel: 'error', optimizeDeps: { entries: ['index.html', 'tests/browser/runtime-notices.ts'] },
    server: { host: 'localhost', port: 0, watch: { ignored: ['**/.workbuddy/**', '**/dist/**', '**/release/**'] } }, plugins: [{ name: 'native-notice-fixture', configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url === '/guest-app') {
          const source = await fs.readFile(path.join(root, 'index.html'), 'utf8')
          const html = source.replace('</head>', '<script>window.__YFE_WEB__=1;window.__YFE_GUEST__=1;</script></head>').replace('</body>', GUEST_BANNER + '</body>')
          res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(await vite.transformIndexHtml(req.url, html)); return
        }
        if (!req.url.startsWith('/tests/browser/runtime-notices.html')) return next()
        const mode = new URL(req.url, 'http://fixture').searchParams.get('mode') ?? 'guest', guest = mode === 'guest'
        const flags = guest ? 'window.__YFE_WEB__=1;window.__YFE_GUEST__=1;' : `window.__YFE_WEB__=1;window.__YFE_PORTABLE__={apiBase:''};window.__YFE_USER__={id:${JSON.stringify(mode)}};`
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(await vite.transformIndexHtml(req.url, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script>${flags}</script></head><body><div id="root"><main id="fixture-main" class="h-screen"><label for="editor">隔离输入</label><textarea id="editor"></textarea><p role="alert" id="fixture-lock">真实存储写锁提示独立保留</p><a href="/login" id="account-link">注册账号</a></main></div>${guest ? GUEST_BANNER : ''}<script type="module" src="/tests/browser/runtime-notices.ts"></script></body></html>`))
      })
    } }] })
  await server.listen(); const origin = `http://localhost:${server.httpServer.address().port}`
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  const observe = p => { p.on('pageerror', error => report.errors.push(error.message)); p.on('response', r => { if (r.status() >= 400) report.assetFailures.push({ path: new URL(r.url()).pathname, status: r.status() }) }) }
  const open = async mode => { const p = await context.newPage(); observe(p); await p.goto(origin + '/tests/browser/runtime-notices.html?mode=' + mode, { waitUntil: 'commit' }); await p.waitForFunction(() => window.__noticeReady); return p }
  page = await open('guest'); const second = await open('guest'); await page.locator('#yfe-tab-guard').waitFor()
  check('guest narrow-screen and multi-window notices share one native host', await page.locator('#yfe-external-notices').count() === 1 && await page.locator('#yfe-mobile-hint').count() === 1 && await page.locator('#yfe-guest-tip').count() === 1)
  const layout = await page.evaluate(() => { const host = document.getElementById('yfe-external-notices').getBoundingClientRect(), main = document.getElementById('fixture-main').getBoundingClientRect(); return { hostBottom: host.bottom, mainTop: main.top, mainBottom: main.bottom, width: document.documentElement.scrollWidth, viewport: innerWidth, height: innerHeight } })
  check('combined notices reserve space and retain readable risk text on narrow screens', layout.mainTop >= layout.hostBottom - 1 && layout.mainBottom <= layout.height + 1 && layout.width <= layout.viewport, layout)
  await page.setViewportSize({ width: 1280, height: 900 }); await page.locator('#yfe-mobile-hint').waitFor({ state: 'detached' })
  check('widening the viewport removes the obsolete narrow-screen notice', await page.locator('#yfe-mobile-hint').count() === 0)
  await second.close(); await page.locator('#yfe-tab-guard').waitFor({ state: 'detached' })
  check('closing the other live page retracts the obsolete multi-window warning', true)
  const cloud = await open('account-a'); check('guest and cloud accounts do not warn about each other', await cloud.locator('#yfe-tab-guard').count() === 0 && await page.locator('#yfe-tab-guard').count() === 0)
  const cloud2 = await open('account-a'); await cloud.locator('#yfe-tab-guard').waitFor()
  check('two real cloud pages show conditional-write guidance for the same identity', (await cloud.locator('#yfe-tab-guard').innerText()).includes('拒绝旧版本'))
  await cloud.getByRole('button', { name: '关闭多窗口提示', exact: true }).click()
  check('closing ordinary notices does not hide the independent write-lock warning', await cloud.locator('#fixture-lock').isVisible())
  await cloud2.evaluate(() => { window.__YFE_USER__.id = 'account-b'; window.dispatchEvent(new Event('storage')) })
  await cloud2.locator('#yfe-tab-guard').waitFor({ state: 'detached' })
  check('an identity change withdraws the old account notice', await cloud2.locator('#yfe-tab-guard').count() === 0)
  await cloud2.close(); await cloud.close()
  // Keep a dirty guard mounted while clicking the actual native registration link.
  await page.evaluate(async () => { const { registerLeaveGuard } = await import('/src/lib/editor/leaveBarrier.ts'); registerLeaveGuard({ isDirty: () => true, flush: async () => ({ ok: false, scope: 'record', error: new Error('isolated save rejection') }) }) })
  const before = page.url(); await page.locator('#account-link').click(); await page.getByText('上次打开账号页面时未确认保存，已留在原页面。请先保存或导出草稿，再打开账号页面。', { exact: true }).waitFor()
  check('native account links respect a failed existing leave barrier', page.url() === before && await page.locator('#editor').isVisible())
  await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(async () => (await import('/src/lib/settings/theme.ts')).applyZoom(160, { manual: true }))
  await page.waitForFunction(() => { const host = document.getElementById('yfe-external-notices').getBoundingClientRect(), main = document.getElementById('fixture-main').getBoundingClientRect(); return main.top >= host.bottom - 1 && main.bottom <= innerHeight + 1 })
  check('native notices use the same height budget at 160 percent UI zoom', true)
  await page.evaluate(() => { document.getElementById('root').replaceChildren() })
  check('server guest notice remains outside a failed or cleared React root', await page.locator('#yfe-guest-tip').isVisible())
  await page.screenshot({ path: path.join(run, 'native-notices.png'), animations: 'disabled' }); await page.close()
  page = await context.newPage(); await page.setViewportSize({ width: 1560, height: 900 }); page.setDefaultTimeout(120000)
  observe(page); page.on('request', request => { if (new URL(request.url()).pathname === '/api/data') report.guestDataRequests.push(request.method()) })
  await page.goto(origin + '/guest-app', { waitUntil: 'commit' }); await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click(); await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click(); await page.getByRole('button', { name: '稍后再说', exact: true }).click()
  await page.getByRole('navigation').waitFor(); await page.waitForFunction(() => {
    const host = document.getElementById('yfe-external-notices').getBoundingClientRect(), app = document.querySelector('#root > .h-screen').getBoundingClientRect()
    return host.top >= -1 && app.top >= host.bottom - 1 && app.bottom <= innerHeight + 1 && Math.abs(scrollY) < 1
  })
  check('the actual guest application reserves notice space and keeps its navigation reachable', await page.getByRole('navigation').isVisible() && await page.locator('#yfe-guest-tip').count() === 1)
  check('actual guest application uses local storage without requesting the cloud data API', report.guestDataRequests.length === 0)
  await page.screenshot({ path: path.join(run, 'guest-real-application.png'), animations: 'disabled' })
  await context.close(); page = null
  check('native and actual-app resources load without HTTP failures', report.assetFailures.length === 0, report.assetFailures)
  check('no real model calls or unexpected page errors', report.modelRequests.length === 0 && report.errors.length === 0, { errors: report.errors })
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.failure = error.stack || String(error)
  await page?.evaluate(() => { for (const input of document.querySelectorAll('input')) input.value = '' }).catch(() => {})
  await page?.screenshot({ path: path.join(run, 'failure-redacted.png'), animations: 'disabled' }).catch(() => {})
} finally {
  report.stale = fingerprint !== snapshot(root).fingerprint || fixtureFingerprint !== await fixtureHash(); if (report.stale) report.status = 'failed'
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await server?.close(); await stop()
  console.log(JSON.stringify({ run, status: report.status, passed: report.checks.filter(c => c.passed).length, total: report.checks.length, stale: report.stale, failure: report.failure })); if (report.status !== 'passed') process.exitCode = 1
}
