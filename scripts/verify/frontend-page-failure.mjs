// UX13: real rejected lazy resource, retained project frame, and explicit document reload.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const run=await fs.mkdtemp(path.join(root,'.workbuddy/tmp/frontend-page-failure-'))
const fingerprint=snapshot(root).fingerprint
const report={kind:'frontend-page-failure',at:new Date().toISOString(),run,fingerprint,checks:[],errors:[],expectedResourceErrors:[],modelRequests:[],blocked:0,status:'running'}
const check=(name,passed,details)=>{report.checks.push({name,passed:!!passed,details});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw Error(name+': '+JSON.stringify(details))}
let server,browser,page,block=true
try{
  server=await createServer({root,cacheDir:path.join(run,'vite-cache'),logLevel:'error',server:{host:'localhost',port:0}})
  await server.listen();const origin=`http://localhost:${server.httpServer.address().port}`
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']})
  const context=await browser.newContext({viewport:{width:1366,height:900},reducedMotion:'reduce'})
  await context.route('**/*',route=>{
    const url=route.request().url()
    if(/\/chat\/completions|\/api\/ai(?:\/|$)/.test(url)){report.modelRequests.push(route.request().method());return route.abort()}
    if(block&&new URL(url).pathname==='/src/components/app/GuidePage.tsx'){report.blocked++;return route.abort('failed')}
    return url.startsWith(origin+'/')?route.continue():route.abort()
  })
  page=await context.newPage();page.setDefaultTimeout(120000)
  page.on('pageerror',error=>{
    if(report.blocked>0&&error.message.includes(origin+'/src/components/app/GuidePage.tsx'))report.expectedResourceErrors.push(error.message)
    else report.errors.push(error.message)
  })
  await page.goto(origin,{waitUntil:'commit'})
  await page.getByRole('button',{name:/先看看示例/}).click()
  await page.getByRole('button',{name:'下一步',exact:true}).click()
  await page.getByRole('button',{name:/跳过，直接开始|开始写作/}).click()
  await page.getByRole('button',{name:'稍后再说',exact:true}).click()
  const nav=page.getByRole('navigation');await nav.waitFor();page.setDefaultTimeout(20000)
  await nav.evaluate(el=>{el.dataset.frameIdentity='preserved-project-frame'})
  const owner=await page.evaluate(async()=>{const db=await import('/src/lib/db.ts');return {id:db.getCurrentProjectId(),name:(await db.getProject(db.getCurrentProjectId())).name}})
  await nav.getByRole('button',{name:'正文编辑',exact:true}).click()
  const editor=page.locator('textarea.novel-textarea');await editor.waitFor()
  const latest=(await editor.inputValue())+'\n资源失败前的离页保存核验'
  await editor.fill(latest)
  await nav.getByRole('button',{name:'使用指南',exact:true}).click()
  const failure=page.getByRole('heading',{name:'当前页面暂时无法打开',exact:true});await failure.waitFor()
  check('a real lazy resource rejection leaves the same project navigation mounted',report.blocked>0&&await nav.isVisible()
    &&await nav.getAttribute('data-frame-identity')==='preserved-project-frame')
  check('embedded failure does not introduce another full-screen main landmark',await page.getByRole('main').count()===1)
  const saved=await page.evaluate(async latest=>{
    const db=await import('/src/lib/db.ts'),chapters=await db.getAllChapters(),chapter=chapters.find(row=>row.content===latest)
    return {id:chapter?.id,chapters:JSON.stringify(chapters)}
  },latest)
  check('the normal leave barrier saved the actual edited chapter before resource loading failed',!!saved.id)
  check('a cached lazy rejection is not advertised as a component-reset retry',!await page.getByRole('button',{name:'重试当前页面',exact:true}).count()
    &&await page.getByRole('button',{name:'重新加载工作台',exact:true}).isVisible())
  await page.getByText('查看技术摘要',{exact:true}).click()
  const summary=await page.locator('pre').innerText()
  check('the visible diagnostic summary excludes workspace URLs and manuscript contents',!summary.includes(origin)&&!summary.includes('/src/components')&&!summary.includes('资源失败前的离页保存核验'),summary)
  await page.screenshot({path:path.join(run,'page-failure.png'),animations:'disabled'})
  await page.getByRole('button',{name:'返回写作面板',exact:true}).click()
  await page.getByRole('heading',{name:'写作面板',exact:true}).waitFor()
  check('returning to writing keeps the current project and authoritative chapter bytes',await page.evaluate(async expected=>{
    const db=await import('/src/lib/db.ts');return db.getCurrentProjectId()===expected.id&&JSON.stringify(await db.getAllChapters())===expected.chapters
  },{id:owner.id,chapters:saved.chapters}))
  const blocked=report.blocked
  await nav.getByRole('button',{name:'使用指南',exact:true}).click();await failure.waitFor();await page.waitForTimeout(300)
  check('reentering the rejected page has a bounded fallback rather than an automatic fetch loop',report.blocked===blocked)
  block=false
  await Promise.all([page.waitForEvent('load'),page.getByRole('button',{name:'重新加载工作台',exact:true}).click()])
  await page.getByRole('button',{name:'打开项目',exact:true}).waitFor({timeout:120000})
  page.setDefaultTimeout(20000)
  check('manual reload returns to the project entry and retains saved data',await page.evaluate(async({id,chapterId,latest})=>{
    const db=await import('/src/lib/db.ts'),{ops}=await import('/src/lib/db/core.ts')
    return !!await db.getProject(id)&&(await ops.get('chapters',chapterId))?.content===latest
  },{id:owner.id,chapterId:saved.id,latest}))
  await page.getByRole('button',{name:'打开项目',exact:true}).click()
  await nav.waitFor();await page.getByRole('button',{name:'稍后再说',exact:true}).click({timeout:1000}).catch(()=>{})
  await nav.getByRole('button',{name:'使用指南',exact:true}).click()
  await page.getByRole('heading',{name:'使用指南',exact:true}).waitFor()
  check('a new document really fetches the restored resource and opens the page',!await failure.count())
  check('no unexpected runtime errors',report.errors.length===0,report.errors)
  check('no model requests',report.modelRequests.length===0,report.modelRequests)
  report.status='passed'
}catch(error){report.status='failed';report.failure=error.stack||String(error);await page?.screenshot({path:path.join(run,'failure.png'),fullPage:true,animations:'disabled'}).catch(()=>{})}
finally{
  report.stale=fingerprint!==snapshot(root).fingerprint;if(report.stale)report.status='failed'
  report.passed=report.checks.filter(check=>check.passed).length
  await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2))
  await browser?.close();await server?.close()
  console.log(JSON.stringify({run,status:report.status,passed:report.passed,total:report.checks.length,stale:report.stale,failure:report.failure}))
  if(report.status!=='passed')process.exitCode=1
}
