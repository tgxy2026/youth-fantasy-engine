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
  check('a narrow overlay keeps the actual selected detail and return control inside the main viewport',await selected()==='atlas-view-60'
    &&await back.evaluate(button=>{const box=button.getBoundingClientRect(),main=document.querySelector('main').getBoundingClientRect();return box.left>=main.left&&box.right<=main.right&&box.bottom<=innerHeight}))
  await back.click();await detail().waitFor({state:'hidden'})
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
  check('no model requests',report.modelRequests.length===0,report.modelRequests);check('no browser errors',report.errors.length===0,report.errors);report.status='passed'
}catch(error){report.status='failed';report.failure=error.stack||String(error);await page?.screenshot({path:path.join(run,'failure.png'),fullPage:true,animations:'disabled'}).catch(()=>{})}
finally{
  report.stale=fingerprint!==snapshot(root).fingerprint;if(report.stale)report.status='failed';report.passed=report.checks.filter(c=>c.passed).length
  await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2));await browser?.close();await server?.close()
  console.log(JSON.stringify({run,status:report.status,passed:report.passed,total:report.checks.length,stale:report.stale,failure:report.failure}));if(report.status!=='passed')process.exitCode=1
}
