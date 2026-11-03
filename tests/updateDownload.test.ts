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
// 🔴 为什么用「读源码」而不是「跑函数」：跑下载要联网、要写盘、要几分钟，不适合放进单测批次；
//    这里只钉住**结构与边界**，真实端到端由实机探针与人工安装验证覆盖。
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

function main() {
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
  ok('② 渲染层拿不到「目标目录」参数（download 只收 url + fileName）',
    /download\(url: string, fileName: string\)/.test(desktop))

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

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
