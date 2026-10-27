// Fresh real app, isolated IDB, real shared table drafts. No library/model service is contacted.
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createServer} from 'vite'
import {chromium} from 'playwright'
import {snapshot} from '../audit/platform/source.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const run=await fs.mkdtemp(path.join(root,'.workbuddy/tmp/frontend-atlas-workspace-'))
const fingerprint=snapshot(root).fingerprint
const report={kind:'frontend-atlas-workspace',at:new Date().toISOString(),run,fingerprint,checks:[],errors:[],assetFailures:[],consoleErrors:[],modelRequests:[],status:'running'}
const check=(name,passed,details)=>{report.checks.push({name,passed:!!passed,details});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw Error(name+': '+JSON.stringify(details))}
let server,browser,page
try{
  server=await createServer({root,cacheDir:path.join(run,'vite-cache'),logLevel:'error',server:{host:'localhost',port:0}})
  await server.listen();const origin=`http://localhost:${server.httpServer.address().port}`
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']})
  const context=await browser.newContext({viewport:{width:1560,height:900},reducedMotion:'reduce'})
  await context.route('**/*',route=>{
    const url=route.request().url()
    if(/\/chat\/completions|\/api\/ai(?:\/|$)/.test(url))report.modelRequests.push({method:route.request().method(),origin:new URL(url).origin})
    return url.startsWith(origin+'/')?route.continue():route.abort()
  })
  page=await context.newPage();page.setDefaultTimeout(120000);page.on('pageerror',e=>report.errors.push(e.message))
  page.on('response',response=>{if(response.status()>=400)report.assetFailures.push({path:new URL(response.url()).pathname,status:response.status()})})
  page.on('requestfailed',request=>{if(request.url().startsWith(origin+'/'))report.assetFailures.push({path:new URL(request.url()).pathname,error:request.failure()?.errorText})})
  page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push(message.text().replace(/https?:\/\/[^\s)]+/g,'[url]').slice(0,400))})
  await page.goto(origin,{waitUntil:'commit'});await page.getByRole('button',{name:/先看看示例/}).click()
  await page.getByRole('button',{name:'下一步',exact:true}).click();await page.getByRole('button',{name:/跳过，直接开始|开始写作/}).click()
  await page.getByRole('button',{name:'稍后再说',exact:true}).click();const nav=page.getByRole('navigation');await nav.waitFor();page.setDefaultTimeout(20000)
  const fixture=await page.evaluate(async()=>{
    const db=await import('/src/lib/db.ts'),schema=await import('/src/lib/schema.ts'),atlas=await import('/src/lib/atlas/schema.ts')
    ;(await import('/src/lib/settings/theme.ts')).applyZoom(100,{manual:true})
    const tab=schema.TABS.find(t=>t.id==='races'),pid=db.getCurrentProjectId()
    const fields=atlas.resolveAtlasFields(tab,{purpose:'detail',ignoreAppliesTo:true}).filter(f=>['text','textarea'].includes(f.builtinType??'text')&&f.key!=='名称'&&f.key!=='编号')
    for(let i=0;i<75;i++){
      const data={名称:'图鉴现场'+String(i).padStart(2,'0'),编号:String(i).padStart(4,'0')}
      for(const field of fields)data[field.key]=i===60||i===61?field.label+'\n'+('只在隔离数据中的长资料内容\n'.repeat(35)):'短资料'
      await db.saveTableRow({id:'atlas-view-'+i,projectId:pid,tabId:'races',data,order:i})
    }
    let puts=0;const put=IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put=function(...args){if(this.name==='tableRows'||this.name==='cardRecords')puts++;return put.apply(this,args)}
    window.__atlasViewPuts=()=>puts
    return {projectId:pid,field:fields[0].key}
  })
  const enter=async()=>{
    await nav.waitFor({state:'visible'})
    if(!await nav.getByRole('button',{name:'种族生物',exact:true}).isVisible())await nav.getByRole('button',{name:'世界构建',exact:true}).click()
    await nav.getByRole('button',{name:'种族生物',exact:true}).click();await page.getByRole('heading',{name:'种族生物',exact:true}).waitFor()
  }
  const dashboard=()=>nav.getByRole('button',{name:'写作面板',exact:true}).click()
  const mode=name=>page.locator('main header').getByRole('button',{name,exact:true}).click()
  const filter=()=>page.locator('[data-table-scroll] thead th').filter({hasText:'名称'}).getByRole('textbox')
  const card=id=>page.locator(`[data-workspace-record="atlas-view-${id}"]`)
  const list=()=>page.locator('[data-atlas-list]'),detail=()=>page.locator('[data-atlas-detail]')
  const selected=()=>page.locator('[data-atlas-list] [aria-current="true"]').getAttribute('data-workspace-record')
  const authoritative=()=>page.evaluate(async()=>JSON.stringify(await(await import('/src/lib/db.ts')).getTableRows('races')))
  await enter();await filter().waitFor();const before=await authoritative()
  await filter().fill('图鉴现场06');await dashboard();await page.getByRole('heading',{name:'写作面板',exact:true}).waitFor();await enter();await filter().waitFor()
  check('column filters survive a real page round trip without record writes',await filter().inputValue()==='图鉴现场06'&&await authoritative()===before&&await page.evaluate(()=>window.__atlasViewPuts()===0))
  await filter().fill('');await mode('图鉴');await list().waitFor()
  check('a new atlas keeps its deliberate no-selection default',await detail().count()===0)
  await card(60).click();await detail().waitFor()
  await page.evaluate(()=>{
    const list=document.querySelector('[data-atlas-list]'),detail=document.querySelector('[data-atlas-detail]')
    list.scrollTop=Math.min(list.scrollTop+80,list.scrollHeight-list.clientHeight);detail.scrollTop=500
  });await page.waitForTimeout(120)
  const positions=await page.evaluate(()=>Object.fromEntries(['list','detail'].map(kind=>{const el=document.querySelector('[data-atlas-'+kind+']');return [kind,{top:el.scrollTop,max:el.scrollHeight-el.clientHeight}]})))
  check('both atlas panes provide genuine scrollable fixtures',positions.list.top>0&&positions.detail.top>0,positions)
  await mode('表格');await filter().waitFor();await mode('图鉴');await detail().waitFor();await page.waitForTimeout(220)
  const restored=await page.evaluate(()=>({list:document.querySelector('[data-atlas-list]').scrollTop,detail:document.querySelector('[data-atlas-detail]').scrollTop}))
  check('table/atlas switching restores the selected record and both pane positions',await selected()==='atlas-view-60'
    &&Math.abs(restored.list-positions.list.top)<8&&Math.abs(restored.detail-positions.detail.top)<8,{positions,restored})
  await dashboard();await page.getByRole('heading',{name:'写作面板',exact:true}).waitFor();await enter();await detail().waitFor();await page.waitForTimeout(220)
  check('a page round trip restores the atlas selection and detail position',await selected()==='atlas-view-60'
    &&Math.abs(await detail().evaluate(el=>el.scrollTop)-positions.detail.top)<8)
  const edit=page.locator('main aside').getByRole('button',{name:'编辑',exact:true});await edit.click()
  const input=page.locator('[data-workspace-field]').filter({has:page.locator('textarea')}).first().locator('textarea')
  await input.fill('现场草稿不得进入视图缓存');await input.evaluate(el=>{el.dataset.keepAtlasDom='same-node'})
  const putsBefore=await page.evaluate(()=>window.__atlasViewPuts())
  await page.evaluate(async()=>(await import('/src/lib/settings/workspaceViewState.ts')).workspaceViews.clear())
  await page.waitForTimeout(150)
  check('optional view invalidation preserves shared drafts the edit mode and actual input DOM',await input.inputValue()==='现场草稿不得进入视图缓存'
    &&await input.getAttribute('data-keep-atlas-dom')==='same-node'&&await page.evaluate(()=>window.__atlasViewPuts())===putsBefore)
  await mode('表格');await filter().waitFor();await mode('图鉴');await detail().waitFor();await edit.click()
  check('atlas edits remain in the shared table draft across view changes',await input.inputValue()==='现场草稿不得进入视图缓存'&&await authoritative()===before)
  const save=page.locator('main header').getByRole('button',{name:'保存',exact:true});await save.click()
  await page.waitForFunction(()=>[...document.querySelectorAll('main header button')].some(button=>button.title==='无未保存的改动'&&button.disabled))
  check('the existing save action persists the shared draft to the original record',await page.evaluate(async()=>Object.values((await(await import('/src/lib/db.ts')).getTableRows('races')).find(row=>row.id==='atlas-view-60').data).includes('现场草稿不得进入视图缓存')))
  const anchors=wanted=>page.evaluate(wanted=>Object.fromEntries(['list','detail'].map(kind=>{
    const el=document.querySelector('[data-atlas-'+kind+']'),attribute=kind==='list'?'data-workspace-record':'data-workspace-field'
    const box=el.getBoundingClientRect(),scale=box.height/el.offsetHeight
    const node=[...el.querySelectorAll('['+attribute+']')].find(node=>wanted?.[kind]
      ?node.getAttribute(attribute)===wanted[kind].id:node.getBoundingClientRect().bottom>box.top&&node.getBoundingClientRect().top<box.bottom)
    return [kind,node?{id:node.getAttribute(attribute),offset:(node.getBoundingClientRect().top-box.top)/scale}:null]
  })),wanted)
  await detail().evaluate(el=>{el.scrollTop=500});await page.waitForTimeout(100);const beforeZoom=await anchors()
  await dashboard();await page.getByRole('heading',{name:'写作面板',exact:true}).waitFor()
  await page.evaluate(async()=>(await import('/src/lib/settings/theme.ts')).applyZoom(110,{manual:true}))
  await enter();await detail().waitFor();await page.waitForTimeout(250);const afterZoom=await anchors(beforeZoom)
  check('semantic record and field anchors survive CSS zoom and grid reflow',Object.keys(beforeZoom).every(kind=>beforeZoom[kind]
    &&afterZoom[kind]?.id===beforeZoom[kind].id&&Math.abs(afterZoom[kind].offset-beforeZoom[kind].offset)<8),{beforeZoom,afterZoom})
  await page.setViewportSize({width:760,height:740})
  const back=page.getByTitle('返回图鉴列表',{exact:true});await back.waitFor()
  await page.screenshot({path:path.join(run,'atlas-narrow.png'),animations:'disabled'})
  check('the covered narrow card wall is inert and hidden from accessibility navigation',await list().evaluate(el=>el.inert&&el.getAttribute('aria-hidden')==='true'))
  check('a narrow overlay keeps the actual selected detail and return control inside the main viewport',await selected()==='atlas-view-60'
    &&await back.evaluate(button=>{const box=button.getBoundingClientRect(),main=document.querySelector('main').getBoundingClientRect();return box.left>=main.left&&box.right<=main.right&&box.bottom<=innerHeight}))
  await back.click();await detail().waitFor({state:'hidden'})
  await page.waitForFunction(()=>document.activeElement?.getAttribute('data-workspace-record')==='atlas-view-60')
  check('narrow return restores keyboard focus to the original card',await card(60).evaluate(el=>el===document.activeElement&&!el.closest('[inert]')))
  check('closing a narrow detail deliberately restores the no-selection list',await page.locator('[data-atlas-list] [aria-current="true"]').count()===0)
  await page.setViewportSize({width:1560,height:900});await page.evaluate(async()=>(await import('/src/lib/settings/theme.ts')).applyZoom(100,{manual:true}))
  await mode('表格');await filter().waitFor();await mode('图鉴');await list().waitFor()
  check('an explicit close remains closed after a table/atlas round trip',await detail().count()===0)
  await mode('表格');await filter().fill('图鉴现场60');await mode('图鉴')
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('yfe:navigate',{detail:{tabId:'races',rowId:'atlas-view-61'}})))
  await page.waitForFunction(()=>document.querySelector('[data-atlas-list] [aria-current="true"]')?.getAttribute('data-workspace-record')==='atlas-view-61')
  check('explicit navigation clears a hiding filter and overrides the remembered atlas selection',await selected()==='atlas-view-61')
  await mode('表格');await filter().waitFor();check('the explicit target filter reset is shared with the table',await filter().inputValue()==='')
  await mode('图鉴');await detail().waitFor();await dashboard();await page.getByRole('heading',{name:'写作面板',exact:true}).waitFor()
  await page.evaluate(async()=>{await(await import('/src/lib/db.ts')).deleteTableRow('atlas-view-61')})
  await enter();await list().waitFor();check('a deleted remembered record returns to no selection without choosing or resurrecting another',await detail().count()===0&&await card(61).count()===0)
  check('view metadata contains IDs geometry and filters without the edited record body',await page.evaluate(async()=>{
    const {workspaceViews}=await import('/src/lib/settings/workspaceViewState.ts'),{currentWorkspaceScope}=await import('/src/lib/settings/workspaceRuntime.ts'),db=await import('/src/lib/db.ts')
    const records=[['list:atlas:races','list-state'],['atlas:races','atlas-view-60'],['table:races','filter-state']].map(([page,id])=>workspaceViews.get(currentWorkspaceScope(db.getCurrentProjectId(),page),id))
    return !JSON.stringify(records).includes('现场草稿不得进入视图缓存')&&!JSON.stringify(records).includes('只在隔离数据中的长资料内容')
  }))
  await page.screenshot({path:path.join(run,'atlas-workspace.png'),animations:'disabled'})
  await card(60).click();await detail().waitFor();await edit.click()
  const failedDraft='表格离页失败保留的草稿'
  await input.fill(failedDraft);await input.evaluate(el=>{el.dataset.tableOwnerDom='same'})
  check('atlas editing keeps the header and detail save controls without an overlapping save bubble',await page.getByRole('button',{name:/^保存 \d+ 行修改$/}).count()===0
    &&await page.locator('main header').getByRole('button',{name:'保存',exact:true}).isVisible()
    &&await page.locator('main aside footer').getByRole('button',{name:'保存',exact:true}).isVisible())
  await page.evaluate(()=>{
    const put=IDBObjectStore.prototype.put
    window.__restoreTableFailure=()=>{IDBObjectStore.prototype.put=put}
    IDBObjectStore.prototype.put=function(...args){if(this.name==='tableRows')throw new DOMException('isolated table fixture','QuotaExceededError');return put.apply(this,args)}
  })
  await dashboard();await page.locator('[data-draft-save-feedback="error"]').waitFor();await page.waitForTimeout(4500)
  await page.screenshot({path:path.join(run,'table-save-failure.png'),animations:'disabled'})
  check('failed table leave preserves the page draft DOM and persistent retry feedback',await input.inputValue()===failedDraft
    &&await input.getAttribute('data-table-owner-dom')==='same'&&await page.getByRole('heading',{name:'种族生物',exact:true}).isVisible())
  await page.getByRole('button',{name:'切换项目',exact:true}).click()
  check('failed table project exit also retains its original project and editable draft',await input.inputValue()===failedDraft
    &&await page.evaluate(async pid=>(await import('/src/lib/db.ts')).getCurrentProjectId()===pid,fixture.projectId))
  await page.evaluate(()=>window.__restoreTableFailure())
  await page.getByRole('button',{name:'重试保存',exact:true}).click()
  await page.waitForFunction(()=>!document.querySelector('[data-draft-save-feedback="error"]'))
  check('explicit table retry persists the retained draft before clearing the failure',await page.evaluate(async()=>Object.values((await(await import('/src/lib/db.ts')).getTableRows('races')).find(row=>row.id==='atlas-view-60').data).includes('表格离页失败保留的草稿')))
  await page.evaluate(()=>{
    const add=IDBRequest.prototype.addEventListener,put=IDBObjectStore.prototype.put,queue=[]
    window.__tableDelayed=0;window.__tableSerialPuts=0
    IDBObjectStore.prototype.put=function(...args){if(this.name==='tableRows')window.__tableSerialPuts++;return put.apply(this,args)}
    IDBRequest.prototype.addEventListener=function(type,listener,...rest){
      if(type==='success'&&this.source instanceof IDBObjectStore&&this.source.name==='tableRows')return add.call(this,type,event=>{
        window.__tableDelayed++;queue.push(()=>typeof listener==='function'?listener.call(this,event):listener.handleEvent(event))
      },...rest)
      return add.call(this,type,listener,...rest)
    }
    window.__releaseTableReceipt=()=>{IDBRequest.prototype.addEventListener=add;for(const release of queue.splice(0))release()}
    window.__restoreTableCounter=()=>{IDBObjectStore.prototype.put=put}
  })
  await input.fill('手动保存中的旧表格快照');await save.click()
  await page.waitForFunction(()=>window.__tableDelayed>0);await input.fill('离页屏障必须保存的新表格草稿')
  await dashboard()
  check('page leave waits for the in-flight table snapshot without losing newer input',await input.inputValue()==='离页屏障必须保存的新表格草稿'
    &&await page.evaluate(()=>window.__tableSerialPuts===1))
  await page.evaluate(()=>window.__releaseTableReceipt());await page.getByRole('heading',{name:'写作面板',exact:true}).waitFor()
  const serial=await page.evaluate(async()=>({puts:window.__tableSerialPuts,
    latestStored:Object.values((await(await import('/src/lib/db.ts')).getTableRows('races')).find(row=>row.id==='atlas-view-60').data).includes('离页屏障必须保存的新表格草稿')}))
  check('manual and leave saves serialize exactly two real writes and retain the latest stored value',serial.puts===2&&serial.latestStored,serial)
  await page.evaluate(()=>window.__restoreTableCounter())
  await enter();await detail().waitFor();await edit.click();await input.fill('不可补写进替换后端的旧私密草稿')
  await page.evaluate(async()=>{
    const db=await import('/src/lib/db.ts'),core=await import('/src/lib/db/core.ts'),original=core.ops,pid=db.getCurrentProjectId()
    const isolated=await new Promise((resolve,reject)=>{const request=indexedDB.open('isolated-table-owner-records',1)
      request.onupgradeneeded=()=>{request.result.createObjectStore('tableRows',{keyPath:'id'});request.result.createObjectStore('projects',{keyPath:'id'})}
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})
    const request=(store,mode,operation)=>new Promise((resolve,reject)=>{
      const tx=isolated.transaction(store,mode),req=operation(tx.objectStore(store));let value
      req.onsuccess=()=>{value=req.result};tx.oncomplete=()=>resolve(value);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)
    })
    await request('projects','readwrite',store=>store.put({id:pid,updatedAt:1}))
    await request('tableRows','readwrite',store=>store.put({id:'replacement-race',projectId:pid,tabId:'races',data:{名称:'替换后端的隔离记录',编号:'Z9000'},order:0}))
    let release;const gate=new Promise(resolve=>{release=resolve});let delayed=true,hits=0,puts=0,failing=false
    const alternate={...original,
      getAll:async store=>store==='tableRows'?request(store,'readonly',s=>s.getAll()):original.getAll(store),
      get:async(store,key)=>['tableRows','projects'].includes(store)?request(store,'readonly',s=>s.get(key)):original.get(store,key),
      put:async(store,value)=>{if(['tableRows','projects'].includes(store)){if(store==='tableRows')puts++;return request(store,'readwrite',s=>s.put(value))}return original.put(store,value)},
      getAllByIndex:async(store,index,value)=>{
        if(store!=='tableRows')return original.getAllByIndex(store,index,value)
        if(failing)throw new Error('isolated replacement record read failure')
        const rows=(await request(store,'readonly',s=>s.getAll())).filter(row=>row[index]===value)
        if(delayed){hits++;await gate}return rows
      },
    }
    window.__tableOwnerFixture={original,alternate,release,stopDelay:()=>{delayed=false},failReads:value=>{failing=value},hits:()=>hits,puts:()=>puts,
      originalRow:()=>original.get('tableRows','atlas-view-60'),replacementRows:()=>request('tableRows','readonly',s=>s.getAll())}
    db.setStoreOps(alternate)
  })
  await page.waitForFunction(()=>window.__tableOwnerFixture.hits()>0)
  check('real backend invalidation hides the old table while the replacement records are loading',await detail().count()===0
    &&!(await page.locator('main').innerText()).includes('不可补写进替换后端的旧私密草稿'))
  await page.evaluate(async()=>{const db=await import('/src/lib/db.ts');db.setStoreOps(window.__tableOwnerFixture.original);window.__tableOwnerFixture.release();window.__tableOwnerFixture.stopDelay()})
  await list().waitFor();await card(60).waitFor();await page.waitForTimeout(150)
  check('a late replacement read cannot overwrite a restored owner or flush the old private draft',await page.locator('[data-workspace-record="replacement-race"]').count()===0
    &&await page.evaluate(async()=>window.__tableOwnerFixture.puts()===0&&!Object.values((await window.__tableOwnerFixture.originalRow()).data).includes('不可补写进替换后端的旧私密草稿')))
  await page.evaluate(async()=>{window.__tableOwnerFixture.failReads(true);(await import('/src/lib/db.ts')).setStoreOps(window.__tableOwnerFixture.alternate)})
  await page.getByRole('heading',{name:'暂时无法读取种族生物',exact:true}).waitFor()
  check('replacement record read failure exposes a real retry while keeping old records out of the page',await card(60).count()===0
    &&await page.getByRole('button',{name:'重试读取表格',exact:true}).isEnabled())
  await page.evaluate(()=>window.__tableOwnerFixture.failReads(false));await page.getByRole('button',{name:'重试读取表格',exact:true}).click()
  await page.locator('[data-workspace-record="replacement-race"]').waitFor()
  check('explicit read retry loads the replacement real IDB records without receiving old drafts',await card(60).count()===0
    &&await page.evaluate(async()=>window.__tableOwnerFixture.puts()===0&&(await window.__tableOwnerFixture.replacementRows()).length===1))
  await page.evaluate(async()=>(await import('/src/lib/db.ts')).setStoreOps(window.__tableOwnerFixture.original))
  await card(60).waitFor();await card(60).click();await detail().waitFor();await edit.click();await input.fill('项目退出前提交给原项目的草稿')
  await page.getByRole('button',{name:'切换项目',exact:true}).click()
  await page.waitForFunction(async()=>(await import('/src/lib/db.ts')).getCurrentProjectId()==='')
  check('successful project exit saves to the bound project before the active project is cleared',await page.evaluate(async()=>Object.values((await window.__tableOwnerFixture.originalRow()).data).includes('项目退出前提交给原项目的草稿')))
  await page.screenshot({path:path.join(run,'table-owner-exit.png'),animations:'disabled'})
  check('no model requests',report.modelRequests.length===0,report.modelRequests);check('no browser errors',report.errors.length===0,report.errors);report.status='passed'
}catch(error){report.status='failed';report.failure=error.stack||String(error);await page?.screenshot({path:path.join(run,'failure.png'),fullPage:true,animations:'disabled'}).catch(()=>{})}
finally{
  report.stale=fingerprint!==snapshot(root).fingerprint;if(report.stale)report.status='failed';report.passed=report.checks.filter(c=>c.passed).length
  await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2));await browser?.close();await server?.close()
  console.log(JSON.stringify({run,status:report.status,passed:report.passed,total:report.checks.length,stale:report.stale,failure:report.failure}));if(report.status!=='passed')process.exitCode=1
}
