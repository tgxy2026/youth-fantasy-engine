// UX07 real remaining-height allocation, isolated data and no model calls.
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createServer} from 'vite'
import {chromium} from 'playwright'
import {snapshot} from '../audit/platform/source.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const run=await fs.mkdtemp(path.join(root,'.workbuddy/tmp/frontend-outline-layout-'))
const fingerprint=snapshot(root).fingerprint
const report={kind:'frontend-outline-layout',at:new Date().toISOString(),run,fingerprint,checks:[],samples:[],errors:[],modelRequests:[],status:'running'}
const check=(name,passed,details)=>{report.checks.push({name,passed:!!passed,details});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw Error(name+': '+JSON.stringify(details))}
let server,browser,page
try{
  server=await createServer({root,cacheDir:path.join(run,'vite-cache'),logLevel:'error',server:{host:'localhost',port:0}})
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
  await page.evaluate(async()=>{
    const db=await import('/src/lib/db.ts'),{getTab}=await import('/src/lib/schema.ts')
    for(const tabId of ['chapter-outline','volume-outline']){
      const tab=getTab(tabId),fields=tab.modules.flatMap(mod=>mod.fields.map(field=>`${mod.name}::${field.name}`))
      for(let i=0;i<24;i++){
        const name='布局'+String(i).padStart(2,'0')+(i===7?'LongUnbrokenName'.repeat(12):'')
        const data=Object.fromEntries(fields.map(key=>[key,/::(?:卷名|章节号\/标题)$/.test(key)?name:'隔离布局内容\n'.repeat(8)]))
        await db.saveCardRecord({id:`layout-${tabId}-${i}`,projectId:db.getCurrentProjectId(),tabId,name,data,order:-1000+i})
      }
    }
    const creative=await import('/src/lib/creative/creativeSession.ts')
    await creative.hydrateCreativeSession();creative.updateInputs({structureId:'stc-15'})
    window.__layoutPuts=0;const put=IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put=function(...args){if(this.name==='cardRecords')window.__layoutPuts++;return put.apply(this,args)}
  })
  const navigate=async name=>{
    if(!await nav.isVisible())await page.getByRole('button',{name:'打开项目菜单',exact:true}).click()
    const button=nav.getByRole('button',{name,exact:true})
    if(!await button.isVisible())await nav.getByRole('button',{name:'大纲规划',exact:true}).click()
    await button.click()
  }
  const cases=[
    {width:1366,height:900,zoom:100,density:'compact'},
    {width:1366,height:900,zoom:100,density:'comfortable'},
    {width:1000,height:640,zoom:125,density:'comfortable'},
    {width:1000,height:640,zoom:160,density:'comfortable'},
    {width:768,height:1024,zoom:125,density:'comfortable'},
    {width:1024,height:600,zoom:100,density:'compact'},
  ]
  for(const sample of cases)for(const [tabId,name]of [['chapter-outline','章节细纲'],['volume-outline','分卷大纲']]){
    const label=`${tabId} ${sample.width}x${sample.height}@${sample.zoom} ${sample.density}`
    await page.setViewportSize({width:sample.width,height:sample.height})
    await page.evaluate(async({zoom,density})=>{
      ;(await import('/src/lib/settings/density.ts')).applyDensity(density)
      ;(await import('/src/lib/settings/theme.ts')).applyZoom(zoom,{manual:true})
    },sample)
    await navigate(name)
    const row=page.locator(`[data-outline-record="layout-${tabId}-7"]`)
    await row.locator('button').first().click()
    await page.waitForTimeout(250)
    const geometry=await page.evaluate(()=>{
      const root=document.querySelector('[data-outline-workspace]'),master=root.querySelector('[data-master-detail]')
      const list=root.querySelector('[data-master-scroll]'),detail=root.querySelector('[data-outline-detail]'),main=root.closest('main')
      const box=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}}
      const header=root.querySelector('header'),structure=root.querySelector('[data-outline-structure]')
      const scale=root.getBoundingClientRect().width/root.offsetWidth
      return {root:box(root),master:box(master),header:box(header),structure:structure?box(structure):null,
        main:box(main),list:box(list),detail:box(detail),scale,mainOverflow:main.scrollWidth-main.clientWidth,
        fill:master.hasAttribute('data-master-fill'),inlineHeight:master.style.height}
    })
    report.samples.push({label,geometry})
    check(label+' uses actual remaining height with reachable panes',geometry.fill&&!geometry.inlineHeight
      &&geometry.master.y>=Math.max(geometry.header.bottom,geometry.structure?.bottom??0)-2
      &&geometry.list.height/geometry.scale>=24&&geometry.detail.height/geometry.scale>=80,geometry)
    check(label+' has no horizontal page overflow',geometry.mainOverflow<=2,geometry)
    const independent=await page.evaluate(()=>{
      const list=document.querySelector('[data-master-scroll]'),detail=document.querySelector('[data-outline-detail]')
      detail.scrollTop=0;list.scrollTop=list.scrollHeight;const position=list.scrollTop
      const first=detail.scrollTop===0&&position>0
      detail.scrollTop=detail.scrollHeight
      return first&&detail.scrollTop>0&&Math.abs(list.scrollTop-position)<1
    })
    check(label+' list and detail scroll independently',independent)
    await page.locator('[data-outline-detail] textarea').last().scrollIntoViewIfNeeded()
    const reachable=await page.locator('[data-outline-detail] textarea').last().evaluate(el=>{
      const r=el.getBoundingClientRect(),main=el.closest('main').getBoundingClientRect(),detail=el.closest('[data-outline-detail]').getBoundingClientRect()
      return Math.min(r.bottom,detail.bottom,main.bottom,innerHeight)-Math.max(r.top,detail.top,main.top,0)>10
    })
    check(label+' bottom field remains reachable',reachable)
    await row.locator('button').first().focus()
    await page.mouse.move(0,0)
    check(label+' keyboard focus reveals record actions',await row.locator('[data-outline-actions]').evaluate(el=>getComputedStyle(el).opacity==='1'))
    await page.locator('[data-outline-detail] h2 button').focus()
    await page.keyboard.press('Enter')
    const dialog=page.getByRole('dialog',{name:`修改${tabId==='chapter-outline'?'章节':'分卷'}名称`,exact:true})
    await dialog.waitFor()
    check(label+' record rename opens with the keyboard',await dialog.isVisible())
    await page.keyboard.press('Escape')
    await page.getByRole('button',{name:`${name} · 怎么填`,exact:true}).click()
    check(label+' tips remain available in help',await page.getByText('填写提示：',{exact:false}).isVisible())
    await page.keyboard.press('Escape')
    await page.screenshot({path:path.join(run,`${tabId}-${sample.width}-${sample.zoom}-${sample.density}.png`),animations:'disabled'})
  }
  check('layout, zoom, help and focus operations never rewrite business records',await page.evaluate(()=>window.__layoutPuts===0))
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
