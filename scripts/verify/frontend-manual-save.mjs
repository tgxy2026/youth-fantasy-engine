// Real isolated app and IDB. Delayed native success events test page receipts, not physical durability.
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createServer} from 'vite'
import {chromium} from 'playwright'
import {snapshot} from '../audit/platform/source.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const run=await fs.mkdtemp(path.join(root,'.workbuddy/tmp/frontend-manual-save-'))
const fingerprint=snapshot(root).fingerprint
const report={kind:'frontend-manual-save',at:new Date().toISOString(),run,fingerprint,checks:[],errors:[],modelRequests:[],status:'running'}
const check=(name,passed,details)=>{report.checks.push({name,passed:!!passed,details});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw Error(name+': '+JSON.stringify(details))}
let server,browser,page
try{
  server=await createServer({root,cacheDir:path.join(run,'vite-cache'),logLevel:'error',server:{host:'localhost',port:0}})
  await server.listen();const origin=`http://localhost:${server.httpServer.address().port}`
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']})
  const context=await browser.newContext({viewport:{width:1366,height:900},reducedMotion:'reduce'})
  await context.route('**/*',route=>{
    const url=route.request().url()
    if(/\/chat\/completions|\/api\/ai(?:\/|$)/.test(url))report.modelRequests.push({method:route.request().method(),origin:new URL(url).origin})
    return url.startsWith(origin+'/')?route.continue():route.abort()
  })
  page=await context.newPage();page.setDefaultTimeout(120000)
  page.on('pageerror',error=>report.errors.push(error.message))
  await page.goto(origin,{waitUntil:'commit'})
  await page.getByRole('button',{name:/先看看示例/}).click()
  await page.getByRole('button',{name:'下一步',exact:true}).click()
  await page.getByRole('button',{name:/跳过，直接开始|开始写作/}).click()
  await page.getByRole('button',{name:'稍后再说',exact:true}).click()
  const nav=page.getByRole('navigation');await nav.waitFor();page.setDefaultTimeout(20000)
  await page.evaluate(async()=>{
    const db=await import('/src/lib/db.ts');(await import('/src/lib/settings/theme.ts')).applyZoom(100,{manual:true})
    await db.saveSubSetFor(db.getCurrentProjectId(),'worldbase',{id:'manual-save-child',projectId:db.getCurrentProjectId(),tabId:'worldbase-sub',name:'保存测试子世界',data:{},order:999})
  })
  const enter=async id=>{
    // A resize replaces the hidden compact sidebar with the desktop sidebar asynchronously.
    await nav.waitFor({state:'visible'})
    const tab=await page.evaluate(async id=>{const tab=(await import('/src/lib/schema.ts')).TABS.find(t=>t.id===id);return {name:tab.name,group:tab.group}},id)
    if(!await nav.getByRole('button',{name:tab.name,exact:true}).isVisible())await nav.getByRole('button',{name:tab.group,exact:true}).click()
    await nav.getByRole('button',{name:tab.name,exact:true}).click();await page.locator('main textarea').first().waitFor()
  }
  const field=()=>page.locator('main textarea').first()
  const save=()=>page.locator('main header').getByRole('button',{name:'保存',exact:true})
  const feedback=()=>page.locator('[data-draft-save-feedback]')
  const clean=()=>page.waitForFunction(()=>document.querySelector('[data-draft-save-feedback="submitted"]'))
  const formHas=value=>page.evaluate(async value=>Object.values(await(await import('/src/lib/db.ts')).getFormData('positioning')).includes(value),value)
  const installFailure=store=>page.evaluate(store=>{
    const put=IDBObjectStore.prototype.put;window.__manualFailedPuts=0
    window.__restoreManualPut=()=>{IDBObjectStore.prototype.put=put}
    IDBObjectStore.prototype.put=function(...args){if(this.name===store){window.__manualFailedPuts++;throw new DOMException('isolated manual-save failure','QuotaExceededError')}return put.apply(this,args)}
  },store)
  await enter('positioning')
  check('an untouched form does not claim a new saved receipt',!await page.locator('main header').getByText('已保存',{exact:true}).count())
  const failed='表单失败后保留的隔离草稿'
  await field().fill(failed);await installFailure('formData');await save().click()
  await page.locator('[data-draft-save-feedback="error"]').waitFor();await page.waitForTimeout(4500)
  check('form failure remains visible beyond a toast and retains the actual unsaved draft',await field().inputValue()===failed
    &&await feedback().getByRole('button',{name:'重试保存',exact:true}).isEnabled()&&!await formHas(failed))
  await page.evaluate(()=>window.__restoreManualPut());await feedback().getByRole('button',{name:'重试保存',exact:true}).click();await clean()
  check('explicit form retry stores the draft and distinguishes submission from final storage receipt',await formHas(failed)
    &&(await feedback().innerText()).includes('最终写入状态')&&!await page.locator('main header').getByText('已保存',{exact:true}).count())
  await page.evaluate(()=>{
    const add=IDBRequest.prototype.addEventListener,put=IDBObjectStore.prototype.put,queue=[]
    window.__manualDelayed=0;window.__manualPuts=0
    IDBObjectStore.prototype.put=function(...args){if(this.name==='formData')window.__manualPuts++;return put.apply(this,args)}
    IDBRequest.prototype.addEventListener=function(type,listener,...rest){
      if(type==='success'&&this.source instanceof IDBObjectStore&&this.source.name==='formData'){
        const wrapped=event=>{window.__manualDelayed++;queue.push(()=>typeof listener==='function'?listener.call(this,event):listener.handleEvent(event))}
        return add.call(this,type,wrapped,...rest)
      }
      return add.call(this,type,listener,...rest)
    }
    window.__releaseManualReceipt=()=>{IDBRequest.prototype.addEventListener=add;IDBObjectStore.prototype.put=put;for(const release of queue.splice(0))release()}
  })
  const first='慢回执的旧表单快照',newer='慢回执期间继续输入的新草稿'
  await field().fill(first);await save().evaluate(button=>{button.click();button.click()})
  await page.waitForFunction(()=>window.__manualDelayed>0);await page.keyboard.press('Control+s')
  await field().fill(newer)
  check('double click and save hotkey issue only one native write while its receipt is pending',await page.evaluate(()=>window.__manualPuts===1)
    &&await page.locator('[data-draft-save-feedback="submitting"]').isVisible())
  await page.evaluate(()=>window.__releaseManualReceipt())
  await page.locator('[data-draft-save-feedback="pending"]').waitFor()
  check('an older receipt leaves the newer form draft dirty while storage contains only the old snapshot',await field().inputValue()===newer
    &&await save().isEnabled()&&await formHas(first)&&!await formHas(newer))
  await save().click();await clean()
  check('a second explicit save persists the latest form edit',await formHas(newer))
  await page.setViewportSize({width:760,height:740})
  check('wrapped form actions and feedback stay inside the main width',await page.locator('main').evaluate(main=>{
    const r=main.getBoundingClientRect();return [...main.querySelectorAll('header button,[data-draft-save-feedback]')].every(el=>{
      const box=el.getBoundingClientRect();return box.left>=r.left-1&&box.right<=r.right+1
    })
  }))
  await page.screenshot({path:path.join(run,'form-save-feedback.png'),animations:'disabled'})
  await page.setViewportSize({width:1366,height:900});await enter('worldbase')
  const child=()=>page.getByTitle('编辑子世界「保存测试子世界」（已完结 · 不发给 AI）',{exact:true})
  const mother=()=>page.getByTitle('编辑全书统一的设定（这一层永远发给 AI）',{exact:true})
  const motherDraft='母级失败时留在原层的隔离草稿'
  await field().fill(motherDraft);await installFailure('formData');await child().click()
  await page.locator('[data-draft-save-feedback="error"]').waitFor()
  check('a failed mother-layer flush blocks selection change and retains its draft',await field().inputValue()===motherDraft
    &&(await page.locator('main').innerText()).includes('【母级】全书统一'))
  await page.evaluate(()=>window.__restoreManualPut());await feedback().getByRole('button',{name:'重试保存',exact:true}).click();await clean()
  await child().click();await page.waitForFunction(()=>document.querySelector('main')?.innerText.includes('【子世界】保存测试子世界'))
  const childDraft='子世界失败时留在原层的隔离草稿'
  await field().fill(childDraft);await installFailure('cardRecords');await mother().click()
  await page.locator('[data-draft-save-feedback="error"]').waitFor()
  check('a failed child-layer flush also blocks selection change and retains its draft',await field().inputValue()===childDraft
    &&(await page.locator('main').innerText()).includes('【子世界】保存测试子世界'))
  await page.screenshot({path:path.join(run,'world-save-failure.png'),animations:'disabled'})
  await page.evaluate(()=>window.__restoreManualPut());await feedback().getByRole('button',{name:'重试保存',exact:true}).click();await clean()
  await mother().click();await page.waitForFunction(()=>document.querySelector('main')?.innerText.includes('【母级】全书统一'))
  check('successful retry allows switching back with mother data intact',await field().inputValue()===motherDraft)
  await child().click();await page.waitForFunction(()=>document.querySelector('main')?.innerText.includes('【子世界】保存测试子世界'))
  check('both layer drafts are actually stored under the original project',await field().inputValue()===childDraft&&await page.evaluate(async({motherDraft,childDraft})=>{
    const db=await import('/src/lib/db.ts'),mother=await db.getFormData('worldbase'),children=await db.getSubSets('worldbase')
    return Object.values(mother).includes(motherDraft)&&Object.values(children.find(row=>row.id==='manual-save-child').data).includes(childDraft)
  },{motherDraft,childDraft}))
  check('no model requests',report.modelRequests.length===0,report.modelRequests)
  check('no browser errors',report.errors.length===0,report.errors);report.status='passed'
}catch(error){report.status='failed';report.failure=error.stack||String(error);await page?.screenshot({path:path.join(run,'failure.png'),fullPage:true,animations:'disabled'}).catch(()=>{})}
finally{
  report.stale=fingerprint!==snapshot(root).fingerprint;if(report.stale)report.status='failed'
  report.passed=report.checks.filter(check=>check.passed).length
  await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2));await browser?.close();await server?.close()
  console.log(JSON.stringify({run,status:report.status,passed:report.passed,total:report.checks.length,stale:report.stale,failure:report.failure}))
  if(report.status!=='passed')process.exitCode=1
}
