// UI protocol fixture; backend authority and physical persistence require separate evidence.
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {createServer} from 'vite'
import {chromium} from 'playwright'
import {snapshot} from '../audit/platform/source.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const run=await fs.mkdtemp(path.join(root,'.workbuddy/tmp/frontend-storage-status-'))
const fingerprint=snapshot(root).fingerprint
const fixtureHash=async()=>{
  const hash=createHash('sha256')
  for(const name of ['storage-status.html','storage-status.tsx'])hash.update(await fs.readFile(path.join(root,'tests/browser',name)))
  return hash.digest('hex')
}
const fixtureFingerprint=await fixtureHash()
const report={kind:'frontend-storage-status',at:new Date().toISOString(),run,fingerprint,fixtureFingerprint,checks:[],errors:[],modelRequests:[],status:'running'}
const check=(name,passed,details)=>{report.checks.push({name,passed:!!passed,details});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw Error(name+': '+JSON.stringify(details))}
let server,browser,page
try{
  server=await createServer({root,cacheDir:path.join(run,'vite-cache'),logLevel:'error',server:{host:'localhost',port:0}})
  await server.listen();const origin=`http://localhost:${server.httpServer.address().port}`
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']})
  const context=await browser.newContext({viewport:{width:800,height:640},reducedMotion:'reduce'})
  await context.route('**/*',route=>{
    const url=route.request().url()
    if(/\/chat\/completions|\/api\/ai(?:\/|$)/.test(url)){report.modelRequests.push(route.request().method());return route.abort()}
    if(url===origin+'/api/auth/me')return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:false})})
    return url.startsWith(origin+'/')?route.continue():route.abort()
  })
  page=await context.newPage();page.setDefaultTimeout(120000);page.on('pageerror',error=>report.errors.push(error.message))
  await page.goto(origin+'/tests/browser/storage-status.html',{waitUntil:'commit'})
  const input=page.getByRole('textbox',{name:'仍可编辑的草稿',exact:true})
  await input.fill('保存状态变化不能改写草稿或抢走焦点');page.setDefaultTimeout(15000)
  const button=page.getByRole('region',{name:'存储状态测试',exact:true}).locator('[data-storage-write-status]'),status=button.getByRole('status')
  const base={connected:true,dirty:false,saving:false,lastError:'',lastSavedAt:100}
  const cases=[
    ['connecting','等待存储',{...base,connected:false},false],
    ['idle','暂无保存记录',{...base,lastSavedAt:0},true],
    ['saved','已保存',base,true],
    ['pending','待保存',{...base,dirty:true},true],
    ['writing','正在写入',{...base,dirty:true,saving:true},false],
    ['error','保存出错',{...base,lastError:'PRIVATE_PATH TOKEN'},true],
    ['error','保存出错',{...base,saving:true,lastError:'PRIVATE_PATH TOKEN'},false],
    ['locked','暂停写入',{...base,writeLocked:true,lastError:'PRIVATE_PATH TOKEN'},false],
    ['conflict','存在冲突',{...base,writeLocked:true,saveConflict:true},false],
  ]
  for(const [kind,label,facts,canSave]of cases){
    await page.evaluate(facts=>window.__storageStatusProbe.update(facts),facts)
    await page.waitForFunction(label=>document.querySelector('[aria-label="存储状态测试"] [role="status"]')?.textContent===label,label)
    check(kind+' has accurate visible and accessible status',await button.getAttribute('data-storage-write-status')===kind
      &&await status.textContent()===label&&(await button.getAttribute('aria-label')).startsWith(label+'：'))
    check(kind+' preserves input focus and draft',await input.inputValue()==='保存状态变化不能改写草稿或抢走焦点'
      &&await input.evaluate(el=>el===document.activeElement))
    check(kind+' permits only the existing valid save action',await button.isEnabled()===canSave)
    check(kind+' never exposes backend diagnostic secrets',(await button.getAttribute('aria-label')).includes('TOKEN')===false)
  }
  const before=await page.evaluate(()=>window.__storageStatusProbe.writes())
  await button.evaluate(el=>el.click())
  check('conflict cannot issue save or unlock through a synthetic click',await page.evaluate(()=>window.__storageStatusProbe.writes())===before)
  await page.evaluate(facts=>window.__storageStatusProbe.update(facts),{...base,dirty:true})
  await button.focus();await page.keyboard.press('Enter')
  check('keyboard retry dispatches the existing handler exactly once',await page.evaluate(()=>window.__storageStatusProbe.writes())===before+1)
  for(const adapter of ['desktop','portable','web']){
    const current=page.locator(`[data-status-adapter="${adapter}"] [data-storage-write-status]`)
    check(adapter+' real data bar uses the shared status without claiming initialized storage',await current.getAttribute('data-storage-write-status')==='connecting'
      &&await current.isDisabled()&&(await current.getAttribute('aria-label')).startsWith('等待存储：'))
  }
  for(const theme of ['dark','eye-care','mono']){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme)
    check(theme+' conveys status with text and an actual themed indicator',await button.evaluate(el=>{
      const dot=el.querySelector('span[aria-hidden="true"]'),color=getComputedStyle(dot).backgroundColor
      return color!=='rgba(0, 0, 0, 0)'&&el.innerText.includes('待保存')
    }))
  }
  await page.setViewportSize({width:320,height:640})
  check('narrow status panel does not cause horizontal page overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
  await page.screenshot({path:path.join(run,'storage-status-narrow.png'),animations:'disabled'})
  check('no model requests',report.modelRequests.length===0,report.modelRequests)
  check('no browser errors',report.errors.length===0,report.errors)
  report.status='passed'
}catch(error){report.status='failed';report.failure=error.stack||String(error);await page?.screenshot({path:path.join(run,'failure.png'),animations:'disabled'}).catch(()=>{})}
finally{
  report.stale=fingerprint!==snapshot(root).fingerprint||fixtureFingerprint!==await fixtureHash();if(report.stale)report.status='failed'
  report.passed=report.checks.filter(check=>check.passed).length
  await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2));await browser?.close();await server?.close()
  console.log(JSON.stringify({run,status:report.status,passed:report.passed,total:report.checks.length,stale:report.stale,failure:report.failure}))
  if(report.status!=='passed')process.exitCode=1
}
