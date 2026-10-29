import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp,writeFile } from 'node:fs/promises'
import path from 'node:path'
const root=process.cwd(),run=await mkdtemp(path.join(root,'.workbuddy/tmp/master-demo-331-'))
const server=await createServer({root,cacheDir:path.join(run,'vite'),logLevel:'error',server:{host:'localhost',port:0}})
let browser
try{
  await server.listen();const origin=`http://localhost:${server.httpServer.address().port}`
  browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1600,height:900},reducedMotion:'reduce'})
  await context.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort())
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)))
  await page.goto(origin,{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:/先看看示例/}).click()
  await page.getByRole('button',{name:'下一步',exact:true}).click();await page.getByRole('button',{name:/跳过，直接开始|开始写作/}).click()
  await page.getByTitle('返回项目列表').waitFor({timeout:60000});const later=page.getByRole('button',{name:'稍后再说',exact:true});if(await later.isVisible())await later.click()
  const nav=page.getByRole('navigation'),results=[]
  for(const label of ['主要角色','次要角色','NPC角色','其他设定','分卷大纲','章节细纲']){
    await nav.getByText(label,{exact:true}).first().click();await page.waitForTimeout(400)
    const choices=page.locator('[data-master-choice]');let count=await choices.count()
    if(label==='主要角色'&&count<2){
      await page.getByRole('button',{name:'新建角色',exact:true}).click()
      const dialog=page.getByRole('dialog',{name:'新建角色'});await dialog.getByRole('textbox').fill('隔离测试角色')
      await dialog.getByRole('button',{name:'确定',exact:true}).click();await page.waitForTimeout(400);count=await choices.count()
    }
    if(count<2){results.push({label,count,status:'不足两条，未测切换'});continue}
    const first=choices.nth(0),second=choices.nth(1)
    await first.click();await first.focus();await page.keyboard.press('ArrowDown')
    await page.waitForFunction(()=>{const selected=document.querySelector('[data-master-choice][aria-pressed="true"]');return !!selected && document.activeElement===selected},null,{timeout:10000})
    if(await second.getAttribute('aria-pressed')!=='true'||!(await second.evaluate(e=>e===document.activeElement)))throw Error(`${label}: wrong selection or focus`)
    results.push({label,count,status:'下一条通过'})
    if(label==='主要角色'){
      await page.getByText('人物立绘 · 尚未上传，点击添加').click()
      await page.evaluate(()=>{
        const read=FileReader.prototype.readAsDataURL
        FileReader.prototype.readAsDataURL=function(file){const reader=this;window.__releasePortrait=()=>{FileReader.prototype.readAsDataURL=read;read.call(reader,file)}}
      })
      const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jx2cAAAAASUVORK5CYII=','base64')
      await page.locator('[data-character-portraits] input[type="file"]').first().setInputFiles({name:'test.png',mimeType:'image/png',buffer:png})
      await page.getByText('处理中…').first().waitFor();await second.focus();await page.keyboard.press('ArrowUp');await page.waitForTimeout(100)
      const kept=await second.getAttribute('aria-pressed')==='true'
      if(!kept)throw Error('portrait in progress allowed switch')
      await page.evaluate(()=>window.__releasePortrait());await page.getByText('处理中…').first().waitFor({state:'hidden',timeout:10000})
      results.push({label:'立绘处理中阻止切换',kept})
    }
    if(label==='次要角色'){
      const field=page.locator('[data-character-detail] [data-card-field] textarea:visible').first();await field.waitFor()
      const marker='【隔离角色保存测试】';await field.fill((await field.inputValue())+marker)
      const from=await second.getAttribute('data-master-choice')
      await page.evaluate(()=>{const put=IDBObjectStore.prototype.put;window.__restoreCardPut=()=>{IDBObjectStore.prototype.put=put};IDBObjectStore.prototype.put=function(...args){if(this.name==='cardRecords')throw new Error('synthetic card write failure');return put.apply(this,args)}})
      await second.focus();await page.keyboard.press('ArrowDown');await page.waitForTimeout(500)
      const kept=await second.getAttribute('aria-pressed')==='true'&&(await field.inputValue()).includes(marker)
      if(!kept)throw Error('failed character save did not retain selection and draft')
      await page.evaluate(()=>window.__restoreCardPut());await second.focus();await page.keyboard.press('ArrowDown')
      await page.waitForFunction(id=>document.querySelector('[data-master-choice][aria-pressed="true"]')?.getAttribute('data-master-choice')!==id,from,{timeout:10000})
      results.push({label:'角色保存失败与重试',kept,switchedAfterRetry:true})
    }
  }
  const field=page.locator('[data-outline-detail] textarea:visible').first();await field.waitFor()
  const marker='【隔离目录保存测试】';await field.fill((await field.inputValue())+marker)
  const selected=page.locator('[data-master-choice][aria-pressed="true"]'),from=await selected.getAttribute('data-master-choice')
  await page.evaluate(()=>{const put=IDBObjectStore.prototype.put;window.__restoreCardPut=()=>{IDBObjectStore.prototype.put=put};IDBObjectStore.prototype.put=function(...args){if(this.name==='cardRecords')throw new Error('synthetic card write failure');return put.apply(this,args)}})
  await selected.focus();await page.keyboard.press('ArrowDown');await page.waitForTimeout(500)
  const kept=await selected.getAttribute('data-master-choice')===from&&(await field.inputValue()).includes(marker)
  if(!kept)throw Error('failed save did not retain outline and draft')
  await page.evaluate(()=>window.__restoreCardPut());await selected.focus();await page.keyboard.press('ArrowDown')
  await page.waitForFunction(id=>document.querySelector('[data-master-choice][aria-pressed="true"]')?.getAttribute('data-master-choice')!==id,from,{timeout:10000})
  results.push({label:'细纲保存失败与重试',kept,switchedAfterRetry:true})
  const evidence={run,results,errors};await writeFile(path.join(run,'result.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence))
  if(errors.length)process.exitCode=1
}finally{await browser?.close();await server.close()}
