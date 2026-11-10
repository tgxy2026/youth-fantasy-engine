// Isolated real server + browser: account-local storage and shared community transport.
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { chromium } from 'playwright'

const root = await fs.mkdtemp(path.resolve('.workbuddy/tmp/community-web-local-'))
const data = path.join(root, 'data')
await fs.mkdir(data)
const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const base = `http://127.0.0.1:${port}`
const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), YFE_DATA: data,
  YFE_WWW: path.resolve(process.env.YFE_TEST_WEB_BUILD || '.workbuddy/tmp/community-web-isolated-build'), YFE_REGISTER: 'open', YFE_SCHEDULER: 'off' }
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_OPTIONS']) delete env[key]
const server = spawn(process.execPath, ['server/index.mjs'], { env, windowsHide: true, stdio: 'ignore' })
let browser
function check(label, ok) { if (!ok) throw new Error(label); console.log(`PASS ${label}`) }
try {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/api/ping`)).ok) break } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext()
  const page = await context.newPage()
  let cloudDataRequests = 0
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/data') cloudDataRequests++ })
  async function auth(route, name) {
    const r = await context.request.post(`${base}/api/auth/${route}`, { data: { name, password: 'TestLocal350!' } })
    check(`${name} ${route}`, r.ok())
  }
  await auth('register', 'local-a350')
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__YFE_ACCOUNT_LOCAL__ === true)
  await page.waitForFunction(async () => (await indexedDB.databases()).some((db) => db.name?.includes('-account-')))
  const first = await page.evaluate(async () => ({ id: window.__YFE_USER__.id, dbs: await indexedDB.databases(), portable: !!window.__YFE_PORTABLE__ }))
  const firstName = `youth-fantasy-engine-account-${encodeURIComponent(first.id)}`
  check('无同步资格账号使用独立主库', first.dbs.some((db) => db.name === firstName) && !first.portable)
  await page.evaluate(async (name) => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    await new Promise((resolve, reject) => { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put({ key: 'test-isolation', value: 'account-a-only' }); tx.oncomplete = resolve; tx.onerror = reject })
    db.close()
  }, firstName)
  await context.request.post(`${base}/api/auth/logout`)
  await auth('register', 'local-b350')
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction((id) => window.__YFE_ACCOUNT_LOCAL__ && window.__YFE_USER__.id !== id, first.id)
  const second = await page.evaluate(() => window.__YFE_USER__.id)
  const secondName = `youth-fantasy-engine-account-${encodeURIComponent(second)}`
  await page.waitForFunction(async (name) => (await indexedDB.databases()).some((db) => db.name === name), secondName)
  const leak = await page.evaluate(async (name) => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    const value = await new Promise((resolve, reject) => { const r = db.transaction('meta').objectStore('meta').get('test-isolation'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    db.close(); return value
  }, secondName)
  check('同浏览器另一账号不读取第一账号的作品库', !leak && secondName !== firstName)
  await context.request.post(`${base}/api/auth/logout`)
  await auth('login', 'local-a350')
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction((id) => window.__YFE_USER__?.id === id && window.__YFE_ACCOUNT_LOCAL__, first.id)
  const retained = await page.evaluate(async (name) => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    const value = await new Promise((resolve, reject) => { const r = db.transaction('meta').objectStore('meta').get('test-isolation'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    db.close(); return value?.value
  }, firstName)
  check('退出并重新登录后本机数据仍在', retained === 'account-a-only')
  const example = await context.request.get(`${base}/api/community/posts`)
  check('未激活账号可访问服务器投稿', example.ok() && (await example.json()).items.some((post) => post.isExample))
  check('未激活账号页面未请求云端作品接口', cloudDataRequests === 0)
  check('实际网页运行未出现脚本异常', pageErrors.length === 0)
  const usersPath = path.join(data, 'users.json')
  const users = JSON.parse(await fs.readFile(usersPath, 'utf8'))
  users.users[first.id].cloudSync = true
  await fs.writeFile(usersPath, JSON.stringify(users))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__YFE_USER__?.cloudSync === true)
  check('获得同步资格后仍保留本机模式', await page.evaluate(() => window.__YFE_ACCOUNT_LOCAL__ === true && !window.__YFE_PORTABLE__))
  await page.evaluate((id) => localStorage.removeItem(`yfe:account-local:${id}`), first.id)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.__YFE_PORTABLE__)
  check('主动选择云端后可切换到云端存储', await page.evaluate(() => !window.__YFE_ACCOUNT_LOCAL__ && !!window.__YFE_PORTABLE__))
  await page.evaluate((id) => localStorage.setItem(`yfe:account-local:${id}`, '1'), first.id)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__YFE_ACCOUNT_LOCAL__ === true)
  const afterReturn = await page.evaluate(async (name) => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    const value = await new Promise((resolve, reject) => { const r = db.transaction('meta').objectStore('meta').get('test-isolation'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    db.close(); return value?.value
  }, firstName)
  check('从云端返回后本机数据未被覆盖', afterReturn === 'account-a-only')
} finally {
  await browser?.close()
  server.kill()
}
