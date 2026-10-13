// ============ 私有网盘同步（WebDAV / S3 兼容）· 3.0.2 新增 ============
//
// 覆盖三件事：
//  ① SigV4 签名 —— 用 **AWS 官方测试向量**（aws-sig-v4-test-suite 的 get-vanilla）逐字节核对。
//     签名一错，S3 全线 403，而这是**纯计算**、最适合单测的部分；不锁死就只能靠真连对象存储才发现。
//  ② 传输三态口径 —— pull/push 在「网络失败 / 认证失败 / 不存在 / 冲突 / 损坏」下必须与
//     FileTransport 完全一致（尤其：读不到**绝不能**当空库，否则一次 push 覆盖云端真实数据）。
//  ③ 静态守卫 —— 凭据不得进同步载荷；主进程桥必须存在；路径按段编码等。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHmac, createHash } from 'node:crypto'

const read = (rel: string) => {
  const p = path.join(process.cwd(), rel)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// 直接把主进程内核加载进来测（它是纯 CJS、无 Electron 依赖 —— 见 design：故意不 require('electron')）。
// 🔴 不能用打包后的 `require`：本文件被 esbuild 打成 ESM，动态 require 会被拒（crypto 加载不了）。
//    故走 Node 原生 createRequire 从磁盘真实加载 CJS 模块。
const nodeRequire = createRequire(import.meta.url)
const remote = nodeRequire(path.join(process.cwd(), 'electron/remoteSync.cjs')) as {
  signS3: (p: Record<string, unknown>) => Record<string, string>
  signV4ForTest: (p: Record<string, unknown>) => Record<string, string>
  encodePath: (p: string) => string
}

// ---------- ① SigV4 官方测试向量（aws-sig-v4-test-suite · get-vanilla）----------
// 出处：AWS 官方 aws-sig-v4-test-suite/get-vanilla
//   固定时间 2015-08-30T12:36:00Z，region us-east-1，service service。
// 🔴 该用例的规范头集**只有 host;x-amz-date**（不含 x-amz-content-sha256）——
//    这正是必须用 signV4ForTest（调用方完全控制头集）而非 signS3 的原因：
//    signS3 会强制补 content-sha 头（S3 要求），拿它对照官方向量只会自己和自己比。
{
  const emptyHash = createHash('sha256').update('').digest('hex')
  const out = remote.signV4ForTest({
    method: 'GET',
    url: 'https://example.amazonaws.com/',
    headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
    payloadHash: emptyHash,
    accessKey: 'AKIDEXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 'service',
    now: new Date('2015-08-30T12:36:00Z'),
  })
  const auth = String(out.Authorization || '')
  ok('SigV4 · 官方向量(get-vanilla)签名值逐字节一致',
    /Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31/.test(auth), auth)
  ok('SigV4 · Credential 作用域正确',
    /Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request/.test(auth), auth)
  ok('SigV4 · SignedHeaders 与输入头集一致（host;x-amz-date）',
    /SignedHeaders=host;x-amz-date/.test(auth), auth)
}

// ---------- ①a S3 形态签名（补 x-amz-content-sha256，S3 必需）----------
// 官方 get-vanilla 不含该头；S3 却要求它 —— 单独锁死这条**策略差异**，防止将来误删。
{
  const out = remote.signS3({
    method: 'GET', url: 'https://example.amazonaws.com/', headers: {},
    payload: null, accessKey: 'AKIDEXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1', service: 'service', now: new Date('2015-08-30T12:36:00Z'),
  })
  ok('SigV4 · S3 形态含 x-amz-content-sha256（与 get-vanilla 头集不同是**有意**的）',
    /SignedHeaders=host;x-amz-content-sha256;x-amz-date/.test(out.Authorization), out.Authorization)
  ok('SigV4 · S3 形态 x-amz-date 按 YYYYMMDDTHHMMSSZ 格式', out['x-amz-date'] === '20150830T123600Z', String(out['x-amz-date']))
}

// 负面对照：密钥改一个字符 → 签名必须变（证明测试真的在校验密钥，而不是恒返回常量）
{
  const base = {
    method: 'GET', url: 'https://example.amazonaws.com/', headers: { host: 'example.amazonaws.com' },
    payload: null, accessKey: 'AKIDEXAMPLE', region: 'us-east-1', service: 'service',
    now: new Date('2015-08-30T12:36:00Z'),
  }
  const a = remote.signS3({ ...base, secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }).Authorization
  const b = remote.signS3({ ...base, secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEZ' }).Authorization
  ok('SigV4 · 负面对照：换密钥 ⇒ 签名不同', a !== b)
}

// 手写独立实现对照（防「实现与向量一起改错」）：用另一套代码路径复算 get-vanilla
{
  const host = 'example.amazonaws.com'
  const amzDate = '20150830T123600Z'
  const dateStamp = '20150830'
  const emptyHash = createHash('sha256').update('').digest('hex')
  const signed = 'host;x-amz-date'
  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`
  const canonicalRequest = `GET\n/\n\n${canonicalHeaders}\n${signed}\n${emptyHash}`
  const scope = `${dateStamp}/us-east-1/service/aws4_request`
  const sts = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash('sha256').update(canonicalRequest).digest('hex')}`
  let k: Buffer = Buffer.from('AWS4wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', 'utf-8')
  for (const part of [dateStamp, 'us-east-1', 'service', 'aws4_request']) k = createHmac('sha256', k).update(part).digest()
  const expected = createHmac('sha256', k).update(sts).digest('hex')
  const got = remote.signV4ForTest({
    method: 'GET', url: 'https://example.amazonaws.com/',
    headers: { host, 'x-amz-date': amzDate }, payloadHash: emptyHash,
    accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1', service: 'service', now: new Date('2015-08-30T12:36:00Z'),
  }).Authorization
  ok('SigV4 · 独立实现对照一致（防实现与向量同错）', got.includes('Signature=' + expected), expected)
}

// ---------- ①b 路径编码（对象键可能含中文 / 空格）----------
{
  ok('encodePath · 保留分隔斜杠、编码中文',
    remote.encodePath('/bucket/青春幻想引擎-同步数据.yfe') === '/bucket/' + encodeURIComponent('青春幻想引擎-同步数据.yfe'),
    remote.encodePath('/bucket/青春幻想引擎-同步数据.yfe'))
  ok('encodePath · 不二次编码已转义段（%20 保持）', remote.encodePath('/a/%20/b') === '/a/%20/b', remote.encodePath('/a/%20/b'))
  ok('encodePath · 空格 / 括号正确转义',
    remote.encodePath('/a b(c)') === '/a%20b%28c%29', remote.encodePath('/a b(c)'))
}

// ---------- ② 传输三态口径（静态审查渲染层源码纪律）----------
{
  const wd = read('src/lib/sync/webdavTransport.ts')
  const s3 = read('src/lib/sync/s3Transport.ts')
  const tr = read('src/lib/sync/syncTransport.ts')

  ok('WebDAV · 读失败 / 认证失败返回 status 0（绝不当空库）',
    /if \(!r\.ok\) return \{ status: 0 \}/.test(wd) && /auth/.test(wd))
  ok('WebDAV · 404 / 204 视为空库（status 200 + rev 0）',
    /status === 404 \|\| status === 204\) return \{ ok: true, text: null \}/.test(wd))
  ok('WebDAV · pull 里 corrupt 走 quarantine 而非 rev=0',
    /'corrupt' in p\) \{\s*\n\s*await quarantine/.test(wd))
  ok('WebDAV · push 读不到远端就不写（status 0）',
    /async push\(baseRev: number, enc: string\)[\s\S]{0,400}?if \(!r\.ok\) return \{ status: 0 \}/.test(wd))
  ok('WebDAV · push 冲突（远端更新）返回 409 并带上 enc', /cur\.rev > baseRev\) return \{ status: 409, rev: cur\.rev, enc: cur\.enc \}/.test(wd))
  ok('WebDAV · 写后回读校验（rev 不一致按 409）', /a\.rev !== newRev\) return \{ status: 409/.test(wd))
  ok('WebDAV · startWatch 读失败本轮跳过、不更新 lastSeenRev',
    /if \(!r\.ok\) return \/\/ 读失败：本轮跳过/.test(wd))

  ok('S3 · 404 视为空库（status 200 + rev 0 + enc null）', /st === 404\) return \{ status: 200, rev: 0, enc: null \}/.test(s3))
  ok('S3 · 非 404 的 4xx/5xx 返回 status 0', /if \(st >= 400\) return \{ status: 0 \}/.test(s3))
  ok('S3 · push 读不到 / 认证失败就不写', /if \(!r\.ok\) return \{ status: 0 \}/.test(s3))
  ok('S3 · push 冲突返回 409', /cur\.rev > baseRev\) return \{ status: 409, rev: cur\.rev, enc: cur\.enc \}/.test(s3))
  ok('S3 · 写后回读校验', /ast >= 400\) return \{ status: 0 \}/.test(s3) && /a\.rev !== newRev\) return \{ status: 409/.test(s3))

  // 两种新传输都实现同一 SyncTransport 接口
  ok('WebDAV · 实现 SyncTransport（mode/pull/push/startWatch/stopWatch）',
    /export function createWebdavTransport\(cfg: WebdavConfig\): SyncTransport/.test(wd))
  ok('S3 · 实现 SyncTransport', /export function createS3Transport\(cfg: S3Config\): SyncTransport/.test(s3))

  // mode 类型仍是 'none' | 'file'（复用 syncCore，不改数据语义）
  ok('SyncTransport.mode 未扩展（复用既有语义）', /mode: 'none' \| 'file'/.test(tr))
}

// ---------- ③ 主进程桥 + 凭据不外泄 ----------
{
  const main = read('electron/main.cjs')
  const preload = read('electron/preload.cjs')
  const remoteSrc = read('electron/remoteSync.cjs')
  const dcs = read('src/lib/sync/desktopCloudSync.ts')
  const core = read('src/lib/sync/syncCore.ts')

  ok('主进程 · 注册 cloud:webdav / cloud:s3 两条 IPC', /ipcMain\.handle\('cloud:webdav'/.test(main) && /ipcMain\.handle\('cloud:s3'/.test(main))
  ok('preload · 暴露 webdav / s3 桥', /webdav: \(url, init\)/.test(preload) && /s3: \(spec\)/.test(preload))
  ok('主进程内核 · 只允许 http/https（拒 file:）', /不许的协议|不允许的协议/.test(remoteSrc) && /u\.protocol !== 'http:'/.test(remoteSrc))
  ok('主进程内核 · 剔除 cookie/referer/origin/host', /lk === 'cookie' \|\| lk === 'referer'/.test(remoteSrc))
  ok('主进程内核 · 有超时与大小上限', /REQ_TIMEOUT_MS/.test(remoteSrc) && /MAX_BYTES/.test(remoteSrc))
  ok('主进程内核 · 永不 throw（结构化结果）', /function fail\(/.test(remoteSrc))

  // 🔴🔴 凭据必须存 localStorage（本机专属、永不进同步载荷），绝不放 meta / 整库 JSON
  ok('🔴🔴 凭据存 localStorage（不进同步载荷）',
    /localStorage\.setItem\(key, JSON\.stringify\(value\)\)/.test(dcs) && /const WEBDAV_KEY = 'yfe-sync-webdav'/.test(dcs))
  ok('🔴🔴 凭据键不在 meta（不落整库 JSON）', !/setMeta\(WEBDAV_KEY/.test(dcs) && !/setMeta\(S3_KEY/.test(dcs))
  ok('🔴 syncCore 排除表未被滥用（该机制仍只服务 meta）', !/app\.sync\.webdav/.test(core))
  ok('关闭同步会清凭据（不残留）', /clearRemoteConfig/.test(dcs))

  // 模式持久化（向后兼容旧用户：缺省 'dir'）
  ok('模式缺省 dir（旧用户无缝升级）', /return m === 'webdav' \|\| m === 's3' \? m : 'dir'/.test(dcs))
}

// ---------- ③b UI / db 入口接线 ----------
{
  const ui = read('src/components/app/CloudFileSyncBar.tsx')
  const core = read('src/lib/db/core.ts')

  ok('UI · 三档模式选择（目录 / WebDAV / S3）', /目录中转/.test(ui) && /WebDAV/.test(ui) && /S3 兼容/.test(ui))
  ok('UI · 两个新表单都有「测试连接」', (ui.match(/测试连接/g) ?? []).length >= 2)
  ok('UI · 测试连接在开启前把关（未测过不许开）', /if \(!tested\) \{ showToast/.test(ui))
  ok('db 入口 · enableDesktopCloudSync 支持 mode 参数', /enableDesktopCloudSync\(handle: SyncDirHandle \| null, mode: SyncMode = 'dir'\)/.test(core))
  ok('db 入口 · 持久化带 mode', /persistDesktopCloudEnabled\(handle, mode\)/.test(core))
}

console.log(`\n${fail === 0 ? '✅' : '❌'} privateCloudSync: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
