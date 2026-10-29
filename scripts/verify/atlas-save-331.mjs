import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'
const root=process.cwd(),run=await mkdtemp(path.join(root,'.workbuddy/tmp/atlas-save-331-'))
const server=await createServer({root,cacheDir:path.join(run,'vite'),logLevel:'error',server:{host:'localhost',port:0}})
let browser
try {
  await server.listen();browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage()
  await page.goto(`http://localhost:${server.httpServer.address().port}`)
  await page.evaluate(()=>{document.body.innerHTML='<div id="fixture"></div>'})
  await page.evaluate(()=>import('/tests/browser/atlas-save-331-fixture.tsx'))
  await page.getByRole('button',{name:'编辑',exact:true}).click()
  const input=page.locator('[data-workspace-field="名称"] textarea');await input.fill('草稿一')
  const save=page.getByRole('button',{name:'保存',exact:true});await save.click()
  if(!await save.isDisabled()||!await page.getByRole('button',{name:'撤销',exact:true}).isDisabled())throw Error('pending save was not protected')
  if(await page.evaluate(()=>window.saveCount)!==1)throw Error('duplicate save launched')
  await page.evaluate(()=>window.finishSave(false));await page.waitForTimeout(50)
  if(await input.inputValue()!=='草稿一'||!await save.isVisible())throw Error('failed save lost edit state')
  await save.click();await input.fill('较新的草稿');await page.evaluate(()=>window.finishSave(false));await page.waitForTimeout(50)
  if(await input.inputValue()!=='较新的草稿'||!await save.isVisible())throw Error('late result lost newer draft')
  await save.click();await page.evaluate(()=>window.finishSave(true))
  await page.getByRole('button',{name:'编辑',exact:true}).waitFor()
  console.log(JSON.stringify({run,result:'failed, delayed/newer and successful save states verified with simulated receipts'}))
}finally{await browser?.close();await server.close()}
