// UX03: real workflow props and real demo navigation, isolated from author data and models.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const run=await fs.mkdtemp(path.join(root,'.workbuddy/tmp/frontend-dashboard-'))
const fingerprint=snapshot(root).fingerprint
const fixtureHash=async()=>{
  const hash=createHash('sha256')
  for(const name of ['dashboard.html','dashboard.tsx'])hash.update(await fs.readFile(path.join(root,'tests/browser',name)))
  return hash.digest('hex')
}
const fixtureFingerprint=await fixtureHash()
const report={kind:'frontend-dashboard',at:new Date().toISOString(),run,fingerprint,fixtureFingerprint,checks:[],errors:[],status:'running'}
const check=(name,passed,details)=>{report.checks.push({name,passed:!!passed,details});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw new Error(name+': '+JSON.stringify(details))}
let server,browser,page
try{
  server=await createServer({root,cacheDir:path.join(run,'vite-cache'),logLevel:'error',server:{host:'localhost',port:0}})
  await server.listen()
  const origin=`http://localhost:${server.httpServer.address().port}`
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']})
  const context=await browser.newContext({viewport:{width:1366,height:900},reducedMotion:'reduce'})
  report.modelRequests=[]
  await context.route('**/*',route=>{
    if(/\/chat\/completions|\/api\/ai(?:\/|$)/.test(route.request().url())){report.modelRequests.push(route.request().method());return route.abort()}
    return route.request().url().startsWith(origin+'/')?route.continue():route.abort()
  })
  page=await context.newPage();page.setDefaultTimeout(120000)
  page.on('pageerror',error=>report.errors.push(error.message))
  const url=origin+'/tests/browser/dashboard.html'
  const hero=page.locator('[data-continue-writing]')
  const open=async mode=>{
    await page.goto(url+'?mode='+mode,{waitUntil:'commit'})
    await hero.waitFor();page.setDefaultTimeout(15000)
  }
  const navigation=async()=>JSON.parse(await page.getByLabel('导航结果',{exact:true}).textContent())
  const fixtureData=()=>page.evaluate(()=>JSON.stringify(window.__workflowFixture))
  await open('remembered')
  const original=await fixtureData()
  check('last opened chapter takes priority over a newer update',await page.locator('[data-continue-target="older"]').count()===1&&await hero.getByText('最近打开 · 第一卷',{exact:true}).isVisible())
  check('continue target exposes real status and update time',await hero.getByText('草稿',{exact:true}).isVisible()&&await hero.locator('time[datetime]').count()===1)
  await hero.getByRole('button',{name:'继续写作：上次打开的章节',exact:true}).click()
  check('primary action navigates to the exact remembered chapter',JSON.stringify(await navigation())===JSON.stringify({id:'editor',chapterId:'older'}))
  check('same chapter is not duplicated among suggestions',!await hero.getByRole('button',{name:/^继续「上次打开的章节」/}).count())
  await hero.getByRole('button',{name:'忽略建议：点检 7 条未回收伏笔',exact:true}).click()
  check('ignore is local UI state and leaves business data unchanged',!await hero.getByRole('button',{name:/点检 7 条未回收伏笔/}).count()&&await fixtureData()===original)
  await open('remembered')
  check('ignored recommendation survives reload',!await hero.getByRole('button',{name:/点检 7 条未回收伏笔/}).count())
  await hero.getByRole('button',{name:'恢复隐藏建议',exact:true}).click()
  check('restoring suggestions brings the original entry back',await hero.getByRole('button',{name:'忽略建议：点检 7 条未回收伏笔',exact:true}).isVisible())
  await hero.getByRole('button',{name:'稍后处理：查看 1 条未用灵感',exact:true}).click()
  const snooze=await page.evaluate(async()=>JSON.parse((await import('/src/lib/settings/uiPrefs.ts')).readStringPref('writing-next-snoozed:fixture-dashboard-remembered')))
  check('postpone retains the 24-hour local reminder contract',snooze.ideas>Date.now()+23*3600000&&!await hero.getByRole('button',{name:/查看 1 条未用灵感/}).count())
  await hero.getByRole('button',{name:'恢复隐藏建议',exact:true}).click()
  const board=page.getByRole('button',{name:/^章节规划板/}).locator('..')
  await board.getByRole('button',{name:/^章节规划板/}).click()
  await board.getByRole('textbox',{name:'搜索章节标题或摘要',exact:true}).fill('不存在的章节')
  check('chapter board keeps a distinct no-results state',await board.getByText('没有符合条件的章节',{exact:true}).isVisible())
  await board.getByRole('textbox',{name:'搜索章节标题或摘要',exact:true}).fill('')
  await board.getByRole('button',{name:/上次打开的章节.*更新于/}).click()
  check('chapter board still navigates to the chosen chapter',(await navigation()).chapterId==='older')
  await open('missing')
  check('deleted remembered chapter falls back to a real updated target',await page.locator('[data-continue-target="newer"]').count()===1&&await hero.getByText('最近更新 · 第一卷',{exact:true}).isVisible())
  await open('empty')
  check('empty project explains how to start without a fake continue target',await hero.getByText('项目还没有章节',{exact:true}).isVisible()&&!await hero.locator('[data-continue-target]').count())
  await hero.getByRole('button',{name:'进入正文编辑，建立第一章',exact:true}).click()
  check('empty-project action reaches the editor without inventing a chapter',(await navigation()).id==='editor'&&!('chapterId'in await navigation()))
  await open('custom')
  check('disabled foreshadow feature creates no dead recommendation',!await hero.getByRole('button',{name:/未回收伏笔/}).count())
  for(const density of ['compact','comfortable'])for(const scenario of [{width:1000,height:640,zoom:100},{width:768,height:1024,zoom:125},{width:1000,height:640,zoom:160}]){
    await page.setViewportSize(scenario)
    await open('extreme')
    await page.evaluate(async({zoom,density})=>{
      (await import('/src/lib/settings/theme.ts')).applyZoom(zoom,{manual:true})
      ;(await import('/src/lib/settings/density.ts')).applyDensity(density)
    },{zoom:scenario.zoom,density})
    check(`long title and volume reflow at ${density} ${scenario.width}/${scenario.zoom}`,await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1))
    check(`zero words and unknown date stay explicit at ${density} ${scenario.width}/${scenario.zoom}`,await hero.getByText('0 字',{exact:true}).isVisible()&&await hero.getByText('更新时间未知',{exact:true}).isVisible())
    const before=await fixtureData()
    await hero.getByRole('button',{name:/^继续写作：/}).click()
    check(`extreme target remains operable at ${density} ${scenario.width}/${scenario.zoom}`,(await navigation()).chapterId==='older'&&await fixtureData()===before)
  }
  await page.screenshot({path:path.join(run,'extreme-workflow.png'),fullPage:true,animations:'disabled'})
  await page.setViewportSize({width:1366,height:900})
  await page.evaluate(async()=>(await import('/src/lib/settings/theme.ts')).applyZoom(100,{manual:true}))
  await page.goto(origin,{waitUntil:'commit'});page.setDefaultTimeout(120000)
  await page.getByRole('button',{name:/先看看示例/}).click()
  await page.getByRole('button',{name:'下一步',exact:true}).click()
  await page.getByRole('button',{name:/跳过，直接开始|开始写作/}).click()
  await page.getByRole('button',{name:'稍后再说',exact:true}).click()
  await page.getByRole('navigation').waitFor();page.setDefaultTimeout(15000)
  const actual=await page.evaluate(async()=>{
    const db=await import('/src/lib/db.ts'),prefs=await import('/src/lib/settings/uiPrefs.ts')
    const id=db.getCurrentProjectId(),project=await db.getProject(id),chapters=await db.getAllChapters()
    const last=prefs.readStringPref('editor-last-chapter:'+id)
    const target=chapters.find(ch=>ch.id===last)??[...chapters].sort((a,b)=>b.updatedAt-a.updatedAt)[0]
    const daily=await db.getDailyStats(),today=(await import('/src/lib/app/date.ts')).todayKey(new Date())
    return {projectName:project.name,target,chapters:JSON.stringify(chapters),todayWords:daily.find(day=>day.date===today)?.words??0}
  })
  check('real dashboard shows the current project identity',await page.locator('[data-page-header]').getByText(actual.projectName,{exact:true}).isVisible())
  const summaryBox=await page.getByRole('region',{name:'创作摘要',exact:true}).boundingBox()
  const guideBox=await page.getByRole('heading',{name:'项目起步清单',exact:true}).boundingBox()
  check('creation summary precedes optional planning on screen',summaryBox&&guideBox&&summaryBox.y<guideBox.y)
  check('today summary comes from authoritative daily records',await page.getByRole('region',{name:'创作摘要',exact:true}).getByText(`今日字数变化 ${actual.todayWords.toLocaleString()} 字`,{exact:true}).isVisible())
  const statistics=page.getByRole('button',{name:/详细统计与趋势/})
  await statistics.waitFor()
  check('detailed statistics default closed and do not mount secondary charts',await statistics.getAttribute('aria-expanded')==='false'
    &&!await page.getByRole('heading',{name:/码字日历|角色出场分布|创作复盘/}).count())
  check('quick entries and editable goals stay outside the fold',await page.getByRole('heading',{name:/快捷入口/}).isVisible()
    &&await page.getByRole('heading',{name:/写作目标与完稿预估/}).isVisible())
  await statistics.focus();await page.keyboard.press('Enter')
  const controls=await statistics.getAttribute('aria-controls')
  check('Enter opens the named controlled statistics region',await statistics.getAttribute('aria-expanded')==='true'
    &&await page.locator(`[id="${controls}"]`).isVisible()
    &&await page.getByRole('heading',{name:/码字日历/}).isVisible()
    &&await page.getByRole('heading',{name:/创作复盘/}).isVisible())
  check('automatic and manually registered metrics retain their separate provenance',await page.getByText('在正文编辑器写作时自动记录',{exact:true}).isVisible()
    &&await page.getByRole('heading',{name:/近 7 日写作字数（手工登记）/}).isVisible())
  for(const density of ['compact','comfortable'])for(const layout of [{width:1366,height:900,zoom:100},{width:1000,height:640,zoom:160},{width:800,height:640,zoom:100}]){
    await page.setViewportSize({width:layout.width,height:layout.height})
    await page.evaluate(async({zoom,density})=>{
      (await import('/src/lib/settings/density.ts')).applyDensity(density)
      ;(await import('/src/lib/settings/theme.ts')).applyZoom(zoom,{manual:true})
    },{...layout,density})
    await page.getByRole('heading',{name:/码字日历/}).scrollIntoViewIfNeeded()
    await page.waitForTimeout(150)
    const dimensions=await page.locator('main').evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth}))
    check(`expanded statistics stay inside the main width: ${density}/${layout.width}/${layout.zoom}%`,dimensions.scrollWidth<=dimensions.width+2,dimensions)
    await page.screenshot({path:path.join(run,`dashboard-statistics-${density}-${layout.width}-${layout.zoom}.png`),animations:'disabled'})
  }
  await page.setViewportSize({width:1366,height:900})
  await page.evaluate(async()=>{
    (await import('/src/lib/settings/density.ts')).applyDensity('compact')
    ;(await import('/src/lib/settings/theme.ts')).applyZoom(100,{manual:true})
  })
  await page.getByRole('heading',{name:/创作复盘/}).scrollIntoViewIfNeeded()
  await page.screenshot({path:path.join(run,'dashboard-review-expanded.png'),animations:'disabled'})
  await statistics.press('Space')
  check('Space closes charts and focus stays on the disclosure',await statistics.getAttribute('aria-expanded')==='false'
    &&await statistics.evaluate(el=>el===document.activeElement)
    &&!await page.getByRole('heading',{name:/码字日历|角色出场分布|创作复盘/}).count())
  await statistics.press('Enter')
  await page.getByRole('navigation').getByRole('button',{name:'正文编辑',exact:true}).click()
  await page.locator('textarea.novel-textarea').waitFor()
  await page.getByRole('navigation').getByRole('button',{name:'写作面板',exact:true}).click()
  await statistics.waitFor()
  check('statistics open preference survives real page unmount and return',await statistics.getAttribute('aria-expanded')==='true'
    &&await page.evaluate(async()=>(await import('/src/lib/settings/uiPrefs.ts')).readBoolPref('dashboard-statistics-open',false)))
  await statistics.press('Space')
  check('folding and remounting leave authoritative chapters unchanged',await page.evaluate(async()=>JSON.stringify(await(await import('/src/lib/db.ts')).getAllChapters()))===actual.chapters)
  await page.getByRole('button',{name:'汉字 ＋ 标点',exact:true}).click()
  check('word-count switch exposes its selected state',await page.getByRole('button',{name:'汉字 ＋ 标点',exact:true,pressed:true}).count()===1)
  await page.getByRole('button',{name:'字数口径说明',exact:true}).click()
  check('word-count explanation is available by click',await page.getByText('平台「作者后台」按「汉字＋标点」统计',{exact:false}).isVisible())
  await page.keyboard.press('Escape')
  check('ordinary foreshadow count is not described as an error or health verdict',!await page.getByText(/防烂尾|健康范围|一切健康/).count()&&await page.getByText('创作线索，按剧情计划跟进',{exact:true}).isVisible())
  check('display changes preserve authoritative chapter data',await page.evaluate(async() => JSON.stringify(await(await import('/src/lib/db.ts')).getAllChapters()))===actual.chapters)
  await page.screenshot({path:path.join(run,'dashboard.png'),animations:'disabled'})
  await hero.getByRole('button',{name:/^继续写作：/}).click()
  const editor=page.locator('textarea.novel-textarea');await editor.waitFor()
  check('real continue action opens the authoritative chapter body',await editor.inputValue()===actual.target.content)
  check('no browser errors',report.errors.length===0,report.errors)
  check('no model requests',report.modelRequests.length===0,report.modelRequests)
  report.status='passed'
}catch(error){report.status='failed';report.error=error.stack||String(error);await page?.screenshot({path:path.join(run,'failure.png'),fullPage:true,animations:'disabled'}).catch(()=>{})}
finally{
  await browser?.close();await server?.close()
  report.stale=fingerprint!==snapshot(root).fingerprint||fixtureFingerprint!==await fixtureHash()
  if(report.stale)report.status='failed'
  await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify({status:report.status,run,passed:report.checks.filter(c=>c.passed).length,total:report.checks.length,error:report.error,stale:report.stale}))
  if(report.status!=='passed')process.exitCode=1
}
