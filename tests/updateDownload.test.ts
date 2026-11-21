// ============ 应用内下载安装包 · 防回归闸（纯静态；只读仓库内文件，零 IO）============
//
// 背景（2026-10-07 · 2.9.0）：把「检查更新」的终点从「开系统浏览器」升级为
//   「应用内下载到「下载」文件夹 → 自动拉起安装向导」。主人拍板口径见
//   docs/2.9.0-应用内更新下载-设计与验证.md。
//
// 这条闸守的是**六个最容易被人无意改回去的点**：
//   ① 🔴 **只有用户点按钮才下载** —— 自动检查只查版本号，绝不顺带下载、绝不自动安装；
//   ② 🔴 **落盘目录由主进程钉死在「下载」文件夹** —— 渲染层不能指定路径（否则等于给了任意写盘口子）；
//   ③ 🔴 **文件名在主进程清洗**（只取 basename + 强制 .exe）—— 防路径穿越；
//   ④ 🔴 **先写 .part 再改名** —— 中断不会留下半截 .exe 被用户误当成品双击；
//   ⑤ 大小比对与 HTML 兜底页拦截仍在（Gitee 要求登录时会回 HTML，存成 .exe 会害人）；
//   ⑥ 拉起安装器前**再校验一次路径**（只在下载文件夹里、.exe、真实存在）—— 不能变成「执行任意 exe」。
//
// 🔴 为什么主体仍用「读源码」而不是「跑函数」：真实下载要联网、写「下载」文件夹、几分钟，
//    不适合放进单测批次；这一层只钉住**结构与边界**。
// ⚠️ 3.6.2 例外：摘要校验的**失败路径**（不符时删不删 .part、未给摘要时标不标 verified）
//    必须真跑才看得准，故 ⑧ 段起一个**本地回环小服务**、载荷几 KB、写临时目录 ——
//    毫秒级、不联网、不碰真实「下载」文件夹。
import * as fs from 'fs'
import * as path from 'path'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 仓库根（单测可能从仓库根或 tests/ 起跑） */
function repoRoot(): string {
  for (const c of [process.cwd(), path.join(process.cwd(), '..')]) {
    if (fs.existsSync(path.join(c, 'package.json'))) return c
  }
  return ''
}

async function main() {
  const root = repoRoot()
  ok('定位仓库根', !!root, 'cwd=' + process.cwd())
  if (!root) { console.log(`\n通过 ${pass} / 失败 ${fail}`); process.exit(1) }

  const read = (p: string) => {
    try { return fs.readFileSync(path.join(root, p), 'utf8') } catch { return '' }
  }

  const core = read('electron/updateDownload.cjs')   // 下载内核
  const main = read('electron/main.cjs')             // IPC 注册
  const preload = read('electron/preload.cjs')       // 桥暴露
  const desktop = read('src/lib/app/desktop.ts')         // 渲染层封装
  const dialog = read('src/components/app/UpdateDialog.tsx')
  const vcheck = read('src/lib/app/versionCheck.ts')

  /* ---------- 0. 文件都在 ---------- */
  ok('① 下载内核 electron/updateDownload.cjs 存在', core.length > 0)
  ok('① UpdateDialog 存在', dialog.length > 0)

  /* ---------- ① 只有用户点按钮才下载 ---------- */
  ok('① 下载入口唯一：startDownload 只被两处按钮 onClick 调用',
    (dialog.match(/void startDownload\(\)/g) || []).length === 2,
    String((dialog.match(/void startDownload\(\)/g) || []).length))
  // 自动检查那条链路（versionCheck.ts）不得引用任何下载/安装 API ⇒ 检查更新只会「查版本号」
  const banned = ['downloadInstallerPackage', 'launchInstallerPackage', 'quitAppForInstall', 'electronUpdate']
  const leaked = banned.filter(b => vcheck.includes(b))
  ok('① versionCheck 不引用任何下载/安装 API（自动检查只查版本号）', leaked.length === 0, leaked.join(', '))
  ok('① 修订后的口径写进了 versionCheck 顶部注释',
    vcheck.includes('自动检查绝不下载任何东西') && vcheck.includes('下载必须由作者点按钮触发'))

  /* ---------- ② 落盘目录由主进程钉死 ---------- */
  ok('② main.cjs 下载目录取 app.getPath(\'downloads\')', /dir:\s*app\.getPath\('downloads'\)/.test(main))
  // 3.6.2 起签名多了第三个可选参数（期望摘要），但仍**没有目录参数** —— 钉住这一点，别让"顺手加个 dir"溜进来
  ok('② 渲染层拿不到「目标目录」参数（download 只收 url + fileName + 可选摘要）',
    /download\(url: string, fileName: string, expectedSha256\?: string\)/.test(desktop)
    && !/download\([^)]*dir\s*:/.test(desktop))

  /* ---------- ③ 文件名清洗 + ④ .part 暂存 ---------- */
  ok('③ 内核有文件名清洗函数（只取 basename + 强制 .exe）',
    core.includes('function sanitizeInstallerName') && /\\\.exe\$\/i\.test\(cleaned\)/.test(core))
  ok('③ basename 提取按路径分隔符切（防穿越）', core.includes("split(/[\\\\/]/).pop()"))
  ok('④ 用 .part 暂存后 rename（不留半截 .exe）',
    core.includes("const part = dest + '.part'") && core.includes('fs.renameSync(part, dest)'))

  /* ---------- ⑤ 大小比对 + HTML 兜底页拦截 ---------- */
  // ⑤ 兜底页拦截：以**文件头**为准（实测 Gitee 的网页是 text/plain ⇒ 按 content-type 判不准）
  ok('⑤ 拦截兜底页：以 PE 文件头 MZ 为准（不是查 content-type）',
    core.includes('function looksLikeExe') && core.includes('head[0] === 0x4d') && core.includes('head[1] === 0x5a'))
  ok('⑤ 兜底页拦截确实接在落盘前（MZ 不过就丢弃 .part）',
    /if \(!looksLikeExe\(part\)\)/.test(core))
  ok('⑤ 不再依赖 content-type 黑名单（会被 text/plain 绕过）',
    !core.includes("ctype.includes('text/html')"))
  ok('⑤ 只放行 http/https', core.includes("target.protocol !== 'http:'") && core.includes("!== 'https:'"))

  /* ---------- ⑥ 拉起安装器前再校验路径 ---------- */
  ok('⑥ main.cjs 有 isDownloadedInstaller 前置校验（下载文件夹内 + .exe + 真实存在）',
    main.includes('const isDownloadedInstaller') &&
    main.includes("app.getPath('downloads')") &&
    /\\\.exe\$\/i\.test\(abs\)/.test(main) &&
    main.includes('fs.statSync(abs).isFile()'))
  const guardUses = (main.match(/isDownloadedInstaller\(/g) || []).length
  ok('⑥ 拉起与定位两个口子都过这道校验（2 处调用）', guardUses >= 2, String(guardUses))

  /* ---------- IPC 通道与桥 ---------- */
  const chans = ['update:download', 'update:cancel', 'update:launch-installer', 'update:reveal-file', 'app:quit']
  const missing = chans.filter(c => !main.includes(`ipcMain.handle('${c}'`))
  ok('IPC 五个通道都在 main.cjs 注册', missing.length === 0, '缺: ' + missing.join(', '))
  const exposed = ['download:', 'cancel:', 'launchInstaller:', 'revealFile:', 'quitApp:', 'onProgress:']
  const missExp = exposed.filter(k => !preload.includes(k))
  ok('preload 暴露 electronUpdate（5 方法 + 进度订阅）',
    preload.includes("exposeInMainWorld('electronUpdate'") && missExp.length === 0, '缺: ' + missExp.join(', '))

  /* ---------- 渲染层封装：永不抛 ---------- */
  ok('desktop.ts 有 HAS_UPDATE_BRIDGE 探测', desktop.includes('export const HAS_UPDATE_BRIDGE'))
  const wrappers = ['downloadInstallerPackage', 'cancelInstallerDownload', 'launchInstallerPackage', 'revealInstallerFile', 'quitAppForInstall']
  const missWrap = wrappers.filter(w => !desktop.includes(`export async function ${w}`))
  ok('desktop.ts 五个封装函数都在', missWrap.length === 0, '缺: ' + missWrap.join(', '))
  ok('desktop.ts 无 electronUpdate 桥时返回 ok:false（不抛）',
    desktop.includes('当前版本没有「应用内下载」能力'))

  /* ---------- 弹窗：状态机 + 兜底 ---------- */
  const phases = ['idle', 'downloading', 'launching', 'launched', 'error']
  const missPh = phases.filter(p => !new RegExp(`kind: '${p}'`).test(dialog))
  ok('弹窗有五个阶段（idle/downloading/launching/launched/error）', missPh.length === 0, '缺: ' + missPh.join(', '))
  ok('弹窗有进度条与取消下载', dialog.includes('取消下载') && dialog.includes('overflow-hidden rounded-full'))
  ok('弹窗失败时保留夸克网盘兜底', dialog.includes('QUARK_URL') && dialog.includes('夸克网盘'))
  ok('弹窗下载中禁止关闭（避免用户以为取消其实还在下）',
    dialog.includes('onClose={downloading ? () => {} : onClose}'))
  ok('弹窗不擅自退出本程序（closeApp 传 false，由作者点「关闭本程序」）',
    dialog.includes('launchInstallerPackage(r.path, false)') && dialog.includes('quitAppForInstall'))
  ok('弹窗不下载到用户没预期的地方：文案明说落在「下载」文件夹',
    dialog.includes('「下载」文件夹'))

  /* ---------- UI 铁律 ---------- */
  ok('弹窗不用原生弹窗（prompt/confirm/alert）',
    !/window\.(prompt|confirm|alert)/.test(dialog))
  // ⚠️ 只看**真实注入写法**，不看注释 —— 本文件的注释里就写着「绝不用 innerHTML」，
  //    早先用 includes('innerHTML') 自查时被自己这句注释判红过（自伤，与 tavernWindow 那次的坑同款）。
  ok('弹窗不注入 HTML（外部输入只走文本节点）',
    !dialog.includes('dangerouslySetInnerHTML') && !/\.innerHTML\s*=/.test(dialog))
  ok('弹窗高度走 foldVh（界面缩放不溢出）', dialog.includes('foldVh('))
  ok('进度订阅有卸载守卫（长任务回来时组件可能已卸载）', dialog.includes('alive.current'))

  /* ---------- ⑦ 3.6.2 · 摘要校验（静态结构） ---------- */
  ok('⑦ 内核有摘要规范化（只认 64 位 hex，其它一律视为未提供）',
    core.includes('function normalizeExpectedSha256') && core.includes('s.length !== 64'))
  ok('⑦ 摘要是「边下边算」（Transform 里 update），不是下完再读一遍盘',
    /if \(hasher\) hasher\.update\(chunk\)/.test(core))
  ok('⑦ 不符时返回 reason: sha256-mismatch', core.includes("reason: 'sha256-mismatch'"))
  ok('⑦ 不符时删掉 .part（不留坏包让用户双击）',
    /reason: 'sha256-mismatch'/.test(core) && (core.match(/fs\.unlinkSync\(part\)/g) || []).length >= 4)
  ok('⑦ 未提供摘要时结果标 verified:false（不假装校验过）',
    core.includes('let verified = false') && /return \{ ok: true, path: dest, size: counted, verified \}/.test(core))
  ok('⑦ main.cjs 透传 expectedSha256', /update:download', async \(e, url, fileName, expectedSha256\)/.test(main))
  ok('⑦ preload 桥三参数透传', /download: \(url, fileName, expectedSha256\)/.test(preload))
  ok('⑦ desktop 封装透传（空串表示不校验）', desktop.includes("api.download(url, fileName, expectedSha256 ?? '')"))
  ok('⑦ 弹窗点下载前就写清「已校验 / 未校验」', dialog.includes('安装包完整性：') && dialog.includes('未校验（清单未提供摘要'))
  ok('⑦ 弹窗下载完成态也标明是否校验过', dialog.includes('已校验（sha256 与清单一致）'))
  ok('⑦ 失败给三条出路：重试 / 换网盘 / 复制下载页',
    dialog.includes('重试') && dialog.includes('夸克网盘') && dialog.includes('复制下载页'))

  /* ---------- ⑧ 3.6.2 · 真实下载行为（本地服务，不联网） ---------- */
  await behaviorChecks()

  /* ---------- ⑨ 3.6.2 · 便攜版：檢查但只提示（不給下載按鈕） ---------- */
  {
    const app = read('src/App.tsx')
    ok('⑨ 更新檢查不再整體跳過便攜版（條件是 !WEB，不是 !PORTABLE）',
      /if \(!WEB\) void \(async \(\) => \{[\s\S]{0,400}checkUpdate\(false\)/.test(app)
      && !/if \(!PORTABLE\) void \(async/.test(app),
      '便攜版跳過分支還在，或改成了别的形态判定')
    ok('⑨ 由调用方告知能否自装（selfInstall={!PORTABLE}）',
      app.includes('selfInstall={!PORTABLE}'))
    ok('⑨ 便攜版给的是「去发布页下载新包」而不是「下载安装包」',
      dialog.includes('去发布页下载新包') && dialog.includes('不能应用内更新'))
    ok('⑨ 不能自装时完整性那行不显示（下都下不了，谈校验没意义）',
      /phase\.kind === 'idle' \|\| phase\.kind === 'error'\) && selfInstall && latest/.test(dialog))
    ok('⑨ 便攜版说明仍写明「把 data 拷进新目录」（避免用户以为要重装全书）',
      dialog.includes('把旧目录里的 data 文件夹拷进新目录'))
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

/**
 * 本地起一个只服务几 KB 的 HTTP 服务，真的跑一遍 `downloadInstaller`。
 *
 * 🔴 为什么值得破一次"只读源码"的规矩：摘要校验的**核心风险在失败路径**——
 *    "不符时有没有删掉 .part"、"未给摘要时有没有标 verified:false" 这两件事，
 *    读源码只能看到字面，跑一遍才能确认顺序真的接对了。
 *    本地回环 + 几 KB 载荷 ⇒ 毫秒级、不联网、不碰真实「下载」文件夹（写临时目录）。
 */
async function behaviorChecks() {
  const http = await import('node:http')
  const os = await import('node:os')
  const crypto = await import('node:crypto')
  const fsp = await import('node:fs/promises')
  const { createRequire } = await import('node:module')
  const requireCjs = createRequire(import.meta.url)
  const { downloadInstaller } = requireCjs('../electron/updateDownload.cjs') as {
    downloadInstaller: (o: Record<string, unknown>) => Promise<Record<string, unknown>>
  }

  // 真 PE 头（MZ）+ 一点内容；downloadInstaller 会以文件头判"是不是可执行文件"
  const payload = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4096, 7)])
  const goodSha = crypto.createHash('sha256').update(payload).digest('hex')
  const html = Buffer.from('<html>请先登录</html>')

  const server = http.createServer((req, res) => {
    if (req.url === '/exe') {
      res.writeHead(200, { 'content-length': String(payload.length) })
      res.end(payload)
    } else if (req.url === '/html') {
      res.writeHead(200, { 'content-length': String(html.length), 'content-type': 'text/plain' })
      res.end(html)
    } else {
      res.writeHead(404); res.end('nope')
    }
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}`
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'yfe-dl-'))
  const files = async () => (await fsp.readdir(dir)).sort()

  try {
    // ① 摘要匹配 → ok，且 .part 已改名为正式文件
    const r1 = await downloadInstaller({ url: `${base}/exe`, dir, fileName: '好包.exe', expectedSha256: goodSha })
    ok('行为①摘要匹配 → ok 且 verified:true', r1.ok === true && r1.verified === true, JSON.stringify(r1))
    ok('行为①落盘文件名沿用清洗后的名字', (await files()).includes('好包.exe'), (await files()).join(','))

    // ② 摘要不符 → 失败 + 删 .part + 不留下任何 exe
    const before = await files()
    const r2 = await downloadInstaller({ url: `${base}/exe`, dir, fileName: '坏包.exe', expectedSha256: 'b'.repeat(64) })
    ok('🔴 行为②摘要不符 → ok:false 且 reason=sha256-mismatch',
      r2.ok === false && r2.reason === 'sha256-mismatch', JSON.stringify(r2))
    const after2 = await files()
    ok('🔴 行为②没有 .part 残留', !after2.some(f => f.endsWith('.part')), after2.join(','))
    ok('🔴 行为②没有留下坏包（文件列表与之前一致）', after2.join(',') === before.join(','), after2.join(','))

    // ③ 未给摘要 → 可完成但 verified:false（Gitee 兜底通道就是这种）
    const r3 = await downloadInstaller({ url: `${base}/exe`, dir, fileName: '未校验.exe' })
    ok('行为③未给摘要 → ok:true 且 verified:false', r3.ok === true && r3.verified === false, JSON.stringify(r3))

    // ④ 摘要格式非法 → 视为未提供（不因为一个坏参数就把好包判坏）
    const r4 = await downloadInstaller({ url: `${base}/exe`, dir, fileName: '坏参数.exe', expectedSha256: 'xyz' })
    ok('行为④摘要格式非法 → 当作未提供，仍可完成', r4.ok === true && r4.verified === false, JSON.stringify(r4))

    // ⑤ 非 MZ 头（登录墙网页）→ 仍拒绝（回归：摘要校验不能替掉兜底页拦截）
    const r5 = await downloadInstaller({ url: `${base}/html`, dir, fileName: '网页.exe', expectedSha256: goodSha })
    ok('🔴 行为⑤非可执行文件 → 拒绝（兜底页拦截未被摘要校验顶掉）', r5.ok === false, JSON.stringify(r5))
    ok('行为⑤拒绝后不留 .part', !(await files()).some(f => f.endsWith('.part')))

    // ⑥ 404 → 失败且不留文件
    const r6 = await downloadInstaller({ url: `${base}/missing`, dir, fileName: '缺.exe' })
    ok('行为⑥服务端 404 → ok:false', r6.ok === false, JSON.stringify(r6))
  } finally {
    await new Promise<void>(r => server.close(() => r()))
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

await main()
