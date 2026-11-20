// ============ 版本清单（version.json）· 解析与双源单测（3.6.2 W1）============
//
// 钉住四类最容易翻车的事：
//   ① 清单是**外部输入**：任何畸形结构都必须返回 null / 跳过该条，**绝不能抛**；
//   ② **未知 kind 忽略、重复 kind 取第一**（以后加新产物类型时旧客户端要能安静跳过）；
//   ③ **sha256 缺失 = 未校验**，不是"清单坏了"（否则一份手改过的清单会让下载按钮消失）；
//   ④ 双源顺序：**先自建清单，拿不到才回落 Gitee**，两条都失败静默返回 null。
import {
  normalizeSha256,
  parseVersionManifest,
  pickAsset,
  manifestToLatestRelease,
  type VersionManifest,
} from '../src/lib/app/versionManifest'
import { compareVersion, fetchLatestRelease } from '../src/lib/app/versionCheck'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const SHA = 'a'.repeat(64)

/** 一份"发布脚本应当产出"的完整清单（用作各用例的基线，逐项破坏） */
function sample(): Record<string, unknown> {
  return {
    schema: 1,
    version: 'v3.6.2',
    releasedAt: '2026-12-05T20:00:00+08:00',
    channel: 'stable',
    minSupported: '3.5.0',
    notesUrl: 'https://gitee.com/tgxy2026/youth-fantasy-engine/releases/tag/v3.6.2',
    webBuildId: 'b20261205abc',
    assets: [
      { kind: 'win-setup', name: '青春幻想引擎-Setup-3.6.2.exe', size: 99680000, sha256: SHA, url: 'https://x/dl/setup.exe' },
      { kind: 'portable-win', name: '便携版-Windows.zip', size: 3200000, sha256: SHA.toUpperCase(), url: 'https://x/dl/pw.zip' },
      { kind: 'portable-unix', name: '便携版-unix.zip', size: 3200000, sha256: SHA, url: 'https://x/dl/pu.zip' },
    ],
  }
}

// ---------- ① 合法清单 ----------
{
  const m = parseVersionManifest(sample())
  ok('合法清单 → 解析成功', m !== null)
  ok('v 前缀被去掉', m?.version === '3.6.2', m?.version ?? 'null')
  ok('schema 保留为数字', m?.schema === 1, String(m?.schema))
  ok('三个已知产物全部保留', m?.assets.length === 3, String(m?.assets.length))
  ok('大小写摘要统一转小写', m?.assets[1].sha256 === SHA, m?.assets[1].sha256)
  ok('未知字段不参与、不影响解析', parseVersionManifest({ ...sample(), extraJunk: { a: 1 } })?.version === '3.6.2')
}

// ---------- ② 结构不符 → null，绝不抛 ----------
{
  const cases: Array<[string, unknown]> = [
    ['null 入参', null],
    ['undefined 入参', undefined],
    ['字符串入参', '{"schema":1}'],
    ['数组入参', [sample()]],
    ['缺 schema', { ...sample(), schema: undefined }],
    ['schema 非数字', { ...sample(), schema: '1' }],
    ['schema 为 0', { ...sample(), schema: 0 }],
    ['schema 带小数', { ...sample(), schema: 1.5 }],
    ['缺 version', { ...sample(), version: undefined }],
    ['version 非法', { ...sample(), version: '开发版' }],
    ['assets 不是数组', { ...sample(), assets: { 0: {} } }],
    ['缺 assets', { ...sample(), assets: undefined }],
  ]
  for (const [name, input] of cases) {
    let threw = false
    let got: VersionManifest | null = null
    try { got = parseVersionManifest(input) } catch { threw = true }
    ok(`🔴 ${name} → null 且不抛`, !threw && got === null, threw ? '抛错了' : String(got))
  }
}

// ---------- ③ 产物级容错：坏一条不牵连整份 ----------
{
  const m = parseVersionManifest({
    ...sample(),
    assets: [
      { kind: 'win-setup', name: 'x.exe', size: 1, sha256: SHA, url: 'https://x/a.exe' },
      { kind: 'portable-win', name: '缺 url', size: 1, sha256: SHA },          // 无 url → 丢弃
      { kind: 'linux-appimage', name: '未来的类型', size: 1, url: 'https://x/b' }, // 未知 kind → 忽略
      { kind: 'portable-unix', name: 'ok.zip', size: -5, sha256: 'not-a-hash', url: 'https://x/c.zip' },
      null,
      'junk',
      42,
    ],
  })
  ok('缺 url 的产物被丢弃', m?.assets.some(a => a.kind === 'portable-win') === false)
  ok('未知 kind 被忽略（不报错）', m?.assets.some(a => a.kind === 'linux-appimage') === false)
  ok('坏一条不影响其它产物', m?.assets.length === 2, String(m?.assets?.length))
  const unix = m?.assets.find(a => a.kind === 'portable-unix')
  ok('非法 sha256 → 空串（未校验，不是拒绝）', unix?.sha256 === '', JSON.stringify(unix?.sha256))
  ok('负数体积 → 0（0 只表示"没给"）', unix?.size === 0, String(unix?.size))
}

{
  const m = parseVersionManifest({
    schema: 1, version: '3.6.2',
    assets: [
      { kind: 'win-setup', url: 'https://x/first.exe' },
      { kind: 'win-setup', url: 'https://x/second.exe' },
    ],
  })
  ok('重复 kind 取第一个', m?.assets.length === 1 && m?.assets[0].url === 'https://x/first.exe',
    JSON.stringify(m?.assets))
}

{
  const m = parseVersionManifest({ schema: 1, version: '3.6.2', assets: [] })
  ok('assets 空数组合法（只能给下载页）', m !== null && m.assets.length === 0)
  ok('空清单也能适配成 LatestRelease（下载直链为空串）', manifestToLatestRelease(m!).downloadUrl === '')
}

// ---------- ④ 摘要与体积字段 ----------
{
  ok('64 位 hex 小写原样', normalizeSha256(SHA) === SHA)
  ok('大写转小写', normalizeSha256(SHA.toUpperCase()) === SHA)
  ok('63 位 → 空（不补零）', normalizeSha256('a'.repeat(63)) === '')
  ok('65 位 → 空（不截断）', normalizeSha256('a'.repeat(65)) === '')
  ok('含非 hex 字符 → 空', normalizeSha256('z'.repeat(64)) === '')
  ok('数字类型 → 空（不 stringify 猜）', normalizeSha256(12345 as unknown) === '')
}

// ---------- ⑤ 超大字符串不崩 ----------
{
  const long = 'x'.repeat(2_000_000)
  let threw = false
  let m: VersionManifest | null = null
  try {
    m = parseVersionManifest({
      schema: 1, version: '3.6.2', notesUrl: long, webBuildId: long,
      assets: [{ kind: 'win-setup', name: long, url: 'https://x/a.exe' }],
    })
  } catch { threw = true }
  ok('🔴 2MB 字符串不抛', !threw)
  ok('超长 name / notesUrl 被截断', (m?.assets[0].name.length ?? 0) <= 260 && (m?.notesUrl.length ?? 0) <= 2048,
    `name=${m?.assets[0].name.length} notes=${m?.notesUrl.length}`)
}

// ---------- ⑥ minSupported / notesUrl 的降级口径 ----------
{
  ok('minSupported 非法 → 视为未设置', parseVersionManifest({ ...sample(), minSupported: '旧版本' })?.minSupported === '')
  ok('minSupported 缺失 → 空串', parseVersionManifest({ ...sample(), minSupported: undefined })?.minSupported === '')
  ok('minSupported 合法 → 标准化三段', parseVersionManifest({ ...sample(), minSupported: 'v3.5' })?.minSupported === '',
    '两段式不算合法版本')
  ok('minSupported 合法三段保留', parseVersionManifest({ ...sample(), minSupported: 'v3.5.0' })?.minSupported === '3.5.0')

  const noNotes = parseVersionManifest({ ...sample(), notesUrl: '' })!
  ok('notesUrl 缺失 → 回落 Gitee Release 页',
    manifestToLatestRelease(noNotes).releaseUrl.includes('gitee.com/tgxy2026/youth-fantasy-engine/releases'),
    manifestToLatestRelease(noNotes).releaseUrl)
  const withNotes = parseVersionManifest(sample())!
  ok('notesUrl 存在 → 原样采用', manifestToLatestRelease(withNotes).releaseUrl === sample().notesUrl)
}

// ---------- ⑦ pickAsset ----------
{
  const m = parseVersionManifest(sample())!
  ok('按 kind 取到 Setup', pickAsset(m, 'win-setup')?.url === 'https://x/dl/setup.exe')
  ok('没有该 kind → null', pickAsset({ ...m, assets: [] }, 'win-setup') === null)
  ok('manifestToLatestRelease 只认 win-setup 作自动下载',
    manifestToLatestRelease(m).downloadUrl === 'https://x/dl/setup.exe',
    manifestToLatestRelease(m).downloadUrl)
  ok('清单无 Setup 时下载直链为空（界面应给下载页）',
    manifestToLatestRelease({ ...m, assets: m.assets.filter(a => a.kind !== 'win-setup') }).downloadUrl === '')
}

// ---------- ⑧ 双源顺序与回落（替换全局 fetch） ----------
type Stub = (url: string) => { ok?: boolean; body: string } | Promise<{ ok?: boolean; body: string }>
const realFetch = globalThis.fetch
function stubFetch(handler: Stub) {
  const calls: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input)
    calls.push(url)
    const r = await handler(url)
    return { ok: r.ok ?? true, status: r.ok === false ? 404 : 200, text: async () => r.body } as unknown as Response
  }) as typeof fetch
  return calls
}
const restoreFetch = () => { globalThis.fetch = realFetch }

{
  // 清单成功 → 不该再去查 Gitee
  const calls = stubFetch(url => url.includes('version.json')
    ? { body: JSON.stringify(sample()) }
    : { body: JSON.stringify({ tag_name: 'v9.9.9', assets: [] }) })
  const r = await fetchLatestRelease()
  restoreFetch()
  ok('清单可用 → 采用清单版本', r?.version === '3.6.2', r?.version ?? 'null')
  ok('清单可用 → 拿清单里的 Setup 直链', r?.downloadUrl === 'https://x/dl/setup.exe', r?.downloadUrl ?? '')
  ok('清单可用 → 不再请求 Gitee（省一次限流额度）', calls.filter(c => c.includes('gitee.com')).length === 0,
    calls.join(' | '))
}

{
  // 清单 404（返回 HTML）→ 回落 Gitee，字段与改动前一致
  const calls = stubFetch(url => url.includes('version.json')
    ? { ok: false, body: '<html>404</html>' }
    : { body: JSON.stringify({ tag_name: 'v3.6.3', name: '青春幻想引擎 3.6.3', body: '说明', assets: [{ name: 'a-Setup.exe', browser_download_url: 'https://g/a.exe' }] }) })
  const r = await fetchLatestRelease()
  restoreFetch()
  ok('清单坏 → 回落 Gitee 且拿到版本', r?.version === '3.6.3', r?.version ?? 'null')
  ok('回落时 name/body 与 Gitee 原口径一致', r?.name === '青春幻想引擎 3.6.3' && r?.body === '说明',
    `${r?.name} | ${r?.body}`)
  ok('回落时 Setup 直链来自 Gitee assets', r?.downloadUrl === 'https://g/a.exe', r?.downloadUrl ?? '')
  ok('两条通道都被请求过', calls.length === 2, calls.join(' | '))
}

{
  // 两条都失败 → null（静默）
  stubFetch(() => ({ ok: false, body: 'boom' }))
  const r = await fetchLatestRelease()
  restoreFetch()
  ok('🔴 双源都失败 → null（静默，不抛）', r === null, String(r))
}

{
  // 网络直接抛错也不能冒出去
  globalThis.fetch = (async () => { throw new Error('offline') }) as typeof fetch
  let threw = false
  let r: unknown = 'sentinel'
  try { r = await fetchLatestRelease() } catch { threw = true }
  restoreFetch()
  ok('🔴 断网（fetch 抛错）→ null 且不冒泡', !threw && r === null, threw ? '抛错了' : String(r))
}

// ---------- ⑨ 清单版本低于当前 → 不提示更新 ----------
{
  const m = parseVersionManifest({ schema: 1, version: '3.6.0', assets: [] })!
  ok('清单版本低于当前 3.6.2 → 比较结果为 -1（不提示）', compareVersion(m.version, '3.6.2') === -1,
    String(compareVersion(m.version, '3.6.2')))
  ok('清单版本高于当前 → 1（提示）', compareVersion('3.6.3', '3.6.2') === 1)
  ok('清单版本等于当前 → 0（不提示）', compareVersion('3.6.2', '3.6.2') === 0)
}

// ---------- ⑩ 源码闸：兜底通道不许被"清理"掉 ----------
{
  const fsNode = await import('node:fs')
  const pathNode = await import('node:path')
  const root = [process.cwd(), pathNode.join(process.cwd(), '..')]
    .find(c => fsNode.existsSync(pathNode.join(c, 'package.json'))) ?? ''
  const src = fsNode.readFileSync(pathNode.join(root, 'src/lib/app/versionCheck.ts'), 'utf8')
  ok('🔴 源码闸：Gitee 兜底函数仍在（防止被当死代码删掉）', src.includes('fetchLatestReleaseGitee'),
    '缺 fetchLatestReleaseGitee')
  ok('🔴 源码闸：顺序是「先清单、后 Gitee」',
    /\(await fetchManifest\(\)\) \?\? \(await fetchLatestReleaseGitee\(\)\)/.test(src),
    '双源顺序被改了：先查 Gitee 就永远用不上摘要校验')
  ok('源码闸：清单地址来自 downloadLinks 的站点常量（不散落硬编码域名）',
    src.includes('VERSION_MANIFEST_URL') && !/https:\/\/youth-fantasy-engine\.online\/version\.json/.test(src))
}

console.log(`\nversionManifest: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
