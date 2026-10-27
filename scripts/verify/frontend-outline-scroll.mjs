// UX06 semantic list/field anchors, with isolated demo data and controlled font readiness.
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createServer} from 'vite'
import {chromium} from 'playwright'
import {snapshot} from '../audit/platform/source.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const run=await fs.mkdtemp(path.join(root,'.workbuddy/tmp/frontend-outline-scroll-'))
const fingerprint=snapshot(root).fingerprint
const report={kind:'frontend-outline-scroll',at:new Date().toISOString(),run,fingerprint,checks:[],errors:[],modelRequests:[],status:'running'}
const check=(name,passed,details)=>{report.checks.push({name,passed:!!passed,details});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw Error(name+': '+JSON.stringify(details))}
let server,browser,page
try{
  server=await createServer({optimizeDeps:{entries:['index.html','tests/browser/*.html']},root,cacheDir:path.join(run,'vite-cache'),logLevel:'error',server:{host:'localhost',port:0}})
  await server.listen();const origin=`http://localhost:${server.httpServer.address().port}`
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']})
  const context=await browser.newContext({viewport:{width:1366,height:900},reducedMotion:'reduce'})
  await context.route('**/*',route=>{
    const url=route.request().url()
    if(/\/chat\/completions|\/api\/ai(?:\/|$)/.test(url)){report.modelRequests.push(route.request().method());return route.abort()}
    return url.startsWith(origin+'/')?route.continue():route.abort()
  })
  page=await context.newPage();page.setDefaultTimeout(120000);page.on('pageerror',e=>report.errors.push(e.message))
  await page.goto(origin,{waitUntil:'commit'})
  await page.getByRole('button',{name:/先看看示例/}).click()
  await page.getByRole('button',{name:'下一步',exact:true}).click()
  await page.getByRole('button',{name:/跳过，直接开始|开始写作/}).click()
  await page.getByRole('button',{name:'稍后再说',exact:true}).click()
  const nav=page.getByRole('navigation');await nav.waitFor();page.setDefaultTimeout(20000)
  const fixture=await page.evaluate(async()=>{
    const db=await import('/src/lib/db.ts'),{getTab}=await import('/src/lib/schema.ts')
    ;(await import('/src/lib/settings/theme.ts')).applyZoom(100,{manual:true})
    const tab=getTab('chapter-outline'),fields=tab.modules.flatMap(mod=>mod.fields.map(field=>`${mod.name}::${field.name}`))
    for(let i=0;i<100;i++){
      const name='锚点'+String(i).padStart(3,'0'),data=Object.fromEntries(fields.map(key=>[key,key==='一、本章定位::章节号/标题'?name:'正文不应进入视图记录：'+('仅作隔离取证\n'.repeat(8))]))
      await db.saveCardRecord({id:'scroll-'+i,projectId:db.getCurrentProjectId(),tabId:tab.id,name,data,order:-1000+i})
    }
    window.__outlineScrollPuts=0;const put=IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put=function(...args){if(this.name==='cardRecords')window.__outlineScrollPuts++;return put.apply(this,args)}
    return {projectId:db.getCurrentProjectId(),field:fields[8],original:JSON.stringify(await db.getCardRecords(tab.id))}
  })
  if(!await nav.getByRole('button',{name:'章节细纲',exact:true}).isVisible())await nav.getByRole('button',{name:'大纲规划',exact:true}).click()
  const navigate=async name=>{
    if(!await nav.isVisible())await page.getByRole('button',{name:'打开项目菜单',exact:true}).click()
    await nav.getByRole('button',{name,exact:true}).click()
  }
  const enter=()=>navigate('章节细纲')
  const dashboard=async()=>{await navigate('写作面板');await page.getByRole('heading',{name:'写作面板',exact:true}).waitFor()}
  const list=page.locator('[data-master-scroll]'),detail=page.locator('[data-outline-detail]')
  const pick=page.getByRole('button',{name:'选择章节大纲：锚点060',exact:true})
  const twoFrames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  const position=async()=>{
    await page.evaluate(({field})=>{
      const pairs=[[document.querySelector('[data-master-scroll]'),'data-workspace-record','scroll-65',13],
        [document.querySelector('[data-outline-detail]'),'data-workspace-field',field,17]]
      for(const [el,attr,id,offset]of pairs){
        const row=[...el.querySelectorAll(`[${attr}]`)].find(node=>node.getAttribute(attr)===id),box=el.getBoundingClientRect(),scale=box.height/el.offsetHeight
        el.scrollTop+=(row.getBoundingClientRect().top-box.top)/scale+offset;el.dispatchEvent(new Event('scroll'))
      }
    },fixture)
    await twoFrames()
  }
  const geometry=()=>page.evaluate(({field})=>{
    const pairs=[[document.querySelector('[data-master-scroll]'),'data-workspace-record','scroll-65'],
      [document.querySelector('[data-outline-detail]'),'data-workspace-field',field]]
    return pairs.map(([el,attr,id])=>{const row=[...el.querySelectorAll(`[${attr}]`)].find(node=>node.getAttribute(attr)===id),box=el.getBoundingClientRect(),scale=box.height/el.offsetHeight
      return {top:el.scrollTop,offset:row?(row.getBoundingClientRect().top-box.top)/scale:null,max:el.scrollHeight-el.clientHeight}})
  },fixture)
  const waitRestored=()=>page.waitForFunction(({field})=>{
    const pairs=[[document.querySelector('[data-master-scroll]'),'data-workspace-record','scroll-65',-13],
      [document.querySelector('[data-outline-detail]'),'data-workspace-field',field,-17]]
    return pairs.every(([el,attr,id,offset])=>{
      if(!el)return false
      const row=[...el.querySelectorAll(`[${attr}]`)].find(node=>node.getAttribute(attr)===id),box=el.getBoundingClientRect(),scale=box.height/el.offsetHeight
      return row&&Math.abs((row.getBoundingClientRect().top-box.top)/scale-offset)<4
    })
  },fixture)
  await enter();await pick.click();await page.getByRole('heading',{name:'锚点060',exact:true}).waitFor();await twoFrames()
  await page.evaluate(()=>{
    window.__outlineScrollTrace=[]
    const detail=document.querySelector('[data-outline-detail]')
    detail.addEventListener('scroll',()=>window.__outlineScrollTrace.push({event:'scroll',top:detail.scrollTop}))
    document.addEventListener('pointerdown',()=>window.__outlineScrollTrace.push({event:'pointer',top:document.querySelector('[data-outline-detail]')?.scrollTop}),true)
  })
  await position();const initial=await geometry()
  check('both independent panes can reach nonzero semantic anchors',initial.every(row=>row.top>100),initial)
  const readDetail=()=>page.evaluate(async({projectId})=>{
    const {workspaceViews}=await import('/src/lib/settings/workspaceViewState.ts'),{currentWorkspaceScope}=await import('/src/lib/settings/workspaceRuntime.ts')
    return workspaceViews.get(currentWorkspaceScope(projectId,'outline:chapter-outline'),'scroll-60')
  },fixture)
  report.beforeLeave=await readDetail()
  await dashboard();report.afterLeave=await readDetail();await enter()
  try { await waitRestored() } catch(error) {
    const diagnostic=await page.evaluate(async({projectId,field})=>{
      const {workspaceViews}=await import('/src/lib/settings/workspaceViewState.ts'),{currentWorkspaceScope}=await import('/src/lib/settings/workspaceRuntime.ts')
      const panes=['[data-master-scroll]','[data-outline-detail]'].map(selector=>{const el=document.querySelector(selector);return {top:el?.scrollTop,height:el?.clientHeight,scrollHeight:el?.scrollHeight}})
      return {panes,field,list:workspaceViews.get(currentWorkspaceScope(projectId,'list:chapter-outline'),'list-state'),detail:workspaceViews.get(currentWorkspaceScope(projectId,'outline:chapter-outline'),'scroll-60'),fonts:document.fonts.status,trace:window.__outlineScrollTrace}
    },fixture)
    throw Error(String(error)+' '+JSON.stringify({diagnostic,beforeLeave:report.beforeLeave,afterLeave:report.afterLeave,geometry:await geometry()}))
  }
  check('real page return restores both list record and detail field offsets',await pick.getAttribute('aria-pressed')==='true',await geometry())
  const memory=await page.evaluate(async({projectId})=>{
    const {workspaceViews}=await import('/src/lib/settings/workspaceViewState.ts'),{currentWorkspaceScope}=await import('/src/lib/settings/workspaceRuntime.ts')
    return [workspaceViews.get(currentWorkspaceScope(projectId,'list:chapter-outline'),'list-state'),workspaceViews.get(currentWorkspaceScope(projectId,'outline:chapter-outline'),'scroll-60')]
  },fixture)
  check('one navigation capture retains both bounded metadata records without field bodies',memory[0]?.anchor?.id==='scroll-65'
    &&memory[1]?.anchor?.id===fixture.field&&!JSON.stringify(memory).includes('正文不应进入视图记录'),memory.map(row=>({kind:row?.kind,anchor:row?.anchor})))
  await dashboard()
  await page.setViewportSize({width:1000,height:640})
  await page.evaluate(async()=>{(await import('/src/lib/settings/density.ts')).applyDensity('comfortable');(await import('/src/lib/settings/theme.ts')).applyZoom(125,{manual:true})})
  await enter();await waitRestored()
  check('anchors survive width, density and CSS zoom changes while away',true,await geometry())
  await page.screenshot({path:path.join(run,'outline-scroll-comfortable-125.png'),animations:'disabled'})
  await page.setViewportSize({width:1366,height:900})
  await page.evaluate(async()=>{(await import('/src/lib/settings/density.ts')).applyDensity('compact');(await import('/src/lib/settings/theme.ts')).applyZoom(100,{manual:true})})
  await position();await dashboard()
  await page.evaluate(()=>{
    const fonts=document.fonts,status=Object.getOwnPropertyDescriptor(fonts,'status')
    Object.defineProperty(fonts,'status',{configurable:true,get:()=> 'loading'})
    window.__restoreOutlineFonts=()=>{if(status)Object.defineProperty(fonts,'status',status);else delete fonts.status}
  })
  await enter();await detail.waitFor()
  await detail.evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-20}));el.dispatchEvent(new Event('scroll'))})
  await page.evaluate(()=>window.__restoreOutlineFonts());await page.waitForTimeout(500)
  check('manual input during delayed font readiness cancels the old detail restore',await detail.evaluate(el=>el.scrollTop<2))
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('yfe:navigate',{detail:{tabId:'chapter-outline',rowId:'scroll-99'}})))
  const target=page.getByRole('button',{name:'选择章节大纲：锚点099',exact:true});await target.waitFor()
  await page.waitForFunction(()=>{
    const el=document.querySelector('[data-master-scroll]'),row=document.querySelector('[data-workspace-record="scroll-99"]')
    if(!el||!row)return false
    const a=el.getBoundingClientRect(),b=row.getBoundingClientRect();return b.top>=a.top-2&&b.bottom<=a.bottom+2
  })
  check('explicit record request overrides an unrelated remembered list anchor',await target.getAttribute('aria-pressed')==='true')
  const query=page.getByRole('textbox',{name:'搜章节名…',exact:true});await query.fill('锚点00');await page.waitForTimeout(200)
  check('consumed explicit requests never revive when the author starts filtering',await query.inputValue()==='锚点00'&&await list.evaluate(el=>el.scrollTop<2))
  await query.fill('');await pick.click();await page.getByRole('heading',{name:'锚点060',exact:true}).waitFor();await twoFrames()
  await position();await dashboard()
  await page.evaluate(async()=>(await import('/src/lib/db.ts')).deleteCardRecord('scroll-65'))
  await enter();await pick.waitFor();await page.waitForTimeout(350)
  check('deleted list anchors fall back to the start without changing the valid selected record',await list.evaluate(el=>el.scrollTop<2)&&await pick.getAttribute('aria-pressed')==='true')
  const unchanged=await page.evaluate(async original=>{
    const db=await import('/src/lib/db.ts'),rows=await db.getCardRecords('chapter-outline')
    return JSON.stringify(rows)===JSON.stringify(JSON.parse(original).filter(row=>row.id!=='scroll-65'))&&!rows.some(row=>row.id==='scroll-65')&&window.__outlineScrollPuts===0
  },fixture.original)
  check('scroll restoration never rewrites business records or resurrects the deleted row',unchanged)
  check('no model requests',report.modelRequests.length===0,report.modelRequests)
  check('no browser errors',report.errors.length===0,report.errors)
  report.status='passed'
}catch(error){report.status='failed';report.failure=error.stack||String(error);await page?.screenshot({path:path.join(run,'failure.png'),fullPage:true,animations:'disabled'}).catch(()=>{})}
finally{
  report.stale=fingerprint!==snapshot(root).fingerprint;if(report.stale)report.status='failed'
  report.passed=report.checks.filter(check=>check.passed).length
  await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2));await browser?.close();await server?.close()
  console.log(JSON.stringify({run,status:report.status,passed:report.passed,total:report.checks.length,stale:report.stale,failure:report.failure}))
  if(report.status!=='passed')process.exitCode=1
}
