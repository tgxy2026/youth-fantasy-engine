// 键盘重排·真机验证（UX12 替代入口）
//
// 章节树此前只能拖拽。这里验的是「键盘真的能排」：聚焦把手 → Alt+↓ → 库里顺序真的变了；
// 到边界按 Alt+↑ 不许动、也不许假报"已保存"。全程不碰模型。
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createServer} from 'vite'
import {chromium} from 'playwright'
import {snapshot} from '../audit/platform/source.mjs'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const run=await fs.mkdtemp(path.join(root,'.workbuddy/tmp/frontend-keyboard-reorder-'))
const fingerprint=snapshot(root).fingerprint
const report={kind:'frontend-keyboard-reorder',at:new Date().toISOString(),run,fingerprint,checks:[],errors:[],modelRequests:[],status:'running'}
const check=(name,passed,details)=>{report.checks.push({name,passed:!!passed,details});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw Error(name+': '+JSON.stringify(details))}
let server,browser,page
try{
  server=await createServer({root,cacheDir:path.join(run,'vite-cache'),logLevel:'error',server:{host:'localhost',port:0}})
  await server.listen();const origin=`http://localhost:${server.httpServer.address().port}`
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']})
  const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'})
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
  const nav=page.getByRole('navigation');await nav.waitFor();page.setDefaultTimeout(25000)
  await page.evaluate(async()=>{(await import('/src/lib/settings/theme.ts')).applyZoom(100,{manual:true})})
  await nav.getByRole('button',{name:'正文编辑',exact:true}).click()
  await page.locator('main textarea').first().waitFor()

  /** 读某一卷里按 order 排好的章（真实库） */
  const chaptersOfVolume=()=>page.evaluate(async()=>{
    const db=await import('/src/lib/db.ts')
    const pid=db.getCurrentProjectId()
    const chs=(await db.getAllChapters()).filter(c=>c.projectId===pid&&!c.isFree)
    const byVol=new Map()
    for(const c of chs){ if(!byVol.has(c.volumeId))byVol.set(c.volumeId,[]); byVol.get(c.volumeId).push(c) }
    for(const list of byVol.values())list.sort((a,b)=>a.order-b.order)
    // 取第一个至少两章的卷（示例项目通常有多章）
    for(const [volumeId,list] of byVol){ if(list.length>=2) return {volumeId, ids:list.map(c=>c.id), titles:list.map(c=>c.title)} }
    return null
  })
  const before=await chaptersOfVolume()
  check('① 示例项目里存在可重排的卷（≥2 章）',!!before,{before})

  const handleOf=(title)=>page.locator(`[role="button"][aria-label^="移动章节"]`).filter({has:page.locator(`xpath=.`)}).filter({hasText:''}).and(page.locator(`[aria-label*="${title}"]`)).first()
  const handleByTitle=(title)=>page.locator(`[aria-label="移动章节「${title}」：Alt 加向上/向下方向键（仅在本卷内）"]`).first()

  // ② 把手可聚焦、有可读名称
  const firstHandle=handleByTitle(before.titles[0])
  await firstHandle.waitFor({timeout:20000})
  const attrs=await firstHandle.evaluate(el=>({tabIndex:el.tabIndex,role:el.getAttribute('role'),label:el.getAttribute('aria-label')}))
  check('🔴 ② 拖拽把手可聚焦且带可读名称（键盘/读屏可达）',
    attrs.tabIndex===0&&attrs.role==='button'&&/^移动章节/.test(attrs.label||''),attrs)

  // ③ Alt+↓ 真的换位并落库
  await firstHandle.focus()
  await page.keyboard.press('Alt+ArrowDown')
  const swapped=await page.waitForFunction(async prev=>{
    const db=await import('/src/lib/db.ts')
    const list=(await db.getAllChapters()).filter(c=>c.projectId===db.getCurrentProjectId()&&!c.isFree&&c.volumeId===prev.volumeId).sort((a,b)=>a.order-b.order)
    return list.length>=2&&list[0].id===prev.ids[1]&&list[1].id===prev.ids[0]
  },before,{timeout:20000}).then(()=>true).catch(()=>false)
  check('🔴 ③ Alt+↓ 把第一章与下一章换位（并写入库）',swapped,await chaptersOfVolume())

  // ④ 到边界按 Alt+↑ 不许动
  const now=await chaptersOfVolume()
  const boundary=handleByTitle(now.titles[0])
  await boundary.focus()
  await page.keyboard.press('Alt+ArrowUp')
  await page.waitForTimeout(600)
  const after=await chaptersOfVolume()
  check('🔴 ④ 已在首位时 Alt+↑ 不改变顺序（不产生空操作）',
    JSON.stringify(after.ids)===JSON.stringify(now.ids),{now:now.ids,after:after.ids})

  // ⑤ 页面上不该出现"排序已保存"的假反馈（边界那一下）
  const toastTexts=await page.locator('[role="status"],[role="alert"]').allInnerTexts().catch(()=>[])
  check('⑤ 边界那一下没有弹出"排序已保存"',!toastTexts.join(' ').includes('排序已保存'),toastTexts)

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
