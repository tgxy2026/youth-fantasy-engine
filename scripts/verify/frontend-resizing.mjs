// Real mouse/touch dispatch plus keyboard and cancellation checks in an isolated Edge profile.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-resizing-'))
const fingerprint = snapshot(root).fingerprint
const fixtureHash = async () => {
  const hash = createHash('sha256')
  for (const name of ['resizing.html','resizing.tsx']) hash.update(await fs.readFile(path.join(root,'tests/browser',name)))
  return hash.digest('hex')
}
const fixtureFingerprint = await fixtureHash()
const report = { kind: 'frontend-resizing', at: new Date().toISOString(), run, fingerprint, fixtureFingerprint, checks: [], errors: [], status: 'running' }
const check = (name, passed, details) => {
  report.checks.push({ name, passed: !!passed, details })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  if (!passed) throw new Error(name + ': ' + JSON.stringify(details))
}
let server, browser, page
try {
  server = await createServer({ root, cacheDir: path.join(run,'vite-cache'), logLevel:'error', server:{ host:'localhost', port:0 } })
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel:'msedge', headless:true, args:['--no-proxy-server'] })
  const context = await browser.newContext({ viewport:{ width:1366,height:900 }, hasTouch:true, reducedMotion:'reduce' })
  await context.route('**/*', route => route.request().url().startsWith(origin+'/') ? route.continue() : route.abort())
  page = await context.newPage()
  page.on('pageerror', e => report.errors.push(e.message))
  page.setDefaultTimeout(120000)
  const url = origin + '/tests/browser/resizing.html'
  await page.goto(url,{waitUntil:'commit'})
  const handle = page.getByRole('separator',{ name:'测试分栏宽度',exact:true })
  await handle.waitFor()
  page.setDefaultTimeout(15000)
  const size = async () => Number(await page.getByLabel('宽度',{exact:true}).textContent())
  const stopped = async () => page.waitForFunction(() => document.querySelector('output[aria-label="拖拽状态"]').textContent === 'false')
  const cdp = await context.newCDPSession(page)
  const touch = (type,x,y) => cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'||type==='touchCancel'?[]:[{x,y,id:1}]})
  for (const zoom of [100,125,160]) {
    await page.evaluate(async zoom => (await import('/src/lib/settings/theme.ts')).applyZoom(zoom,{manual:true}),zoom)
    await handle.focus(); await handle.press('Home')
    const before = await size(), box = await handle.boundingBox()
    const x=box.x+box.width/2,y=box.y+30
    await page.mouse.move(x,y); await page.mouse.down(); await page.mouse.move(x+40,y,{steps:4}); await page.mouse.up()
    await stopped()
    check(`mouse delta uses layout coordinates at ${zoom}%`,Math.abs(await size()-before-40/(zoom/100))<1,{before,after:await size()})
    const next=await size(), rect=await handle.boundingBox(), tx=rect.x+rect.width/2,ty=rect.y+40
    await touch('touchStart',tx,ty); await touch('touchMove',tx+40,ty); await touch('touchEnd')
    await stopped()
    check(`touch delta uses layout coordinates at ${zoom}%`,Math.abs(await size()-next-40/(zoom/100))<1,{before:next,after:await size()})
  }
  await handle.focus(); await handle.press('Home'); check('Home reaches minimum',await size()===160)
  await handle.press('ArrowRight'); check('arrow step is available',await size()===176)
  await handle.press('Shift+ArrowRight'); check('shift arrow provides coarse step',await size()===224)
  await handle.press('End'); check('End reaches maximum',await size()===420)
  await page.getByRole('button',{name:'测试分栏宽度：打开调整菜单',exact:true}).click()
  await page.getByRole('button',{name:'加宽',exact:true}).waitFor()
  check('step button is disabled at maximum',await page.getByRole('button',{name:'加宽',exact:true}).isDisabled())
  await page.getByRole('button',{name:'收窄',exact:true}).click(); check('single click narrows without drag',await size()===396)
  await page.getByRole('button',{name:'恢复默认',exact:true}).click(); check('single click restores default',await size()===240)
  await page.getByRole('button',{name:'加宽',exact:true}).click(); check('single click widens without drag',await size()===264)
  await page.keyboard.press('Escape')
  for (const mode of ['pointercancel','blur','lostcapture']) {
    const box=await handle.boundingBox(),x=box.x+box.width/2,y=box.y+40
    await handle.evaluate(el => el.addEventListener('pointerdown',event => { el.dataset.testPointer=String(event.pointerId) },{once:true}))
    await touch('touchStart',x,y); await touch('touchMove',x+12,y)
    if (mode==='pointercancel') await touch('touchCancel')
    else if (mode==='blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    else {
      await handle.evaluate(el => el.releasePointerCapture(Number(el.dataset.testPointer)))
      await touch('touchMove',x+16,y)
    }
    await stopped()
    const frozen=await size()
    if (mode==='pointercancel') await handle.evaluate((el,{x,y}) => window.dispatchEvent(new PointerEvent('pointermove',{pointerId:Number(el.dataset.testPointer),clientX:x,clientY:y,bubbles:true})),{x:x+60,y})
    else { await touch('touchMove',x+60,y); await touch('touchEnd') }
    check(`${mode} releases drag state and ignores later movement`,Math.abs(await size()-frozen)<0.1)
  }
  const previous=await size(),box=await handle.boundingBox(),x=box.x+box.width/2,y=box.y+40
  await touch('touchStart',x,y)
  await page.getByRole('button',{name:'切换挂载',exact:true}).evaluate(el=>el.click())
  await touch('touchEnd')
  await page.getByRole('button',{name:'切换挂载',exact:true}).click()
  check('unmount releases capture and retains last width',Math.abs(await size()-previous)<0.1)
  check('resize does not change manuscript',await page.getByRole('textbox',{name:'正文内容',exact:true}).inputValue()==='不可改变的稿件')
  check('touch restriction is limited to separator',await handle.evaluate(el=>getComputedStyle(el).touchAction)==='none' && await page.getByRole('textbox',{name:'正文内容',exact:true}).evaluate(el=>getComputedStyle(el).touchAction)!=='none')
  await page.reload({waitUntil:'commit'})
  await handle.waitFor()
  check('width persists across reload',Math.abs(await size()-previous)<0.1)
  check('no browser errors',report.errors.length===0,report.errors)
  await page.screenshot({path:path.join(run,'final.png'),animations:'disabled'})
  report.status='passed'
} catch(error) {
  report.status='failed'; report.error=error.stack||String(error)
  await page?.screenshot({path:path.join(run,'failure.png'),animations:'disabled'}).catch(()=>{})
} finally {
  await browser?.close(); await server?.close()
  report.stale=fingerprint!==snapshot(root).fingerprint||fixtureFingerprint!==await fixtureHash()
  if(report.stale) report.status='failed'
  await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify({status:report.status,run,passed:report.checks.filter(c=>c.passed).length,total:report.checks.length,error:report.error,stale:report.stale}))
  if(report.status!=='passed') process.exitCode=1
}
