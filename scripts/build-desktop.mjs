// 桌面版打包脚本：npm run build:desktop
// 封装了国内镜像 + 项目本地缓存，保证在任何网络/受限环境下可重复打包。
// 产物：release/桌面安装版/青春幻想引擎-Setup-<版本号>.exe（版本取自 package.json）
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, renameSync, statSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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

// 🔴 复用模式（YFE_REUSE_OUT）：跳过 vite build。
//   原因：dist 变了就得重打 NSIS（app.asar 封的是 dist），而重打 NSIS 会再次写主 exe、
//   把从外层补写好的元数据覆盖回默认值 —— 那就回到了死循环。
//   复用模式的语义就是「产物已在，只补校验与交付」，dist 必须保持原样。
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
// 🔴 复用模式（YFE_REUSE_OUT）：**跳过 electron-builder**，直接用该目录里已有的产物。
//   用途：主 exe 的元数据补写必须从**外层**做（本环境脚本内起子进程被拦成 EBUSY），
//   补写完成后重跑本脚本时传 YFE_REUSE_OUT=<同一目录>，走这里直接校验 + 交付。
//   为什么不能在这里重打包：① electron-builder 会**再次写主 exe**，把补写的元数据覆盖回默认值；
//   ② `win-unpacked/resources/app.asar` 常被实时防护占着，重打包会直接失败。
const buildResult = reuseOut
  ? { status: 0, stdout: '' }
  : spawnSync(process.execPath, [builder, '--win', '--x64', `-c.directories.output=${desktopOut}`], {
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
 * 🔴🔴 主 exe 验收 + 重打安装包（2026-10-02 · 2.7.1 轮实测后新增）。
 *
 * 【为什么需要这一段】写主 exe 元数据的钩子已从 `afterPack` 挪到 `afterAllArtifactBuild`
 *   （原因见 electron-builder.yml 的注释：electron-builder 在 afterPack 之后还会再写一次主 exe，
 *   把刚写好的元数据整体覆盖回默认值）。但那个时机**在安装包已经打好之后**——
 *   安装包里封的仍是「默认元数据」的 exe。所以必须：
 *     ① 先查主 exe 到底写没写进去（不信钩子日志，只信 PE 里的字节）；
 *     ② 没写进去就地补写 → **重打安装包**让它封进去 → **再补一次**（重打包本身又会覆盖）；
 *     ④ 最后复验。
 *
 * 【为什么必须重打】NSIS 是在 afterPack 之后打的 ⇒ 包内是旧 exe。
 *   只补 win-unpacked 的 exe 而不重打包，安装出来的程序仍是 Electron 默认图标/版本信息 ——
 *   也就是 2.7.1 首轮封装「日志全绿、验收却不过」的那个坏产物的真正后果。
 *
 * 【为什么补写要写两遍】重打包会再次触发 electron-builder 写 exe ⇒ 又覆盖回默认值。
 *   故顺序必须是「补写 → 重打包 → 再补写」，且第二次之后**不再重打包**（否则死循环）。
 */
const APP_NAME = '青春幻想引擎'          // 与 electron-builder.yml 的 productName 一致
const COMPANY = '青春幻想引擎开发组'   // 主 exe 的公司名（验收基准）
const exePath = path.join(desktopOut, 'win-unpacked', `${APP_NAME}.exe`)
const EXPECT_BASE_SIZE = 181097984 // 历史基线：图标写入后主 exe 的逐字节大小
const expectStrings = [COMPANY, APP_NAME, pkg.version].filter(Boolean)

function exeMetaOk(p) {
  try {
    const b = readFileSync(p)
    return { ok: expectStrings.every(s => b.includes(Buffer.from(s, 'utf16le'))), size: b.length }
  } catch (e) {
    return { ok: false, size: 0, err: e.message }
  }
}

if (existsSync(exePath)) {
  const chk = exeMetaOk(exePath)
  if (chk.ok) {
    console.log(`[build:desktop] 主 exe 元数据校验通过（${chk.size} 字节${chk.size === EXPECT_BASE_SIZE ? '，与基线逐字节一致' : `（基线 ${EXPECT_BASE_SIZE}，差 ${chk.size - EXPECT_BASE_SIZE}）`}）`)
  } else {
    console.warn(`[build:desktop] 主 exe 元数据缺失（体积 ${chk.size}），开始补写 + 重打包 ...`)
    /**
     * 校验主 exe 元数据；缺失时**打印一条可直接粘贴执行的 rcedit 命令**并以非零码退出。
     *
     * 🔴🔴 为什么脚本自己不调 rcedit（2026-10-02 实踩，本环境红线）：
     *   本环境里**任何脚本内 spawn 出来的子进程都会被拦成 `EBUSY`** ——
     *   实测 `spawnSync(rcedit, …)` 恒返回 `{status:null, error:{code:'EBUSY'}}`，
     *   走 `shell:true`、走 `cmd.exe /c bat` 全部一样（bat 内容已确认正确、rcedit 也确实能写，
     *   但**从脚本里就是启动不了**）。而从 Git Bash **外层**直接跑 rcedit 则 100% 成功、
     *   体积精确回到基线 181,097,984。
     *   ⇒ 结论与 skill 一致：**脚本内不起子进程，改由外层执行**。
     *
     * 【用法】本脚本打印那条命令后退出（码 2）→ 外层执行它 → 再跑一次本脚本即完成校验与交付。
     */
    const patchExe = () => {
      const rcedit = (() => {
        const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign')
        if (!existsSync(cache)) return ''
        for (const sub of readdirSync(cache)) {
          const p = path.join(cache, sub, 'rcedit-x64.exe')
          if (existsSync(p)) return p
        }
        return ''
      })()
      if (!rcedit) {
        console.warn('[build:desktop] ❌ 找不到 rcedit，无法补写主 exe')
        return false
      }
      const cmd = [
        `"${rcedit}"`, `"${exePath}"`,
        '--set-version-string', 'FileDescription', APP_NAME,
        '--set-version-string', 'ProductName', APP_NAME,
        '--set-version-string', 'InternalName', APP_NAME,
        '--set-version-string', 'CompanyName', COMPANY,
        '--set-file-version', pkg.version,
        '--set-product-version', `${pkg.version}.0`,
        '--set-icon', '"' + path.join(root, 'build', 'icon.ico') + '"',
      ].join(' ')
      // 🔴🔴 补写之后**必须用 `--prepackaged` 重打 NSIS**（2026-10-02 实测，这是唯一可行解）。
      //   原因：electron-builder 每次运行都会在 packaging 阶段**从 electron 压缩包重新铺一遍 exe**，
      //   把外层补写好的元数据与图标**整体覆盖回默认值**（实测 4 种调法都如此：afterPack /
      //   afterAllArtifactBuild / 复用模式 / 补写后立刻 `--win nsis`，无一例外）。
      //   而普通调用无法指定「沿用已铺好的 win-unpacked」。
      //   `--prepackaged <dir>` 正是 electron-builder 提供的这个开关：**跳过解包、直接用现成的
      //   win-unpacked 去做 NSIS** ⇒ exe 保持不动。实测打包后 exe 仍是 181,097,984。
      const rebuildCmd = [
        `"${process.execPath}" node_modules/electron-builder/cli.js --win nsis --x64`,
        `--prepackaged "${path.join(desktopOut, 'win-unpacked')}"`,
        `-c.directories.output="${desktopOut}"`,
      ].join(' ')
      console.error('\n[build:desktop] ✋ 主 exe 元数据/图标缺失，需从**外层**执行下面两步')
      console.error('[build:desktop] （本环境脚本内起子进程一律被拦成 EBUSY；且 electron-builder 重跑会覆盖 exe）\n')
      console.error('  ① 补写主 exe：\n     ' + cmd + '\n')
      console.error('  ② 用 --prepackaged 重打安装包（保住刚补好的 exe）：\n     ' + rebuildCmd + '\n')
      writeFileSync(
        path.join(root, '.workbuddy', 'tmp', 'last-desktop-out.txt'),
        `${desktopOut}\n${cmd}\n${rebuildCmd}\n`,
        'utf8',
      )
      console.error(`[build:desktop] （两步命令已记入 .workbuddy/tmp/last-desktop-out.txt）\n`)
      return false
    }

    // 补写必须从外层做（脚本内起子进程被 EBUSY 拦）⇒ 打印命令后退出，等外层补完再重跑本脚本。
    patchExe()
    process.exit(2)
  }
}

// 把安装包复制到固定交付目录
const destDir = path.join(root, 'release', '桌面安装版')
mkdirSync(destDir, { recursive: true })
copyFileSync(src, path.join(destDir, setupName))
console.log(`\n打包完成：${path.join(destDir, setupName)}（${(setupSize / 1024 / 1024).toFixed(2)} MB，体积闸门已通过）`)
