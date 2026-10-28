// 拆书断点·真机验证（隔离 SPA + 注入断点，不调用真实模型）
//
// 交接要求「切页恢复 / 跨项目不能误续 / 失败不静默」必须在真实浏览器里看，而不是只看单测。
// 这里不跑 AI：直接把一条**带身份信息的断点**注入任务中心，再看面板怎么反应
// —— 面板的所有判断都基于任务中心的 resume 快照，注入即可覆盖。
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createServer} from 'vite'
import {chromium} from 'playwright'
import {snapshot} from '../audit/platform/source.mjs'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const run=await fs.mkdtemp(path.join(root,'.workbuddy/tmp/frontend-bookbreak-resume-'))
const fingerprint=snapshot(root).fingerprint
const report={kind:'frontend-bookbreak-resume',at:new Date().toISOString(),run,fingerprint,checks:[],errors:[],modelRequests:[],status:'running'}
const check=(name,passed,details)=>{report.checks.push({name,passed:!!passed,details});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw Error(name+': '+JSON.stringify(details))}
let server,browser,page
const TEXT='第一章 风起\n'+'甲'.repeat(400)+'\n\n第二章 逆流\n'+'乙'.repeat(400)
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
  await page.evaluate(async()=>{(await import('/src/lib/settings/theme.ts')).applyZoom(100,{manual:true})})

  const rawBox=()=>page.getByPlaceholder(/把小说原文粘贴到这里/)
  const gotoBookbreak=async()=>{
    await nav.waitFor({state:'visible'})
    if(!await nav.getByRole('button',{name:/拆书/}).first().isVisible().catch(()=>false)){
      await nav.getByRole('button',{name:'灵感工具',exact:true}).click().catch(()=>{})
    }
    await nav.getByRole('button',{name:/拆书/}).first().click()
    await rawBox().waitFor({timeout:30000})
  }
  /** 注入一条断点：`fail` 时任务记为失败（模拟"上次失败"），否则记为完成 */
  const inject = (opts) => page.evaluate(async opts => {
    const tc=await import('/src/lib/ai/aiTaskCenter.ts')
    const runMod=await import('/src/lib/bookbreak/run.ts')
    tc.resetTaskCenter()
    const base=runMod.initialBookBreakResume(opts.text,{})
    const checkpoint={...base,doneUnits:1,totalUnits:2,label:'已完成 1/2 个抽取单元',...(opts.patch||{})}
    tc.startTask({ownerTab:'bookbreak',kind:'bookbreak',title:'一键拆书',run:async ctx=>{
      ctx.setResume(checkpoint)
      throw new Error('隔离验证：模拟抽取失败')
    }})
    return {projectId:base.projectId}
  }, opts)

  await gotoBookbreak()
  check('① 拆书页可达（原文框在）',await rawBox().isVisible())

  // ---- 场景 A：本项目的失败断点 → 切页回来原文与失败提示都还在 ----
  const a=await inject({text:TEXT})
  report.projectId=a.projectId
  await nav.getByRole('button',{name:'写作面板',exact:true}).click()   // 卸掉拆书面板
  await nav.waitFor({state:'visible'})
  await gotoBookbreak()                                              // 重新挂载
  await page.waitForTimeout(400)
  check('🔴 ② 切页回来后原文已回填（断点留在任务内存，不靠偏好/书库）',
    (await rawBox().inputValue())===TEXT,{len:(await rawBox().inputValue()).length})
  const alerts=()=>page.locator('[role="alert"]').allInnerTexts()
  const texts=(await alerts()).join('\n')
  check('🔴 ③ 失败不静默：页面有失败提示',/上次拆书未完成/.test(texts),texts)
  check('🔴 ④ 断点说明写明"上次失败在"与进度',/上次失败在/.test(await page.locator('body').innerText())
    &&/已完成 1\/2 个抽取单元/.test(await page.locator('body').innerText()))
  const startBtn=page.getByRole('button',{name:/继续抽取|开始抽取/}).first()
  check('⑤ 有断点时按钮文案为「继续抽取」',/继续抽取/.test(await startBtn.innerText()),await startBtn.innerText())

  // ---- 场景 B：断点属于另一项目 → 拦截，不允许在当前书里续 ----
  await inject({text:TEXT,patch:{projectId:'another-book'}})
  await nav.getByRole('button',{name:'写作面板',exact:true}).click()
  await nav.waitFor({state:'visible'})
  await gotoBookbreak()
  await page.waitForTimeout(400)
  const texts2=(await page.locator('body').innerText())
  check('🔴 ⑥ 跨项目断点被拦下并说明原因',/属于另一项目或存储空间/.test(texts2),texts2.slice(0,200))
  const blocked=await page.getByRole('button',{name:/继续抽取|开始抽取/}).first().isDisabled()
  check('🔴 ⑦ 跨项目时开始/继续按钮禁用（不能误续）',blocked,{disabled:blocked})
  check('⑦ 跨项目时原文也不再回填成旧项目的内容',(await rawBox().inputValue())!==TEXT)

  check('没有任何真实模型请求',report.modelRequests.length===0,report.modelRequests)
  check('没有浏览器异常',report.errors.length===0,report.errors)
  report.status='passed'
}catch(error){
  report.status='failed';report.failure=error.stack||String(error)
  await page?.screenshot({path:path.join(run,'failure.png'),fullPage:true,animations:'disabled'}).catch(()=>{})
}finally{
  report.stale=snapshot(root).fingerprint!==fingerprint
  await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2))
  await browser?.close().catch(()=>{});await server?.close().catch(()=>{})
  console.log(JSON.stringify({run,status:report.status,passed:report.checks.filter(c=>c.passed).length,total:report.checks.length,stale:report.stale,failure:report.failure}))
  if(report.status!=='passed')process.exitCode=1
}
