// UX06 outline selection/query memory and real save/read failures, isolated demo only.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const run=await fs.mkdtemp(path.join(root,'.workbuddy/tmp/frontend-outline-view-'))
const fingerprint=snapshot(root).fingerprint
const report={kind:'frontend-outline-view',at:new Date().toISOString(),run,fingerprint,checks:[],errors:[],modelRequests:[],status:'running'}
const check=(name,passed,details)=>{
  report.checks.push({name,passed:!!passed,details});console.log(`${passed?'PASS':'FAIL'} ${name}`)
  if(!passed)throw Error(name+': '+JSON.stringify(details))
}
let server,browser,page
try {
  server=await createServer({root,cacheDir:path.join(run,'vite-cache'),logLevel:'error',server:{host:'localhost',port:0}})
  await server.listen();const origin=`http://localhost:${server.httpServer.address().port}`
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']})
  const context=await browser.newContext({viewport:{width:1366,height:900},reducedMotion:'reduce'})
  await context.route('**/*',route=>{
    const url=route.request().url()
    if(/\/chat\/completions|\/api\/ai(?:\/|$)/.test(url))report.modelRequests.push(route.request().method())
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
  const fixture=await page.evaluate(async()=>{
    const db=await import('/src/lib/db.ts'),{getTab}=await import('/src/lib/schema.ts')
    const tab=getTab('chapter-outline'),keys=tab.modules.flatMap(mod=>mod.fields.map(field=>`${mod.name}::${field.name}`))
    const nameKey='一、本章定位::章节号/标题',fieldIndex=keys.findIndex(key=>key!==nameKey),field=keys[fieldIndex]
    for(const [index,name]of ['现场甲','现场乙','现场丙'].entries())await db.saveCardRecord({id:`view-outline-${index}`,projectId:db.getCurrentProjectId(),tabId:tab.id,name,data:{[nameKey]:name},order:-500+index})
    for(const [index,name]of ['现场卷甲','现场卷乙'].entries())await db.saveCardRecord({id:`view-volume-${index}`,projectId:db.getCurrentProjectId(),tabId:'volume-outline',name,data:{'一、本卷定位::卷名':name},order:-500+index})
    return {fieldIndex,field,projectId:db.getCurrentProjectId()}
  })
  if(!await nav.getByRole('button',{name:'章节细纲',exact:true}).isVisible())await nav.getByRole('button',{name:'大纲规划',exact:true}).click()
  const enter=()=>nav.getByRole('button',{name:'章节细纲',exact:true}).click()
  const dashboard=()=>nav.getByRole('button',{name:'写作面板',exact:true}).click()
  const pick=name=>page.getByRole('button',{name:`选择章节大纲：${name}`,exact:true})
  const query=page.getByRole('textbox',{name:'搜章节名…',exact:true})
  const field=page.locator('[data-master-detail] textarea').nth(fixture.fieldIndex)
  const rows=()=>page.evaluate(async()=>JSON.stringify(await(await import('/src/lib/db.ts')).getCardRecords('chapter-outline')))
  await enter();await pick('现场甲').waitFor()
  await query.focus();await page.keyboard.insertText('筛'.repeat(250))
  check('filter input respects the bounded 200-character UI contract',(await query.inputValue()).length===200)
  await query.fill('')
  await pick('现场乙').focus();await page.keyboard.press('Enter')
  await query.fill('现场')
  const before=await rows()
  await dashboard();await page.getByRole('heading',{name:'写作面板',exact:true}).waitFor()
  await enter();await query.waitFor()
  check('real page return restores outline selection and filter',await query.inputValue()==='现场'&&await pick('现场乙').getAttribute('aria-pressed')==='true')
  check('view-only navigation never modifies outline business records',await rows()===before)
  await nav.getByRole('button',{name:'分卷大纲',exact:true}).click()
  const volumeQuery=page.getByRole('textbox',{name:'搜分卷名…',exact:true})
  await page.getByRole('button',{name:'选择分卷大纲：现场卷乙',exact:true}).click();await volumeQuery.fill('现场卷')
  await enter();await query.waitFor()
  check('chapter and volume list namespaces preserve independent filters and selected records',await query.inputValue()==='现场'&&await pick('现场乙').getAttribute('aria-pressed')==='true')
  await nav.getByRole('button',{name:'分卷大纲',exact:true}).click();await volumeQuery.waitFor()
  check('the volume page independently restores its own selected row and filter',await volumeQuery.inputValue()==='现场卷'
    &&await page.getByRole('button',{name:'选择分卷大纲：现场卷乙',exact:true}).getAttribute('aria-pressed')==='true')
  await enter();await query.waitFor()

  const marker='工作现场清理时仍保留这份未保存大纲'
  await field.fill(marker);await field.evaluate(el=>{el.dataset.probeIdentity='same-node'})
  await page.evaluate(async()=>(await import('/src/lib/settings/workspaceViewState.ts')).workspaceViews.clear())
  await page.waitForTimeout(200)
  check('clearing optional UI views never reloads or discards an active business draft',await field.inputValue()===marker
    &&await field.getAttribute('data-probe-identity')==='same-node'&&await pick('现场乙').getAttribute('aria-pressed')==='true')
  await page.evaluate(()=>{
    const original=IDBObjectStore.prototype.put;window.__outlinePuts=0
    window.__restoreOutlinePut=()=>{IDBObjectStore.prototype.put=original}
    IDBObjectStore.prototype.put=function(value,...args){if(this.name==='cardRecords')window.__outlinePuts++;return original.call(this,value,...args)}
  })
  await pick('现场甲').focus();await page.keyboard.press('Enter')
  await page.waitForFunction(()=>document.querySelector('button[aria-label="选择章节大纲：现场甲"]')?.getAttribute('aria-pressed')==='true')
  await page.waitForTimeout(150)
  check('native keyboard record switch commits a dirty draft exactly once',await page.evaluate(()=>window.__outlinePuts===1))
  check('switching records saves the authoritative field rather than a view copy',await page.evaluate(async({field,marker})=>
    (await(await import('/src/lib/db.ts')).getCardRecords('chapter-outline')).find(row=>row.id==='view-outline-1')?.data[field]===marker,{field:fixture.field,marker}))
  await page.evaluate(()=>window.__restoreOutlinePut())

  await query.fill('现场甲')
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('yfe:navigate',{detail:{tabId:'chapter-outline',rowId:'view-outline-2'}})))
  await page.waitForFunction(()=>document.querySelector('button[aria-label="选择章节大纲：现场丙"]')?.getAttribute('aria-pressed')==='true')
  check('explicit row targeting beats remembered selection and clears a hiding filter',await query.inputValue()==='')
  await dashboard();await page.getByRole('heading',{name:'写作面板',exact:true}).waitFor()
  await page.evaluate(async()=>(await import('/src/lib/db.ts')).deleteCardRecord('view-outline-2'))
  await enter();await query.waitFor()
  check('deleted remembered selections fall back without resurrecting the record',await pick('现场甲').getAttribute('aria-pressed')==='true'&&!await pick('现场丙').count())

  const dirty='保存故障期间保留在原页的草稿'
  await field.fill(dirty)
  await page.evaluate(()=>{
    const original=IDBObjectStore.prototype.put;window.__outlineFailedPuts=0
    window.__restoreOutlinePut=()=>{IDBObjectStore.prototype.put=original}
    IDBObjectStore.prototype.put=function(value,...args){if(this.name==='cardRecords'){window.__outlineFailedPuts++;throw new DOMException('isolated outline fixture','QuotaExceededError')}return original.call(this,value,...args)}
  })
  await dashboard();await page.waitForFunction(()=>document.body.innerText.includes('当前大纲改动没存上'))
  check('failed page leave preserves outline DOM, draft and selection with accurate feedback',await field.inputValue()===dirty
    &&await pick('现场甲').getAttribute('aria-pressed')==='true'&&await page.evaluate(()=>window.__outlineFailedPuts>0))
  await pick('现场乙').click();await page.waitForFunction(()=>document.body.innerText.includes('上一张的改动没能保存'))
  check('failed local record switch also retains the original draft',await field.inputValue()===dirty&&await pick('现场甲').getAttribute('aria-pressed')==='true')
  await page.evaluate(()=>window.__restoreOutlinePut())
  await pick('现场乙').click();await page.waitForFunction(()=>document.querySelector('button[aria-label="选择章节大纲：现场乙"]')?.getAttribute('aria-pressed')==='true')
  check('retry after write recovery saves the actual original record',await page.evaluate(async({field,dirty})=>
    (await(await import('/src/lib/db.ts')).getCardRecords('chapter-outline')).find(row=>row.id==='view-outline-0')?.data[field]===dirty,{field:fixture.field,dirty}))
  await dashboard();await page.getByRole('heading',{name:'写作面板',exact:true}).waitFor()

  await page.evaluate(()=>{
    const original=IDBObjectStore.prototype.getAll
    window.__restoreOutlineRead=()=>{IDBObjectStore.prototype.getAll=original}
    IDBObjectStore.prototype.getAll=function(...args){if(this.name==='cardRecords')throw new DOMException('isolated outline read fixture','UnknownError');return original.apply(this,args)}
  })
  await enter();await page.getByRole('heading',{name:'大纲目录暂时无法读取',exact:true}).waitFor()
  check('a read failure has a bounded local notice and an explicit retry',await page.getByRole('button',{name:'重试读取大纲',exact:true}).isVisible())
  await page.evaluate(()=>window.__restoreOutlineRead())
  await page.getByRole('button',{name:'重试读取大纲',exact:true}).click();await query.waitFor()
  check('read retry recovers the remembered valid record',await pick('现场乙').getAttribute('aria-pressed')==='true')
  await query.fill('现场乙')
  const memory=await page.evaluate(async projectId=>{
    const {workspaceViews}=await import('/src/lib/settings/workspaceViewState.ts'),{currentWorkspaceScope}=await import('/src/lib/settings/workspaceRuntime.ts')
    return workspaceViews.get(currentWorkspaceScope(projectId,'list:chapter-outline'),'list-state')
  },fixture.projectId)
  check('real list memory retains only bounded UI metadata and no edited field body',memory?.kind==='list'
    &&memory.selectedId==='view-outline-1'&&memory.query==='现场乙'&&!JSON.stringify(memory).includes(dirty)&&!JSON.stringify(memory).includes(marker))
  // Delay the first real IDB put completion notification. Manual selection and page leave
  // must share one serialized writer even when the author continues typing in between.
  await query.fill('')
  await field.fill('慢完成协议：旧稿')
  await page.evaluate(()=>{
    const originalPut=IDBObjectStore.prototype.put,originalListen=IDBRequest.prototype.addEventListener,held=new WeakSet()
    let holdNext=true;window.__outlineSerialPuts=0;window.__releaseOutlineWrite=null
    window.__restoreOutlineSerial=()=>{IDBObjectStore.prototype.put=originalPut;IDBRequest.prototype.addEventListener=originalListen}
    IDBObjectStore.prototype.put=function(...args){
      const request=originalPut.apply(this,args)
      if(this.name==='cardRecords'){window.__outlineSerialPuts++;if(holdNext){holdNext=false;held.add(request)}}
      return request
    }
    IDBRequest.prototype.addEventListener=function(type,listener,options){
      if(type==='success'&&held.has(this)){
        const request=this
        return originalListen.call(this,type,event=>{window.__releaseOutlineWrite=()=>typeof listener==='function'?listener.call(request,event):listener.handleEvent(event)},options)
      }
      return originalListen.call(this,type,listener,options)
    }
  })
  await pick('现场甲').click();await page.waitForFunction(()=>typeof window.__releaseOutlineWrite==='function')
  const latest='慢完成协议：保存期间继续输入的新稿'
  await field.fill(latest);await dashboard();await page.waitForTimeout(200)
  check('slow local save and page leave share one pending writer while preserving newer typing',await page.evaluate(()=>window.__outlineSerialPuts===1)
    &&await field.inputValue()===latest&&await pick('现场乙').getAttribute('aria-pressed')==='true')
  await page.evaluate(()=>window.__releaseOutlineWrite())
  await page.getByRole('heading',{name:'写作面板',exact:true}).waitFor()
  check('queued leave completes after exactly the old and latest snapshot writes',await page.evaluate(()=>window.__outlineSerialPuts===2))
  check('after delayed completion the authoritative record retains the newer draft',await page.evaluate(async({field,latest})=>
    (await(await import('/src/lib/db.ts')).getCardRecords('chapter-outline')).find(row=>row.id==='view-outline-1')?.data[field]===latest,{field:fixture.field,latest}))
  await page.evaluate(()=>window.__restoreOutlineSerial())
  await enter();await query.waitFor();await pick('现场乙').click();await query.fill('现场乙')
  const authoritative=await rows()
  await page.evaluate(async()=>(await import('/src/lib/storage/contextEpoch.ts')).invalidateStorageContext())
  await page.waitForFunction(()=>document.querySelector('button[aria-label="选择章节大纲：现场甲"]')?.getAttribute('aria-pressed')==='true')
  check('storage-context protocol invalidation clears old filter and selection without rewriting business data',await query.inputValue()===''&&await rows()===authoritative)
  await page.screenshot({path:path.join(run,'outline-view.png'),animations:'disabled'})
  check('no model requests',report.modelRequests.length===0,report.modelRequests)
  check('no browser errors',report.errors.length===0,report.errors)
  report.status='passed'
}catch(error){report.status='failed';report.failure=error.stack||String(error);await page?.screenshot({path:path.join(run,'failure.png'),fullPage:true,animations:'disabled'}).catch(()=>{})}
finally{
  report.stale=fingerprint!==snapshot(root).fingerprint
  if(report.stale)report.status='failed'
  report.passed=report.checks.filter(check=>check.passed).length
  await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2))
  await browser?.close();await server?.close()
  console.log(JSON.stringify({run,status:report.status,passed:report.passed,total:report.checks.length,stale:report.stale,failure:report.failure}))
  if(report.status!=='passed')process.exitCode=1
}
