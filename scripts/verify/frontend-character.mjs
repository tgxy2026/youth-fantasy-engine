// UX05 sample: fresh demo only; real field editing, template projection and portrait processing.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const run=await fs.mkdtemp(path.join(root,'.workbuddy/tmp/frontend-character-'))
const fingerprint=snapshot(root).fingerprint
const report={kind:'frontend-character',at:new Date().toISOString(),run,fingerprint,checks:[],errors:[],modelRequests:[],status:'running'}
const check=(name,passed,details)=>{report.checks.push({name,passed:!!passed,details});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw new Error(name+': '+JSON.stringify(details))}
let server,browser,page
try{
  server=await createServer({root,cacheDir:path.join(run,'vite-cache'),logLevel:'error',server:{host:'localhost',port:0}})
  await server.listen()
  const origin=`http://localhost:${server.httpServer.address().port}`
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']})
  const context=await browser.newContext({viewport:{width:1366,height:900},reducedMotion:'reduce',permissions:['clipboard-read','clipboard-write']})
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
  const seed=await page.evaluate(async()=>{
    const db=await import('/src/lib/db.ts'),{TABS}=await import('/src/lib/schema.ts')
    const tab=TABS.find(item=>item.id==='char-main'),projectId=db.getCurrentProjectId()
    const identity=tab.modules.flatMap(group=>group.fields.map(field=>({key:group.name+'::'+field.name,name:field.name}))).find(field=>field.name==='身份定位').key
    const background=tab.modules.flatMap(group=>group.fields.map(field=>({key:group.name+'::'+field.name,name:field.name}))).find(field=>field.name==='出身背景').key
    const full='守门人的身份 '+('长值FullValue_'.repeat(80))+'\n完整的第二行'
    const records=[{id:'ux05-a',name:'档案样板甲',data:{[identity]:full,[background]:'很长的经历\n'.repeat(80)}},{id:'ux05-b',name:'档案样板乙',data:{[identity]:'第二位守门人'}}]
    for(const [order,rec] of records.entries())await db.saveCardRecord({...rec,tabId:tab.id,projectId,order:100+order})
    const misc=TABS.find(item=>item.id==='misc-settings'),miscKey=misc.modules[0].name+'::'+misc.modules[0].fields[0].name
    await db.saveCardRecord({id:'ux05-misc',name:'设定样板',data:{[miscKey]:'这是未绑定角色语义的设定说明'},tabId:misc.id,projectId,order:100})
    return {identity,background,full,projectId}
  })
  const nav=page.getByRole('navigation')
  if(!await nav.getByRole('button',{name:'主要角色',exact:true}).isVisible())await nav.getByRole('button',{name:'角色管理',exact:true}).click()
  await nav.getByRole('button',{name:'主要角色',exact:true}).click()
  const choose=name=>page.getByRole('button',{name:'选择角色：'+name,exact:true})
  await choose('档案样板甲').click();page.setDefaultTimeout(15000)
  const profile=page.locator('[data-character-profile]'),detail=page.locator('[data-character-detail]')
  await profile.getByRole('button',{name:'修改名称：档案样板甲',exact:true}).waitFor()
  check('keyboard-selectable list identifies its active record',await choose('档案样板甲').getAttribute('aria-pressed')==='true')
  const tools=page.getByRole('button',{name:'档案工具',exact:true})
  const options=page.getByRole('group',{name:'档案工具选项',exact:true})
  await tools.focus();await tools.press('Enter');await options.waitFor()
  check('named tools open by keyboard and focus their first action',await options.getByRole('button').first().evaluate(el=>el===document.activeElement))
  check('primary actions stay direct while secondary actions are grouped',await page.locator('[data-character-workspace] > header').getByRole('button',{name:'新建角色',exact:true}).isVisible()&&await options.getByRole('button',{name:'移动到其他页签',exact:true}).isVisible())
  check('unconfigured AI explains its disabled state without sending requests',await options.getByRole('button',{name:'AI 新增角色',exact:true}).isDisabled()&&await options.getByRole('button',{name:'AI 补全当前档案',exact:true}).isDisabled())
  const alias=options.getByRole('button',{name:'字段名',exact:true})
  await alias.click();await page.getByRole('dialog',{name:'字段显示名 · 主要角色',exact:true}).waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('dialog',{name:'字段显示名 · 主要角色',exact:true}).waitFor({state:'hidden'})
  check('alias modal consumes one Escape and returns to its parent tool',await options.isVisible()&&await alias.evaluate(el=>el===document.activeElement))
  await page.keyboard.press('Escape')
  check('second Escape closes tools and returns focus',!await options.isVisible()&&await tools.evaluate(el=>el===document.activeElement))
  for(const [action,title] of [['模板管理','模板 · 主要角色'],['批量导入',/导入/],['移动到其他页签','移动「档案样板甲」到其他角色页签']]){
    await tools.click();await options.getByRole('button',{name:action,exact:true}).click()
    const modal=page.getByRole('dialog',{name:title})
    await modal.waitFor();await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'})
    check(action+' keeps its original dialog and returns focus to tools',await tools.evaluate(el=>el===document.activeElement)&&!await options.isVisible())
  }
  const empty=page.locator('[data-character-portraits="empty"]')
  check('empty portraits use a folded compact entry',await empty.count()===1&&!await empty.evaluate(el=>el.open)&&(await empty.boundingBox()).height<65)
  const groups=page.locator('[data-card-group]')
  check('first/basic group opens while long groups start folded',await groups.first().evaluate(el=>el.open)&&await groups.evaluateAll(items=>items.slice(1).some(item=>!item.open)))
  await profile.getByRole('button',{name:'查看完整身份定位',exact:true}).click()
  await page.getByRole('button',{name:'复制完整内容',exact:true}).click()
  await page.getByText('完整内容已复制',{exact:true}).waitFor()
  const copied=await page.evaluate(()=>navigator.clipboard.readText())
  check('full fact can be opened and copied without visual truncation',copied.replaceAll('\r\n','\n')===seed.full)
  await page.keyboard.press('Escape')
  const rename=profile.getByRole('button',{name:'修改名称：档案样板甲',exact:true})
  await rename.focus();await rename.press('Enter')
  await page.getByRole('dialog',{name:'修改角色名称',exact:true}).waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('dialog',{name:'修改角色名称',exact:true}).waitFor({state:'hidden'})
  check('name rename is keyboard accessible and returns focus',await rename.evaluate(el=>el===document.activeElement))
  const background=page.locator('[data-card-field]').filter({has:page.locator('textarea[aria-label="出身背景"]')})
  const backgroundGroup=background.locator('xpath=ancestor::details[1]')
  await backgroundGroup.locator('summary').click()
  const longInput=page.getByRole('textbox',{name:'出身背景',exact:true})
  await page.waitForFunction(()=>[...document.querySelectorAll('textarea')].find(el=>el.getAttribute('aria-label')==='出身背景')?.clientHeight>100)
  check('opening a folded long field remeasures its real content',(await longInput.boundingBox()).height>100)
  const identity=page.getByRole('textbox',{name:'身份定位',exact:true})
  const edited='作者修改的身份 0 false'
  await identity.fill(edited)
  await tools.click()
  const exportDownload=page.waitForEvent('download')
  await options.getByRole('button',{name:'导出全部为 CSV',exact:true}).click()
  const csv=await exportDownload,exportPath=path.join(run,'draft-export.csv')
  await csv.saveAs(exportPath)
  check('grouped CSV export preserves unsaved draft values',(await fs.readFile(exportPath,'utf8')).includes(edited))
  await page.keyboard.press('Control+s')
  await page.waitForFunction(async({key,value})=>(await(await import('/src/lib/db.ts')).getCardRecords('char-main')).find(rec=>rec.id==='ux05-a')?.data[key]===value,{key:seed.identity,value:edited})
  check('field editing and save keep the authoritative storage key',await profile.getByRole('button',{name:'查看完整身份定位',exact:true}).innerText().then(text=>text.includes(edited)))
  await empty.locator('summary').click()
  await page.getByRole('button',{name:'上传立绘 1',exact:true}).focus()
  check('portrait upload has a named keyboard control',await page.getByRole('button',{name:'上传立绘 1',exact:true}).evaluate(el=>el===document.activeElement))
  // Hold an actual FileReader, switch card, then let normal image decode/compression finish.
  await page.evaluate(()=>{
    const original=FileReader.prototype.readAsDataURL,encode=HTMLCanvasElement.prototype.toDataURL
    FileReader.prototype.readAsDataURL=function(file){window.__releasePortrait=()=>original.call(this,file)}
    HTMLCanvasElement.prototype.toDataURL=function(...args){const result=encode.apply(this,args);window.__portraitCompressed=true;return result}
    window.__restorePortraitIO=()=>{FileReader.prototype.readAsDataURL=original;HTMLCanvasElement.prototype.toDataURL=encode}
  })
  const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=36;canvas.height=64;canvas.getContext('2d').fillRect(0,0,36,64);return canvas.toDataURL('image/png').split(',')[1]})
  await page.evaluate(()=>{window.__portraitCompressed=false})
  const file={name:'isolated-portrait.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')}
  await empty.locator('input[type=file]').first().setInputFiles(file)
  await page.waitForFunction(()=>typeof window.__releasePortrait==='function')
  await choose('档案样板乙').click();await profile.getByRole('button',{name:'修改名称：档案样板乙',exact:true}).waitFor()
  await page.evaluate(()=>window.__releasePortrait())
  await page.waitForFunction(()=>window.__portraitCompressed)
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  check('late portrait completion cannot attach to a different character',await page.locator('[data-character-portraits="filled"]').count()===0&&!await profile.locator('img').count())
  await page.evaluate(()=>window.__restorePortraitIO())
  await choose('档案样板甲').click();await empty.locator('summary').click()
  await empty.locator('input[type=file]').first().setInputFiles(file)
  const filled=page.locator('[data-character-portraits="filled"]');await filled.waitFor()
  check('real portrait compression updates only the selected card',await profile.locator('img').count()===1&&await filled.locator('img').count()===1)
  await filled.locator('input[type=file]').first().setInputFiles([])
  check('empty file chooser change does not erase a portrait',await filled.locator('img').count()===1)
  await filled.locator('input[type=file]').nth(1).setInputFiles(file)
  await filled.locator('img').nth(1).waitFor()
  check('both portrait slots remain available with uncropped rendering',await filled.locator('img').evaluateAll(items=>items.length===2&&items.every(el=>getComputedStyle(el).objectFit==='contain')))
  await page.keyboard.press('Control+s')
  await page.waitForFunction(async()=>{const rec=(await(await import('/src/lib/db.ts')).getCardRecords('char-main')).find(item=>item.id==='ux05-a');return rec?.portrait&&rec?.portrait2})
  check('both images persist through the original save path',true)
  await page.getByRole('button',{name:'移除立绘 2',exact:true}).click();await page.getByRole('button',{name:'移除立绘 1',exact:true}).click()
  await empty.waitFor()
  check('explicit removal restores compact empty presentation',!await empty.evaluate(el=>el.open))
  await page.keyboard.press('Control+s')

  const longName='极长姓名LongUnbrokenName'.repeat(35)
  const templateResult=await page.evaluate(async({name})=>{
    const db=await import('/src/lib/db.ts'),{TABS}=await import('/src/lib/schema.ts'),{snapshotOfBuiltin}=await import('/src/lib/templates/snapshot.ts'),{saveTemplateDef}=await import('/src/lib/templates/store.ts')
    const tab=TABS.find(item=>item.id==='char-main'),def=snapshotOfBuiltin(tab),base=def.fields.find(field=>field.sourceKey.endsWith('::身份定位'))
    base.label='江湖职责';base.permissions.aiRead=false
    base.description='从人物所承担的职责、与其他人物的关系以及阶段性的目标入手，结合故事发展补充不同场合下的行为和选择。这里可以自由记录较长的创作思考，完整说明应当能够通过键盘打开阅读。'
    const critical=def.fields.find(field=>field.id!==base.id&&field.permissions.detail)
    critical.description='保密提示：这段说明关系到资料的使用范围，应当始终保留在字段附近，不能因为文字较长而藏进填写说明。请先核对本页的 AI 权限，再决定填写哪些资料。'
    const hidden={...base,id:'cf_hidden_sample',sourceKey:'cf_hidden_sample',source:'custom',label:'不可见摘要',permissions:{...base.permissions,detail:false}}
    def.fields.push(hidden);def.bindings={identity:[base.id],desc:[],alias:[hidden.id],realm:[],faction:[]}
    // Renaming the basic group also checks that portrait access is independent of its wording.
    def.groups[0].label='作者自定分组'
    const rec=(await db.getCardRecords(tab.id)).find(item=>item.id==='ux05-b');rec.name=name;rec.data[base.sourceKey]='0';rec.data[hidden.sourceKey]='不应在摘要出现'
    await db.saveCardRecord(rec)
    return saveTemplateDef(db.getCurrentProjectId(),def)
  },{name:longName})
  check('customized template uses the existing validated store',templateResult.ok,templateResult)
  // Re-enter through actual navigation to reload the authoritative record list.
  await nav.getByRole('button',{name:'正文编辑',exact:true}).click();await nav.getByRole('button',{name:'主要角色',exact:true}).click()
  await choose(longName).click();await profile.getByRole('button',{name:'修改名称：'+longName,exact:true}).waitFor()
  await profile.getByRole('button',{name:'查看完整江湖职责',exact:true}).waitFor()
  check('renamed private-to-AI field remains visible as an author fact',(await profile.innerText()).includes('江湖职责：0')&&!(await profile.innerText()).includes('不应在摘要出现'))
  const identityRow=page.locator('[data-card-field]').filter({has:page.getByRole('textbox',{name:'江湖职责',exact:true})})
  check('AI read restrictions stay visible beside the field',await identityRow.getByText(/不供 AI 参考/).isVisible())
  const help=identityRow.getByRole('button',{name:'查看江湖职责的填写说明',exact:true})
  await help.focus();await help.press('Enter')
  await page.getByText('从人物所承担的职责、与其他人物的关系以及阶段性的目标入手，结合故事发展补充不同场合下的行为和选择。这里可以自由记录较长的创作思考，完整说明应当能够通过键盘打开阅读。',{exact:true}).waitFor()
  await page.keyboard.press('Escape')
  check('long guidance opens by keyboard and returns focus without altering the field',await help.evaluate(el=>el===document.activeElement)&&await page.getByRole('textbox',{name:'江湖职责',exact:true}).inputValue()==='0')
  check('long privacy guidance remains inline',await page.locator('[data-field-description="inline"]').filter({hasText:'保密提示：'}).isVisible())
  check('renamed groups retain an accessible portrait entry',await empty.count()===1)
  const originalValue=await page.getByRole('textbox',{name:'江湖职责',exact:true}).inputValue()
  for(const density of ['comfortable','compact'])for(const viewport of [{width:1366,height:900,zoom:100},{width:1000,height:760,zoom:125},{width:768,height:1024,zoom:160},{width:1000,height:640,zoom:160,flow:true}]){
    await page.setViewportSize(viewport)
    await page.evaluate(async({density,zoom})=>{(await import('/src/lib/settings/density.ts')).applyDensity(density);(await import('/src/lib/settings/theme.ts')).applyZoom(zoom,{manual:true})},{density,zoom:viewport.zoom})
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    await page.locator('main').evaluate(el=>el.scrollTop=0)
    const geometry=await page.locator('[data-master-detail]').evaluate(el=>{const r=el.getBoundingClientRect();return {height:r.height,bottom:r.bottom,width:r.width,inner:innerHeight,zoom:Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom'))}})
    const detailHeight=(await detail.boundingBox()).height/geometry.zoom
    const flow=await page.locator('main').evaluate(el=>el.scrollHeight>el.clientHeight)
    check(`wrapped header leaves a usable work area ${density}/${viewport.width}/${viewport.height}/${viewport.zoom}`,geometry.zoom===viewport.zoom/100&&geometry.height/geometry.zoom>=80&&detailHeight>=80&&(viewport.flow?flow:geometry.bottom<=geometry.inner+2),{...geometry,detailHeight,flow})
    await tools.click();await options.waitFor()
    const popup=await options.locator('xpath=ancestor::div[@id][1]').boundingBox()
    const actualZoom=await page.evaluate(()=>Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')))
    check(`tools stay inside the zoomed viewport ${density}/${viewport.width}/${viewport.zoom}`,actualZoom===viewport.zoom/100&&popup.x>=-1&&popup.y>=-1&&popup.x+popup.width<=viewport.width+1&&popup.y+popup.height<=viewport.height+1,{popup,actualZoom})
    await page.keyboard.press('Escape')
    if(viewport.flow){
      const field=page.getByRole('textbox',{name:'江湖职责',exact:true})
      await field.evaluate(el=>el.scrollIntoView({block:'end'}));await field.click()
      const box=await field.boundingBox(),header=await page.locator('[data-character-workspace] > header').boundingBox()
      check(`short-window field can actually be focused below sticky chrome ${density}`,await field.evaluate(el=>el===document.activeElement)&&box.y>=header.y+header.height-1&&box.y+box.height<=viewport.height+1,{box,header})
      await page.screenshot({path:path.join(run,`short-${density}.png`)})
    }
    check(`long name and original field remain reachable ${density}/${viewport.width}/${viewport.zoom}`,await profile.getByRole('button',{name:'修改名称：'+longName,exact:true}).isVisible()&&await page.getByRole('textbox',{name:'江湖职责',exact:true}).inputValue()===originalValue)
    await detail.evaluate(el=>el.scrollTop=el.scrollHeight)
    await empty.locator('summary').scrollIntoViewIfNeeded()
    if(viewport.flow)await empty.locator('summary').evaluate(el=>el.scrollIntoView({block:'end'}))
    check(`last portrait entry is reachable ${density}/${viewport.width}/${viewport.zoom}`,await empty.locator('summary').isVisible())
    await detail.evaluate(el=>el.scrollTop=0)
  }
  await page.setViewportSize({width:1366,height:900});await page.evaluate(async()=>(await import('/src/lib/settings/theme.ts')).applyZoom(100))
  for(const theme of ['dark','eye-care','midnight','sepia','dusk-violet','porcelain','pine-ink','peach-note','mono']){
    await page.evaluate(async theme=>(await import('/src/lib/settings/theme.ts')).applyTheme(theme),theme)
    check('profile renders in theme '+theme,await profile.isVisible())
  }
  await page.screenshot({path:path.join(run,'character.png'),fullPage:true})
  if(!await nav.getByRole('button',{name:'其他设定',exact:true}).isVisible())await nav.getByRole('button',{name:'世界构建',exact:true}).click()
  await nav.getByRole('button',{name:'其他设定',exact:true}).click()
  await page.getByRole('button',{name:'选择设定：设定样板',exact:true}).click()
  await profile.getByRole('button',{name:'修改名称：设定样板',exact:true}).waitFor()
  check('generic settings retain their visible-field preview without character semantics',(await page.locator('[data-master-list]').innerText()).includes('这是未绑定角色语义的设定说明')&&!await profile.getByLabel('档案摘要',{exact:true}).count())
  check('no model requests or unhandled runtime errors',report.modelRequests.length===0&&report.errors.length===0,{errors:report.errors,modelRequests:report.modelRequests})
  report.status='passed'
}catch(error){report.status='failed';report.failure=String(error.stack||error);if(page)await page.screenshot({path:path.join(run,'failure.png'),fullPage:true}).catch(()=>{});throw error}
finally{report.stale=snapshot(root).fingerprint!==fingerprint;if(report.stale){report.status='failed';process.exitCode=1}report.passed=report.checks.filter(item=>item.passed).length;await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2));await browser?.close();await server?.close();console.log(JSON.stringify({run,status:report.status,passed:report.passed,stale:report.stale}))}
