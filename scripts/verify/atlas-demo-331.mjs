import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp,writeFile } from 'node:fs/promises'
import path from 'node:path'
const root=process.cwd(),run=await mkdtemp(path.join(root,'.workbuddy/tmp/atlas-demo-331-'))
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
  for(const label of ['种族生物','物品资源','国家势力','地理风物']){
    await nav.getByText(label,{exact:true}).first().click();await page.getByRole('button',{name:'图鉴',exact:true}).click();await page.locator('[data-workspace-record]').first().waitFor()
    const cards=page.locator('[data-workspace-record]'),count=await cards.count()
    if(label==='物品资源'){
      const layoutCases=[]
      for(const density of ['紧凑','标准','宽松'])for(const zoom of [80,100,130,160]){
        await page.getByTitle(`卡片密度：${density}`).click()
        await page.evaluate(async value=>(await import('/src/lib/settings/theme.ts')).applyZoom(value,{manual:true}),zoom);await page.waitForTimeout(80)
        const rects=await cards.evaluateAll(nodes=>nodes.map(node=>({id:node.getAttribute('data-workspace-record'),top:node.getBoundingClientRect().top})))
        const cols=rects.findIndex(rect=>Math.abs(rect.top-rects[0].top)>1)
        await cards.first().focus();await page.keyboard.press('ArrowDown')
        const actual=await page.evaluate(()=>document.activeElement?.getAttribute('data-workspace-record'))
        const expected=cols>0&&cols<rects.length?rects[cols].id:rects[0].id
        if(actual!==expected)throw Error(`${density}@${zoom}: wrong grid target`)
        layoutCases.push({density,zoom,cols,passed:true})
      }
      results.push({label:'布局变化',layoutCases})
      await page.evaluate(async ()=>(await import('/src/lib/settings/theme.ts')).applyZoom(100,{manual:true}))
      await page.getByTitle('卡片密度：标准').click();await page.waitForTimeout(100)
    }
    const geometry=await cards.evaluateAll(nodes=>nodes.map(node=>({id:node.getAttribute('data-workspace-record'),top:node.getBoundingClientRect().top})))
    const columns=geometry.findIndex(rect=>Math.abs(rect.top-geometry[0].top)>1)
    await cards.first().focus();await page.keyboard.press('ArrowDown')
    const gridActual=await page.evaluate(()=>document.activeElement?.getAttribute('data-workspace-record'))
    const gridExpected=columns>0&&columns<count?geometry[columns].id:geometry[0].id
    if(gridActual!==gridExpected)throw Error(`${label}: grid down selected wrong row`)
    await cards.first().click()
    const detail=page.locator('[data-atlas-nav]');await detail.waitFor();const before=await detail.getAttribute('aria-label')
    await detail.focus();await page.keyboard.press('ArrowRight');const after=await detail.getAttribute('aria-label')
    if(count>1&&before===after)throw Error(`${label}: did not advance`)
    results.push({label,count,columns,gridActual,gridExpected,before,after})
  }
  await page.getByRole('button',{name:'编辑',exact:true}).click()
  const savedId=await page.locator('[data-workspace-record][aria-current="true"]').getAttribute('data-workspace-record')
  const field=page.locator('[data-atlas-detail] [data-workspace-field] textarea').first();await field.waitFor()
  const original=await field.inputValue(), marker='【隔离保存测试】';await field.fill(original+marker)
  await page.evaluate(()=>{
    const originalPut=IDBObjectStore.prototype.put
    window.__restoreTablePut=()=>{IDBObjectStore.prototype.put=originalPut}
    IDBObjectStore.prototype.put=function(...args){if(this.name==='tableRows')throw new Error('synthetic write failure');return originalPut.apply(this,args)}
  })
  const save=page.getByTitle('保存并退出编辑（与表格底部「保存」是同一个动作）');await save.click();await page.waitForTimeout(350)
  const failureKept=await field.isVisible()&&(await field.inputValue()).endsWith(marker)
  if(!failureKept)throw Error('failed persistence exited edit or lost draft')
  await page.evaluate(()=>window.__restoreTablePut());await save.click()
  await page.getByRole('button',{name:'编辑',exact:true}).waitFor({timeout:10000})
  const saveRetried=await page.locator('[data-atlas-detail]').innerText()
  if(!saveRetried.includes(marker))throw Error('successful retry did not show new value')
  await nav.getByText('写作面板',{exact:true}).click();await nav.getByText('地理风物',{exact:true}).click()
  await page.getByRole('button',{name:'图鉴',exact:true}).click()
  await page.locator(`[data-workspace-record="${savedId}"]`).click()
  const reloaded=(await page.locator('[data-atlas-detail]').innerText()).includes(marker)
  if(!reloaded)throw Error('saved value did not survive leaving and reopening table')
  results.push({label:'隔离写入故障与重试',failureKept,retryVisible:saveRetried.includes(marker),reloaded})
  const evidence={run,results,errors};await writeFile(path.join(run,'result.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence))
  if(errors.length)process.exitCode=1
}finally{await browser?.close();await server.close()}
