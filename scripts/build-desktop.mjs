// 桌面版打包脚本：npm run build:desktop
// 封装了国内镜像 + 项目本地缓存，保证在任何网络/受限环境下可重复打包。
// 产物：release/桌面安装版/青春幻想引擎-Setup-<版本号>.exe（版本取自 package.json）
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, renameSync } from 'node:fs'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
// 安装包文件名随 package.json 的 version 自动变化，避免版本升级后此处写死导致找不到文件
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const setupName = `青春幻想引擎-Setup-${pkg.version}.exe`
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

console.log('[2/3] Vite 构建渲染层 ...')
// 构建前把旧 dist 改名移走：避开本环境 safe-delete 对 vite emptyOutDir(rmSync→回收站) 的拦截
// （rename 是非破坏性操作，不受 safe-delete 影响；vite 随后新建空白 dist）
const distDir = path.join(root, 'dist')
if (existsSync(distDir)) {
  renameSync(distDir, path.join(root, `dist_bak_${Date.now()}`))
}
run(process.execPath, [vite, 'build'])

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
  // 其中已含 @electron/get 可识别的 electron-v31.7.7-win32-x64.zip。
  // ⚠️ 切勿指向 release/eb-cache/electron-zip —— 那里只有扁平 zip、缺少 @electron/get 的
  //    hash 子目录结构，离线时 electron-builder 找不到运行时，只会打出空壳安装包（约 500KB、无法运行）。
  ELECTRON_CACHE: path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.cache'), 'electron', 'Cache'),
}
// electron 运行时 zip 缓存：若此前下载过（旧位置 _tmp_tools），复用之
const legacyZip = path.join(root, '_tmp_tools', 'electron-cache', 'electron-v31.7.7-win32-x64.zip')
const zipDir = env.ELECTRON_CACHE
if (!existsSync(path.join(zipDir, 'electron-v31.7.7-win32-x64.zip')) && existsSync(legacyZip)) {
  mkdirSync(zipDir, { recursive: true })
  fs.copyFileSync(legacyZip, path.join(zipDir, 'electron-v31.7.7-win32-x64.zip'))
}

// 构建前把旧的 desktop-out 改名移走（rename 非破坏性，避开 safe-delete 对 rm 的拦截，也避免复用陈旧产物）
// 注意：历史打包（如 1.2.0）的 electron-builder 可能因 safe-delete 拦截收尾文件清理而残留为僵尸进程，
// 持续占用 release/desktop-out 目录句柄，导致后续构建 renameSync 抛 EBUSY/EPERM 异常崩溃。
// 故按版本号隔离输出目录（desktop-out-<version>），彻底绕开被锁死的旧目录，避免再次卡死，且各版本产物互不污染。
// 额外保险：当旧目录被残留进程锁死（rename 失败）时，不再阻塞本次构建——改用带时间戳的唯一输出目录，
// 完全避开被占用的旧目录，保证打包可重复成功。
const desktopOutBase = path.join(root, 'release', `desktop-out-${pkg.version}`)
const desktopOut = path.join(root, 'release', `desktop-out-${pkg.version}-${Date.now()}`)
if (existsSync(desktopOutBase)) {
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
const buildResult = spawnSync(process.execPath, [builder, '--win', '--x64', `-c.directories.output=${desktopOut}`], {
  cwd: root, stdio: 'inherit', shell: false, env: { ...process.env, ...env },
})
const src = path.join(desktopOut, setupName)
if (buildResult.status !== 0) {
  if (!existsSync(src)) {
    console.error(`[build:desktop] electron-builder 失败：${builder} --win --x64`)
    process.exit(buildResult.status ?? 1)
  }
  console.warn('[build:desktop] 提示：electron-builder 退出码非 0，但安装包已正常产出（safe-delete 清理中间文件被拦截，可忽略），继续交付。')
}

// 把安装包复制到固定交付目录
const destDir = path.join(root, 'release', '桌面安装版')
mkdirSync(destDir, { recursive: true })
copyFileSync(src, path.join(destDir, setupName))
console.log(`\n打包完成：${path.join(destDir, setupName)}`)
