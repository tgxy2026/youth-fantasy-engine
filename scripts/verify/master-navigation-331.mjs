import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'
const root=process.cwd(),run=await mkdtemp(path.join(root,'.workbuddy/tmp/master-navigation-331-'))
const server=await createServer({root,cacheDir:path.join(run,'vite'),logLevel:'error',server:{host:'localhost',port:0}})
let browser
try{
  await server.listen();browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage()
  await page.goto(`http://localhost:${server.httpServer.address().port}`);await page.evaluate(()=>{document.body.innerHTML='<div id="fixture"></div>'})
  await page.evaluate(()=>import('/tests/browser/master-navigation-331-fixture.tsx'))
  const a=page.getByRole('button',{name:'a',exact:true}),b=page.getByRole('button',{name:'b',exact:true}),input=page.getByRole('textbox',{name:'输入框'})
  await a.focus();await a.dispatchEvent('keydown',{key:'ArrowDown',isComposing:true})
  if(await page.evaluate(()=>window.selectionCount||0)!==0)throw Error('composition key was intercepted')
  await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown')
  if(await page.evaluate(()=>window.selectionCount)!==1)throw Error('pending keyboard events were queued')
  await page.evaluate(()=>window.resolveSelection(false));await page.waitForTimeout(50)
  if(await a.getAttribute('aria-pressed')!=='true'||!(await a.evaluate(e=>e===document.activeElement)))throw Error('failed save changed record or focus')
  await page.keyboard.press('ArrowDown');await input.focus();await page.evaluate(()=>window.resolveSelection(true));await page.waitForTimeout(50)
  if(!(await input.evaluate(e=>e===document.activeElement))||await a.getAttribute('aria-pressed')!=='true')throw Error('late result stole focus or changed record')
  await b.focus();await page.keyboard.press('ArrowUp');await page.evaluate(()=>window.resolveSelection(true));await page.waitForTimeout(100)
  if(!(await a.evaluate(e=>e===document.activeElement))||await a.getAttribute('aria-pressed')!=='true')throw Error('successful selection did not focus target')
  await page.keyboard.press('Alt+ArrowDown');if(await page.evaluate(()=>window.selectionCount)!==3)throw Error('modifier key was intercepted')
  await page.keyboard.press('ArrowDown');await page.getByRole('button',{name:'筛掉 b'}).click();await page.evaluate(()=>window.resolveSelection(true));await page.waitForTimeout(50)
  if(await b.count()!==0||await a.getAttribute('aria-pressed')!=='true')throw Error('filtered target was still selected')
  console.log(JSON.stringify({run,result:'failure, pending input, focus ownership, modifiers and filtered targets checked'}))
}finally{await browser?.close();await server.close()}
