// Standalone real-service acceptance. Works on main without the 3.3.0 app fixtures.
// All credentials/data are disposable and never included in the report or images.
import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../../', import.meta.url))
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/auth-entry-integration-'))
const files = ['server/lib/authPage.mjs','server/lib/authClient.mjs','server/lib/authStyle.mjs','server/index.mjs','server/lib/auth.mjs','scripts/verify/auth-entry-integration.mjs']
const fingerprint = async () => {
  const hash = createHash('sha256')
  for (const file of files) hash.update(file).update(await fs.readFile(path.join(root,file)))
  return hash.digest('hex')
}
const report = {run,fingerprint:await fingerprint(),checks:[],errors:[]}
const check = (name,passed) => {report.checks.push({name,passed:!!passed});if(!passed) throw Error(name)}
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms))
const port = () => new Promise((resolve,reject)=>{
  const socket=net.createServer();socket.once('error',reject);socket.listen(0,'127.0.0.1',()=>{const value=socket.address().port;socket.close(()=>resolve(value))})
})
let child,browser
const stop = async () => {
  if(!child)return
  const owned=child;child=null
  if(owned.exitCode===null){owned.kill();await Promise.race([new Promise(resolve=>owned.once('exit',resolve)),pause(5000)])}
}
try {
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']})
  for(const mode of ['invite','open','closed']) {
    const base=path.join(run,mode),www=path.join(base,'www');await fs.mkdir(www,{recursive:true})
    await fs.writeFile(path.join(www,'index.html'),'<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"><main id="auth-hub">独立验收入口</main></div></body></html>')
    const servicePort=await port(),origin=`http://127.0.0.1:${servicePort}`
    child=spawn(process.execPath,['server/index.mjs'],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,HOST:'127.0.0.1',PORT:String(servicePort),YFE_DATA:path.join(base,'data'),YFE_WWW:www,YFE_REGISTER:mode,YFE_BOOTSTRAP_INVITE:'TEST2026'}})
    let ready=false
    for(let i=0;i<80;i++){try{ready=(await fetch(origin)).status===200;if(ready)break}catch{/* Service startup. */}await pause(100)}
    if(!ready)throw Error('isolated service failed to start')
    const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'})
    await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort())
    const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message))
    await page.goto(origin)
    check(mode+' registration visibility follows policy',await page.getByRole('button',{name:'注册',exact:true}).count()===(mode==='closed'?0:1))
    check(mode+' real server sends eye-care entry page',await page.locator('body').getAttribute('class')==='auth-entry')
    check(mode+' recovery, guest and download targets are retained',await page.locator('.forgot a').getAttribute('href')==='/reset'&&await page.locator('.guestBtn').getAttribute('href')==='/guest'&&(await page.locator('.dl a').getAttribute('href')).startsWith('https://gitee.com/'))
    await page.locator('#name').fill('验收账号');await page.locator('#pwd').fill('disposable-password')
    await page.locator('#pwd').press('Enter');await page.locator('#msg').filter({hasText:'用户名或密码不正确'}).waitFor()
    check(mode+' real login errors retain inputs and focus the alert',await page.locator('#name').inputValue()==='验收账号'&&!await page.locator('#btn').isDisabled()&&await page.locator('#msg').evaluate(el=>el===document.activeElement))
    if(mode!=='closed') {
      await page.getByRole('button',{name:'注册',exact:true}).click()
      if(mode==='invite') {
        await page.locator('#invite').fill('INVALID');await page.locator('#btn').click();await page.locator('#msg.err').waitFor()
        check('invalid invite is rejected by the unchanged backend',!await page.locator('#btn').isDisabled()&&await page.locator('#name').inputValue()==='验收账号')
        await page.locator('#invite').fill('TEST2026')
      }
      await page.locator('#btn').click();await page.locator('#auth-hub').waitFor()
      check(mode+' actual registration creates an authenticated session',(await context.request.get(origin+'/api/auth/me')).status()===200)
      await page.reload();await page.locator('#auth-hub').waitFor()
      check(mode+' reload retains the signed-in route',true)
      if(mode==='invite') {
        const resetContext=await browser.newContext(),reset=await resetContext.newPage();await reset.goto(origin+'/reset')
        await reset.locator('#name').fill('验收账号');await reset.locator('#invite').fill('test2026');await reset.locator('#pwd').fill('replacement-password')
        await reset.locator('#btn').click();await reset.locator('#msg').filter({hasText:'重置成功'}).waitFor()
        check('real reset invalidates the original session',(await context.request.get(origin+'/api/auth/me')).status()===401)
        await reset.waitForURL(origin+'/');await reset.locator('#name').fill('验收账号');await reset.locator('#pwd').fill('replacement-password');await reset.locator('#btn').click();await reset.locator('#auth-hub').waitFor()
        check('replacement password logs in through the real endpoint',true);await resetContext.close()
      }
    }else check('closed policy still rejects direct registration',(await context.request.post(origin+'/api/auth/register',{data:{name:'禁止注册',password:'disposable-password'}})).status()===403)
    await page.goto(origin+'/login');await page.locator('#name').fill('不存在的账号');await page.locator('#pwd').fill('disposable-password')
    let release,hits=0;const gate=new Promise(resolve=>{release=resolve})
    const delayed=async route=>{hits++;const response=await route.fetch();await gate;await route.fulfill({response}).catch(()=>{})}
    await page.route('**/api/auth/login',delayed);await page.locator('#btn').click();await page.locator('#cancel').waitFor({state:'visible'})
    await page.locator('#form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
    check(mode+' pending prevents duplicate requests and form changes',hits===1&&await page.locator('#name').isDisabled()&&await page.locator('#password-toggle').isDisabled())
    await page.locator('#cancel').click();release();await page.unroute('**/api/auth/login',delayed)
    check(mode+' cancellation restores controls and warns about server uncertainty',!await page.locator('#btn').isDisabled()&&(await page.locator('#msg').innerText()).includes('服务端可能已处理'))
    await page.locator('#btn').click();await page.locator('#msg').filter({hasText:'用户名或密码不正确'}).waitFor()
    check(mode+' retry remains usable after cancellation',!await page.locator('#btn').isDisabled())
    await page.route('**/api/auth/login',route=>route.abort('internetdisconnected'));await page.locator('#btn').click();await page.locator('#msg').filter({hasText:'网络异常'}).waitFor()
    check(mode+' network failure is recoverable',!await page.locator('#btn').isDisabled());await page.unroute('**/api/auth/login')
    if(mode==='invite') {
      await page.clock.install();let releaseSlow;const slowGate=new Promise(resolve=>{releaseSlow=resolve})
      const slow=async route=>{const response=await route.fetch();await slowGate;await route.fulfill({response}).catch(()=>{})}
      await page.route('**/api/auth/login',slow);await page.locator('#btn').click();await page.clock.fastForward(31000);await page.locator('#msg').filter({hasText:'等待响应超时'}).waitFor()
      releaseSlow();await page.unroute('**/api/auth/login',slow)
      check('timeout restores controls without replaying the request',!await page.locator('#btn').isDisabled())
    }
    for(let i=0;i<13;i++)await context.request.post(origin+'/api/auth/login',{data:{name:'不存在的账号',password:'disposable-password'}})
    await page.locator('#btn').click();await page.locator('#msg').filter({hasText:'尝试次数过多'}).waitFor()
    check(mode+' backend rate limiting remains intact',!await page.locator('#btn').isDisabled())
    await page.goto(origin+'/guest');await page.locator('#auth-hub').waitFor()
    check(mode+' guest route retains its existing local-data notice',await page.locator('#yfe-guest-tip').count()===1)
    await context.close();await stop()
  }
  check('no browser exceptions during actual account flows',report.errors.length===0);report.status='passed'
}catch(error){report.status='failed';report.failure=error.stack||String(error)}finally{
  report.stale=report.fingerprint!==await fingerprint();if(report.stale)report.status='failed'
  await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2));await browser?.close();await stop()
  console.log(JSON.stringify({run,status:report.status,passed:report.checks.filter(c=>c.passed).length,total:report.checks.length,stale:report.stale,failure:report.failure}))
  if(report.status!=='passed')process.exitCode=1
}
