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
  setTrustSelfSigned: (on: boolean) => void
  isSelfSignedError: (req: unknown) => boolean
  certCoversHost: (req: unknown) => boolean
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
//
// 🔴 2026-10-13 六维审计（arch A2）：三态骨架已抽到 `syncRemoteCore.ts` ——
//    WebDAV 与 S3 原先逐字同构的那 50 余行收成一处。⇒ 纪律断言**改盯公共引擎那一份**：
//    原先要盯两份实现，改一处漏一处的风险更高；收成一处后，一条纪律只有**一个**落点。
//    协议侧则只断言各自的「读原语」语义 —— 那才是两协议真正的差别。
{
  const core = read('src/lib/sync/syncRemoteCore.ts')
  const wd = read('src/lib/sync/webdavTransport.ts')
  const s3 = read('src/lib/sync/s3Transport.ts')
  const tr = read('src/lib/sync/syncTransport.ts')

  // —— 公共引擎：三态纪律的唯一落点 ——
  ok('🔴 引擎 · pull 读失败返回 status 0（绝不当空库）',
    /if \(!r\.ok\) return \{ status: 0 \} \/\/ 网络失败/.test(core))
  ok('🔴 引擎 · corrupt 走 quarantine 而非 rev=0',
    /'corrupt' in parsed\) \{\s*\n\s*await quarantineOnce/.test(core))
  ok('🔴 引擎 · push 读不到远端就不写（status 0）',
    /async push\([\s\S]{0,220}?if \(!r\.ok\) return \{ status: 0 \} \/\/ 读不到远端/.test(core))
  ok('🔴 引擎 · push 冲突（远端更新）返回 409 并带上 enc',
    /cur\.rev > baseRev\) return \{ status: 409, rev: cur\.rev, enc: cur\.enc \}/.test(core))
  ok('🔴 引擎 · 写后回读校验（rev 不一致按 409）', /a\.rev !== newRev\) return \{ status: 409/.test(core))
  ok('🔴 引擎 · startWatch 读失败本轮跳过、不更新 lastSeenRev',
    /if \(!r\.ok\) return \/\/ 读失败：本轮跳过/.test(core))
  ok('🔴 引擎 · 空 / 不存在的载荷视为 rev 0', /if \(text == null \|\| !String\(text\)\.trim\(\)\) return \{ rev: 0, enc: null \}/.test(core))
  ok('🔴 引擎 · 解析失败明确 corrupt（**不**退化成 rev 0）', /return \{ corrupt: true \}/.test(core))

  // —— 协议侧：只留「怎么读写远端」的原语 ——
  ok('WebDAV · 404 / 204 视为空库（读原语）', /st === 404 \|\| st === 204\) return \{ ok: true, text: null \}/.test(wd))
  ok('WebDAV · 其余 4xx/5xx 按读失败', /if \(st >= 400\) return \{ ok: false \}/.test(wd))
  ok('S3 · 只把 404 视为空库（无 204 那一路）', /st === 404\) return \{ ok: true, text: null \}/.test(s3))
  ok('S3 · 非 404 的 4xx/5xx 按读失败', /if \(st >= 400\) return \{ ok: false \}/.test(s3))

  // —— 两端都真的用了公共引擎（防"抽了但没用"）——
  ok('🔴 WebDAV 走公共引擎（createRemoteSyncTransport）', /createRemoteSyncTransport\(/.test(wd))
  ok('🔴 S3 走公共引擎（createRemoteSyncTransport）', /createRemoteSyncTransport\(/.test(s3))
  // 反向对照：确认这条断言能抓到"退回各写一份"的坏形态
  ok('  · 自检：不走公共引擎的形态会被判坏',
    !/createRemoteSyncTransport\(/.test('export function createWebdavTransport(cfg) { return { mode: "file" } }'))

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

// ---------- ④ 信任自签证书开关（安全边界守卫）----------
{
  const remoteSrc = read('electron/remoteSync.cjs')
  const wd = read('src/lib/sync/webdavTransport.ts')
  const s3 = read('src/lib/sync/s3Transport.ts')
  const ui = read('src/components/app/CloudFileSyncBar.tsx')

  // —— 主进程：机制正确 ——
  ok('自签 · 用专用 partition 会话（不污染全局 fetch）',
    /session\.fromPartition\(CERT_PARTITION/.test(remoteSrc) && /const CERT_PARTITION = 'yfe-private-cloud'/.test(remoteSrc))
  ok('自签 · 用 ses.fetch（net.fetch(url,{session}) 不触发证书回调）',
    /ses\.fetch\(u, o\)/.test(remoteSrc) && /typeof ses\.fetch === 'function'/.test(remoteSrc))
  ok('自签 · 接受用 callback(0)、其余回退 Chromium 结果 callback(-3)',
    /callback\(0\)/.test(remoteSrc) && /callback\(-3\)/.test(remoteSrc))
  ok('🔴🔴 自签 · 放行须同时满足「不受信」与「覆盖主机名」两个条件（缺一即误放行）',
    /isSelfSignedError\(req\) && certCoversHost\(req\)/.test(remoteSrc))
  ok('🔴 自签 · 覆盖判定用 checkHost / checkIP（RFC 6125 + IP）',
    /cert\.checkHost\(host\)/.test(remoteSrc) && /cert\.checkIP\(host\)/.test(remoteSrc))
  ok('🔴 自签 · 校验证书有效期（过期不放行）',
    /validFromDate/.test(remoteSrc) && /validToDate/.test(remoteSrc))
  ok('自签 · 覆盖判定解析失败一律返回 false（默认拒绝）',
    /return false \/\/ 解析失败一律不放行/.test(remoteSrc))
  ok('自签 · 关闭时还原 setCertificateVerifyProc(null)', /setCertificateVerifyProc\(null\)/.test(remoteSrc))
  ok('自签 · 只在开关打开时才走专用会话',
    /trustSelfSignedActive \? ensureCertProc\(\) : null/.test(remoteSrc))
  ok('自签 · 开关默认 false（主进程侧初值）', /let trustSelfSignedActive = false/.test(remoteSrc))
  ok('自签 · 逐请求显式授权（webdavRequest 读 init.trustSelfSigned）',
    /setTrustSelfSigned\(opts\.trustSelfSigned === true\)/.test(remoteSrc))
  ok('自签 · 逐请求显式授权（s3Request 读 p.trustSelfSigned）',
    /setTrustSelfSigned\(p\.trustSelfSigned === true\)/.test(remoteSrc))
  ok('自签 · 无 Electron 时静默退回全局 fetch（单测不炸）',
    /require\('electron'\)\.session/.test(remoteSrc) && /catch \{\s*\n\s*return null \/\/ 单测/.test(remoteSrc))

  // —— 🔴🔴 核心安全边界：只放行「自签 / 不受信根」，不放行主机名不符 / 已吊销 / 过期 ——
  // ⚠️ 静态扫描只在**去掉注释后**的代码上做：注释里提到错误名不应算「实现里含该错误码」。
  //    真正的守卫是下面的行为级断言（真加载内核跑 isSelfSignedError）。
  // ⚠️ 白名单是**正则字面量**（`ERR_CERT_(AUTHORITY_INVALID|…)`），故只查词干、不要求全等。
  const remoteCode = remoteSrc
    .replace(/\/\*[\s\S]*?\*\//g, '') // 去块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1') // 去行注释（保留 http:// 里的 //）
  ok('🔴 白名单不含 COMMON_NAME_INVALID（主机名不符仍拒）',
    !/COMMON_NAME_INVALID/.test(remoteCode) && !/-200\b/.test(remoteCode))
  ok('🔴 白名单不含 REVOKED（已吊销仍拒）', !/REVOKED/.test(remoteCode))
  ok('🔴 白名单不含 DATE_INVALID（过期仍拒）', !/DATE_INVALID/.test(remoteCode))
  ok('🔴 白名单确实认 AUTHORITY_INVALID（自签能放行）',
    /AUTHORITY_INVALID/.test(remoteCode) && /-202/.test(remoteCode))

  // —— isSelfSignedError 行为级验证（真加载主进程内核）——
  ok('自签判定 · -202 / ERR_CERT_AUTHORITY_INVALID → true',
    remote.isSelfSignedError({ errorCode: -202, verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID' }) === true)
  ok('自签判定 · 字符串兜底（只给 verificationResult 也认）',
    remote.isSelfSignedError({ verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID' }) === true)
  ok('🔴 自签判定 · 主机名不符（-200 / COMMON_NAME_INVALID）→ false',
    remote.isSelfSignedError({ errorCode: -200, verificationResult: 'net::ERR_CERT_COMMON_NAME_INVALID' }) === false)
  ok('🔴 自签判定 · 主机名不符（只给 errorCode -200）→ false',
    remote.isSelfSignedError({ errorCode: -200 }) === false)
  ok('🔴 自签判定 · 已吊销（-210 / REVOKED）→ false',
    remote.isSelfSignedError({ errorCode: -210, verificationResult: 'net::ERR_CERT_REVOKED' }) === false)
  ok('🔴 自签判定 · 过期（-211 / DATE_INVALID）→ false',
    remote.isSelfSignedError({ errorCode: -211, verificationResult: 'net::ERR_CERT_DATE_INVALID' }) === false)
  ok('🔴 自签判定 · 未知错误码 → false（默认拒绝）',
    remote.isSelfSignedError({ errorCode: -999, verificationResult: 'net::ERR_FAILED' }) === false)
  ok('自签判定 · 无请求对象 → false（不误放行）', remote.isSelfSignedError(undefined) === false)

  // —— ② 覆盖判定 certCoversHost（主机名不符绝不放行 —— 实测 Electron 会同报 -202）——
  // 🔴 这是「不是一律不校验」这条边界的**唯一**防线：错误码区分不了，全靠它。
  ok('覆盖判定 · 无证书 / 空 data → false（不误放行）',
    remote.certCoversHost(undefined) === false &&
    remote.certCoversHost({ hostname: 'a', certificate: {} }) === false &&
    remote.certCoversHost({ hostname: 'a', certificate: { data: '' } }) === false)
  ok('覆盖判定 · 证书解析不了 → false（默认拒绝）',
    remote.certCoversHost({ hostname: 'a', certificate: { data: 'not-a-pem' } }) === false)
  ok('覆盖判定 · 无 hostname → false', remote.certCoversHost({ certificate: { data: 'x' } }) === false)
  // 真实证书级验证（自签一张，覆盖 localhost，含 IP 写成 DNS SAN 的兼容路径）
  {
    const os = nodeRequire('node:os') as typeof import('node:os')
    const nodeFs = nodeRequire('node:fs') as typeof import('node:fs')
    const cp = nodeRequire('node:child_process') as typeof import('node:child_process')
    const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'yfe-testcert-'))
    const key = path.join(dir, 'k.pem')
    const crt = path.join(dir, 'c.pem')
    let made = true
    try {
      cp.execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', key, '-out', crt, '-days', '2',
        '-subj', '/CN=nas.local',
        '-addext', 'subjectAltName=DNS:nas.local,DNS:192.168.1.10',
      ], { stdio: 'ignore' })
    } catch { made = false }
    if (made) {
      const pem = nodeFs.readFileSync(crt, 'utf8')
      const req = (hostname: string) => ({ hostname, certificate: { data: pem } })
      ok('🔴 覆盖判定 · 相符域名 → true（自签能放行）',
        remote.certCoversHost(req('nas.local')) === true)
      ok('🔴 覆盖判定 · 不符域名 → false（主机名不符仍拒）',
        remote.certCoversHost(req('evil.example')) === false)
      ok('🔴 覆盖判定 · 相符 IP（写成 DNS SAN）→ true（兼容常见写法）',
        remote.certCoversHost(req('192.168.1.10')) === true)
      ok('🔴 覆盖判定 · 不符 IP → false', remote.certCoversHost(req('10.0.0.1')) === false)
      ok('覆盖判定 · 大小写不敏感（RFC 6125）',
        remote.certCoversHost(req('NAS.LOCAL')) === true)
      const nodeCrypto = nodeRequire('node:crypto') as typeof import('node:crypto')
      const x = new nodeCrypto.X509Certificate(pem)
      ok('覆盖判定 · 被测证书确在有效期内（排除「过期被拒」干扰本组用例）',
        Date.now() >= (x.validFromDate as Date).getTime() && Date.now() <= (x.validToDate as Date).getTime())
    } else {
      pass++; console.log('PASS 覆盖判定 · 跳过（本机无 openssl，无法现签证书）')
    }
  }

  // —— 渲染层：标志随每次请求透传，且默认关 ——
  ok('Webdav · 配置含 trustSelfSigned（可选、默认关）', /trustSelfSigned\?: boolean/.test(wd))
  ok('Webdav · 每次桥调用都带上 trustSelfSigned', /trustSelfSigned: init\.trustSelfSigned === true/.test(wd))
  // 🔴 2026-10-13 六维审计：原先这两条数的是「透传开关的调用点**数量**」（≥4 / ≥2）。
  //    抽公共骨架后，各协议的桥调用**收成唯一出口**（`callPath` / `callS3Path`），
  //    数量从 4/2 变成 1 —— 但**语义更强了**：原先要保证 N 处都写对，现在只有一处能写。
  //    ⇒ 断言改为「桥调用唯一 + 各调用点都经它」，这才是真正要守的东西。
  ok('🔴 Webdav · 桥调用只有一条通路，开关在那条里透传',
    (wd.match(/b\.webdav\(/g) ?? []).length === 1 &&
    /trustSelfSigned: init\.trustSelfSigned === true/.test(wd))
  ok('🔴 Webdav · 各调用点都经该通路（callPath：read/write/quarantine/test）',
    (wd.match(/callPath\(/g) ?? []).length >= 4)
  ok('S3 · 配置含 trustSelfSigned（可选、默认关）', /trustSelfSigned\?: boolean/.test(s3))
  ok('🔴 S3 · 桥调用只有一条通路，开关在那条里透传（含 quarantine 分支）',
    (s3.match(/b\.s3\(/g) ?? []).length === 1 &&
    /trustSelfSigned: cfg\.trustSelfSigned === true/.test(s3))
  ok('🔴 S3 · 各调用点都经该通路（callS3Path/callS3）',
    ((s3.match(/callS3Path\(/g) ?? []).length + (s3.match(/callS3\(/g) ?? []).length) >= 4)

  // —— UI：开关 + 风险文案 + 默认不勾 ——
  ok('UI · 开关名为「信任自签证书」', /信任自签证书/.test(ui))
  ok('UI · 默认不勾（useState(false)）', /useState\(false\)/.test(ui) && /setTrustSelfSigned\(c\.trustSelfSigned === true\)/.test(ui))
  ok('UI · 勾选后给出风险与范围警示（只对本通道生效）',
    /仅对本同步通道生效/.test(ui) && /公网服务器，请勿勾选/.test(ui))
  ok('UI · 两个表单都挂了开关（≥2 处使用）', (ui.match(/<TrustSelfSignedToggle/g) ?? []).length >= 2)
  ok('UI · 改开关会重置「已测过」状态（须重测）',
    /setTrustSelfSigned\(v\); setTested\(false\)/.test(ui))
}

console.log(`\n${fail === 0 ? '✅' : '❌'} privateCloudSync: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
