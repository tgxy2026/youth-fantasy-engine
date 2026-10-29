import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'
const root=process.cwd(),run=await mkdtemp(path.join(root,'.workbuddy/tmp/atlas-navigation-331-'))
const server=await createServer({root,cacheDir:path.join(run,'vite'),logLevel:'error',server:{host:'localhost',port:0}})
let browser
try {
  await server.listen();browser=await chromium.launch({channel:'msedge',headless:true})
  for(const width of [1400,650,350]) {
    const page=await browser.newPage({viewport:{width,height:900}})
    await page.goto(`http://localhost:${server.httpServer.address().port}`)
    await page.evaluate(()=>{document.body.innerHTML='<div id="fixture"></div>'})
    await page.evaluate(()=>import('/tests/browser/atlas-navigation-331-fixture.tsx'))
    const cards=page.locator('[data-workspace-record]')
    if(await cards.filter({has:page.locator('[tabindex="0"]')}).count())throw Error('unexpected nested tab stop')
    if(await page.locator('[data-workspace-record][tabindex="0"]').count()!==1)throw Error(`${width}: expected one card tab stop`)
    await page.locator('[data-workspace-record="row1"]').focus();await page.keyboard.press('ArrowRight')
    const cols=await page.evaluate(()=>{const a=[...document.querySelectorAll('[data-workspace-record]')].map(e=>e.getBoundingClientRect());return a.length>1 && Math.abs(a[0].top-a[1].top)<1})
    const expected=cols?'row2':'row1'
    if(await page.evaluate(()=>document.activeElement?.getAttribute('data-workspace-record'))!==expected)throw Error(`${width}: grid right moved incorrectly`)
    if(await page.locator('[data-atlas-nav]').count())throw Error(`${width}: grid focus opened detail`)
    await page.locator('[data-workspace-record="row1"]').click()
    let nav=page.locator('[data-atlas-nav]'); await nav.waitFor()
    if(!(await nav.evaluate(e=>e===document.activeElement))) throw Error(`${width}: navigation did not receive focus`)
    await nav.dispatchEvent('keydown',{key:'ArrowRight',isComposing:true})
    if(!/甲/.test(await nav.getAttribute('aria-label')))throw Error(`${width}: composition key changed entry`)
    const clipped=await nav.evaluate(el=>[...el.querySelectorAll('button')].some(button=>button.getBoundingClientRect().right>window.innerWidth+1))
    if(clipped)throw Error(`${width}: navigation button clipped by viewport`)
    await page.getByTitle('移除主图（文字内容不受影响）').click();await nav.focus();await page.keyboard.press('ArrowRight')
    if(!/甲/.test(await nav.getAttribute('aria-label'))||!await page.getByRole('button',{name:'下一条'}).isDisabled())throw Error(`${width}: switched while image write pending`)
    await page.evaluate(()=>window.finishImage());await page.waitForTimeout(50)
    const picker=page.waitForEvent('filechooser');await page.getByRole('button',{name:'换一张'}).click();await picker
    if(!await page.getByRole('button',{name:'下一条'}).isDisabled())throw Error(`${width}: navigation not blocked while file picker open`)
    await page.locator('input[type="file"]').last().dispatchEvent('cancel');await page.waitForTimeout(50)
    if(await page.getByRole('button',{name:'下一条'}).isDisabled())throw Error(`${width}: simulated picker cancel did not unlock navigation`)
    await nav.focus()
    await page.keyboard.press('ArrowRight')
    nav=page.locator('[data-atlas-nav]')
    if(!/乙.*第 2/.test(await nav.getAttribute('aria-label'))||!(await nav.evaluate(e=>e===document.activeElement)))throw Error(`${width}: detail or focus did not advance`)
    await page.keyboard.press('ArrowDown'); if(!/丙.*第 3/.test(await nav.getAttribute('aria-label')))throw Error(`${width}: down did not advance`)
    if(!await page.getByRole('button',{name:'下一条'}).isDisabled())throw Error(`${width}: end was not disabled`)
    await page.keyboard.press('ArrowRight');if(!/丙/.test(await nav.getAttribute('aria-label')))throw Error(`${width}: wrapped at end`)
    await page.keyboard.press('ArrowUp');if(!/乙/.test(await nav.getAttribute('aria-label')))throw Error(`${width}: up did not go back`)
    await page.keyboard.press('Escape');await page.waitForTimeout(100)
    if(await nav.count()||await page.evaluate(()=>document.activeElement?.getAttribute('data-workspace-record'))!=='row2')throw Error(`${width}: escape did not restore last card focus`)
    await page.locator('[data-workspace-record="row2"]').click()
    await page.getByRole('button',{name:'编辑',exact:true}).click();nav=page.locator('[data-atlas-nav]');await nav.focus();await page.keyboard.press('ArrowRight')
    if(!/乙/.test(await nav.getAttribute('aria-label'))||!await page.getByRole('button',{name:'下一条'}).isDisabled())throw Error(`${width}: switched during edit`)
    const input=page.locator('[data-atlas-detail] textarea').first();await input.focus();await page.keyboard.press('ArrowDown')
    if(!/乙/.test(await nav.getAttribute('aria-label'))||!(await input.evaluate(e=>e===document.activeElement)))throw Error(`${width}: editing input lost focus or changed entry`)
    if(width===1400){await page.locator('[data-workspace-record="row3"]').click();if(!/乙/.test(await nav.getAttribute('aria-label')))throw Error('mouse switch discarded edit')}
    await page.getByRole('button',{name:'筛掉乙'}).click()
    if(!/乙.*不在筛选/.test(await nav.getAttribute('aria-label'))||!await page.getByRole('button',{name:'撤销',exact:true}).isVisible())throw Error(`${width}: filter removed active editor`)
    await page.getByRole('button',{name:'撤销',exact:true}).click();await page.waitForTimeout(100)
    if(await nav.count())throw Error(`${width}: filtered clean detail did not close`)
    if(!await page.locator('[data-atlas-list]').evaluate(el=>el===document.activeElement))throw Error(`${width}: filtered detail lost its return focus`)
    await page.close()
  }
  console.log(JSON.stringify({run,result:'grid focus and detail wide/narrow keys, boundaries, edit/mouse/filter blocking and clean close passed'}))
}finally{await browser?.close();await server.close()}
