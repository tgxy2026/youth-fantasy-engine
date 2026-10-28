// Real browser rendering of the independent identity template. Only an ephemeral
// loopback fixture is reachable; no real accounts, cloud data or model requests.
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import { renderAuthPage, renderResetPage } from '../../server/lib/authPage.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const files = ['server/lib/authPage.mjs', 'server/lib/authStyle.mjs', 'server/lib/authClient.mjs', 'src/index.css', 'scripts/verify/auth-entry-layout.mjs']
const fingerprint = async () => {
  const hash = createHash('sha256')
  for (const file of files) hash.update(file).update(await fs.readFile(path.join(root, file)))
  return hash.digest('hex')
}
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/auth-entry-layout-'))
const report = { run, fingerprint: await fingerprint(), checks: [], errors: [], externalRequests: [] }
const check = (name, ok, details) => {
  report.checks.push({ name, passed: !!ok, ...(details ? { details } : {}) })
  if (!ok) throw Error(name + (details ? ': ' + JSON.stringify(details) : ''))
}
const service = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(url.pathname === '/reset' ? renderResetPage() : renderAuthPage({ mode: url.searchParams.get('mode') || 'invite', error: url.searchParams.get('error') || '' }))
})
await new Promise(resolve => service.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${service.address().port}`
let browser, page
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  await context.route('**/*', route => {
    if (route.request().url().startsWith(origin + '/')) return route.continue()
    report.externalRequests.push('blocked'); return route.abort()
  })
  page = await context.newPage()
  page.on('pageerror', error => report.errors.push(error.message))
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
  for (const mode of ['invite', 'open', 'closed']) {
    for (const [width, height] of [[1920,1080],[1366,768],[768,1024],[390,844],[320,568]]) {
      await page.setViewportSize({ width, height }); await page.goto(origin + '/?mode=' + mode)
      const prefix = `${mode}-${width}`
      check(prefix + ' login fits the viewport width', await fits())
      check(prefix + ' invite is absent on login', !await page.locator('#inviteBox').isVisible())
      check(prefix + ' inputs remain 16px and at least 48px high', await page.locator('#name,#pwd').evaluateAll(inputs => inputs.every(input => getComputedStyle(input).fontSize === '16px' && input.getBoundingClientRect().height >= 48)))
      for (const selector of ['#btn', '.guestBtn', '.forgot a', '.dl a']) {
        await page.locator(selector).scrollIntoViewIfNeeded()
        await page.locator(selector).click({ trial: true })
      }
      check(prefix + ' all primary and auxiliary actions are reachable', true)
      if (mode === 'invite') {
        await page.evaluate(() => scrollTo(0,0)); await page.screenshot({ path: path.join(run, `login-${width}.png`), fullPage: true })
      }
      if (mode !== 'closed') {
        await page.getByRole('button', { name: '注册', exact: true }).click()
        check(prefix + ' registration reflows without clipping', await fits())
        check(prefix + ' invite follows server registration policy', await page.locator('#invite').isVisible() === (mode === 'invite') && await page.locator('#invite').evaluate(input => input.required) === (mode === 'invite'))
        check(prefix + ' password manager switches to new-password', await page.locator('#pwd').getAttribute('autocomplete') === 'new-password')
        if (mode === 'invite') {
          await page.evaluate(() => scrollTo(0,0)); await page.screenshot({ path: path.join(run, `register-${width}.png`), fullPage: true })
        }
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(origin)
  await page.locator('#btn').click()
  check('native empty-field errors have associated text and invalid state', await page.locator('#name').getAttribute('aria-invalid') === 'true' && await page.locator('#name-error').isVisible())
  await page.locator('#name').fill('测试用户')
  check('editing clears the field error', await page.locator('#name').getAttribute('aria-invalid') === null && !await page.locator('#name-error').isVisible())
  await page.locator('#pwd').fill('isolated-password')
  await page.getByRole('button', { name: '显示密码', exact: true }).focus(); await page.keyboard.press('Enter')
  check('keyboard reveals the password and updates the accessible button', await page.locator('#pwd').getAttribute('type') === 'text' && await page.getByRole('button', { name: '隐藏密码', exact: true }).getAttribute('aria-pressed') === 'true')
  await page.getByRole('button', { name: '注册', exact: true }).click()
  check('changing mode conceals the password again without losing input', await page.locator('#pwd').getAttribute('type') === 'password' && await page.locator('#pwd').inputValue() === 'isolated-password')
  await page.locator('#btn').click()
  check('missing invite has its own field error', await page.locator('#invite').getAttribute('aria-invalid') === 'true' && await page.locator('#invite-error').isVisible())

  await page.goto(origin); await page.locator('#name').fill('测试用户'); await page.locator('#pwd').fill('isolated-password')
  let finish, hits = 0
  const gate = new Promise(resolve => { finish = resolve })
  await page.route('**/api/auth/login', async route => { hits++; await gate; await route.fulfill({ status: 401, json: { error: '用户名或密码不正确' } }).catch(() => {}) })
  await page.locator('#pwd').press('Enter'); await page.locator('#cancel').waitFor({ state: 'visible' })
  check('Enter submits once and disables password visibility while pending', hits === 1 && await page.locator('#password-toggle').isDisabled() && await page.locator('#btn').isDisabled())
  await page.screenshot({ path: path.join(run, 'pending.png'), fullPage: true, mask: [page.locator('input')] })
  await page.locator('#cancel').click(); finish()
  check('cancel restores reveal control and preserves uncertainty message', !await page.locator('#password-toggle').isDisabled() && (await page.locator('#msg').innerText()).includes('服务端可能已处理'))
  await page.unroute('**/api/auth/login')

  await page.goto(origin + '/?error=' + encodeURIComponent('网络暂时不可用，请稍后重试。'))
  await page.screenshot({ path: path.join(run, 'error.png'), fullPage: true })
  check('server errors remain accessible alerts', await page.locator('#msg').getAttribute('role') === 'alert')
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 320, height: 568 })
  check('forced colors preserves control boundaries and width', await fits() && await page.locator('#btn').evaluate(el => getComputedStyle(el).borderTopStyle !== 'none'))
  await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'reduce' })
  check('reduced motion disables entrance and loading animation', await page.evaluate(() => [...document.querySelectorAll('.story,.card')].every(el => getComputedStyle(el).animationName === 'none')))
  // 1366x768 at 200% zoom provides a 683x384 CSS viewport.
  await page.setViewportSize({ width: 683, height: 384 })
  check('200 percent equivalent CSS viewport retains scrolling and horizontal reflow', await fits())
  await page.goto(origin)
  const appCss = await fs.readFile(path.join(root, 'src/index.css'), 'utf8')
  const eyeCare = appCss.match(/\[data-theme='eye-care'\]\s*\{([^}]+)\}/)[1]
  const themeValue = name => eyeCare.match(new RegExp('--' + name + ':\\s*([^;]+)'))[1].trim().split(/\s+/).map(Number)
  const actualPalette = await page.evaluate(() => {
    const style = getComputedStyle(document.body), card = getComputedStyle(document.querySelector('.card'))
    return { background: style.backgroundColor, accent: style.getPropertyValue('--accent').trim(), surface: card.backgroundColor, scheme: style.colorScheme }
  })
  const rgbHex = rgb => '#' + rgb.map(value => value.toString(16).padStart(2,'0')).join('')
  check('entry background and accent match the actual default eye-care theme', actualPalette.background === `rgb(${themeValue('ink-950').join(', ')})` && actualPalette.accent === rgbHex(themeValue('amber')) && actualPalette.scheme === 'light', actualPalette)
  await page.locator('#name').focus()
  check('keyboard input focus has a visible non-color outline', await page.locator('#name').evaluate(el => parseFloat(getComputedStyle(el).outlineWidth) >= 2 && getComputedStyle(el).outlineStyle !== 'none'))
  await page.setViewportSize({width:390,height:400}); await page.locator('#pwd').focus(); await page.locator('#pwd').scrollIntoViewIfNeeded()
  check('short dynamic viewport can scroll the focused password into view', await page.locator('#pwd').evaluate(el => { const r=el.getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight }))
  await page.setViewportSize({width:1366,height:768})
  await page.goto(origin + '/reset')
  check('reset retains its independent original presentation', await page.locator('body').getAttribute('class') === null && await page.locator('#btn').innerText() === '重置密码')

  const luminance = hex => {
    const c = hex.match(/\w\w/g).map(v => parseInt(v,16)/255).map(v => v<=.04045 ? v/12.92 : ((v+.055)/1.055)**2.4)
    return c[0]*.2126+c[1]*.7152+c[2]*.0722
  }
  const ratio = (a,b) => { const x=luminance(a),y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05) }
  const contrast = [['body','2b3a22','e6f0e0',4.5],['secondary','3c5230','e6f0e0',4.5],['muted','506646','dce8d4',4.5],['placeholder','506646','f6f9f2',4.5],['button start','ffffff','44764e',4.5],['button end','ffffff','4d7953',4.5],['error','b91c1c','eddfd7',4.5],['input border','7a8e6e','f6f9f2',3]]
  for (const [name,foreground,background,minimum] of contrast) check(name+' contrast meets applicable AA threshold',ratio(foreground,background)>=minimum,{ratio:Number(ratio(foreground,background).toFixed(2)),minimum})
  check('no external assets, third-party requests or browser exceptions', report.errors.length === 0 && report.externalRequests.length === 0)
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.failure = error.stack || String(error)
} finally {
  report.stale = report.fingerprint !== await fingerprint()
  if (report.stale) report.status = 'failed'
  await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2))
  await browser?.close(); await new Promise(resolve => service.close(resolve))
  console.log(JSON.stringify({run,status:report.status,passed:report.checks.filter(c=>c.passed).length,total:report.checks.length,stale:report.stale,failure:report.failure}))
  if (report.status !== 'passed') process.exitCode=1
}
