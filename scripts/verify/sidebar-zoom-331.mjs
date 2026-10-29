import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp,writeFile } from 'node:fs/promises'
import path from 'node:path'
const root=process.cwd(),run=await mkdtemp(path.join(root,'.workbuddy/tmp/sidebar-zoom-331-'))
const server=await createServer({root,cacheDir:path.join(run,'vite'),logLevel:'error',server:{host:'localhost',port:0}})
let browser
try{
  await server.listen();const origin=`http://localhost:${server.httpServer.address().port}`
  browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1600,height:1000},reducedMotion:'reduce'})
  await context.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort())
  const page=await context.newPage();await page.goto(origin,{waitUntil:'domcontentloaded'})
  await page.getByRole('button',{name:/先看看示例/}).click();await page.getByRole('button',{name:'下一步',exact:true}).click()
  await page.getByRole('button',{name:/跳过，直接开始|开始写作/}).click();await page.getByTitle('返回项目列表').waitFor({timeout:60000})
  const later=page.getByRole('button',{name:'稍后再说',exact:true});if(await later.isVisible())await later.click()
  const input=page.getByRole('spinbutton',{name:'界面缩放百分比'}),auto=page.getByRole('button',{name:'跟随窗口自动调整'})
  const cases=[]
  const resize=page.getByRole('separator',{name:'侧栏宽度'})
  for(const side of ['Home','End'])for(const zoom of [80,100,130,160]){
    await resize.focus();await page.keyboard.press(side)
    await input.fill(String(zoom));await input.press('Enter');await page.waitForTimeout(150)
    const result=await page.evaluate(()=>{
      const input=document.querySelector('[aria-label="界面缩放百分比"]'),auto=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='自动'),title=[...document.querySelectorAll('span')].find(e=>e.textContent.trim()==='界面缩放')
      const rect=e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}}
      return {input:rect(input),auto:rect(auto),title:rect(title),value:input.value,pressed:auto.getAttribute('aria-pressed')}
    })
    if(result.value!==String(zoom)||result.pressed!=='false'||Math.abs(result.input.top-result.auto.top)>5||result.title.bottom>result.input.top+3)throw Error(`zoom layout mismatch ${JSON.stringify(result)}`)
    cases.push({side,zoom,...result})
  }
  await auto.click();const autoPressed=await auto.getAttribute('aria-pressed');if(autoPressed!=='true')throw Error('automatic mode not restored')
  const evidence={run,cases,autoPressed};await writeFile(path.join(run,'result.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence))
}finally{await browser?.close();await server.close()}
