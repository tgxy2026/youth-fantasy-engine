// Render failure, denied initialization, delayed initialization, and manual recovery; no real library.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const run=await fs.mkdtemp(path.join(root,'.workbuddy/tmp/frontend-failures-'))
const fingerprint=snapshot(root).fingerprint
const fixtureHash=async()=>{
  const hash=createHash('sha256')
  for(const name of ['failures.html','failures.tsx']) hash.update(await fs.readFile(path.join(root,'tests/browser',name)))
  return hash.digest('hex')
}
const fixtureFingerprint=await fixtureHash()
const report={kind:'frontend-failures',at:new Date().toISOString(),run,fingerprint,fixtureFingerprint,checks:[],errors:[],status:'running'}
const check=(name,passed,details)=>{
  report.checks.push({name,passed:!!passed,details}); console.log(`${passed?'PASS':'FAIL'} ${name}`)
  if(!passed)throw new Error(name+': '+JSON.stringify(details))
}
let server,browser,page
try{
  server=await createServer({root,cacheDir:path.join(run,'vite-cache'),logLevel:'error',server:{host:'localhost',port:0}})
  await server.listen()
  const origin=`http://localhost:${server.httpServer.address().port}`
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']})
  const context=await browser.newContext({viewport:{width:1000,height:640},reducedMotion:'reduce',permissions:['clipboard-read','clipboard-write']})
  await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort())
  page=await context.newPage(); page.setDefaultTimeout(120000)
  page.on('pageerror',e=>{if(!e.message.includes('故障注入-仅夹具'))report.errors.push(e.message)})
  await page.goto(origin+'/tests/browser/failures.html',{waitUntil:'commit'})
  const heading=page.getByRole('heading',{name:'页面渲染出错',exact:true})
  await heading.waitFor(); page.setDefaultTimeout(15000)
  check('render failure receives a named focused heading',await heading.evaluate(el=>el===document.activeElement))
  check('render failure does not guarantee saved data',!await page.getByText('未造成数据丢失',{exact:false}).count()&&await page.getByText('未提交的修改可能需要恢复',{exact:false}).isVisible())
  check('technical detail starts folded',!await page.locator('details pre').isVisible())
  await page.getByText('查看技术摘要',{exact:true}).click()
  const summary=await page.locator('details pre').textContent()
  check('public technical detail includes location without sensitive payload',summary.includes('FailureFixture.tsx:15:9')&&!['private-manuscript','private-token','private-user','C:\\Users'].some(value=>summary.includes(value)),summary)
  await page.getByRole('button',{name:'复制技术摘要',exact:true}).click()
  await page.getByText('技术摘要已复制',{exact:true}).waitFor()
  const copied=await page.evaluate(()=>navigator.clipboard.readText())
  check('clipboard receives only the displayed safe summary',copied.replace(/\r\n/g,'\n')===summary,{expectedLength:summary.length,actualLength:copied.length})
  for(const zoom of [100,160,200]){
    const actualZoom=await page.evaluate(async zoom=>{
      if(zoom<=160)return (await import('/src/lib/settings/theme.ts')).applyZoom(zoom,{manual:true})
      // The app's supported UI setting stops at 160%. This is an explicit CSS stress case,
      // not evidence of browser zoom, OS DPI, or a supported 200% UI preference.
      document.documentElement.style.zoom=String(zoom/100)
      return Number(document.documentElement.style.zoom)*100
    },zoom)
    const scope=zoom>160?'forced CSS stress':'supported UI zoom'
    check(`requested magnification actually applies: ${zoom}% ${scope}`,actualZoom===zoom,{requested:zoom,actual:actualZoom,scope})
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1)
    check(`failure content reflows without horizontal overflow at ${zoom}% ${scope}`,!overflow)
    check(`recovery controls remain reachable at ${zoom}% ${scope}`,await page.getByRole('button',{name:'重试当前页面',exact:true}).isVisible())
  }
  await page.screenshot({path:path.join(run,'render-failure.png'),animations:'disabled',fullPage:true})
  await page.getByRole('button',{name:'修复夹具故障条件',exact:true}).click()
  await page.getByRole('button',{name:'重试当前页面',exact:true}).click()
  await page.getByText('当前页面重试成功',{exact:true}).waitFor()
  check('manual component retry remounts successfully after cause is removed',!await heading.isVisible())
  for(const primitive of ['null','empty']){
    const primitivePage=await context.newPage()
    primitivePage.setDefaultTimeout(15000)
    await primitivePage.goto(origin+'/tests/browser/failures.html?primitive='+primitive,{waitUntil:'commit'})
    await primitivePage.getByRole('heading',{name:'页面渲染出错',exact:true}).waitFor()
    await primitivePage.getByText('查看技术摘要',{exact:true}).click()
    check(`non-Error thrown value ${primitive} still reaches the fallback`,(await primitivePage.locator('details pre').textContent()).includes('错误类型：Error'))
    await primitivePage.close()
  }
  const modalPage=await context.newPage()
  modalPage.setDefaultTimeout(15000)
  await modalPage.goto(origin+'/tests/browser/failures.html?modal=1',{waitUntil:'commit'})
  await modalPage.getByRole('dialog',{name:'故障前模态',exact:true}).waitFor()
  await modalPage.waitForFunction(()=>document.body.style.overflow==='hidden')
  await modalPage.getByRole('button',{name:'触发模态内渲染故障',exact:true}).click()
  await modalPage.getByRole('heading',{name:'页面渲染出错',exact:true}).waitFor()
  check('modal crash releases background isolation and scroll lock',await modalPage.locator('#fixture-root').evaluate(el=>!el.inert&&document.body.style.overflow!=='hidden'))
  check('modal crash removes obsolete keyboard ownership',await modalPage.evaluate(async()=>!(await import('/src/lib/app/overlayScope.ts')).getActiveOverlayScope()))
  await modalPage.getByText('查看技术摘要',{exact:true}).click()
  check('modal crash leaves recovery controls interactive',await modalPage.getByRole('button',{name:'复制技术摘要',exact:true}).isVisible())
  await modalPage.close()

  // A fresh browser profile denies IDB opens before any app module loads.
  const denied=await browser.newContext({viewport:{width:1000,height:640},reducedMotion:'reduce'})
  await denied.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort())
  await denied.addInitScript(()=>{
    sessionStorage.setItem('fixture-reloads',String(Number(sessionStorage.getItem('fixture-reloads')||0)+1))
    indexedDB.open=()=>{throw new DOMException('故障注入-启动读取失败 private-manuscript','SecurityError')}
  })
  page=await denied.newPage();page.setDefaultTimeout(120000)
  await page.goto(origin,{waitUntil:'commit'})
  const bootHeading=page.getByRole('heading',{name:'启动失败',exact:true})
  await bootHeading.waitFor();page.setDefaultTimeout(15000)
  check('denied storage shows a real startup failure',await bootHeading.isVisible())
  check('startup failure does not depend on an unmounted dock',!await page.getByText('左下角',{exact:false}).count()&&await page.getByText('数据管理工具尚未载入',{exact:false}).isVisible())
  await page.getByText('查看技术摘要',{exact:true}).click()
  check('startup detail classifies storage refusal without original message',(await page.locator('details pre').textContent()).includes('SecurityError')&&!(await page.locator('details pre').textContent()).includes('private-manuscript'))
  const reloads=await page.evaluate(()=>Number(sessionStorage.getItem('fixture-reloads')))
  await page.getByRole('button',{name:'重新加载工作台',exact:true}).click()
  await page.waitForFunction(previous=>Number(sessionStorage.getItem('fixture-reloads'))>previous,reloads)
  await bootHeading.waitFor()
  check('startup reload is an actual navigation with a stable failure screen',await bootHeading.isVisible())
  await page.screenshot({path:path.join(run,'startup-failure.png'),animations:'disabled'})

  // Hold the first real IDB open so the loading screen can be inspected without a guessed timeout.
  const delayed=await browser.newContext({viewport:{width:1000,height:640},reducedMotion:'reduce'})
  await delayed.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort())
  await delayed.addInitScript(()=>{
    const original=indexedDB.open.bind(indexedDB)
    let release
    const gate=new Promise(resolve=>{release=resolve})
    window.__fixtureReleaseBoot=release
    indexedDB.open=(...args)=>{
      const request=original(...args)
      request.addEventListener('success',event=>{
        event.stopImmediatePropagation()
        gate.then(()=>request.dispatchEvent(new Event('success')))
      },{once:true})
      return request
    }
  })
  page=await delayed.newPage();page.setDefaultTimeout(120000)
  await page.goto(origin,{waitUntil:'commit'})
  const waiting=page.getByRole('status',{name:'正在打开创作工作台',exact:true})
  await waiting.waitFor()
  check('initialization waiting has real accessible status and no percentage',await waiting.isVisible()&&!await waiting.getByText(/\d+%/).count())
  await page.screenshot({path:path.join(run,'startup-waiting.png'),animations:'disabled'})
  await page.evaluate(()=>window.__fixtureReleaseBoot())
  await page.getByRole('button',{name:/写我的第一本书|先看看示例/}).first().waitFor()
  check('releasing initialization reaches the ordinary welcome screen',!await waiting.isVisible())
  check('no unexpected render fixture errors',report.errors.length===0,report.errors)
  report.status='passed'
}catch(error){
  report.status='failed';report.error=error.stack||String(error)
  await page?.screenshot({path:path.join(run,'failure.png'),animations:'disabled',fullPage:true}).catch(()=>{})
}finally{
  await browser?.close();await server?.close()
  report.stale=fingerprint!==snapshot(root).fingerprint||fixtureFingerprint!==await fixtureHash()
  if(report.stale)report.status='failed'
  await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify({status:report.status,run,passed:report.checks.filter(c=>c.passed).length,total:report.checks.length,error:report.error,stale:report.stale}))
  if(report.status!=='passed')process.exitCode=1
}
