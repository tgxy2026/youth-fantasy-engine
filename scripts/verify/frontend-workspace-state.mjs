// UX06 session foundation in a fresh real app. No author library or remote/model service.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const run=await fs.mkdtemp(path.join(root,'.workbuddy/tmp/frontend-workspace-state-'))
const fingerprint=snapshot(root).fingerprint
const report={kind:'frontend-workspace-state',at:new Date().toISOString(),run,fingerprint,checks:[],errors:[],modelRequests:[],status:'running'}
const check=(name,passed,details)=>{report.checks.push({name,passed:!!passed,details});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw new Error(name+': '+JSON.stringify(details))}
let server,browser,page
try{
  server=await createServer({optimizeDeps:{entries:['index.html','tests/browser/*.html']},root,cacheDir:path.join(run,'vite-cache'),logLevel:'error',server:{host:'localhost',port:0}})
  await server.listen()
  const origin=`http://localhost:${server.httpServer.address().port}`
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
  await page.getByRole('navigation').waitFor();page.setDefaultTimeout(15000)
  const observations=await page.evaluate(async()=>{
    const runtime=await import('/src/lib/settings/workspaceRuntime.ts')
    const {workspaceViews}=await import('/src/lib/settings/workspaceViewState.ts')
    const db=await import('/src/lib/db.ts'),core=await import('/src/lib/db/core.ts')
    await runtime.resolveWorkspaceIdentity()
    const keepId=db.getCurrentProjectId(),before=JSON.stringify(await db.getAllChapters())
    const scope=runtime.currentWorkspaceScope(keepId,'editor')
    const victim=await db.createProject('视图清理隔离临时项目')
    const victimScope=runtime.currentWorkspaceScope(victim.id,'editor')
    const value={version:1,kind:'editor',objectId:'view-only-object',revision:'sha-fixture',length:100,
      selection:{start:10,end:20,direction:'backward'},scroll:{top:20,ratio:.3,outerTop:0,outerRatio:0},
      layout:{width:500,height:400,fontSize:18,lineHeight:34.2},focused:true}
    let persistenceWrites=0
    const setItem=Storage.prototype.setItem
    Storage.prototype.setItem=function(...args){persistenceWrites++;return setItem.apply(this,args)}
    let saved,normalized
    try{saved=workspaceViews.put(scope,{...value,content:'private manuscript must never become view state'});normalized=workspaceViews.get(scope,value.objectId)}
    finally{Storage.prototype.setItem=setItem}
    const plainView=JSON.stringify(normalized)
    workspaceViews.put(victimScope,value)
    await db.deleteProject(victim.id)
    const deletion={keep:!!workspaceViews.get(scope,value.objectId),removed:workspaceViews.get(victimScope,value.objectId)===null}
    const oldGeneration=workspaceViews.generation(),original=core.ops
    core.setStoreOps({...original})
    const clearedAfterBackend=workspaceViews.stats().objects===0
    await runtime.resolveWorkspaceIdentity()
    const newScope=runtime.currentWorkspaceScope(keepId,'editor')
    const staleRejected=!workspaceViews.put(scope,value,oldGeneration)
    core.setStoreOps(original);await runtime.resolveWorkspaceIdentity()
    const currentScope=runtime.currentWorkspaceScope(keepId,'editor')
    const contentUntouched=before===JSON.stringify(await db.getAllChapters())
    workspaceViews.put(currentScope,value)
    const {importGuestData}=await import('/src/lib/db/guestData.ts')
    const generation=workspaceViews.generation()
    const rejected=await importGuestData(JSON.stringify({app:'youth-fantasy-engine',kind:'portable-data',fileVersion:999,stores:{}}))
    const rejectedKeptView=!rejected.ok&&workspaceViews.generation()===generation&&!!workspaceViews.get(currentScope,value.objectId)
    const project=await db.getProject(keepId)
    const imported=await importGuestData(JSON.stringify({app:'youth-fantasy-engine',kind:'portable-data',fileVersion:2,
      stores:{projects:[project],chapters:[{id:'replacement-test-chapter',projectId:keepId,volumeId:'replacement-volume',title:'隔离替换章',content:'替换只发生在本次隔离上下文'}]}}))
    const replacementCleared=imported.ok&&workspaceViews.stats().objects===0&&!workspaceViews.put(currentScope,value,generation)
    await runtime.resolveWorkspaceIdentity()
    const afterScope=runtime.currentWorkspaceScope(keepId,'editor')
    workspaceViews.put(afterScope,value)
    window.dispatchEvent(new PageTransitionEvent('pagehide'))
    const lifecycleCleared=workspaceViews.stats().objects===0
    workspaceViews.put(afterScope,value)
    return {saved,persistenceWrites,noContent:!plainView.includes('private manuscript')&&!('content' in normalized),
      opaque:/^space-[a-f0-9]{64}$/.test(scope.space),deletion,clearedAfterBackend,changedSpace:newScope.space!==scope.space,
      staleRejected,contentUntouched,rejectedKeptView,replacementCleared,lifecycleCleared,recordsBeforeReload:workspaceViews.stats().objects}
  })
  check('session view storage uses opaque spaces and keeps business prose out',observations.saved&&observations.opaque&&observations.noContent)
  check('view writes never write localStorage or sessionStorage',observations.persistenceWrites===0)
  check('real project deletion clears its views and retains another project',observations.deletion.keep&&observations.deletion.removed)
  check('backend replacement clears views and changes the namespace',observations.clearedAfterBackend&&observations.changedSpace)
  check('old asynchronous generation cannot write into a replaced context',observations.staleRejected)
  check('view/backend bookkeeping leaves authoritative chapter bytes unchanged',observations.contentUntouched)
  check('rejected library import does not clear a valid view',observations.rejectedKeptView)
  check('real library replacement clears views and rejects an old writer',observations.replacementCleared)
  check('pagehide lifecycle notification clears session views',observations.lifecycleCleared)
  page.on('dialog',async dialog=>{if(dialog.type()==='beforeunload')await dialog.accept();else await dialog.dismiss()})
  await page.reload({waitUntil:'commit',timeout:45000})
  const afterReload=await page.evaluate(async()=>(await import('/src/lib/settings/workspaceViewState.ts')).workspaceViews.stats().objects)
  check('real reload starts a fresh empty view store',observations.recordsBeforeReload===1&&afterReload===0)
  check('no model requests or runtime errors',report.modelRequests.length===0&&report.errors.length===0,{errors:report.errors})
  report.status='passed'
}catch(error){report.status='failed';report.failure=String(error.stack||error);if(page)await page.screenshot({path:path.join(run,'failure.png'),fullPage:true}).catch(()=>{});throw error}
finally{report.stale=snapshot(root).fingerprint!==fingerprint;if(report.stale){report.status='failed';process.exitCode=1}report.passed=report.checks.filter(item=>item.passed).length;await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2));await browser?.close();await server?.close();console.log(JSON.stringify({run,status:report.status,passed:report.passed,stale:report.stale}))}
