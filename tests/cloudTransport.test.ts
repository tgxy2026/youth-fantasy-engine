// 3.3.2 · P5 同步请求通道 · 单测 + 静态契约
//
// 盯五件事：
//   ① 默认通道不改网页行为（不配置时 `syncApi` 仍走同源 fetch）；
//   ② 桌面适配器把 `{status, base64}` 正确还原成标准 Response（含二进制）；
//   ③ 请求体：字符串 / ArrayBuffer / 类型化数组都支持，Blob 明确报错；
//   ④ 主进程侧确实支持二进制返回与「登录 origin」查询；
//   ⑤ 宿主错误（未登录 / 目标源不符）必须抛出，不能静默返回空响应。
import fs from 'node:fs'
import path from 'node:path'
import {
  base64ToBytes, desktopCloudFetch, headersToRecord, responseFromBase64,
} from '@/lib/cloud/cloudTransport'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const root = process.cwd()
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')
const B64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

async function main() {
  // ① HeadersInit 归一
  ok('对象头原样保留', JSON.stringify(headersToRecord({ 'Content-Type': 'application/json' })) === '{"Content-Type":"application/json"}')
  ok('数组头转对象', headersToRecord([['a', '1'], ['b', '2']]).b === '2')
  ok('Headers 实例可读', headersToRecord(new Headers({ 'x-yfe': '1' }))['x-yfe'] === '1')
  ok('空值返回空对象', Object.keys(headersToRecord(undefined)).length === 0 && Object.keys(headersToRecord(null)).length === 0)

  // ② base64 → 字节 / Response
  {
    const bytes = base64ToBytes(B64('hello'))
    ok('base64 还原字节', bytes.length === 5 && bytes[0] === 104, String(bytes[0]))
    const res = responseFromBase64(B64('对象内容'), 201)
    const text = await res.text()
    ok('Response 状态码保留', res.status === 201)
    ok('Response 正文可读', text === '对象内容', text)
    const empty = responseFromBase64('', 404)
    ok('空 base64 不炸', empty.status === 404 && (await empty.text()) === '')
  }

  // ③ 桌面适配器
  {
    const calls: Array<Record<string, unknown>> = []
    const fetchImpl = desktopCloudFetch('https://yfe.example', async (opts) => {
      calls.push(opts as Record<string, unknown>)
      return { ok: true, status: 200, base64: B64('{"ok":true}') }
    })
    const res = await fetchImpl('https://yfe.example/api/v2/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' })
    ok('适配器返回标准 Response', res.status === 200 && (await res.json() as { ok: boolean }).ok === true)
    ok('请求透传 origin 与 binary', calls[0].origin === 'https://yfe.example' && calls[0].binary === true)
    ok('请求方法与头透传', calls[0].method === 'POST' && (calls[0].headers as Record<string, string>)['Content-Type'] === 'application/json')
    ok('字符串请求体原样', calls[0].body === '{"a":1}')
  }
  {
    const calls: Array<Record<string, unknown>> = []
    const fetchImpl = desktopCloudFetch('https://x', async (opts) => { calls.push(opts as Record<string, unknown>); return { ok: true, status: 200, base64: '' } })
    await fetchImpl('https://x/api/v2/projects/p/objects/h', { method: 'PUT', body: new Uint8Array([1, 2, 3]).buffer })
    const body = calls[0].body
    ok('ArrayBuffer 请求体转成 Uint8Array', body instanceof Uint8Array && body.length === 3, String(body))
  }
  {
    const calls: Array<Record<string, unknown>> = []
    const fetchImpl = desktopCloudFetch('https://x', async (opts) => { calls.push(opts as Record<string, unknown>); return { ok: true, status: 200, base64: '' } })
    await fetchImpl('https://x/api/v2/projects', { method: 'GET' })
    ok('GET 不带请求体', calls[0].body === undefined)
  }
  {
    const fetchImpl = desktopCloudFetch('https://x', async () => ({ ok: true, status: 200, base64: '' }))
    let threw = ''
    try { await fetchImpl('https://x', { method: 'POST', body: new Blob(['x']) }) } catch (e) { threw = e instanceof Error ? e.message : String(e) }
    ok('Blob 请求体明确报错', /只支持字符串或二进制/.test(threw), threw)
  }
  {
    const errImpl = desktopCloudFetch('https://x', async () => ({ ok: false, status: 0, error: '请求目标与登录服务器不一致' }))
    let threw = ''
    try { await errImpl('https://x') } catch (e) { threw = e instanceof Error ? e.message : String(e) }
    ok('宿主错误必须抛出（不静默）', threw === '请求目标与登录服务器不一致', threw)
  }
  {
    const noBody = desktopCloudFetch('https://x', async () => ({ ok: true, status: 200 }))
    let threw = ''
    try { await noBody('https://x') } catch (e) { threw = e instanceof Error ? e.message : String(e) }
    ok('没有返回内容时抛出', /没有返回内容/.test(threw), threw)
  }

  // ④ 静态契约：默认通道 + 宿主能力
  {
    const api = read('src/lib/cloud/syncApi.ts')
    ok('syncApi 不再直接调用全局 fetch', !/await fetch\(/.test(api), '仍有一处直连 fetch')
    ok('syncApi 提供通道配置且默认空', /configureCloudTransport/.test(api) && /activeFetch: CloudFetch \| null = null/.test(api))
    ok('syncApi 所有请求走 f()', (api.match(/await f\(\)\(/g) || []).length >= 6, String((api.match(/await f\(\)\(/g) || []).length))

    const boot = read('src/lib/app/syncBoot.ts')
    ok('桌面已登录时才装配 Bearer 通道', /if \(!DESKTOP\) return false/.test(boot) && /desktopAuthStatus\(\)/.test(boot) && /configureCloudTransport\(\{ base: origin, fetch: transport \}\)/.test(boot))
    ok('未登录 / 登出时复原默认通道', /configureCloudTransport\(null\)/.test(boot))
    ok('拿不到 origin 时保持默认通道', /st\.signedIn \? await desktopOrigin\(\) : ''/.test(boot))

    const dl = read('src/lib/cloud/desktopLogin.ts')
    ok('渲染层有 origin 查询与二进制代发', /export async function desktopOrigin/.test(dl) && /export async function desktopFetchBytes/.test(dl))

    const preload = read('electron/preload.cjs')
    ok('preload 暴露 origin', /origin: \(\) => ipcRenderer\.invoke\('auth:desktopOrigin'\)/.test(preload))

    const main = read('electron/main.cjs')
    ok('主进程有 origin 查询', /auth:desktopOrigin/.test(main))
    ok('主进程代发支持二进制返回', /opts\.binary/.test(main) && /base64: buf\.toString\('base64'\)/.test(main))
    ok('登录时记录 origin、登出时清掉', /saveAuthOrigin\(new URL\(baseUrl\)\.origin\)/.test(main) && /saveAuthOrigin\(''\)/.test(main))

    const client = read('src/lib/sync/syncClient.ts')
    ok('上传编排也走统一通道（不只读侧）', /cloudFetch\(\)/.test(client) && /baseOf\(\)/.test(client) && !/await fetch\(/.test(client))

    const panel = read('src/components/app/CloudSyncPanel.tsx')
    ok('桌面已登录才显示同步入口', /WEB_CLOUD \|\| \(DESKTOP && desktopSignedIn\)/.test(panel))
    ok('桌面入口走整行样式（inline）', /inline \? 'secondary' : 'icon-muted'/.test(panel))

    const sidebar = read('src/components/app/Sidebar.tsx')
    ok('侧栏挂账号与同步入口（仅桌面）',
      /\{DESKTOP && <DesktopCloudAccount \/>\}/.test(sidebar) && /\{DESKTOP && <CloudSyncPanel inline \/>\}/.test(sidebar))

    const account = read('src/components/app/DesktopCloudAccount.tsx')
    ok('登录文案写明不上传作品', /不会上传、下载或合并任何作品/.test(account))
    ok('登录/登出都重配通道并广播', (account.match(/configureDesktopTransportIfSignedIn/g) || []).length >= 2
      && /DESKTOP_ACCOUNT_EVENT/.test(account))

    // ⑤ 同源校验（服务端）与退出前提示（客户端）
    const idx = read('server/index.mjs')
    ok('写请求做同源校验', /function sameOriginWriteOk/.test(idx) && /请求来源不被信任/.test(idx))
    ok('Bearer / 无 Origin 请求豁免', /startsWith\('Bearer '\)/.test(idx) && /if \(origin\) return accept\(origin\)/.test(idx))

    const appSrc = read('src/App.tsx')
    ok('退出项目前提示未同步内容', /还有未同步的内容/.test(appSrc) && /ctl\.stateOf\(pid\)/.test(appSrc))
    ok('退出提示只提醒、不删队列', /退出项目不会删除它们/.test(appSrc))
  }

  console.log(`\n▶ cloudTransport: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })