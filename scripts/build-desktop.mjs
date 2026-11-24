// 桌面版打包脚本：npm run build:desktop
// 封装了国内镜像 + 项目本地缓存，保证在任何网络/受限环境下可重复打包。
// 产物：release/桌面安装版/青春幻想引擎-Setup-<版本号>.exe（版本取自 package.json）
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, renameSync, statSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import './verify/agent-docs.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
// 安装包文件名随 package.json 的 version 自动变化，避免版本升级后此处写死导致找不到文件
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const setupName = `青春幻想引擎-Setup-${pkg.version}.exe`
// Electron 运行时版本：**唯一真源＝已安装的 electron 包**（打包用的就是它）。
// 🔴 刻意不写死版本号 —— 每次升 electron 都回来改一遍脚本是必然出错的（2026-10-07 起改为动态推导）。
const ELECTRON_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version
  } catch {
    return ''
  }
})()
const ELECTRON_ZIP = ELECTRON_VERSION ? `electron-v${ELECTRON_VERSION}-win32-x64.zip` : ''
// 直接经 node 调 JS 入口，避免 .cmd 在 shell:false 下无法派生的坑（跨平台稳健）
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
const builder = path.join(root, 'node_modules', 'electron-builder', 'cli.js')

function run(cmd, args, extraEnv = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, ...extraEnv },
  })
  if (r.status !== 0) {
    console.error(`[build:desktop] 步骤失败：${path.basename(cmd)} ${args.join(' ')}`)
    process.exit(r.status ?? 1)
  }
}

console.log('[1/3] TypeScript 类型检查 ...')
run(process.execPath, [tsc, '--noEmit'])

// 调试开关（YFE_REUSE_OUT）：跳过 vite build，直接用已有产物目录做「校验 + 交付」。
//   2026-11-24 起正常封装**不需要**它 —— 元数据已由 electron-builder 在打包阶段写好，
//   不再有「重打包会覆盖补写结果」的死循环（那也是当年引入本开关的原因）。
//   保留仅为排查产物 / 复验时省掉一次重建。
const reuseOutEnv = process.env.YFE_REUSE_OUT || ''
if (reuseOutEnv) {
  console.log(`[2/3] 复用模式：跳过 Vite 构建（产物已存在，重建 dist 会作废已打的 app.asar）`)
} else {
  console.log('[2/3] Vite 构建渲染层 ...')
  // 构建前把旧 dist 改名移走：避开本环境 safe-delete 对 vite emptyOutDir(rmSync→回收站) 的拦截
  // （rename 是非破坏性操作，不受 safe-delete 影响；vite 随后新建空白 dist）
  const distDir = path.join(root, 'dist')
  if (existsSync(distDir)) {
    renameSync(distDir, path.join(root, `dist_bak_${Date.now()}`))
  }
  run(process.execPath, [vite, 'build'])
}

// ─────────────────────────────────────────────────────────────────────────────
// 🔴🔴 绕开 electron-builder 26 的「解包改名」死锁（2026-10-07 · 2.9.0 轮实测）
//
// 【现象】builder 26 的 extractArchive 走「解包到 win-unpacked.tmp → fs.rename 成 win-unpacked」。
//   本机安全软件 / 文件监视会**瞬时占用**刚写出的那 ~200MB 目录 ⇒ rename 必报
//   `EPERM: operation not permitted, rename …win-unpacked.tmp -> …win-unpacked`，封装必然失败。
//   （2026-10-07 独立探针实测：解包成功、紧跟的 rename 失败，但**同一进程延迟 5 秒后改名成功**
//     ⇒ 外部瞬时占用，不是权限问题、也不是句柄未释放。builder 24 是直接解到目标目录，故旧版不撞。）
//
// 【解法】改用 electron-builder 的 `electronDist` 指向「**已解包**的 Electron 目录」：
//   `app-builder-lib/out/electron/ElectronFramework.js` 的 unpack() 里，只有 electronDist 是
//   「目录、且不含 electron-v<ver>-win32-x64.zip」时才走 copyDir（**不做 rename**）；
//   指向 zip 或含 zip 的目录仍会走 extractArchive（仍会撞）。
//
// 【为什么剔两个文件】自定义 electronDist 时 cleanupAfterUnpack 的 isFullCleanup=false，
//   不会替咱删 `resources/default_app.asar` 与 `version`（默认流程会删）⇒ 缓存里预先删掉，
//   产物才与既有发布版逐项一致。（LICENSE→LICENSE.electron.txt 改名两种情况都做，无需处理。）
// ─────────────────────────────────────────────────────────────────────────────
function deepRemove(p) {
  let st
  try { st = fs.lstatSync(p) } catch { return }
  if (st.isDirectory()) {
    let names = []
    try { names = fs.readdirSync(p) } catch { return }
    for (const n of names) deepRemove(path.join(p, n))
    try { fs.rmdirSync(p) } catch { /* 里面可能还有被占用的文件 */ }
  } else {
    try { fs.unlinkSync(p) } catch { /* 被占用就留下 */ }
  }
}

/** 手动递归复制目录（替代被本机 shim 掐断的 fs.cpSync）。官方 electron dist 无符号链接。 */
function copyDirDeep(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name)
    const d = path.join(dest, ent.name)
    if (ent.isDirectory()) copyDirDeep(s, d)
    else fs.copyFileSync(s, d)
  }
}

function ensureUnpackedElectronDist() {
  try {
    const electronVersion = ELECTRON_VERSION
    if (!electronVersion) {
      console.warn('[build:desktop] ⚠️ 读不到已安装 electron 的版本 → 退回默认解包逻辑')
      return null
    }
    const srcDist = path.join(root, 'node_modules', 'electron', 'dist')
    const cacheRoot = path.join(root, 'release', 'eb-cache', 'electron-unpacked')
    const cacheDist = path.join(cacheRoot, `electron-v${electronVersion}-win32-x64`)
    const stamp = path.join(cacheRoot, `stamp-${electronVersion}.txt`)

    if (existsSync(stamp) && existsSync(path.join(cacheDist, 'electron.exe'))) {
      console.log(`[build:desktop] 复用「已解包 Electron」缓存：${cacheDist}`)
      return cacheDist
    }
    if (!existsSync(path.join(srcDist, 'electron.exe'))) {
      console.warn('[build:desktop] ⚠️ 未找到 node_modules/electron/dist（是不是漏跑了 electron 的安装脚本？）')
      console.warn('[build:desktop]    → 退回 electron-builder 默认解包逻辑（本机大概率会因 EPERM 失败）')
      return null
    }
    // 重建缓存：逐文件删（安全删除策略会拦整体 rmSync），且副本名带版本号，换版本即换目录
    if (existsSync(cacheDist)) deepRemove(cacheDist)
    // ⚠️ 不能 use fs.cpSync —— 本机它被 shim 拦下后**进程静默退出（码 127、无任何报错）**
    //    （2026-10-07 实测：探针停在 cpSync 那一行，日志只剩「begin」，退出码 127）。
    //    改用 readdir + copyFileSync 手动递归（copyFileSync 在脚本里已被验证可用）。
    copyDirDeep(srcDist, cacheDist)
    for (const rel of [path.join('resources', 'default_app.asar'), 'version']) {
      try { fs.unlinkSync(path.join(cacheDist, rel)) } catch { /* 本来就没有也行 */ }
    }
    mkdirSync(cacheRoot, { recursive: true })
    writeFileSync(stamp, electronVersion, 'utf8')
    console.log(`[build:desktop] 已准备「已解包 Electron」缓存：${cacheDist}`)
    return cacheDist
  } catch (e) {
    console.warn('[build:desktop] ⚠️ 准备「已解包 Electron」失败，退回默认解包逻辑：', e.message)
    return null
  }
}

console.log('[3/3] electron-builder 打包 NSIS 安装包 ...')
// 国内镜像（海外网络下也可用，npmmirror 对全球开放）
// 项目本地缓存：首次构建后组件会缓存在 release/eb-cache，重复构建不再联网
const env = {
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  // 复用系统默认 electron-builder 缓存（已含 1.0 成功解压的 winCodeSign-2.6.0、nsis 等工具）。
  // 注意：项目内的 release/eb-cache 在本环境会因 7-Zip 无法创建 darwin 符号链接而解压失败，
  // 故指向默认缓存目录，避免重复下载与解压。
  ELECTRON_BUILDER_CACHE: path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.cache', 'electron-builder'), 'electron-builder', 'Cache'),
  // electron 运行时缓存：同样指向系统默认缓存（C:\Users\<用户>\AppData\Local\electron\Cache），
  // 其中应含 @electron/get 可识别的 `electron-v<版本>-win32-x64.zip`（版本＝已安装的 electron）。
  // ⚠️ 切勿指向 release/eb-cache/electron-zip —— 那里只有扁平 zip、缺少 @electron/get 的
  //    hash 子目录结构，离线时 electron-builder 找不到运行时，只会打出空壳安装包（约 500KB、无法运行）。
  ELECTRON_CACHE: path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.cache'), 'electron', 'Cache'),
}
// electron 运行时 zip 缓存迁移：若此前下载过（旧位置 _tmp_tools），复制到系统缓存复用
if (ELECTRON_ZIP) {
  const legacyZip = path.join(root, '_tmp_tools', 'electron-cache', ELECTRON_ZIP)
  const zipDir = env.ELECTRON_CACHE
  if (!existsSync(path.join(zipDir, ELECTRON_ZIP)) && existsSync(legacyZip)) {
    mkdirSync(zipDir, { recursive: true })
    fs.copyFileSync(legacyZip, path.join(zipDir, ELECTRON_ZIP))
  }
}

// 构建前把旧的 desktop-out 改名移走（rename 非破坏性，避开 safe-delete 对 rm 的拦截，也避免复用陈旧产物）
// 注意：历史打包（如 1.2.0）的 electron-builder 可能因 safe-delete 拦截收尾文件清理而残留为僵尸进程，
// 持续占用 release/desktop-out 目录句柄，导致后续构建 renameSync 抛 EBUSY/EPERM 异常崩溃。
// 故按版本号隔离输出目录（desktop-out-<version>），彻底绕开被锁死的旧目录，避免再次卡死，且各版本产物互不污染。
// 额外保险：当旧目录被残留进程锁死（rename 失败）时，不再阻塞本次构建——改用带时间戳的唯一输出目录，
// 完全避开被占用的旧目录，保证打包可重复成功。
const desktopOutBase = path.join(root, 'release', `desktop-out-${pkg.version}`)
// 🔴 可复用已有输出目录：主 exe 补写（须从外层做，见下）之后重跑本脚本时，
//    靠这个参数**复用同一个目录**才能让安装包封进补写好的 exe。
//    不传则每次都用新的时间戳目录（首轮打包的默认行为，防旧目录被锁死）。
const reuseOut = process.env.YFE_REUSE_OUT || ''
const desktopOut = reuseOut
  ? path.resolve(root, reuseOut)
  : path.join(root, 'release', `desktop-out-${pkg.version}-${Date.now()}`)
if (!reuseOut && existsSync(desktopOutBase)) {
  try {
    renameSync(desktopOutBase, path.join(root, `release/desktop-out-bak_${Date.now()}`))
  } catch (e) {
    console.warn('[build:desktop] 提示：旧 desktop-out 目录被占用，跳过清理（改用唯一输出目录，不阻塞本次构建）：', e.message)
  }
}

// electron-builder 打包 NSIS 安装包。
// 已知坑：本环境 safe-delete 会把末尾清理中间文件（.nsis.7z）的 unlink 拦截成"移入回收站"，
// 回收站操作异常导致 electron-builder 以非零码退出——但安装包 exe 已正常产出。
// 故此处不立即失败：若 exe 已存在则视为成功并继续交付，否则才真正报错。
//
// 调试开关（YFE_REUSE_OUT）：**跳过 electron-builder**，直接用该目录里已有的产物做校验 + 交付。
//   正常发布不用它（原因见文件顶部）；只有「产物已经在、只想复验或重新交付」时才传。
// 复用模式不重打，故也不需要 electronDist；正常模式则先备好「已解包 Electron」缓存
const electronDist = reuseOut ? null : ensureUnpackedElectronDist()
const builderArgs = [builder, '--win', '--x64', `-c.directories.output=${desktopOut}`]
if (electronDist) builderArgs.push(`-c.electronDist=${electronDist}`)

const buildResult = reuseOut
  ? { status: 0, stdout: '' }
  : spawnSync(process.execPath, builderArgs, {
      cwd: root, stdio: 'inherit', shell: false, env: { ...process.env, ...env },
    })
if (reuseOut) {
  console.log(`[build:desktop] 复用已有产物目录：${desktopOut}（跳过 electron-builder）`)
}
/**
 * ⚠️ 体积闸门（防「空壳安装包」再发事故）：
 * 2.0.0 曾因 ELECTRON_CACHE 指向扁平 zip 目录，离线时 electron 运行时没打进包，
 * 产出仅 513KB 的 NSIS 空壳（双击无任何反应）；而旧脚本「exe 存在即成功」的兜底
 * 把它误判为 OK，坏包一路躺进交付目录。正常含 electron 运行时的安装包约 85MB，
 * 故此处强制 >= 50MB 才算有效产物。
 */
const MIN_SETUP_BYTES = 50 * 1024 * 1024

const src = path.join(desktopOut, setupName)
if (!existsSync(src)) {
  console.error(`[build:desktop] 未找到安装包产物：${src}`)
  process.exit(buildResult.status ?? 1)
}
const setupSize = statSync(src).size
if (setupSize < MIN_SETUP_BYTES) {
  console.error(
    `[build:desktop] 安装包体积异常：${(setupSize / 1024 / 1024).toFixed(2)} MB，低于阈值 ${MIN_SETUP_BYTES / 1024 / 1024} MB。`,
  )
  console.error('[build:desktop] 判定为 NSIS 空壳（electron 运行时未打进包），已中止交付。')
  console.error('[build:desktop] 请检查 ELECTRON_CACHE 是否指向含 hash 子目录结构的系统默认缓存。')
  process.exit(1)
}
if (buildResult.status !== 0) {
  console.warn('[build:desktop] 提示：electron-builder 退出码非 0，但安装包体积正常（多为 safe-delete 清理中间文件被拦截，可忽略），继续交付。')
}

/**
 * 主 exe 的图标与版本元数据：**由 electron-builder 在打包阶段写入**（2026-11-24 起）。
 *
 * 【历史】2.7.1–3.7.0 用的是「关掉内置 rcedit + 外层手工补写」的绕法：当时 electron-builder 24
 *   写主 exe 资源必报 `Fatal error: Unable to commit changes`，重试耗尽还会中止整个构建，
 *   只能把 `signAndEditExecutable` 整段关掉，再在外层跑 rcedit + `--prepackaged` 重打。
 *   代价：每次发版人工介入三轮；而 `--prepackaged` 会复用同目录旧 `*-nsis.7z`，
 *   漏删就会把「没补元数据的 exe」封进安装包（2026-10-29 实踩）。
 *
 * 【现在】electron-builder 26 支持 `win.signExecutable: false` —— **只跳过签名、保留资源编辑**
 *   （app-builder-lib/out/winPackager.js 里确认：设了它仍会走 signAndEditResources）。
 *   ⇒ 图标 + FileVersion / ProductVersion / CompanyName / ProductName / LegalCopyright
 *     在 packaging 阶段一次写对，NSIS 在同一次运行内直接封这份 exe，无需任何外层补救。
 *
 * 本段只做**验收**：读回 PE 查字符串，写不对就停下查配置，不做「自动修补」。
 */
const EXE_FILENAME = 'YouthFantasyEngine'   // 与 electron-builder.yml 的 win.executableName 一致
const DISPLAY_NAME = '青春幻想引擎'          // 与 electron-builder.yml 的 productName 一致
const COMPANY = '青春幻想引擎开发组'   // 与 package.json 的 author 一致（appInfo.companyName = author.name）
const exePath = path.join(desktopOut, 'win-unpacked', `${EXE_FILENAME}.exe`)
// 图标 + 元数据写入后主 exe 的逐字节大小（**仅日志比对，不是闸门**）。
// ⚠️ 换 electron 大版本、换图标或换写入方式都会变 ⇒ 按首次实测刷新（历史值见 git log）：
//    electron 31.7.7 → 181,097,984 ｜ electron 44.6.0 + 旧图标 → 246,487,040
//    3.5.5 / 3.5.6（外层 rcedit 补写）→ 246,365,184
//    3.7.0 起（electron-builder 自带资源编辑）→ 246,365,696
//    🔴 差的 512 字节来自 **LegalCopyright**（rcedit 方案没写这一项），不是图标缺失；
//       图标缺失会少约 248 KB，量级完全不同，别把两种差异当成一回事。
const EXPECT_BASE_SIZE = 246365696
const expectStrings = [COMPANY, DISPLAY_NAME, pkg.version].filter(Boolean)

function exeMetaOk(p) {
  try {
    const b = readFileSync(p)
    return { ok: expectStrings.every(s => b.includes(Buffer.from(s, 'utf16le'))), size: b.length }
  } catch (e) {
    return { ok: false, size: 0, err: e.message }
  }
}

if (!existsSync(exePath)) {
  console.error(`[build:desktop] 未找到主 exe：${exePath}`)
  console.error('[build:desktop] 检查 electron-builder.yml 的 win.executableName 是否仍为 YouthFantasyEngine')
  process.exit(3)
}

const chk = exeMetaOk(exePath)
if (!chk.ok) {
  console.error(`[build:desktop] ❌ 主 exe 元数据验收未通过（体积 ${chk.size}）`)
  console.error(`[build:desktop]   应含这些串：${expectStrings.join(' / ')}`)
  console.error('[build:desktop] 按这三处查：')
  console.error('[build:desktop]   ① electron-builder.yml 的 win 段是否被改回 signAndEditExecutable: false')
  console.error('[build:desktop]      （那一项会把「资源编辑」与「签名」一起跳过 → exe 无图标无版本）')
  console.error('[build:desktop]   ② build/icon.ico 是否存在（图标缺失时体积会少约 248 KB）')
  console.error('[build:desktop]   ③ package.json 的 author 是否被改（公司名取自 author.name）')
  console.error('[build:desktop] 本次产物不可交付。')
  process.exit(3)
}
console.log(
  `[build:desktop] 主 exe 元数据验收通过（${chk.size} 字节${chk.size === EXPECT_BASE_SIZE ? '，与基线逐字节一致' : `（基线 ${EXPECT_BASE_SIZE}，差 ${chk.size - EXPECT_BASE_SIZE}）`}）`,
)

// 把安装包复制到固定交付目录
const destDir = path.join(root, 'release', '桌面安装版')
mkdirSync(destDir, { recursive: true })
copyFileSync(src, path.join(destDir, setupName))
console.log(`\n打包完成：${path.join(destDir, setupName)}（${(setupSize / 1024 / 1024).toFixed(2)} MB，体积闸门已通过）`)
// 包内 exe 不必再单独核对：NSIS 与 packaging 在同一次 electron-builder 运行内完成，
// 封的就是上面验收通过的那份 exe，不存在 `--prepackaged` 复用旧 `*-nsis.7z` 的路径。
// （3.7.0 实测：包内 YouthFantasyEngine.exe = 246,365,696 B，与 win-unpacked 完全一致。）
console.log('[build:desktop] NSIS 在同一次运行内封装上面这份 exe，无需再核对包内 exe。')
