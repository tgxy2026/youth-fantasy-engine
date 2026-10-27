// UI protocol: seed only TemplateFill's initial result via Vite; InterviewChat restores actual isolated IDB.
// No generation/provider is mocked as successful and no real model is contacted.
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {createServer} from 'vite'
import {chromium} from 'playwright'
import {snapshot} from '../audit/platform/source.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const run=await fs.mkdtemp(path.join(root,'.workbuddy/tmp/frontend-candidate-submission-'))
const fingerprint=snapshot(root).fingerprint
const candidate='<script>window.__candidateScriptRan=true</script>\n'+'候选完整内容\n'.repeat(80)
const fixtureHash=async()=>{
  const hash=createHash('sha256')
  for(const name of ['candidate-submission.html','candidate-submission.tsx'])hash.update(await fs.readFile(path.join(root,'tests/browser',name)))
  return hash.digest('hex')
}
const fixtureFingerprint=await fixtureHash()
const report={kind:'frontend-candidate-submission',at:new Date().toISOString(),run,fingerprint,fixtureFingerprint,
  templateSeed:'only initial result state, not generation or backend success',checks:[],errors:[],modelRequests:[],status:'running'}
const check=(name,passed,details)=>{report.checks.push({name,passed:!!passed,details});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw Error(name+': '+JSON.stringify(details))}
let server,browser,page,seedHits=0
try{
  server=await createServer({root,cacheDir:path.join(run,'vite-cache'),logLevel:'error',server:{host:'localhost',port:0},plugins:[{
    name:'candidate-ui-initial-result-fixture',enforce:'pre',transform(code,id){
      if(!id.replaceAll('\\','/').split('?')[0].endsWith('/src/components/ai/AITemplateFill.tsx'))return
      const from='const [result, setResult] = useState<Record<string, string> | null>(null)'
      if(code.split(from).length!==2)throw Error('Candidate initial-result fixture no longer matches source')
      seedHits++
      return code.replace(from,`const [result, setResult] = useState<Record<string, string> | null>(() => Object.fromEntries(fields.filter(f => !f.locked && !existing?.[f.key]?.trim()).map(f => [f.key, ['卷名','章节号/标题','姓名','名称'].some(key => f.key === key || f.key.endsWith('::' + key)) ? '采用测试记录' : ${JSON.stringify(candidate)}])))`)
    },
  }]})
  await server.listen();const origin=`http://localhost:${server.httpServer.address().port}`
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']})
  const context=await browser.newContext({viewport:{width:1000,height:800},reducedMotion:'reduce'})
  await context.route('**/*',route=>{
    const url=route.request().url()
    if(/\/chat\/completions|\/api\/ai(?:\/|$)/.test(url)){report.modelRequests.push(route.request().method());return route.abort()}
    return url.startsWith(origin+'/')?route.continue():route.abort()
  })
  page=await context.newPage();page.setDefaultTimeout(120000);page.on('pageerror',error=>report.errors.push(error.message))
  await page.goto(origin+'/tests/browser/candidate-submission.html',{waitUntil:'commit'})
  await page.getByRole('button',{name:'打开模板候选',exact:true}).click();page.setDefaultTimeout(15000)
  const dialog=page.getByRole('dialog',{name:'模板候选采用测试',exact:true})
  const apply=()=>dialog.getByRole('button',{name:'采用候选',exact:true})
  const field=dialog.locator('[data-candidate-field="fixture::field"]')
  await field.waitFor()
  check('seeded real template preview preserves the complete candidate',await field.inputValue()===candidate&&seedHits===1)
  await apply().evaluate(el=>{el.click();el.click()})
  await dialog.getByRole('button',{name:'正在采用…',exact:true}).waitFor()
  check('same-event repeated adoption dispatches one actual callback',await page.evaluate(()=>window.__candidateUI.counts().calls)===1)
  check('pending adoption retains the modal and disables candidate mutation and regeneration',await dialog.isVisible()
    &&await field.isDisabled()&&await dialog.getByRole('button',{name:'重新生成',exact:true}).isDisabled()
    &&await dialog.getByRole('button',{name:'取消',exact:true}).isDisabled())
  await page.keyboard.press('Escape')
  check('Escape cannot close an in-flight adoption',await dialog.isVisible()&&await page.evaluate(()=>window.__candidateUI.counts().closes)===0)
  await page.evaluate(()=>window.__candidateUI.settle(false))
  await dialog.getByRole('alert').waitFor()
  check('explicit refusal retains candidate and permits an explicit retry',await field.inputValue()===candidate
    &&await apply().isEnabled()&&await page.evaluate(()=>window.__candidateUI.counts().closes)===0)
  await page.evaluate(()=>window.__candidateUI.behavior('throw'));await apply().click()
  await page.waitForFunction(()=>window.__candidateUI.counts().calls===2&&document.querySelector('[data-candidate-field]')?.disabled===false)
  check('a failed callback leaves the candidate with bounded non-secret feedback',await field.inputValue()===candidate
    &&await dialog.getByRole('alert').isVisible()&&!(await dialog.getByRole('alert').innerText()).includes('private submission'))
  check('candidate HTML is plain text and never executes',await page.evaluate(()=>window.__candidateScriptRan!==true&&document.querySelectorAll('script').length>0))
  await page.screenshot({path:path.join(run,'template-submission-failure.png'),animations:'disabled'})
  await page.evaluate(()=>window.__candidateUI.behavior('accept'));await apply().click();await dialog.waitFor({state:'hidden'})
  check('a successful callback alone closes once and receives the complete immutable payload',await page.evaluate(candidate=>{
    const p=window.__candidateUI;return p.counts().calls===3&&p.counts().closes===1&&p.payloads().every(value=>value['fixture::field']===candidate)
  },candidate))
  await page.evaluate(()=>window.__candidateUI.behavior('pending'))
  await page.getByRole('button',{name:'打开模板候选',exact:true}).click();await field.waitFor();await apply().click()
  await page.evaluate(()=>{window.__candidateUI.project('replacement-project');window.__candidateUI.settle(true)})
  const changed=page.getByRole('dialog',{name:'工作上下文已变化',exact:true})
  await changed.getByRole('alert').waitFor()
  check('late completion hides original content and requests verification without replay',await changed.isVisible()
    &&await changed.getByRole('button',{name:'采用候选',exact:true}).count()===0&&await changed.getByRole('button',{name:'关闭',exact:true}).last().isEnabled()
    &&!(await page.locator('body').innerText()).includes('候选完整内容')
    &&await page.evaluate(()=>window.__candidateUI.counts().calls===4&&window.__candidateUI.counts().closes===1))
  await changed.getByRole('button',{name:'关闭',exact:true}).last().click();await changed.waitFor({state:'hidden'})
  await page.evaluate(()=>window.__candidateUI.project('candidate-ui-fixture'))
  await page.getByRole('button',{name:'打开模板候选',exact:true}).click();await field.waitFor();await apply().click()
  await page.evaluate(()=>{window.__YFE_USER__={id:'replacement-identity'};window.__candidateUI.settle(true)})
  await changed.getByRole('alert').waitFor()
  check('same-project identity replacement hides prior candidate and rejects a late receipt',await changed.isVisible()
    &&await changed.getByRole('button',{name:'采用候选',exact:true}).count()===0&&await changed.getByRole('button',{name:'关闭',exact:true}).last().isEnabled()
    &&!(await page.locator('body').innerText()).includes('候选完整内容')
    &&await page.evaluate(()=>window.__candidateUI.counts().calls===5&&window.__candidateUI.counts().closes===2))
  await changed.getByRole('button',{name:'关闭',exact:true}).last().click();await changed.waitFor({state:'hidden'})
  await page.evaluate(()=>{delete window.__YFE_USER__})
  await page.evaluate(async()=>{window.__candidateUI.project('candidate-ui-fixture');await window.__candidateUI.seedArchive()})
  const archiveBefore=await page.evaluate(async()=>JSON.stringify(await window.__candidateUI.archive()))
  check('interview fixture has a real recoverable archive',archiveBefore!=='null')
  await page.getByRole('button',{name:'打开访谈候选',exact:true}).click()
  const interview=page.getByRole('dialog',{name:'对话引导 · 创建采用测试',exact:true})
  await interview.getByRole('button',{name:'继续上次',exact:true}).click()
  const adopt=()=>interview.getByRole('button',{name:'采用候选并填入',exact:true})
  await adopt().evaluate(el=>{el.click();el.click()})
  await interview.getByRole('button',{name:'正在采用…',exact:true}).waitFor()
  check('interview waits for actual adoption without deleting its archive',await page.evaluate(async original=>
    window.__candidateUI.counts().calls===6&&JSON.stringify(await window.__candidateUI.archive())===original,archiveBefore))
  await page.evaluate(()=>window.__candidateUI.settle(false));await interview.getByRole('alert').waitFor()
  check('declined interview keeps both the visible candidate and original archive',await interview.locator('pre').innerText()!==''
    &&await page.evaluate(async original=>JSON.stringify(await window.__candidateUI.archive())===original,archiveBefore))
  await page.evaluate(()=>window.__candidateUI.behavior('throw'));await adopt().click()
  await page.waitForFunction(()=>window.__candidateUI.counts().calls===7)
  check('failed interview adoption never clears recovery evidence or falsely closes',await interview.isVisible()
    &&await page.evaluate(async original=>JSON.stringify(await window.__candidateUI.archive())===original,archiveBefore))
  await page.evaluate(()=>window.__candidateUI.behavior('accept'));await adopt().click();await interview.waitFor({state:'hidden'})
  check('accepted interview clears its original archive only after the callback',await page.evaluate(async()=>
    window.__candidateUI.counts().calls===8&&window.__candidateUI.counts().closes===4&&await window.__candidateUI.archive()===null))
  check('no model generation was used to obtain the candidate',await page.evaluate(()=>window.__candidateUI.counts().chatCalls)===0)
  // A controlled callChat promise verifies generation ownership without a model request.
  await page.getByRole('button',{name:'打开访谈候选',exact:true}).click()
  await page.waitForFunction(()=>window.__candidateUI.counts().chatCalls===1)
  await page.evaluate(()=>{window.__YFE_USER__={id:'late-generation-identity'};window.__candidateUI.settleChat(JSON.stringify({question:'原身份私密生成内容',filled:{'fixture::field':'原身份私密生成内容'},done:true}))})
  await changed.getByRole('alert').waitFor()
  check('late interview generation neither displays private output nor writes a new archive',!(await page.locator('body').innerText()).includes('原身份私密生成内容')
    &&await page.evaluate(async()=>await window.__candidateUI.archive()===null))
  await changed.getByRole('button',{name:'关闭',exact:true}).last().click();await changed.waitFor({state:'hidden'})
  await page.evaluate(()=>{delete window.__YFE_USER__})
  // Exercise the actual Outline callback and IDB failure path, not a successful callback fixture.
  page.setDefaultTimeout(120000);await page.setViewportSize({width:1366,height:900})
  await page.goto(origin,{waitUntil:'commit'})
  await page.getByRole('button',{name:/先看看示例/}).click()
  await page.getByRole('button',{name:'下一步',exact:true}).click()
  await page.getByRole('button',{name:/跳过，直接开始|开始写作/}).click()
  await page.getByRole('button',{name:'稍后再说',exact:true}).click()
  const nav=page.getByRole('navigation');await nav.waitFor();page.setDefaultTimeout(20000)
  const original=await page.evaluate(async origin=>{
    const ai=await import('/src/lib/ai.ts'),db=await import('/src/lib/db.ts')
    ;(await import('/src/lib/settings/theme.ts')).applyZoom(100,{manual:true})
    await ai.saveProviders([{id:'never-requested',name:'隔离候选测试',type:'openai',baseUrl:origin+'/fixture-model',apiKey:'fixture-not-a-real-key',model:'never-requested',contextWindow:8192}])
    await ai.saveActiveId('never-requested')
    return JSON.stringify(await db.getCardRecords('chapter-outline'))
  },origin)
  if(!await nav.getByRole('button',{name:'章节细纲',exact:true}).isVisible())await nav.getByRole('button',{name:'大纲规划',exact:true}).click()
  await nav.getByRole('button',{name:'章节细纲',exact:true}).click()
  const create=page.getByRole('button',{name:'AI 新增',exact:true})
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='AI 新增'&&!button.disabled))
  await create.click()
  const real=page.getByRole('dialog',{name:'AI 新增 · 章节细纲',exact:true});await real.waitFor()
  const selected=await page.locator('[data-outline-record]:has(button[aria-pressed="true"])').getAttribute('data-outline-record')
  await page.evaluate(()=>{
    const put=IDBObjectStore.prototype.put;window.__candidateFailedPuts=0;window.__candidateSuccessfulPuts=0
    IDBObjectStore.prototype.put=function(value,...args){if(this.name==='cardRecords'){window.__candidateFailedPuts++;throw new DOMException('isolated candidate write failure','QuotaExceededError')}return put.call(this,value,...args)}
    window.__recoverCandidatePut=()=>{IDBObjectStore.prototype.put=function(value,...args){if(this.name==='cardRecords')window.__candidateSuccessfulPuts++;return put.call(this,value,...args)}}
  })
  await real.getByRole('button',{name:'采用候选',exact:true}).evaluate(el=>{el.click();el.click()})
  await real.getByRole('alert').waitFor()
  check('real failed outline creation keeps the candidate and existing authoritative records',await real.isVisible()
    &&await page.evaluate(async original=>JSON.stringify(await(await import('/src/lib/db.ts')).getCardRecords('chapter-outline'))===original&&window.__candidateFailedPuts===1,original))
  check('real failed adoption retains the original selection and complete candidate',await page.locator('[data-outline-record]:has(button[aria-pressed="true"])').getAttribute('data-outline-record')===selected
    &&await real.locator('[data-candidate-field="二、场景细纲::场景1"]').inputValue()===candidate)
  await page.evaluate(()=>window.__recoverCandidatePut())
  await real.getByRole('button',{name:'采用候选',exact:true}).click();await real.waitFor({state:'hidden'})
  check('explicit real retry creates exactly one record and leaves previous records unchanged',await page.evaluate(async({original,candidate})=>{
    const rows=await(await import('/src/lib/db.ts')).getCardRecords('chapter-outline'),created=rows.filter(row=>row.name==='采用测试记录')
    return created.length===1&&rows.length===JSON.parse(original).length+1&&created[0].data['二、场景细纲::场景1']===candidate
      &&JSON.stringify(rows.filter(row=>row.id!==created[0].id))===original&&window.__candidateSuccessfulPuts===1
  },{original,candidate}))
  check('no model requests',report.modelRequests.length===0,report.modelRequests)
  check('no browser errors',report.errors.length===0,report.errors)
  report.status='passed'
}catch(error){report.status='failed';report.failure=error.stack||String(error);await page?.screenshot({path:path.join(run,'failure.png'),animations:'disabled'}).catch(()=>{})}
finally{
  report.stale=fingerprint!==snapshot(root).fingerprint||fixtureFingerprint!==await fixtureHash();if(report.stale)report.status='failed'
  report.passed=report.checks.filter(check=>check.passed).length
  await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2));await browser?.close();await server?.close()
  console.log(JSON.stringify({run,status:report.status,passed:report.passed,total:report.checks.length,stale:report.stale,failure:report.failure}))
  if(report.status!=='passed')process.exitCode=1
}
