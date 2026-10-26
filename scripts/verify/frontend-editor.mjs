// UX04 sample: real editor/IDB in a fresh profile; no production library or model requests.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const run=await fs.mkdtemp(path.join(root,'.workbuddy/tmp/frontend-editor-'))
const fingerprint=snapshot(root).fingerprint
const report={kind:'frontend-editor',at:new Date().toISOString(),run,fingerprint,checks:[],errors:[],modelRequests:[],status:'running'}
const check=(name,passed,details)=>{report.checks.push({name,passed:!!passed,details});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw new Error(name+': '+JSON.stringify(details))}
let server,browser,page
try{
  server=await createServer({root,cacheDir:path.join(run,'vite-cache'),logLevel:'error',server:{host:'localhost',port:0}})
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
  await page.getByRole('navigation').getByRole('button',{name:'正文编辑',exact:true}).click()
  const editor=page.locator('textarea.novel-textarea')
  await editor.waitFor();page.setDefaultTimeout(15000)
  const title=page.getByRole('textbox',{name:'章节标题',exact:true})
  const status=page.getByRole('combobox',{name:'章节状态',exact:true})
  const save=page.getByRole('button',{name:'保存正文',exact:true})
  const tools=page.getByRole('button',{name:'编辑工具',exact:true})
  const actions=page.getByRole('group',{name:'编辑工具选项',exact:true})
  await editor.evaluate(el=>{window.__editorOriginalNode=el})
  const sameNode=()=>editor.evaluate(el=>el===window.__editorOriginalNode)
  const original=await editor.inputValue(),originalTitle=await title.inputValue(),originalStatus=await status.inputValue()
  const typography=await editor.evaluate(el=>({fontSize:getComputedStyle(el).fontSize,lineHeight:getComputedStyle(el).lineHeight}))
  check('chapter title has usable width beside a visible save control',(await title.boundingBox()).width>96&&await save.isVisible())
  await tools.click();await actions.waitFor()
  await page.waitForFunction(()=>document.activeElement?.textContent?.includes('排版与缩进'))
  check('tool disclosure focuses its first named action',await actions.getByRole('button',{name:'排版与缩进',exact:true}).evaluate(el=>el===document.activeElement))
  await page.keyboard.press('Escape')
  check('tool Escape closes one layer and returns to its trigger',!await actions.isVisible()&&await tools.evaluate(el=>el===document.activeElement))
  await tools.focus();await tools.press('Enter');await actions.waitFor()
  await actions.getByRole('button',{name:'排版与缩进',exact:true}).click()
  const format=page.getByRole('dialog',{name:'排版',exact:true});await format.waitFor()
  check('tool action closes disclosure before opening a dialog',!await actions.isVisible()&&await sameNode()&&await editor.inputValue()===original)
  await page.keyboard.press('Escape')
  check('dialog close returns to a connected tool trigger',await tools.evaluate(el=>el===document.activeElement)&&await sameNode())

  await editor.focus();await editor.press('Control+End')
  const undoMarker='\n原生撤销回归验收'
  await page.keyboard.insertText(undoMarker)
  await page.getByTitle('撤销（与 Ctrl+Z 同一撤销栈）',{exact:true}).click()
  check('toolbar undo uses the native edit history',await editor.inputValue()===original)
  await page.getByTitle('恢复（与 Ctrl+Y 同一撤销栈）',{exact:true}).click()
  check('toolbar redo restores the same edit',await editor.inputValue()===original+undoMarker)
  await editor.focus();await editor.press('Control+End')
  const beforeComposition=await editor.inputValue(),cdp=await context.newCDPSession(page)
  await cdp.send('Input.imeSetComposition',{text:'“',selectionStart:1,selectionEnd:1})
  check('CDP composition preview is not transformed prematurely',await editor.inputValue()===beforeComposition+'“')
  await cdp.send('Input.insertText',{text:'“'})
  await page.waitForFunction(expected=>document.querySelector('textarea.novel-textarea')?.value===expected,beforeComposition+'“”')
  check('CDP composition commit pairs punctuation once',await editor.inputValue()===beforeComposition+'“”')
  await editor.press('Control+End');await page.keyboard.insertText('\n可见保存按钮实际写入验收')
  const savedContent=await editor.inputValue()
  await save.click()
  const activeId=await page.evaluate(async()=>{
    const db=await import('/src/lib/db.ts'),prefs=await import('/src/lib/settings/uiPrefs.ts')
    return prefs.readStringPref('editor-last-chapter:'+db.getCurrentProjectId())
  })
  await page.waitForFunction(async({id,content})=>(await(await import('/src/lib/db.ts')).getAllChapters()).find(ch=>ch.id===id)?.content===content,{id:activeId,content:savedContent})
  check('visible save writes the exact current body to authoritative storage',true)
  const changedStatus=originalStatus==='修改'?'草稿':'修改'
  await title.fill('元信息验收-'+originalTitle);await status.selectOption(changedStatus)
  await page.waitForFunction(async({id,title,status})=>{const ch=(await(await import('/src/lib/db.ts')).getAllChapters()).find(ch=>ch.id===id);return ch?.title===title&&ch.status===status},{id:activeId,title:'元信息验收-'+originalTitle,status:changedStatus})
  check('title and status still persist without replacing body',await editor.inputValue()===savedContent&&await sameNode())
  await title.fill(originalTitle);await status.selectOption(originalStatus)
  await page.waitForFunction(async({id,title,status})=>{const ch=(await(await import('/src/lib/db.ts')).getAllChapters()).find(ch=>ch.id===id);return ch?.title===title&&ch.status===status},{id:activeId,title:originalTitle,status:originalStatus})

  const focusButton=page.getByTitle('专注模式',{exact:true})
  await focusButton.click()
  check('focus mode has a named exit and preserves editor DOM',await page.getByRole('button',{name:'退出专注',exact:true,pressed:true}).isVisible()&&await sameNode())
  await page.getByTitle('退出专注模式',{exact:true}).click()
  const refs=page.getByTitle('本章资料：查看细纲、固定资料与正文引用',{exact:true})
  await refs.click();await refs.click()
  check('reference panel toggles preserve draft and editor node',await sameNode()&&await editor.inputValue()===savedContent)
  const separator=page.getByRole('separator',{name:'章节栏宽度',exact:true})
  await separator.focus();await separator.press('End')
  const preference=await page.evaluate(()=>localStorage.getItem('yfe-chapter-w'))
  for(const density of ['compact','comfortable'])for(const scenario of [{width:1366,height:900,zoom:100},{width:768,height:1024,zoom:125},{width:1000,height:640,zoom:160}]){
    await page.setViewportSize({width:scenario.width,height:scenario.height})
    const applied=await page.evaluate(async({zoom,density})=>{
      const actual=(await import('/src/lib/settings/theme.ts')).applyZoom(zoom,{manual:true})
      ;(await import('/src/lib/settings/density.ts')).applyDensity(density)
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
      return actual
    },{zoom:scenario.zoom,density})
    // 🔴 160% 缩放下换档 + 重排不是两个 rAF 就稳的（机器忙时实测偶发量到中间态）。
    //    这里补一个**探针侧**的落地等待，不改任何断言阈值。
    await page.waitForTimeout(150)
    const titleBox=await title.boundingBox(),saveBox=await save.boundingBox()
    check(`primary controls stay visible at ${density} ${scenario.width}/${scenario.zoom}`,applied===scenario.zoom&&titleBox.width>96*scenario.zoom/100&&saveBox.x>=0&&saveBox.x+saveBox.width<=scenario.width+1&&saveBox.y+saveBox.height<=scenario.height)
    // 🔴 失败时要把三项分别报出来：同一句断言里混了「DOM 复用 / 写作区高度 / 正文内容」三件事，
    //    只报一句话会让人误以为是布局问题（2026-10-26 实测踩过）。
    const same=await sameNode()
    const height=await editor.evaluate(el=>el.clientHeight)
    const value=await editor.inputValue()
    check(`writing area and DOM remain usable at ${density} ${scenario.width}/${scenario.zoom}`,same&&height>=80&&value===savedContent,{same,height,valueLen:value.length,savedLen:savedContent.length,valueTail:value.slice(-24),savedTail:savedContent.slice(-24)})
    await tools.click();await actions.waitFor()
    const last=actions.getByRole('button').last();await last.focus()
    const box=await last.boundingBox()
    check(`last tool remains reachable at ${density} ${scenario.width}/${scenario.zoom}`,box.y>=0&&box.y+box.height<=scenario.height+1)
    // 🔴 Escape 之后必须等浮层真的收起来再进入下一档：工具浮层参与纵向排布，
    //    它没关就换档测量，会把正文区高度量成「工具面板还占着行」的中间态
    //    （2026-10-26 实测：链条里连跑两次 compact 1000/160 量到 56px，单独跑却 40/40）。
    await page.keyboard.press('Escape')
    await actions.waitFor({state:'hidden'})
    check(`layout preserves writing typography at ${density} ${scenario.width}/${scenario.zoom}`,await editor.evaluate((el,style)=>getComputedStyle(el).fontSize===style.fontSize&&getComputedStyle(el).lineHeight===style.lineHeight,typography))
  }
  check('narrow layout never rewrites the wide panel preference',await page.evaluate(()=>localStorage.getItem('yfe-chapter-w'))===preference)
  await page.setViewportSize({width:1366,height:900})
  await page.evaluate(async()=>(await import('/src/lib/settings/theme.ts')).applyZoom(100,{manual:true}))
  await page.getByRole('button',{name:'章节栏宽度：打开调整菜单',exact:true}).click()
  await page.getByRole('button',{name:'恢复默认',exact:true}).click();await page.keyboard.press('Escape')
  await page.screenshot({path:path.join(run,'editor.png'),animations:'disabled'})
  check('no model request is triggered by layout and tool inspection',report.modelRequests.length===0,report.modelRequests)
  check('no browser errors',report.errors.length===0,report.errors)
  report.status='passed'
}catch(error){report.status='failed';report.error=error.stack||String(error);await page?.screenshot({path:path.join(run,'failure.png'),fullPage:true,animations:'disabled'}).catch(()=>{})}
finally{
  await browser?.close();await server?.close()
  report.stale=fingerprint!==snapshot(root).fingerprint
  if(report.stale)report.status='failed'
  await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify({status:report.status,run,passed:report.checks.filter(c=>c.passed).length,total:report.checks.length,error:report.error,stale:report.stale}))
  if(report.status!=='passed')process.exitCode=1
}
