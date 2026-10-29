// Retain real host callbacks and delay real PNG preparation; no model or storage success is mocked.
// Replacement records use a second actual IDB; unrelated metadata forwards the original fixture Ops.
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createServer} from 'vite'
import {chromium} from 'playwright'
import {snapshot} from '../audit/platform/source.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const run=await fs.mkdtemp(path.join(root,'.workbuddy/tmp/frontend-async-record-owner-'))
const fingerprint=snapshot(root).fingerprint
const report={kind:'frontend-async-record-owner',at:new Date().toISOString(),run,fingerprint,checks:[],errors:[],modelRequests:[],assetFailures:[],consoleErrors:[],status:'running'}
const check=(name,passed,details)=>{report.checks.push({name,passed:!!passed,details});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw Error(name+': '+JSON.stringify(details))}
let server,browser,page,hooks=0
const pending=new Map()
try{
  server=await createServer({root,cacheDir:path.join(run,'vite-cache'),logLevel:'error',server:{host:'localhost',port:0},plugins:[{
    name:'observe-original-record-callbacks',enforce:'pre',transform(source,id){
      const file=id.replaceAll('\\','/').split('?')[0],code=source.replaceAll('\r\n','\n')
      if(file.endsWith('/src/components/sheets/useTableSheetModel.ts')){
        const from='  return {\n    // 落库与装载';if(code.split(from).length!==2)throw Error('record callback fixture no longer matches')
        hooks++;return code.replace(from,`  window.__recordOwnerApi = { rows, calendars, callbacks: { saveRowImage, saveAtlasConfig, createAtlasFields, handleOrganize, handleImport, importAtlasPackage, saveCalendars } };\n${from}`)
      }
      if(file.endsWith('/src/components/atlas/AtlasDetail.tsx')){
        const from='const r = await readAtlasImage(file)',done='const okSave = await commitImage(r.image)'
        if(code.split(from).length!==2||code.split(done).length!==2)throw Error('image preparation fixture no longer matches')
        return code.replace(from,`const preparation = window.__imageOwnerPause; if(preparation){ preparation.hits++; await preparation.promise }\n      ${from}`)
          .replace(done,`${done}; if(preparation){ preparation.done++; preparation.accepted=okSave }`)
      }
    },
  }]})
  await server.listen();const origin=`http://localhost:${server.httpServer.address().port}`
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']})
  const context=await browser.newContext({viewport:{width:1560,height:900},reducedMotion:'reduce'})
  await context.route('**/*',route=>{
    const url=route.request().url();if(/\/chat\/completions|\/api\/ai(?:\/|$)/.test(url))report.modelRequests.push({method:route.request().method(),origin:new URL(url).origin})
    return url.startsWith(origin+'/')?route.continue():route.abort()
  })
  page=await context.newPage();page.setDefaultTimeout(120000);page.on('pageerror',e=>report.errors.push(e.message))
  page.on('request',request=>{if(request.url().startsWith(origin+'/'))pending.set(request,new URL(request.url()).pathname)})
  page.on('requestfinished',request=>pending.delete(request))
  page.on('requestfailed',request=>{if(pending.has(request))report.assetFailures.push({path:pending.get(request),error:request.failure()?.errorText});pending.delete(request)})
  page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push(message.text().replace(/https?:\/\/[^\s)]+/g,'[url]').slice(0,400))})
  page.on('response',r=>{if(r.status()>=400)report.assetFailures.push({path:new URL(r.url()).pathname,status:r.status()})})
  await page.goto(origin,{waitUntil:'commit'});await page.getByRole('button',{name:/先看看示例/}).click()
  await page.getByRole('button',{name:'下一步',exact:true}).click();await page.getByRole('button',{name:/跳过，直接开始|开始写作/}).click()
  await page.getByRole('button',{name:'稍后再说',exact:true}).click();const nav=page.getByRole('navigation');await nav.waitFor();page.setDefaultTimeout(20000)
  await page.evaluate(async()=>{
    const db=await import('/src/lib/db.ts');(await import('/src/lib/settings/theme.ts')).applyZoom(100,{manual:true})
    await db.saveTableRow({id:'owned-image-row',projectId:db.getCurrentProjectId(),tabId:'races',data:{名称:'原仓主图条目',编号:'R9001'},order:9001})
  })
  if(!await nav.getByRole('button',{name:'种族生物',exact:true}).isVisible())await nav.getByRole('button',{name:'世界构建',exact:true}).click()
  await nav.getByRole('button',{name:'种族生物',exact:true}).click()
  await page.locator('main header').getByRole('button',{name:'图鉴',exact:true}).click()
  await page.locator('[data-workspace-record="owned-image-row"]').click();await page.locator('[data-atlas-detail]').waitFor()
  const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;const ctx=canvas.getContext('2d');ctx.fillStyle='#4d7051';ctx.fillRect(0,0,2,2);return canvas.toDataURL('image/png').split(',')[1]})
  const imageFile=path.join(run,'isolated-image.png');await fs.writeFile(imageFile,Buffer.from(png,'base64'))
  const upload=()=>page.locator('main aside input[type="file"]')
  await upload().setInputFiles(imageFile)
  await page.waitForFunction(async()=>!!(await(await import('/src/lib/db.ts')).getTableRows('races')).find(row=>row.id==='owned-image-row')?.atlasImage)
  await page.locator('main aside img').waitFor({state:'visible'})
  check('stable owner real PNG preparation writes its original row image',await page.locator('main aside img').isVisible())
  await page.evaluate(async()=>{
    const db=await import('/src/lib/db.ts'),core=await import('/src/lib/db/core.ts'),original=core.ops,pid=db.getCurrentProjectId()
    window.__oldRecordCallbacks=window.__recordOwnerApi.callbacks
    window.__originalImageRow=JSON.stringify(await original.get('tableRows','owned-image-row'))
    const isolated=await new Promise((yes,no)=>{const request=indexedDB.open('async-image-owner-replacement',1)
      request.onupgradeneeded=()=>request.result.createObjectStore('tableRows',{keyPath:'id'});request.onsuccess=()=>yes(request.result);request.onerror=()=>no(request.error)})
    const request=(mode,operation)=>new Promise((yes,no)=>{const tx=isolated.transaction('tableRows',mode),req=operation(tx.objectStore('tableRows'));let value
      req.onsuccess=()=>{value=req.result};tx.oncomplete=()=>yes(value);tx.onabort=()=>no(tx.error);tx.onerror=()=>no(tx.error)})
    await request('readwrite',store=>store.put({id:'owned-image-row',projectId:pid,tabId:'races',data:{名称:'替换仓同ID条目',编号:'R9001'},order:1}))
    let batchPause=null;const writes=[]
    const alternate={...original,get:async(store,key)=>store==='tableRows'?request('readonly',s=>s.get(key)):original.get(store,key),
      getAll:async store=>store==='tableRows'?request('readonly',s=>s.getAll()):original.getAll(store),
      getAllByIndex:async(store,index,value)=>store==='tableRows'?(await request('readonly',s=>s.getAll())).filter(row=>row[index]===value):original.getAllByIndex(store,index,value),
      put:async(store,value)=>{
        if(store==='tableRows'||store==='settingsKV')writes.push({store,id:value.id??value.key})
        if(store==='tableRows'){await request('readwrite',s=>s.put(value));if(batchPause&&value.data?.名称==='当前批次第一条'){batchPause.hits++;await batchPause.promise}}
        else await original.put(store,value)
      }}
    window.__recordFixture={original,alternate,writes,rows:()=>request('readonly',s=>s.getAll()),setBatchPause:value=>{batchPause=value}}
    let release;const promise=new Promise(resolve=>{release=resolve})
    window.__imageOwnerPause={promise,release,hits:0,done:0,accepted:null}
  })
  await upload().setInputFiles(imageFile);await page.waitForFunction(()=>window.__imageOwnerPause.hits===1)
  await page.evaluate(async()=>(await import('/src/lib/db.ts')).setStoreOps(window.__recordFixture.alternate))
  await page.waitForFunction(()=>window.__recordOwnerApi.rows.some(row=>row.data.名称==='替换仓同ID条目'))
  const before=await page.evaluate(async()=>({writes:window.__recordFixture.writes.length,rows:JSON.stringify(await window.__recordFixture.rows())}))
  await page.evaluate(()=>window.__imageOwnerPause.release());await page.waitForFunction(()=>window.__imageOwnerPause.done===1)
  check('a real delayed old PNG preparation cannot write a same-ID replacement row or report image acceptance',await page.evaluate(async before=>
    window.__imageOwnerPause.accepted===false&&window.__recordFixture.writes.length===before.writes&&JSON.stringify(await window.__recordFixture.rows())===before.rows,before))
  check('the original PNG record also remains unchanged after its old component unmounts',await page.evaluate(async()=>JSON.stringify(await window.__recordFixture.original.get('tableRows','owned-image-row'))===window.__originalImageRow))
  const late=await page.evaluate(async()=>{
    const {emptyAtlasSchema}=await import('/src/lib/atlas/schema.ts'),{buildAtlasPackage}=await import('/src/lib/atlas/packageIO.ts'),{TABS}=await import('/src/lib/schema.ts')
    const callbacks=window.__oldRecordCallbacks,config=emptyAtlasSchema(),pkg=buildAtlasPackage(TABS.find(tab=>tab.id==='races'),config,[])
    const cases=[['image',()=>callbacks.saveRowImage('owned-image-row',null)],['schema',()=>callbacks.saveAtlasConfig(config)],
      ['fields',()=>callbacks.createAtlasFields([{label:'旧字段',type:'text'}])],['organize',()=>callbacks.handleOrganize([{名称:'旧整理行'}])],
      ['import',()=>callbacks.handleImport([{data:{名称:'旧导入行'}}])],['package',()=>callbacks.importAtlasPackage(pkg)],
      ['calendar',()=>callbacks.saveCalendars([{name:'旧历法',value:0}],[])]]
    const result=[]
    for(const [name,run]of cases){const count=window.__recordFixture.writes.length;let rejected=false;try{await run()}catch{rejected=true}
      result.push({name,rejected,wrote:window.__recordFixture.writes.length!==count})}
    return result
  })
  check('all retained mutation callbacks reject or safely skip before writing into a replacement owner',late.every(r=>!r.wrote&&(r.name==='calendar'||r.rejected)),late)
  await page.evaluate(()=>{let release;const promise=new Promise(resolve=>{release=resolve});window.__batchOwnerPause={promise,release,hits:0};window.__recordFixture.setBatchPause(window.__batchOwnerPause)
    window.__batchOwnerResult=null;window.__recordOwnerApi.callbacks.handleImport([{data:{名称:'当前批次第一条'}},{data:{名称:'当前批次第二条'}}])
      .then(()=>{window.__batchOwnerResult='accepted'},()=>{window.__batchOwnerResult='rejected'})})
  await page.waitForFunction(()=>window.__batchOwnerPause.hits===1)
  await page.evaluate(async()=>{(await import('/src/lib/db.ts')).setStoreOps(window.__recordFixture.original);window.__batchOwnerPause.release()})
  await page.waitForFunction(()=>window.__batchOwnerResult!==null)
  const partial=await page.evaluate(async()=>{
    const rows=await window.__recordFixture.rows(),old=await window.__recordFixture.original.getAllByIndex('tableRows','tabId','races')
    return {result:window.__batchOwnerResult,issued:rows.filter(r=>r.data.名称?.startsWith('当前批次')).length,
      second:rows.some(r=>r.data.名称==='当前批次第二条'),wrongOwner:old.some(r=>r.data.名称?.startsWith('当前批次'))}
  })
  check('a current batch stops after an issued row when owner changes and never writes its second row into either owner',partial.result==='rejected'&&partial.issued===1&&!partial.second&&!partial.wrongOwner,partial)
  check('callback observation used the actual transformed host',hooks>0)
  check('no model requests',report.modelRequests.length===0,report.modelRequests);check('no browser errors',report.errors.length===0,report.errors);report.status='passed'
}catch(error){report.status='failed';report.failure=error.stack||String(error);report.pendingAssets=[...pending.values()].slice(0,80)
  report.documentState=await page?.evaluate(()=>({ready:document.readyState,rootChildren:document.getElementById('root')?.childElementCount,title:document.title})).catch(()=>null)
  await page?.screenshot({path:path.join(run,'failure.png'),animations:'disabled'}).catch(()=>{})}
finally{
  report.stale=fingerprint!==snapshot(root).fingerprint;if(report.stale)report.status='failed';report.passed=report.checks.filter(c=>c.passed).length
  await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2));await browser?.close();await server?.close()
  console.log(JSON.stringify({run,status:report.status,passed:report.passed,total:report.checks.length,stale:report.stale,failure:report.failure}));if(report.status!=='passed')process.exitCode=1
}
